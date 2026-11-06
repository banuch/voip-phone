// Minimal SIP user agent over UDP: registers and accepts incoming calls.
#pragma once
#include <Arduino.h>

namespace sip {

void loop();          // call often from Arduino loop()
void answer();        // answer a ringing call
void hangup();        // decline a ringing call or end the active call
void button();        // answer if ringing, otherwise hang up
void reRegister();    // force a fresh REGISTER now
void printStatus();
bool registered();
String lastError();          // last registration problem, empty when fine
const char *callStateName();

}  // namespace sip
