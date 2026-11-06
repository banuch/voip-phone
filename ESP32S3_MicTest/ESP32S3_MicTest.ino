// Standalone INMP441 microphone test — Serial Monitor only (115200 baud).
// No Wi-Fi, no web server, no speaker. Arduino-ESP32 3.x, ESP32-S3.
//
// Commands (type in Serial Monitor, send with Enter):
//   1  = mic ON  (start I2S capture, print stats every 500 ms)
//   0  = mic OFF (stop I2S)
//   u  = toggle weak pull-up on SD (GPIO6) while mic is ON
//        -> readings become 0xFFFFFFFF : mic is NOT driving SD (power/clock/solder)
//        -> readings stay 0            : something holds SD low (short to GND)
//        -> readings unchanged/noisy   : mic is driving SD normally
//   p  = probe SD pin with mic OFF (detect shorts to GND/3V3)
//   r  = print 8 raw L/R slot values (mic ON)
//   h  = help
#include <Arduino.h>
#include <ESP_I2S.h>
#include <driver/gpio.h>

constexpr int BCLK_PIN = 4, WS_PIN = 5, MIC_PIN = 6;
constexpr uint32_t RATE = 16000;

I2SClass i2s;
bool micOn = false, pullup = false;

struct Stats {
  uint32_t reads, timeouts, frames, zeroL, zeroR, onesL, onesR;
  int32_t minL, maxL, minR, maxR;
  int64_t sumSqL;
  uint32_t lastPrint, started;
} st;

void resetWindow() {
  st.frames = st.zeroL = st.zeroR = st.onesL = st.onesR = 0;
  st.minL = st.minR = INT32_MAX; st.maxL = st.maxR = INT32_MIN;
  st.sumSqL = 0;
}

void help() {
  Serial.println();
  Serial.println("=== INMP441 mic test ===");
  Serial.printf("Pins: SCK/BCLK=GPIO%d  WS=GPIO%d  SD=GPIO%d  (L/R -> GND, VDD -> 3V3)\n", BCLK_PIN, WS_PIN, MIC_PIN);
  Serial.println("1 = mic ON, 0 = mic OFF, u = toggle SD pull-up, p = probe SD pin, r = raw samples, h = help");
}

void micStart() {
  if (micOn) { Serial.println("[MIC] already ON"); return; }
  i2s.setPins(BCLK_PIN, WS_PIN, -1, MIC_PIN);
  bool ok = i2s.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO);
  Serial.printf("[MIC] I2S begin RX rate=%lu 32-bit stereo -> %s\n", (unsigned long)RATE, ok ? "OK" : "FAILED");
  if (!ok) return;
  pullup = false;
  memset(&st, 0, sizeof(st)); resetWindow();
  st.lastPrint = st.started = millis();
  micOn = true;
  Serial.println("[MIC] ON  - speak / tap the mic. Send 0 to stop.");
}

void micStop() {
  if (!micOn) { Serial.println("[MIC] already OFF"); return; }
  i2s.end();
  micOn = false; pullup = false;
  gpio_pullup_dis((gpio_num_t)MIC_PIN);
  Serial.println("[MIC] OFF");
}

void togglePullup() {
  if (!micOn) { Serial.println("[PULLUP] turn mic ON first (1)"); return; }
  pullup = !pullup;
  if (pullup) gpio_pullup_en((gpio_num_t)MIC_PIN); else gpio_pullup_dis((gpio_num_t)MIC_PIN);
  Serial.printf("[PULLUP] SD pull-up %s\n", pullup ? "ENABLED" : "disabled");
}

void probePin() {
  if (micOn) { Serial.println("[PIN] turn mic OFF first (0)"); return; }
  // With no clock the INMP441 sleeps and its SD output is high-impedance.
  pinMode(MIC_PIN, INPUT_PULLUP);   delay(5); int up = digitalRead(MIC_PIN);
  pinMode(MIC_PIN, INPUT_PULLDOWN); delay(5); int down = digitalRead(MIC_PIN);
  pinMode(MIC_PIN, INPUT);
  const char *v = (up == 1 && down == 0) ? "tri-state (normal while mic is off)"
                : (up == 0 && down == 0) ? "held LOW  -> SD shorted to GND?"
                : (up == 1 && down == 1) ? "held HIGH -> SD shorted to 3V3?"
                : "odd reading";
  Serial.printf("[PIN] GPIO%d pullup=%d pulldown=%d -> %s\n", MIC_PIN, up, down, v);
}

