#!/usr/bin/env bash
# Enable the Wintek Softphone "directory server" on a native Asterisk + nginx host.
#
#   - Asterisk HTTP/ARI listens on 127.0.0.1:8088 only (not reachable from outside)
#   - adds a READ-ONLY ARI user "phone" with a random password
#   - nginx publishes only  GET https://<host>/ari/endpoints  over the existing TLS site
#   - backs up every file it touches; rolls nginx back if its config test fails
#
# Run as root on the server:
#   bash setup_ari_directory.sh
# or from Windows:
#   ssh root@SERVER 'bash -s' < setup_ari_directory.sh
#
# Safe to run again: steps that are already done are skipped.
set -euo pipefail

AST_DIR=${AST_DIR:-/etc/asterisk}
SITE=${SITE:-/etc/nginx/sites-available/attendance}
BACKUP_DIR=${BACKUP_DIR:-/root}
TS=$(date +%Y%m%d%H%M%S)

[ -f "$AST_DIR/http.conf" ] && [ -f "$AST_DIR/ari.conf" ] || { echo "Asterisk config not found in $AST_DIR" >&2; exit 1; }
[ -f "$SITE" ] || { echo "nginx site not found: $SITE (set SITE=...)" >&2; exit 1; }

cp -p "$AST_DIR/http.conf" "$AST_DIR/http.conf.bak-$TS"
cp -p "$AST_DIR/ari.conf" "$AST_DIR/ari.conf.bak-$TS"
SITE_BAK="$BACKUP_DIR/$(basename "$SITE").bak-$TS"
cp -p "$SITE" "$SITE_BAK"
echo "Backups: $AST_DIR/{http,ari}.conf.bak-$TS  $SITE_BAK"

# 1. Asterisk built-in HTTP server, localhost only ------------------------------
H="$AST_DIR/http.conf"
grep -q '^\[general\]' "$H" || printf '[general]\n' >> "$H"
grep -qE '^\s*enabled\s*=' "$H"  || sed -i '/^\[general\]/a enabled=yes' "$H"
grep -qE '^\s*bindaddr\s*=' "$H" || sed -i '/^\[general\]/a bindaddr=127.0.0.1' "$H"
grep -qE '^\s*bindport\s*=' "$H" || sed -i '/^\[general\]/a bindport=8088' "$H"
sed -i -E 's/^\s*enabled\s*=.*/enabled=yes/' "$H"

# 2. Read-only ARI user ------------------------------------------------------------
A="$AST_DIR/ari.conf"
PW=""
if grep -q '^\[phone\]' "$A"; then
  echo "ARI user 'phone' already exists – password left unchanged."
else
  PW=$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-28)
  printf '\n; Read-only user for Wintek Softphone (lists online extensions). Added %s\n[phone]\ntype = user\nread_only = yes\npassword = %s\n' \
    "$TS" "$PW" >> "$A"
  chmod 640 "$A"
  chown asterisk:asterisk "$A" 2>/dev/null || true
fi

# 3. nginx: publish only GET /ari/endpoints over HTTPS ----------------------------
if grep -q 'location = /ari/endpoints' "$SITE"; then
  echo "nginx already publishes /ari/endpoints."
else
  BLK='    # Wintek Softphone directory: read-only list of online extensions (Asterisk ARI).
    location = /ari/endpoints {
        limit_except GET { deny all; }
        proxy_pass         http://127.0.0.1:8088;
        proxy_set_header   Host $host;
        proxy_read_timeout 10s;
    }
'
  TMP=$(mktemp)
  # insert before the first "location / {" of the TLS server block
  BLK="$BLK" awk 'done == 0 && /^[[:space:]]*location \/ \{/ { printf "%s\n", ENVIRON["BLK"]; done = 1 } { print }' \
    "$SITE" > "$TMP"
  grep -q 'location = /ari/endpoints' "$TMP" || { rm -f "$TMP"; echo "Could not find 'location / {' in $SITE" >&2; exit 1; }
  cat "$TMP" > "$SITE"
  rm -f "$TMP"
fi
if ! nginx -t; then
  echo "nginx config test FAILED – restoring $SITE" >&2
  cat "$SITE_BAK" > "$SITE"
  exit 1
fi
systemctl reload nginx

# 4. Apply to Asterisk (does not drop calls) ---------------------------------------
asterisk -rx 'module reload http' >/dev/null
asterisk -rx 'module reload res_ari.so' >/dev/null
sleep 1

# 5. Verify --------------------------------------------------------------------------
echo
asterisk -rx 'ari show users'
if [ -n "$PW" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -u "phone:$PW" http://127.0.0.1:8088/ari/endpoints || true)
  echo "Local ARI check: HTTP $CODE (200 = OK)"
fi
HOST=$(awk '/server_name/ { gsub(";", "", $2); print $2; exit }' "$SITE")
echo
echo "=================================================================="
echo " Softphone ▸ Phone ▸ Directory server (ARI):"
echo "   URL:      https://$HOST"
echo "   Username: phone"
if [ -n "$PW" ]; then
  echo "   Password: $PW"
  echo "   (shown once – it is also stored in $A)"
else
  echo "   Password: see [phone] in $A"
fi
echo "=================================================================="
