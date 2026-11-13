// ESP32-S3 SIP phone: registers to a SIP server (e.g. Asterisk) and answers
// incoming calls with two-way G.711 audio over INMP441 mic + MAX98357A speaker.
// Arduino-ESP32 3.3.12, no external libraries.
//
// Settings are provisioned over Bluetooth LE (the Flutter app or provision.html)
// and stored in flash. Bluetooth is always on, so the phone can be configured
// at any time. config.h only supplies first-boot defaults and pin numbers.
//
// Firmware updates over Wi-Fi: http://<phone-ip>/update once an update
// password is set over Bluetooth (see ota.h).
//
// Voice prompts "Wi-Fi connected" and "SIP phone connected successfully" are
// built into the firmware; firmware/tools/make_prompts.py regenerates prompts.h.
//
// BOOT button: press = answer when ringing, otherwise hang up.
// Serial commands (115200 baud):
//   a = answer   h = hang up / decline   s = status   r = re-register
//   + / - = speaker volume   ] / [ = mic gain
//   X = factory reset (erase saved settings)   ? = help
#include <Arduino.h>
#include <WiFi.h>
#include "app_config.h"
#include "settings.h"
#include "audio.h"
#include "sip.h"
#include "ble_prov.h"
#include "ota.h"

void help() {
  Serial.println("Commands: a=answer h=hang up s=status r=re-register +/-=volume ]/[=mic gain X=factory reset ?=help");
  Serial.println("BOOT: press = answer/hang up");
}

void saveLevels() { settings::saveAudio(audio::volume(), audio::micGain()); }

void handleSerial() {
  while (Serial.available()) {
    switch (Serial.read()) {
      case 'a': sip::answer(); break;
      case 'h': sip::hangup(); break;
      case 's':
        sip::printStatus();
        Serial.printf("[STATUS] Bluetooth %s, settings %s\n", ble_prov::active() ? "on" : "FAILED",
                      settings::configured() ? "configured" : "NOT configured");
        ota::printStatus();
        break;
      case 'r': sip::reRegister(); break;
      case '+': audio::setVolume(audio::volume() + 10); saveLevels(); Serial.printf("Volume %d%%\n", audio::volume()); break;
      case '-': audio::setVolume(audio::volume() - 10); saveLevels(); Serial.printf("Volume %d%%\n", audio::volume()); break;
      case ']': audio::setMicGain(audio::micGain() + 1); saveLevels(); Serial.printf("Mic gain %d\n", audio::micGain()); break;
      case '[': audio::setMicGain(audio::micGain() - 1); saveLevels(); Serial.printf("Mic gain %d\n", audio::micGain()); break;
      case 'X':
        Serial.println("Erasing saved settings and restarting...");
        settings::factoryReset();
        delay(200);
        ESP.restart();
        break;
      case '?': help(); break;
      default: break;
    }
  }
}

// Acts on release, after a debounced press of at least 50 ms.
void handleButton() {
  static bool lastLevel = HIGH;
  static uint32_t changedAt = 0;
  bool level = digitalRead(ANSWER_BUTTON_PIN);
  uint32_t now = millis();
  if (level == lastLevel) return;
  if (now - changedAt < 30) return;  // debounce
  if (level == HIGH && now - changedAt >= 50) sip::button();
  lastLevel = level;
  changedAt = now;
}

void reportWifi() {
  static wl_status_t last = WL_IDLE_STATUS;
  wl_status_t now = WiFi.status();
  if (now == last) return;
  if (now == WL_CONNECTED) {
    Serial.printf("[WIFI] connected, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    audio::playPrompt(audio::PROMPT_WIFI_CONNECTED);
  } else if (last == WL_CONNECTED) {
    Serial.println("[WIFI] disconnected, reconnecting...");
  }
  last = now;
}

// Says "SIP phone connected successfully" when registration is gained, not on
// the periodic re-registrations that keep it alive.
void reportSip() {
  static bool last = false;
  bool now = sip::registered();
  if (now && !last) audio::playPrompt(audio::PROMPT_SIP_CONNECTED);
  last = now;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== ESP32-S3 SIP phone ===");
  settings::begin();
  ota::begin();
  const Settings &c = settings::cfg;
  pinMode(ANSWER_BUTTON_PIN, INPUT_PULLUP);
  if (!audio::begin()) Serial.println("[AUDIO] I2S init FAILED: check pins and board settings");
  else Serial.println("[AUDIO] I2S full duplex 16 kHz running");

  if (settings::configured()) {
    Serial.printf("SIP %s@%s:%u, auto-answer %d ms\n", c.sipUser.c_str(), c.sipServer.c_str(),
                  (unsigned)c.sipServerPort, (int)c.autoAnswerMs);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);  // power save adds large RTP latency/jitter
    WiFi.setAutoReconnect(true);
    WiFi.begin(c.wifiSsid.c_str(), c.wifiPassword.c_str());
    Serial.printf("[WIFI] joining %s...\n", c.wifiSsid.c_str());
  } else {
    Serial.println("Not configured: connect over Bluetooth with the setup app or provision.html");
  }
  ble_prov::begin();
  help();
}

void loop() {
  reportWifi();
  handleSerial();
  handleButton();
  sip::loop();
  reportSip();
  ble_prov::loop();
  ota::loop();
  delay(1);
}
