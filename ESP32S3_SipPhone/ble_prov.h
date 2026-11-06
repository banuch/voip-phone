// Bluetooth LE setup mode: exposes all settings over an encrypted GATT service.
//
// Service  6b3f0001-7c1a-4d2e-9b8f-2a1c5e7d9f01
//   Config   ...0002  read/write (encrypted)  settings JSON; written in chunks
//   Command  ...0003  write (encrypted)       begin | save | reboot | exit | factory_reset
//   Status   ...0004  read/notify             live Wi-Fi / SIP / last result JSON
//
// Write protocol: "begin" on Command, then the JSON in one or more Config writes
// (appended), then "save". Saving validates, stores to NVS and reboots back into
// setup mode once so the result can be checked.
#pragma once
#include <Arduino.h>

namespace ble_prov {

void begin();          // decides whether to start setup mode at boot
void start();          // enter setup mode (start advertising)
void stop();           // leave setup mode (Bluetooth off)
bool active();
void loop();           // call from Arduino loop(): commands, timeout, status

}  // namespace ble_prov