void printRaw() {
  if (!micOn) { Serial.println("[RAW] turn mic ON first (1)"); return; }
  int32_t raw[16];
  size_t n = i2s.readBytes((char *)raw, sizeof(raw));
  Serial.printf("[RAW] %u bytes\n", (unsigned)n);
  for (size_t i = 0; i < n / 8; i++)
    Serial.printf("   #%u  L=0x%08lX  R=0x%08lX\n", (unsigned)i, (unsigned long)raw[i * 2], (unsigned long)raw[i * 2 + 1]);
}

void capture() {
  int32_t raw[256];
  size_t n = i2s.readBytes((char *)raw, sizeof(raw));
  st.reads++;
  if (!n) { st.timeouts++; }
  for (size_t i = 0; i < n / 8; i++) {
    int32_t l = raw[i * 2], r = raw[i * 2 + 1];
    if (l == 0) st.zeroL++;
    if (r == 0) st.zeroR++;
    if (l == -1) st.onesL++;
    if (r == -1) st.onesR++;
    st.minL = min(st.minL, l); st.maxL = max(st.maxL, l);
    st.minR = min(st.minR, r); st.maxR = max(st.maxR, r);
    int32_t s24 = l >> 8;                 // INMP441: 24-bit sample, MSB-aligned
    st.sumSqL += int64_t(s24) * s24 >> 8; // scaled to avoid overflow
  }
  st.frames += n / 8;

  if (millis() - st.lastPrint < 500) return;
  st.lastPrint = millis();
  Serial.printf("[MIC] t=%lus reads=%lu timeouts=%lu frames=%lu%s\n",
    (unsigned long)((millis() - st.started) / 1000), (unsigned long)st.reads,
    (unsigned long)st.timeouts, (unsigned long)st.frames, pullup ? "  (SD PULL-UP ON)" : "");
  if (st.frames) {
    Serial.printf("   L: min=%11ld max=%11ld zeros=%lu ones=%lu\n", (long)st.minL, (long)st.maxL, (unsigned long)st.zeroL, (unsigned long)st.onesL);
    Serial.printf("   R: min=%11ld max=%11ld zeros=%lu ones=%lu\n", (long)st.minR, (long)st.maxR, (unsigned long)st.zeroR, (unsigned long)st.onesR);
    // Level meter from left-channel RMS (24-bit scale, log-ish bar).
    double rms = sqrt(double(st.sumSqL) * 256.0 / st.frames);
    int bars = rms < 1 ? 0 : constrain(int(log10(rms) * 6), 0, 40);
    char bar[41]; memset(bar, '#', bars); bar[bars] = 0;
    Serial.printf("   L level rms=%.0f |%-40s|\n", rms, bar);

    bool allZero = st.zeroL == st.frames && st.zeroR == st.frames;
    bool allOnes = st.onesL == st.frames && st.onesR == st.frames;
    if (allZero) Serial.println("   => NO DATA: both channels exactly 0. Mic not driving SD (power / SCK / WS / solder / SD wire).");
    else if (allOnes) Serial.println(pullup ? "   => SD floats high with pull-up: mic is NOT driving SD."
                                            : "   => SD stuck HIGH (short to 3V3 or floating).");
    else if (st.zeroL == st.frames) Serial.println("   => Data on RIGHT only: L/R pin is not tied to GND.");
    else Serial.println("   => Mic is producing data.");
  } else {
    Serial.println("   => no frames received");
  }
  resetWindow();
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  help();
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    switch (c) {
      case '1': micStart(); break;
      case '0': micStop(); break;
      case 'u': togglePullup(); break;
      case 'p': probePin(); break;
      case 'r': printRaw(); break;
      case 'h': case '?': help(); break;
      default: break; // ignore CR/LF and others
    }
  }
  if (micOn) capture();
  else delay(5);
}
