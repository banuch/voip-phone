#!/usr/bin/env bash
# End-to-end smoke test against a running API (SIP_DRIVER=simulated) with seed data.
set -euo pipefail
B=${API:-http://localhost:3000}/api/v1
PW=${SEED_PASSWORD:-Wintek#Demo2026}
J='Content-Type: application/json'
py() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }
tok() { curl -sf -H "$J" -d "{\"username\":\"$1\",\"password\":\"$PW\"}" "$B/auth/login" | py 'print(d["accessToken"])'; }
OP=$(tok operator1); AU=$(tok auditor)
get() { curl -s -H "Authorization: Bearer $1" "$B/$2"; }
post() { curl -s -H "Authorization: Bearer $1" -H "$J" -X "${4:-POST}" -d "$3" "$B/$2"; }

post "$OP" operators/me/heartbeat '{"sipRegistered":true}' >/dev/null
post "$OP" operators/me/presence '{"availability":"AVAILABLE"}' PUT | py 'print("presence:", d["effective"])'
read -r ATM TOTAL < <(get "$OP" "atms?mine=true&registration=REGISTERED&status=ACTIVE&inCall=false&pageSize=1" | py 'print(d["items"][0]["id"], d["total"])')
echo "ATMs operator1 may call (online): $TOTAL"
RID="smoke-$(date +%s%N)"
R=$(post "$OP" calls/initiate "{\"atmId\":\"$ATM\",\"requestId\":\"$RID\"}")
CID=$(echo "$R" | py 'print(d["call"]["id"])'); echo "$R" | py 'print("initiate:", d["call"]["state"], d["dial"]["target"])'
post "$OP" calls/initiate "{\"atmId\":\"$ATM\",\"requestId\":\"$RID\"}" | py "print('idempotent replay same call:', d['call']['id']=='$CID')"
post "$OP" calls/initiate "{\"atmId\":\"$ATM\",\"requestId\":\"$RID-b\"}" | py 'print("second call:", d["code"])'
for t in 0.15 0.6 2.2; do sleep $t; get "$OP" "calls/$CID/status" | py 'print("  state:", d["state"])'; done
post "$OP" "calls/$CID/hangup" '{}' >/dev/null; sleep 0.5
get "$OP" "calls/$CID/status" | py 'print("final:", d["state"], "| hangupBy", d["hangupBy"], "| timeline:", " -> ".join(e["to"] for e in d["events"]))'
post "$AU" calls/initiate "{\"atmId\":\"$ATM\",\"requestId\":\"$RID-c\"}" | py 'print("auditor initiate:", d["code"], d.get("missing"))'
get "$AU" "audit?pageSize=5" | py '[print("  audit:", i["action"], i["outcome"], i["actorUsername"]) for i in d["items"]]'
