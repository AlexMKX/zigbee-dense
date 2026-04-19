#!/usr/bin/env bash
# Upload a .gbl to SLZB-06MU and trigger a router flash.
#
# Usage:  scripts/flash-slzb06mu.sh <path-to.gbl>
# Env:    SLZB_HOST (default 192.168.88.144)
#         SLZB_FW_CH (default 1 == ZB_ROUTER)
set -euo pipefail

GBL="${1:?usage: $0 <path-to.gbl>}"
HOST="${SLZB_HOST:-192.168.88.144}"
FWCH="${SLZB_FW_CH:-1}"

if [[ ! -f "$GBL" ]]; then
    echo "error: file not found: $GBL" >&2
    exit 1
fi

echo "== Upload $GBL -> http://${HOST}/fw.bin =="
curl -fsS -F "update=@${GBL}" \
    "http://${HOST}/fileUpload?customName=/fw.bin" >/dev/null

echo "== Trigger flash (fwCh=${FWCH}) =="
curl -fsS \
    "http://${HOST}/api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=${FWCH}" \
    >/dev/null

echo "== Waiting for device to come back (max 5 minutes) =="
# In coordMode=2 (Zigbee Router standalone), SLZB-OS does not query the EFR32
# via EZSP so zb_type and zb_version remain 0 / -1. Success criterion is simply
# that the device responds to HTTP and coord_mode is still 2 (router).
for i in {1..60}; do
    sleep 5
    if info=$(curl -fsS --max-time 3 "http://${HOST}/ha_info" 2>/dev/null); then
        coord_mode=$(echo "$info" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Info"]["coord_mode"])' 2>/dev/null || echo "?")
        if [[ "$coord_mode" == "2" ]]; then
            echo "== Back online (coord_mode=2 / Zigbee Router) =="
            echo "$info" | python3 -m json.tool
            exit 0
        fi
        echo "  ... up but coord_mode=${coord_mode} ($((i*5))s)"
    else
        echo "  ... still rebooting ($((i*5))s)"
    fi
done
echo "!! Timeout waiting for device to come back online" >&2
exit 1
