#!/bin/sh
# Render ${VAR} placeholders in the config templates, then run Asterisk in the foreground.
set -eu
for f in /etc/asterisk/templates/*.conf; do
  envsubst < "$f" > "/etc/asterisk/$(basename "$f")"
done
exec asterisk -f -vvv
