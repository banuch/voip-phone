// Runtime settings: loaded from NVS (flash), defaults from config.h on first boot.
#pragma once
#include <Arduino.h>

struct Settings {
  String wifiSsid, wifiPassword;
  String sipServer, sipDomain, sipUser, sipAuthUser, sipPassword;
  uint16_t sipServerPort = 5060, sipLocalPort = 5060, rtpLocalPort = 4000;
  uint32_t sipExpires = 300;
  int32_t autoAnswerMs = 1000;  // -1 = manual answer only
  int micGain = 4;              // 1..32
  int speakerVolume = 60;       // 0..100

  String domain() const { return sipDomain.length() ? sipDomain : sipServer; }
  String authUser() const { return sipAuthUser.length() ? sipAuthUser : sipUser; }
};

namespace settings {

extern Settings cfg;  // active settings; change only from the Arduino loop task

void begin();                                    // load NVS, falling back to config.h defaults
bool configured();                               // enough to join Wi-Fi and register
bool validate(const Settings &s, String &err);
bool save(const Settings &s, String &err);       // validate + write NVS + update cfg
void saveAudio(int volume, int micGain);         // persist serial-adjusted levels
void factoryReset();                             // erase NVS settings (reboot afterwards)

// JSON exchange for BLE. Passwords are never emitted, only "*_password_set".
String toJson(const Settings &s);
// Merges the keys present in json into s; a missing password key keeps the old one.
bool mergeJson(const String &json, Settings &s, String &err);

}  // namespace settings
