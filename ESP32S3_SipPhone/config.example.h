// Copy this file to config.h (same folder) and fill in your values.
// config.h is git-ignored so passwords stay out of the repository.
#pragma once

// ---- Wi-Fi (2.4 GHz) ----
#define WIFI_SSID          "your-ssid"
#define WIFI_PASSWORD      "your-wifi-password"

// ---- SIP account (Asterisk endpoint) ----
#define SIP_SERVER         "192.168.1.10"   // IP or hostname of the SIP server
#define SIP_SERVER_PORT    5060
#define SIP_DOMAIN         ""               // empty = use SIP_SERVER
#define SIP_USER           "1001"           // extension / username
#define SIP_AUTH_USER      ""               // empty = use SIP_USER
#define SIP_PASSWORD       "change-me"
#define SIP_EXPIRES        300              // registration lifetime, seconds
#define SIP_LOCAL_PORT     5060             // UDP port the ESP32 listens on for SIP
#define RTP_LOCAL_PORT     4000             // UDP port for call audio (RTP)

// ---- Call handling ----
// Auto-answer delay after an INVITE arrives, in ms. Set to -1 to disable
// (then answer with the BOOT button or by sending 'a' on Serial).
#define AUTO_ANSWER_MS     1000
#define ANSWER_BUTTON_PIN  0                // BOOT button: answer / hang up

// ---- Audio hardware (same wiring as ESP32S3_AudioWebTest) ----
#define I2S_BCLK_PIN       4                // INMP441 SCK + MAX98357A BCLK
#define I2S_WS_PIN         5                // INMP441 WS  + MAX98357A LRC
#define I2S_MIC_PIN        6                // INMP441 SD
#define I2S_SPEAKER_PIN    7                // MAX98357A DIN
#define MIC_GAIN           4                // 1..32; raise if the far end hears you quietly
#define SPEAKER_VOLUME     60               // 0..100 %; keep low to limit echo
