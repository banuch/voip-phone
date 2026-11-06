// Firmware update over Wi-Fi: a small web server on port 80.
//
//   GET  /        status page (firmware version, SIP and call state)
//   GET  /update  upload page (HTTP Basic auth: user "admin", update password)
//   POST /update  multipart upload of the .bin; written to the other OTA slot
//
// Updates are off until an update password is set over Bluetooth. Uploads are
// refused during a call. A new image must bring Wi-Fi up and run for 30 s
// before it is marked good; otherwise the bootloader returns to the previous one.
#pragma once
#include <Arduino.h>

namespace ota {

void begin();      // call once in setup(), after settings::begin()
void loop();       // call from Arduino loop(): web server, rollback check, restart
bool enabled();    // update password set
String url();      // "http://<ip>/update" when the server is reachable, else ""
void printStatus();

}  // namespace ota
