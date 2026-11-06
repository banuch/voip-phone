#include "ble_prov.h"
#include "settings.h"
#include "sip.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLESecurity.h>
#include <WiFi.h>
#include <esp_attr.h>

namespace {

const char *SERVICE_UUID = "6b3f0001-7c1a-4d2e-9b8f-2a1c5e7d9f01";
const char *CONFIG_UUID = "6b3f0002-7c1a-4d2e-9b8f-2a1c5e7d9f01";
const char *COMMAND_UUID = "6b3f0003-7c1a-4d2e-9b8f-2a1c5e7d9f01";
const char *STATUS_UUID = "6b3f0004-7c1a-4d2e-9b8f-2a1c5e7d9f01";

constexpr uint32_t IDLE_TIMEOUT_MS = 10 * 60 * 1000;
constexpr size_t MAX_JSON = 2048;
constexpr uint32_t SETUP_MAGIC = 0x5E7A5E7A;

// Survives ESP.restart(): reboot straight back into setup mode after a save.
RTC_NOINIT_ATTR uint32_t setupAfterBoot;

bool isActive = false;
volatile bool connected = false;
volatile uint32_t lastActivity = 0;
BLEServer *server = nullptr;
BLECharacteristic *configChr = nullptr, *statusChr = nullptr;

// Shared between the BLE host task (callbacks) and the loop task.
SemaphoreHandle_t mutex = nullptr;
String rxJson, pendingCmd;
bool rxOverflow = false;

String lastStatus, lastConfig, result = "ready", resultDetail;
uint32_t statusAt = 0, rebootAt = 0, stopAt = 0;

String deviceName() {
  uint64_t mac = ESP.getEfuseMac();
  char b[16];
  snprintf(b, sizeof(b), "SipPhone-%02X%02X", (unsigned)((mac >> 32) & 0xFF), (unsigned)((mac >> 40) & 0xFF));
  return b;
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override {
    connected = true;
    lastActivity = millis();
  }
  void onDisconnect(BLEServer *) override {
    connected = false;
    lastActivity = millis();
    if (isActive) BLEDevice::startAdvertising();
  }
};

class ConfigCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String chunk = c->getValue();
    xSemaphoreTake(mutex, portMAX_DELAY);
    if (rxJson.length() + chunk.length() > MAX_JSON) rxOverflow = true;
    else rxJson += chunk;
    xSemaphoreGive(mutex);
    lastActivity = millis();
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String cmd = c->getValue();
    cmd.trim();
    xSemaphoreTake(mutex, portMAX_DELAY);
    if (cmd == "begin") {  // handled here so it stays ordered before the chunks
      rxJson = "";
      rxOverflow = false;
    } else {
      pendingCmd = cmd;
    }
    xSemaphoreGive(mutex);
    lastActivity = millis();
  }
};

ServerCallbacks serverCallbacks;
ConfigCallbacks configCallbacks;
CommandCallbacks commandCallbacks;

String jsonEscape(const String &v) {
  String o;
  for (unsigned i = 0; i < v.length(); i++) {
    char c = v[i];
    if (c == '"' || c == '\\') o += '\\';
    if ((uint8_t)c >= 0x20) o += c;
  }
  return o;
}

String buildStatus() {
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  String s = "{\"configured\":" + String(settings::configured() ? "true" : "false");
  s += ",\"wifi\":\"" + String(settings::cfg.wifiSsid.isEmpty() ? "not set" : wifiUp ? "connected" : "connecting") + "\"";
  s += ",\"ip\":\"" + (wifiUp ? WiFi.localIP().toString() : String()) + "\"";
  s += ",\"rssi\":" + String(wifiUp ? WiFi.RSSI() : 0);
  s += ",\"sip\":\"" + String(sip::registered() ? "registered" : "not registered") + "\"";
  s += ",\"sip_detail\":\"" + jsonEscape(sip::lastError()) + "\"";
  s += ",\"call\":\"" + String(sip::callStateName()) + "\"";
  s += ",\"result\":\"" + result + "\"";
  s += ",\"detail\":\"" + jsonEscape(resultDetail) + "\"}";
  return s;
}

void setResult(const String &r, const String &detail) {
  result = r;
  resultDetail = detail;
  statusAt = 0;  // publish now
  Serial.printf("[BLE] %s%s%s\n", r.c_str(), detail.length() ? ": " : "", detail.c_str());
}

