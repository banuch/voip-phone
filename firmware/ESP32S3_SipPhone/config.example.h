// Build-time defaults. Normally you leave the account fields empty and set
// everything over Bluetooth (provision.html); values saved over Bluetooth are
// kept in flash and override these.
//
// To bake settings into the firmware instead, copy this file to config.h
// (git-ignored) and fill them in. They are used until something is saved
// over Bluetooth, or again after a factory reset.
#pragma once

// ---- Wi-Fi (2.4 GHz) ----
#define WIFI_SSID          ""
#define WIFI_PASSWORD      ""

// ---- SIP account (Asterisk endpoint) ----
#define SIP_SERVER         ""               // IP or hostname of the SIP server
#define SIP_SERVER_PORT    5060
#define SIP_DOMAIN         ""               // empty = use SIP_SERVER
#define SIP_USER           "1001"           // extension / username
#define SIP_AUTH_USER      ""               // empty = use SIP_USER
#define SIP_PASSWORD       ""
#define SIP_EXPIRES        300              // registration lifetime, seconds
#define SIP_LOCAL_PORT     5060             // UDP port the ESP32 listens on for SIP
#define RTP_LOCAL_PORT     4000             // UDP port for call audio (RTP)

// ---- Firmware update over Wi-Fi (http://<phone-ip>/update) ----
#define OTA_PASSWORD       ""               // empty = updates off; else 8-64 chars

// ---- Call handling ----
#define AUTO_ANSWER_MS     1000             // -1 = answer manually only
#define ANSWER_BUTTON_PIN  0                // BOOT: press = answer / hang up

// ---- Audio hardware (build-time only; same wiring as ESP32S3_AudioWebTest) ----
#define I2S_BCLK_PIN       4                // INMP441 SCK + MAX98357A BCLK
#define I2S_WS_PIN         5                // INMP441 WS  + MAX98357A LRC
#define I2S_MIC_PIN        6                // INMP441 SD
#define I2S_SPEAKER_PIN    7                // MAX98357A DIN
#define MIC_GAIN           4                // 1..32
#define SPEAKER_VOLUME     60               // 0..100 %
