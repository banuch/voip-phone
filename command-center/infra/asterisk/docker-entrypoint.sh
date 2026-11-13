#!/bin/sh
# Render ${VAR} placeholders in the config templates, then run Asterisk in the foreground.
set -eu
for f in /etc/asterisk/templates/*.conf; do
  envsubst < "$f" > "/etc/asterisk/$(basename "$f")"
done
# The read-only softphone ARI user (last section of ari.conf) only exists when it has a password.
if [ -z "${ARI_PHONE_PASSWORD:-}" ]; then
  sed -i '/^\[phone\]/,$d' /etc/asterisk/ari.conf
fi
exec asterisk -f -vvv
