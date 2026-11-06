// Picks config.h when present, otherwise the placeholder example config.
#pragma once
#if __has_include("config.h")
#include "config.h"
#else
#warning "config.h not found: using config.example.h placeholders. Copy it to config.h and edit."
#include "config.example.h"
#endif
