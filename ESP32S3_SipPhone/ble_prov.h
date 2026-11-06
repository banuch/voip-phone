// Bluetooth LE configuration service, always on: the phone advertises and
// accepts connections at all times, alongside Wi-Fi and calls.
//
// Service  6b3f0001-7c1a-4d2e-9b8f-2a1c5e7d9f01
//   Config   ...0002  read/write (encrypted)  settings JSON; written in chunks
//   Command  ...0003  write (encrypted)       begin | save | reboot | factory_reset
//   Status   ...0004  read/notify             live Wi-Fi / SIP / last result JSON
//
// Write protocol: "begin" on Command, then the JSON in one or more Config writes
// (appended), then "save". Saving validates, stores to NVS and reboots; the
// phone is connectable again as soon as it is back up.
#pragma once
#include <Arduino.h>

namespace ble_prov {

void begin();          // start the GATT service and advertising (call once in setup())
bool active();         // true once begin() has run
void loop();           // call from Arduino loop(): commands, status, reboot

}  // namespace ble_prov
