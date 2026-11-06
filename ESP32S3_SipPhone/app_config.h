// Build-time defaults: config.h when present, otherwise config.example.h.
// Runtime settings come from flash (provisioned over Bluetooth); see settings.h.
#pragma once
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif
