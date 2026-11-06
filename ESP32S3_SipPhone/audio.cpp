// Audio path:
//   INMP441 -> I2S RX 16 kHz/32-bit -> DC block + gain -> halfband decimate to 8 kHz
//           -> G.711 encode -> RTP (20 ms, 160 samples) -> network
//   network -> RTP -> jitter buffer -> G.711 decode -> interpolate to 16 kHz
//           -> volume -> I2S TX -> MAX98357A
// One I2S port drives both directions on shared BCLK/WS, so mic reads and
// speaker writes are paced by the same clock.
#include "audio.h"
#include "app_config.h"
#include "settings.h"
#include <ESP_I2S.h>
#include <WiFiUdp.h>
#include <math.h>

namespace {

constexpr uint32_t I2S_RATE = 16000;
constexpr size_t FRAME16 = 320;  // 20 ms at 16 kHz
constexpr size_t FRAME8 = 160;   // 20 ms at 8 kHz
constexpr size_t RTP_HDR = 12;

I2SClass i2s;
WiFiUDP rtp;
portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;

// Commands from the SIP side (loop task) to the audio task.
struct Pending {
  bool has = false;
  bool start = false;
  IPAddress ip;
  uint16_t port = 0;
  uint8_t pt = 0;
} pending;
volatile bool ringing = false;
volatile int volumePct = 60;  // set from settings in audio::begin()
volatile int gain = 4;
audio::Stats st = {};

// ---- State owned by the audio task ----
bool active = false;
IPAddress remoteIp;
uint16_t remotePort = 0;
uint8_t payloadType = 0;
uint16_t txSeq = 0;
uint32_t txTs = 0, ssrc = 0;
bool marker = false;
bool haveRxSeq = false;
uint16_t expectedSeq = 0;

int32_t i2sIn[FRAME16 * 2];
int32_t i2sOut[FRAME16 * 2];
int16_t dsBuf[FRAME16 + 6];  // 6 samples of decimator history + frame
int16_t usBuf[FRAME8 + 3];   // 3 samples of interpolator history + frame
int16_t mic8[FRAME8];
int16_t spk16[FRAME16];
uint8_t txPkt[RTP_HDR + FRAME8];
uint8_t rxPkt[1500];
int32_t dcX = 0, dcY = 0;
float tonePhase = 0;
uint32_t frameCount = 0;

// ---- Jitter buffer (8 kHz samples) ----
constexpr size_t JB_CAP = 4096;            // 512 ms
constexpr size_t JB_PREFILL = FRAME8 * 3;  // start playout at 60 ms
constexpr size_t JB_HIGH = FRAME8 * 15;    // >300 ms: drift, trim
constexpr size_t JB_TRIM = FRAME8 * 4;
int16_t jb[JB_CAP];
size_t jbRead = 0, jbCount = 0;
bool jbPlaying = false;

void jbReset() { jbRead = jbCount = 0; jbPlaying = false; }
void jbDrop(size_t n) { n = min(n, jbCount); jbRead = (jbRead + n) % JB_CAP; jbCount -= n; }
void jbPush(int16_t s) {
  if (jbCount == JB_CAP) jbDrop(1);
  jb[(jbRead + jbCount) % JB_CAP] = s;
  jbCount++;
}
void jbPop(int16_t *out, size_t n) {
  if (!jbPlaying && jbCount >= JB_PREFILL) jbPlaying = true;
  if (jbPlaying && jbCount > JB_HIGH) jbDrop(jbCount - JB_TRIM);
  if (!jbPlaying) { memset(out, 0, n * 2); return; }
  size_t got = min(n, jbCount);
  for (size_t i = 0; i < got; i++) out[i] = jb[(jbRead + i) % JB_CAP];
  jbDrop(got);
  if (got < n) {  // underrun: pad and re-buffer
    memset(out + got, 0, (n - got) * 2);
    jbPlaying = false;
    st.underruns++;
  }
}

// ---- G.711 (ITU-T, classic Sun reference algorithm) ----
uint8_t linearToUlaw(int16_t pcm) {
  const int BIAS = 0x84, CLIP = 32635;
  int v = pcm, sign = (v >> 8) & 0x80;
  if (sign) v = -v;
  if (v > CLIP) v = CLIP;
  v += BIAS;
  int exponent = 7;
  for (int mask = 0x4000; !(v & mask) && exponent > 0; mask >>= 1) exponent--;
  int mantissa = (v >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa);
}
int16_t ulawToLinear(uint8_t u) {
  u = ~u;
  int t = ((u & 0x0F) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return (u & 0x80) ? (0x84 - t) : (t - 0x84);
}
uint8_t linearToAlaw(int16_t pcm) {
  static const int segEnd[8] = {0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF};
  int v = pcm >> 3, mask;
  if (v >= 0) mask = 0xD5;
  else { mask = 0x55; v = -v - 1; }
  int seg = 0;
  while (seg < 8 && v > segEnd[seg]) seg++;
  if (seg >= 8) return 0x7F ^ mask;
  int aval = seg << 4;
  aval |= (seg < 2 ? (v >> 1) : (v >> seg)) & 0x0F;
  return aval ^ mask;
}
int16_t alawToLinear(uint8_t a) {
  a ^= 0x55;
  int t = (a & 0x0F) << 4;
  int seg = (a & 0x70) >> 4;
  if (seg == 0) t += 8;
  else if (seg == 1) t += 0x108;
  else { t += 0x108; t <<= seg - 1; }
  return (a & 0x80) ? t : -t;
}

inline int16_t clamp16(int32_t v) { return v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
inline void put16(uint8_t *p, uint16_t v) { p[0] = v >> 8; p[1] = v; }
inline void put32(uint8_t *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }

// ---- Microphone -> RTP ----
void processMic() {
  int g = gain, peak = 0;
  int16_t *x = dsBuf + 6;
  for (size_t i = 0; i < FRAME16; i++) {
    int32_t s = i2sIn[2 * i] >> 8;           // left slot, INMP441 24-bit sample
    int32_t y = s - dcX + dcY - (dcY >> 8);  // one-pole DC blocker
    dcX = s; dcY = y;
    x[i] = clamp16((y * g) >> 8);
    peak = max(peak, abs(int(x[i])));
  }
  st.micPeak = peak;
  // Halfband low-pass {-1,0,9,16,9,0,-1}/32, keep every second sample.
  for (size_t k = 0; k < FRAME8; k++) {
    const int16_t *a = dsBuf + 2 * k;
    mic8[k] = clamp16((-a[0] + 9 * a[2] + 16 * a[3] + 9 * a[4] - a[6]) / 32);
  }
  memmove(dsBuf, dsBuf + FRAME16, 6 * sizeof(int16_t));
}

void sendRtp() {
  if (!active || !remotePort || remoteIp == IPAddress(0, 0, 0, 0)) return;
  txPkt[0] = 0x80;
  txPkt[1] = payloadType | (marker ? 0x80 : 0);
  put16(txPkt + 2, txSeq);
  put32(txPkt + 4, txTs);
  put32(txPkt + 8, ssrc);
  for (size_t i = 0; i < FRAME8; i++)
    txPkt[RTP_HDR + i] = payloadType == 8 ? linearToAlaw(mic8[i]) : linearToUlaw(mic8[i]);
  if (rtp.beginPacket(remoteIp, remotePort) && rtp.write(txPkt, sizeof(txPkt)) == sizeof(txPkt) && rtp.endPacket()) {
    st.txPackets++;
    marker = false;
  }
  txSeq++;
  txTs += FRAME8;
}

// ---- RTP -> jitter buffer ----
void handleRtp(const uint8_t *p, int len) {
  if (len < (int)RTP_HDR || (p[0] >> 6) != 2) return;
  uint8_t pt = p[1] & 0x7F;
  if (pt != payloadType) return;  // ignores telephone-event, comfort noise, etc.
  int off = RTP_HDR + (p[0] & 0x0F) * 4;
  if (p[0] & 0x10) {  // header extension
    if (len < off + 4) return;
    off += 4 + ((p[off + 2] << 8) | p[off + 3]) * 4;
  }
  int end = len;
  if (p[0] & 0x20) end -= p[len - 1];  // padding
  if (end <= off) return;

  uint16_t seq = (p[2] << 8) | p[3];
  if (haveRxSeq) {
    int16_t diff = int16_t(seq - expectedSeq);
    if (diff < 0) { st.rxLate++; return; }
    if (diff > 0) {
      st.rxLost += diff;
      // Conceal a short gap with silence so timing stays aligned.
      if (diff <= 3) for (int i = 0; i < diff * (int)FRAME8; i++) jbPush(0);
    }
  }
  haveRxSeq = true;
  expectedSeq = seq + 1;
  st.rxPackets++;
  for (int i = off; i < end; i++) jbPush(payloadType == 8 ? alawToLinear(p[i]) : ulawToLinear(p[i]));
}

// ---- Speaker ----
void producePlayout() {
  if (active) {
    int16_t *s = usBuf + 3;
    jbPop(s, FRAME8);
    // 4-point halfband interpolation to 16 kHz (one sample of delay).
    for (size_t n = 0; n < FRAME8; n++) {
      const int16_t *a = usBuf + n;
      spk16[2 * n] = a[1];
      spk16[2 * n + 1] = clamp16((-a[0] + 9 * a[1] + 9 * a[2] - a[3]) / 16);
    }
    memmove(usBuf, usBuf + FRAME8, 3 * sizeof(int16_t));
  } else if (ringing && (frameCount % 200) < 50) {  // 1 s on, 3 s off
    const float step = 2.0f * float(M_PI) * 425.0f / I2S_RATE;
    for (size_t i = 0; i < FRAME16; i++) {
      spk16[i] = int16_t(6000.0f * sinf(tonePhase));
      tonePhase += step;
      if (tonePhase > 2.0f * float(M_PI)) tonePhase -= 2.0f * float(M_PI);
    }
  } else {
    memset(spk16, 0, sizeof(spk16));
  }
  int vol = volumePct;
  for (size_t i = 0; i < FRAME16; i++) {
    int32_t v = (int32_t(spk16[i]) * vol / 100) << 16;
    i2sOut[2 * i] = v;
    i2sOut[2 * i + 1] = v;
  }
}

void applyPending() {
  Pending p;
  portENTER_CRITICAL(&lock);
  p = pending;
  pending.has = false;
  portEXIT_CRITICAL(&lock);
  if (!p.has) return;
  if (p.start) {
    if (!active) {
      if (!rtp.begin(settings::cfg.rtpLocalPort)) { Serial.println("[RTP] cannot open UDP port"); return; }
      txSeq = esp_random(); txTs = esp_random(); ssrc = esp_random();
      haveRxSeq = false; marker = true;
      jbReset();
      memset(usBuf, 0, sizeof(usBuf));
      st.txPackets = st.rxPackets = st.rxLost = st.rxLate = st.underruns = 0;
      active = true;
    }
    remoteIp = p.ip; remotePort = p.port; payloadType = p.pt;
    Serial.printf("[RTP] -> %s:%u %s\n", remoteIp.toString().c_str(), remotePort, payloadType == 8 ? "PCMA" : "PCMU");
  } else if (active) {
    rtp.stop();
    active = false;
    Serial.println("[RTP] stopped");
  }
}

void audioTask(void *) {
  for (;;) {
    applyPending();
    size_t n = i2s.readBytes((char *)i2sIn, sizeof(i2sIn));  // blocks ~20 ms
    if (n != sizeof(i2sIn)) memset((uint8_t *)i2sIn + n, 0, sizeof(i2sIn) - n);
    processMic();
    if (active) {
      sendRtp();
      int len;
      while ((len = rtp.parsePacket()) > 0) handleRtp(rxPkt, rtp.read(rxPkt, sizeof(rxPkt)));
    }
    producePlayout();
    i2s.write((uint8_t *)i2sOut, sizeof(i2sOut));
    st.active = active;
    st.bufferedMs = jbCount / 8;
    frameCount++;
  }
}

}  // namespace

namespace audio {

bool begin() {
  volumePct = constrain(settings::cfg.speakerVolume, 0, 100);
  gain = constrain(settings::cfg.micGain, 1, 32);
  i2s.setPins(I2S_BCLK_PIN, I2S_WS_PIN, I2S_SPEAKER_PIN, I2S_MIC_PIN);
  if (!i2s.begin(I2S_MODE_STD, I2S_RATE, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO)) return false;
  i2s.setTimeout(200);
  // Prime the speaker queue with 40 ms of silence so playout has headroom.
  memset(i2sOut, 0, sizeof(i2sOut));
  i2s.write((uint8_t *)i2sOut, sizeof(i2sOut));
  i2s.write((uint8_t *)i2sOut, sizeof(i2sOut));
  return xTaskCreatePinnedToCore(audioTask, "audio", 6144, nullptr, 5, nullptr, 1) == pdPASS;
}

void setRinging(bool on) { ringing = on; }

void startCall(IPAddress ip, uint16_t port, uint8_t pt) {
  portENTER_CRITICAL(&lock);
  pending.has = true; pending.start = true;
  pending.ip = ip; pending.port = port; pending.pt = pt;
  portEXIT_CRITICAL(&lock);
}

void stopCall() {
  portENTER_CRITICAL(&lock);
  pending.has = true; pending.start = false;
  portEXIT_CRITICAL(&lock);
}

void setVolume(int percent) { volumePct = constrain(percent, 0, 100); }
int volume() { return volumePct; }
void setMicGain(int g) { gain = constrain(g, 1, 32); }
int micGain() { return gain; }
Stats stats() { return st; }

}  // namespace audio
