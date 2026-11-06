// ESP32-S3 SIP phone: registers to a SIP server (e.g. Asterisk) and answers
// incoming calls with two-way G.711 audio over INMP441 mic + MAX98357A speaker.
// Arduino-ESP32 3.3.12, no external libraries. Settings live in config.h.
//
// Serial commands (115200 baud):
//   a = answer   h = hang up / decline   s = status   r = re-register
//   + / - = speaker volume   ] / [ = mic gain   ? = help
#include <Arduino.h>
#include <WiFi.h>
#include "app_config.h"
#include "audio.h"
#include "sip.h"

void help() {
  Serial.println("Commands: a=answer h=hang up s=status r=re-register +/-=volume ]/[=mic gain ?=help");
}

void handleSerial() {
  while (Serial.available()) {
    switch (Serial.read()) {
      case 'a': sip::answer(); break;
      case 'h': sip::hangup(); break;
      case 's': sip::printStatus(); break;
      case 'r': sip::reRegister(); break;
      case '+': audio::setVolume(audio::volume() + 10); Serial.printf("Volume %d%%\n", audio::volume()); break;
      case '-': audio::setVolume(audio::volume() - 10); Serial.printf("Volume %d%%\n", audio::volume()); break;
      case ']': audio::setMicGain(audio::micGain() + 1); Serial.printf("Mic gain %d\n", audio::micGain()); break;
      case '[': audio::setMicGain(audio::micGain() - 1); Serial.printf("Mic gain %d\n", audio::micGain()); break;
      case '?': help(); break;
      default: break;
    }
  }
}

void handleButton() {
  static bool lastLevel = HIGH;
  static uint32_t changedAt = 0;
  static bool handled = false;
  bool level = digitalRead(ANSWER_BUTTON_PIN);
  if (level != lastLevel) { lastLevel = level; changedAt = millis(); handled = false; }
  if (level == LOW && !handled && millis() - changedAt > 50) {
    handled = true;
    sip::button();
  }
}

void reportWifi() {
  static wl_status_t last = WL_IDLE_STATUS;
  wl_status_t now = WiFi.status();
  if (now == last) return;
  if (now == WL_CONNECTED) Serial.printf("[WIFI] connected, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  else if (last == WL_CONNECTED) Serial.println("[WIFI] disconnected, reconnecting...");
  last = now;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== ESP32-S3 SIP phone ===");
  Serial.printf("SIP %s@%s:%d, auto-answer %d ms\n", SIP_USER, SIP_SERVER, SIP_SERVER_PORT, AUTO_ANSWER_MS);
  pinMode(ANSWER_BUTTON_PIN, INPUT_PULLUP);
  if (!audio::begin()) Serial.println("[AUDIO] I2S init FAILED: check pins and board settings");
  else Serial.println("[AUDIO] I2S full duplex 16 kHz running");
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // power save adds large RTP latency/jitter
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WIFI] joining %s...\n", WIFI_SSID);
  help();
}

void loop() {
  reportWifi();
  handleSerial();
  handleButton();
  sip::loop();
  delay(1);
}
