#include "ble_prov.h"
#include "settings.h"
#include "sip.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLESecurity.h>
#include <WiFi.h>

namespace {

const char *SERVICE_UUID = "6b3f0001-7c1a-4d2e-9b8f-2a1c5e7d9f01";
const char *CONFIG_UUID = "6b3f0002-7c1a-4d2e-9b8f-2a1c5e7d9f01";
const char *COMMAND_UUID = "6b3f0003-7c1a-4d2e-9b8f-2a1c5e7d9f01";
const char *STATUS_UUID = "6b3f0004-7c1a-4d2e-9b8f-2a1c5e7d9f01";

constexpr size_t MAX_JSON = 2048;
// Advertising interval in 0.625 ms units (500 ms - 1 s). Slow enough to leave
// the shared 2.4 GHz radio to Wi-Fi/RTP, fast enough to be found in a scan.
constexpr uint16_t ADV_MIN = 800, ADV_MAX = 1600;

bool isActive = false;
volatile bool connected = false;
BLEServer *server = nullptr;
BLECharacteristic *configChr = nullptr, *statusChr = nullptr;

// Shared between the BLE host task (callbacks) and the loop task.
SemaphoreHandle_t mutex = nullptr;
String rxJson, pendingCmd;
bool rxOverflow = false;

String lastStatus, lastConfig, result = "ready", resultDetail;
uint32_t statusAt = 0, rebootAt = 0;

String deviceName() {
  uint64_t mac = ESP.getEfuseMac();
  char b[16];
  snprintf(b, sizeof(b), "SipPhone-%02X%02X", (unsigned)((mac >> 32) & 0xFF), (unsigned)((mac >> 40) & 0xFF));
  return b;
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override {
    connected = true;
  }
  void onDisconnect(BLEServer *) override {
    connected = false;
    BLEDevice::startAdvertising();  // always connectable
  }
};

class ConfigCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String chunk = c->getValue();
    xSemaphoreTake(mutex, portMAX_DELAY);
    if (rxJson.length() + chunk.length() > MAX_JSON) rxOverflow = true;
    else rxJson += chunk;
    xSemaphoreGive(mutex);
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
      rebootAt = millis() + 1500;
    }
  } else if (cmd == "reboot") {
    setResult("rebooting", "");
    rebootAt = millis() + 1000;
  } else if (cmd == "factory_reset") {
    settings::factoryReset();
    setResult("reset", "settings erased, restarting");
    rebootAt = millis() + 1500;
  } else if (cmd.length()) {
    setResult("error", "unknown command " + cmd);
  }
}

}  // namespace

namespace ble_prov {

bool active() { return isActive; }

void begin() {
  if (isActive) return;
  mutex = xSemaphoreCreateMutex();
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
  adv->setMinInterval(ADV_MIN);
  adv->setMaxInterval(ADV_MAX);
  BLEDevice::startAdvertising();
  isActive = true;
  result = "ready";
  resultDetail = "";
  Serial.printf("[BLE] advertising as \"%s\": connect with the setup app or page\n", name.c_str());
}

void loop() {
  if (rebootAt && int32_t(millis() - rebootAt) >= 0) {
    Serial.println("[BLE] restarting");
    Serial.flush();
    ESP.restart();
  }
  if (!isActive) return;

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
}

}  // namespace ble_prov
