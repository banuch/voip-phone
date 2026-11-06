// Build-time defaults: config.h when present, otherwise config.example.h.
// Runtime settings come from flash (provisioned over Bluetooth); see settings.h.
#pragma once
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

// Added after the first config.h files were written, so default them here.
#ifndef OTA_PASSWORD
#define OTA_PASSWORD ""
#endif