void handleCommand(const String &cmd) {
  if (cmd == "save") {
    xSemaphoreTake(mutex, portMAX_DELAY);
    String json = rxJson;
    bool overflow = rxOverflow;
    rxJson = "";
    xSemaphoreGive(mutex);
    Settings next = settings::cfg;
    String err;
    if (overflow) setResult("error", "settings JSON too large");
    else if (!settings::mergeJson(json, next, err)) setResult("error", err);
    else if (!settings::save(next, err)) setResult("error", err);
    else {
      setResult("saved", "restarting to apply");
      setupAfterBoot = SETUP_MAGIC;
      rebootAt = millis() + 1500;
    }
  } else if (cmd == "reboot") {
    setResult("rebooting", "");
    setupAfterBoot = SETUP_MAGIC;
    rebootAt = millis() + 1000;
  } else if (cmd == "factory_reset") {
    settings::factoryReset();
    setResult("reset", "settings erased, restarting");
    setupAfterBoot = SETUP_MAGIC;
    rebootAt = millis() + 1500;
  } else if (cmd == "exit") {
    setResult("exiting", "Bluetooth off");
    stopAt = millis() + 500;
  } else if (cmd.length()) {
    setResult("error", "unknown command " + cmd);
  }
}

}  // namespace

namespace ble_prov {

void begin() {
  mutex = xSemaphoreCreateMutex();
  bool after = setupAfterBoot == SETUP_MAGIC;
  setupAfterBoot = 0;
  if (after || !settings::configured()) start();
}

bool active() { return isActive; }

void start() {
  if (isActive) return;
  String name = deviceName();
  BLEDevice::init(name);
  BLEDevice::setMTU(247);
  BLESecurity::setCapability(ESP_IO_CAP_NONE);          // Just Works pairing
  BLESecurity::setAuthenticationMode(true, false, true);  // bond, no MITM, LE Secure Connections

  server = BLEDevice::createServer();
  server->setCallbacks(&serverCallbacks);
  BLEService *svc = server->createService(SERVICE_UUID);
  configChr = svc->createCharacteristic(CONFIG_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_READ_ENC |
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_ENC);
  configChr->setCallbacks(&configCallbacks);
  BLECharacteristic *cmdChr = svc->createCharacteristic(COMMAND_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_ENC);
  cmdChr->setCallbacks(&commandCallbacks);
  statusChr = svc->createCharacteristic(STATUS_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  lastConfig = settings::toJson(settings::cfg);
  configChr->setValue(lastConfig);
  lastStatus = buildStatus();
  statusChr->setValue(lastStatus);
  svc->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  isActive = true;
  lastActivity = millis();
  result = "ready";
  resultDetail = "";
  Serial.printf("[BLE] setup mode ON: connect to \"%s\" with the setup page\n", name.c_str());
}

void stop() {
  if (!isActive) return;
  isActive = false;
  connected = false;
  BLEDevice::deinit(false);
  server = nullptr;
  configChr = statusChr = nullptr;
  Serial.println("[BLE] setup mode OFF");
}

void loop() {
  if (rebootAt && int32_t(millis() - rebootAt) >= 0) {
    Serial.println("[BLE] restarting");
    Serial.flush();
    ESP.restart();
  }
  if (!isActive) return;
  if (stopAt && int32_t(millis() - stopAt) >= 0) {
    stopAt = 0;
    stop();
    return;
  }

  String cmd;
  xSemaphoreTake(mutex, portMAX_DELAY);
  cmd = pendingCmd;
  pendingCmd = "";
  xSemaphoreGive(mutex);
  if (cmd.length()) handleCommand(cmd);

  if (!statusAt || millis() - statusAt > 1000) {
    statusAt = millis();
    String s = buildStatus();
    if (s != lastStatus) {
      lastStatus = s;
      statusChr->setValue(s);
      if (connected) statusChr->notify();
    }
    String c = settings::toJson(settings::cfg);
    if (c != lastConfig) {
      lastConfig = c;
      configChr->setValue(c);
    }
  }

  // Stay on while unconfigured; otherwise switch off after 10 idle minutes.
  if (settings::configured() && !connected && !rebootAt && millis() - lastActivity > IDLE_TIMEOUT_MS) {
    Serial.println("[BLE] idle timeout");
    stop();
  }
}

}  // namespace ble_prov
