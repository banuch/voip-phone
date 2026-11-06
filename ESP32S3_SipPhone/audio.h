// Full-duplex I2S audio + G.711 RTP, running in its own FreeRTOS task.
#pragma once
#include <Arduino.h>
#include <IPAddress.h>

namespace audio {

struct Stats {
  bool active;            // RTP session open
  uint32_t txPackets;
  uint32_t rxPackets;
  uint32_t rxLost;        // sequence gaps
  uint32_t rxLate;        // late / duplicate packets dropped
  uint32_t underruns;     // jitter buffer ran dry
  uint32_t bufferedMs;    // current jitter buffer depth
  int micPeak;            // 0..32767 over the last frame
};

bool begin();                                                    // start I2S + audio task
void setRinging(bool on);                                        // local ring tone on speaker
void startCall(IPAddress ip, uint16_t port, uint8_t payloadType); // open or retarget RTP
void stopCall();
void setVolume(int percent);
int volume();
void setMicGain(int gain);
int micGain();
Stats stats();

}  // namespace audio
