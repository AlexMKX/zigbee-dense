# Zigbee-Dense Debug Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime-toggleable debug logging to `smlight_slzb06mu_dense_zigbee_router` firmware: UART stream with timestamped lines + manufacturer-specific ZCL cluster 0xFC00 on endpoint 1 for remote control via Z2M.

**Architecture:** All changes land in `AlexMKX/zigbee-dense` as patches applied to upstream `Nerivec/silabs-firmware-builder@sisdk-2025.12.x` at CI time. No fork of upstream. Two independent channels: OUT = EFR32 USART → (ESP32 TCP bridge when available) → terminal; CTRL = ZCL cluster 0xFC00 (manufacturer 0x1002) exposing debug_groups bitmap, heartbeat interval, and RO health attrs (uptime, route fill %, neighbor count, free buffer bytes, last incoming src). Z2M external converter maps the cluster to MQTT-friendly expose fields.

**Tech Stack:** Silicon Labs EmberZNet 9.0.1 (Simplicity SDK 2025.12.2), C (EFR32MG21), ZAP for ZCL config generation, Python build tool `build_project.py` (runs `slc-cli` under the hood), GitHub Actions CI, Docker image `ghcr.io/alexmkx/zigbee-dense:<hash>`, Bash for deploy helper, Z2M `zigbee-herdsman-converters` for external converter.

**Spec:** `docs/superpowers/specs/2026-04-19-zigbee-dense-debug-logging-design.md`

---

## File Structure

Files created or modified in this plan:

- **Create:** `patches/0002-router-add-debug-cluster-0xFC00.patch`
  - Adds cluster 0xFC00 (manufacturer 0x1002) on endpoint 1 of `src/zigbee_router/config/zcl/zcl_config.zap`.
  - Adds a companion C file `src/zigbee_router/debug_cluster.c` (and header `debug_cluster.h`) that owns the runtime-mirror state + hooks.
  - Adds `src/zigbee_router/debug_cluster.c` to `src/zigbee_router/zigbee_router.slcp` `source` list.
- **Create:** `patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch`
  - Modifies `src/zigbee_router/app.c` to call wrapper + heartbeat init + stack-status hook.
- **Modify:** `manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`
  - Add explicit `c_defines` pins for debug group compile-time enables.
- **Create:** `scripts/flash-slzb06mu.sh`
  - One-shot upload + trigger + wait helper.
- **Create:** `z2m/slzb06mu_dense_router.js`
  - Z2M external converter.
- **Modify:** `README.md`
  - Add "Debug logging" section documenting flash-slzb06mu.sh, Z2M converter install, MQTT examples, known UART-read procedure.

**Key interfaces locked in Task 1:**

The `debug_cluster.c` module owns all runtime state and exposes:

```c
// debug_cluster.h
#include <stdint.h>
#include <stdbool.h>

enum dbg_group {
  DBG_STACK = 0, DBG_CORE = 1, DBG_APP = 2, DBG_ZCL = 3,
  DBG_ROUTE = 4, DBG_APS_IN = 5, DBG_HB = 6,
};
#define DBG_ALL_MASK 0x007Fu

// Call once from app init.
void dbg_init(void);

// Print if (groups_mask & (1<<group)) is set. Adds "[uptime.ms] [GROUP] " prefix.
void dbg_print(enum dbg_group group, const char *fmt, ...);

// Hooks called from app.c (thin adapters, defined in debug_cluster.c).
void dbg_hook_stack_status(uint8_t status);                    // sl_zigbee_af_stack_status_cb
void dbg_hook_incoming_message(uint16_t src_short, uint16_t profile_id,
                               uint16_t cluster_id, uint16_t payload_len); // sl_zigbee_af_pre_message_received_cb
void dbg_hook_post_attribute_change(uint8_t endpoint, uint16_t cluster,
                                    uint16_t attr_id);         // sl_zigbee_af_post_attribute_change_cb
```

Everything else (heartbeat event, mirror globals, clamping logic) is `static` inside `debug_cluster.c`. `app.c` touches only the public header.

---

## Preflight

- [ ] **Step 0.1: Confirm clean working tree on main**

Run: `cd /home/alex/Projects/zigbee/zigbee-dense && git status`
Expected: `On branch main`, `nothing to commit, working tree clean`.
Fail action: stash or commit pending work before starting.

- [ ] **Step 0.2: Confirm a fresh upstream clone exists and mirrors what CI sees**

Run:
```bash
rm -rf /tmp/zd-upstream
git clone --depth 1 --branch sisdk-2025.12.x \
  https://github.com/Nerivec/silabs-firmware-builder /tmp/zd-upstream
cd /tmp/zd-upstream && git rev-parse HEAD
```
Expected: clone succeeds, prints a 40-hex SHA. This is the tree our patches will apply against.

- [ ] **Step 0.3: Verify existing patch 0001 still applies**

Run:
```bash
cd /tmp/zd-upstream
git apply --check \
  /home/alex/Projects/zigbee/zigbee-dense/patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch
```
Expected: silent exit 0.
Fail action: upstream has moved; rebase patch 0001 before adding new ones.

- [ ] **Step 0.4: Apply patch 0001 so Tasks 1-5 work against the exact tree CI will build**

Run:
```bash
cd /tmp/zd-upstream
git apply \
  /home/alex/Projects/zigbee/zigbee-dense/patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch
git -C . diff --stat
```
Expected: `tools/build_project.py | 12 +++++++---` line shown.

---

## Task 1: Bootstrap `debug_cluster.{h,c}` with no-op stubs

**Purpose:** lock in the public interface *before* touching ZAP or app.c. Produces a patch that adds two files to upstream and registers them in the slcp — nothing functional yet, but the firmware builds clean.

**Files:**
- Create (via patch): upstream `src/zigbee_router/debug_cluster.h`
- Create (via patch): upstream `src/zigbee_router/debug_cluster.c`
- Modify (via patch): upstream `src/zigbee_router/zigbee_router.slcp`
- Create: `patches/0002-router-add-debug-cluster-0xFC00.patch` (will grow over Tasks 1-4)

- [ ] **Step 1.1: Prepare a staging dir to author the patch**

Run:
```bash
cd /tmp/zd-upstream
git checkout -b dbg-cluster-staging
```

- [ ] **Step 1.2: Write `debug_cluster.h`**

File: `/tmp/zd-upstream/src/zigbee_router/debug_cluster.h`

```c
/***************************************************************************//**
 * @file debug_cluster.h
 * @brief Runtime debug logging + manufacturer cluster 0xFC00 glue for
 *        the zigbee_router application.
 *
 * See docs/superpowers/specs/2026-04-19-zigbee-dense-debug-logging-design.md
 * in the AlexMKX/zigbee-dense repo for the full design.
 ******************************************************************************/
#ifndef DEBUG_CLUSTER_H
#define DEBUG_CLUSTER_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

enum dbg_group {
  DBG_STACK  = 0,
  DBG_CORE   = 1,
  DBG_APP    = 2,
  DBG_ZCL    = 3,
  DBG_ROUTE  = 4,
  DBG_APS_IN = 5,
  DBG_HB     = 6,
};

#define DBG_ALL_MASK  0x007Fu

/** One-shot init. Must be called from sl_zigbee_af_main_init_cb. */
void dbg_init(void);

/** Print one line if the group is enabled. Prefix: "[uptime_s.ms] [TAG] ". */
void dbg_print(enum dbg_group group, const char *fmt, ...);

/* Hooks — thin adapters called from app.c. All are no-ops until Task 3. */
void dbg_hook_stack_status(uint8_t status);
void dbg_hook_incoming_message(uint16_t src_short,
                               uint16_t profile_id,
                               uint16_t cluster_id,
                               uint16_t payload_len);
void dbg_hook_post_attribute_change(uint8_t endpoint,
                                    uint16_t cluster,
                                    uint16_t attr_id);

#ifdef __cplusplus
}
#endif
#endif /* DEBUG_CLUSTER_H */
```

- [ ] **Step 1.3: Write `debug_cluster.c` (stubs only)**

File: `/tmp/zd-upstream/src/zigbee_router/debug_cluster.c`

```c
/***************************************************************************//**
 * @file debug_cluster.c
 * @brief Implementation stubs. Functional body lands in Tasks 2-4.
 ******************************************************************************/
#include "debug_cluster.h"

void dbg_init(void) { /* filled in Task 3 */ }

void dbg_print(enum dbg_group group, const char *fmt, ...)
{
  (void)group; (void)fmt;
}

void dbg_hook_stack_status(uint8_t status) { (void)status; }

void dbg_hook_incoming_message(uint16_t src_short,
                               uint16_t profile_id,
                               uint16_t cluster_id,
                               uint16_t payload_len)
{
  (void)src_short; (void)profile_id; (void)cluster_id; (void)payload_len;
}

void dbg_hook_post_attribute_change(uint8_t endpoint,
                                    uint16_t cluster,
                                    uint16_t attr_id)
{
  (void)endpoint; (void)cluster; (void)attr_id;
}
```

- [ ] **Step 1.4: Register both files in `zigbee_router.slcp`**

Find in `/tmp/zd-upstream/src/zigbee_router/zigbee_router.slcp` the `source:` list (near the top). It currently contains:

```yaml
source:
  - path: app.c
  - path: main.c
```

Edit it to:

```yaml
source:
  - path: app.c
  - path: main.c
  - path: debug_cluster.c
```

And find the `include:` block and append an entry for the header:

```yaml
include:
  - path: .
    file_list:
      - path: debug_cluster.h
```

(The exact indentation and whether `include:` already exists must be matched to the surrounding yaml — grep first with `grep -n '^include:\|^source:' zigbee_router.slcp` to locate positions.)

- [ ] **Step 1.5: Verify the staging build still succeeds locally (smoke)**

Skipped — local build unverified, CI is the source of truth. We verify by running CI after Step 1.7.

- [ ] **Step 1.6: Generate the patch file**

Run:
```bash
cd /tmp/zd-upstream
git add src/zigbee_router/debug_cluster.h \
        src/zigbee_router/debug_cluster.c \
        src/zigbee_router/zigbee_router.slcp
git -c user.name=zigbee-dense -c user.email=build@local \
    commit -m "router: add debug_cluster.{h,c} stubs + register in slcp"
git format-patch -1 HEAD \
  -o /home/alex/Projects/zigbee/zigbee-dense/patches/
# Rename to 0002-*
cd /home/alex/Projects/zigbee/zigbee-dense/patches/
mv 0001-router-add-debug-cluster-*.patch 0002-router-add-debug-cluster-0xFC00.patch
```
Expected: new file `patches/0002-router-add-debug-cluster-0xFC00.patch` exists. The existing `0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch` is **not** overwritten (format-patch numbers from 1 but we rename).

- [ ] **Step 1.7: Commit the new patch and trigger CI**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add patches/0002-router-add-debug-cluster-0xFC00.patch
git commit -m "patch(router): add debug_cluster.{h,c} stubs"
git push origin main
gh workflow run build.yaml -R AlexMKX/zigbee-dense
gh run watch -R AlexMKX/zigbee-dense
```
Expected: CI run completes **green**. Release contains a `.gbl` of approximately the same size as before (debug_cluster.c is pure stubs; <200 B cost expected).

If the build fails on `debug_cluster.c` not found: fix the slcp `source:` block (Step 1.4) and re-push.

- [ ] **Step 1.8: Sanity-check release asset**

Run:
```bash
mkdir -p /tmp/slzb06mu-gbl/task1
gh release list -R AlexMKX/zigbee-dense -L 1
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
gh release download "$TAG" -R AlexMKX/zigbee-dense \
    -p 'smlight_slzb06mu_dense_zigbee_router_*.gbl' \
    -D /tmp/slzb06mu-gbl/task1/
ls -lh /tmp/slzb06mu-gbl/task1/
```
Expected: one `.gbl` file, size between 200 KiB and 300 KiB.

---

## Task 2: Add `flash-slzb06mu.sh` and flash the Task 1 build

**Purpose:** verify that we can close the build→flash→verify loop with a no-op patch before adding functional complexity.

**Files:**
- Create: `scripts/flash-slzb06mu.sh`

- [ ] **Step 2.1: Write the flash helper**

File: `/home/alex/Projects/zigbee/zigbee-dense/scripts/flash-slzb06mu.sh`

```bash
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
for i in {1..60}; do
    sleep 5
    if info=$(curl -fsS --max-time 3 "http://${HOST}/ha_info" 2>/dev/null); then
        zb_type=$(echo "$info" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Info"]["zb_type"])' 2>/dev/null || echo "?")
        if [[ "$zb_type" == "1" ]]; then
            echo "== Back online as ZB_ROUTER =="
            echo "$info" | python3 -m json.tool
            exit 0
        fi
        echo "  ... up but zb_type=${zb_type} ($((i*5))s)"
    else
        echo "  ... still rebooting ($((i*5))s)"
    fi
done
echo "!! Timeout waiting for device to report zb_type=1" >&2
exit 1
```

- [ ] **Step 2.2: Make it executable and commit**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
chmod +x scripts/flash-slzb06mu.sh
git add scripts/flash-slzb06mu.sh
git commit -m "scripts: add flash-slzb06mu.sh (upload + trigger + wait)"
git push origin main
```

- [ ] **Step 2.3: Flash the Task 1 build and verify zb_type=1**

Run:
```bash
GBL=$(ls /tmp/slzb06mu-gbl/task1/smlight_slzb06mu_dense_zigbee_router_*.gbl | head -1)
./scripts/flash-slzb06mu.sh "$GBL"
```
Expected: final line `"zb_type": 1`. The device reports `zb_type=1` (ZB_ROUTER), meaning our firmware (not bootloader, not coordinator) is running.

If `zb_type != 1`: do NOT continue. Check `ha_info.model` — if it's now `SLZB-06MU` again, you accidentally triggered `fwCh=2`. Revert via:
```bash
SLZB_FW_CH=1 ./scripts/flash-slzb06mu.sh "$GBL"
```

- [ ] **Step 2.4: Verify Z2M still sees the router online**

Run:
```bash
ssh root@hassio.h.xxl.cx mosquitto_sub -h core-mosquitto \
  -t 'zigbee2mqtt/bridge/devices' -C 1 \
  | python3 -c '
import json, sys
for d in json.load(sys.stdin):
    if d.get("type") == "Router" and "SLZB" in (d.get("model_id") or ""):
        print(d["ieee_address"], d.get("model_id"), "supported=", d.get("supported"))
'
```
Expected: IEEE `0x385c040001a7dd93` (or the current dense-router EUI64), `model_id` starts with `SLZB-06M`, `supported=True`.

---

## Task 3: Fill in `debug_cluster.c` — wrapper, uptime, hook bodies

**Purpose:** implement the UART-facing half without touching ZAP yet. After this task, enabling any group at compile time would produce timestamped log lines on USART. ZCL cluster itself lands in Task 4.

**Files:**
- Edit (in the staging dir `/tmp/zd-upstream`): `src/zigbee_router/debug_cluster.c`
- Regenerate: `patches/0002-router-add-debug-cluster-0xFC00.patch`

- [ ] **Step 3.1: Prepare staging (re-apply, re-checkout the staging branch)**

Run:
```bash
cd /tmp/zd-upstream
git checkout dbg-cluster-staging
```

- [ ] **Step 3.2: Replace `debug_cluster.c` with functional body**

File: `/tmp/zd-upstream/src/zigbee_router/debug_cluster.c`

```c
/***************************************************************************//**
 * @file debug_cluster.c
 ******************************************************************************/
#include "debug_cluster.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "app/framework/include/af.h"
#include "app/framework/plugin/debug-print/sl_zigbee_debug_print.h"
#include "stack/include/stack-info.h"
#include "buffer_manager/buffer-management.h"
#include "sl_sleeptimer.h"

/* Compile-time defaults. Mirrors are RAM-only (no NVM3). */
#define DBG_GROUPS_DEFAULT         0x001Fu   /* stack|core|app|zcl, no route/aps_in/hb */
#define DBG_HB_INTERVAL_DEFAULT    60u
#define DBG_HB_INTERVAL_MIN        5u
#define DBG_HB_INTERVAL_MAX        3600u

#define DBG_ENDPOINT               1
#define DBG_CLUSTER                0xFC00u
#define DBG_MFG_CODE               0x1002u

#define DBG_ATTR_GROUPS            0x0000u
#define DBG_ATTR_HB_INTERVAL       0x0001u
#define DBG_ATTR_UPTIME_S          0x0010u
#define DBG_ATTR_ROUTE_FILL_PCT    0x0011u
#define DBG_ATTR_NEIGHBOR_COUNT    0x0012u
#define DBG_ATTR_BUFFER_FREE_B     0x0013u
#define DBG_ATTR_LAST_INCOMING_SRC 0x0014u

static uint16_t s_dbg_groups  = DBG_GROUPS_DEFAULT;
static uint16_t s_hb_s        = DBG_HB_INTERVAL_DEFAULT;
static uint16_t s_last_src    = 0xFFFFu;
static sl_zigbee_af_event_t s_heartbeat_event;

static const char *const s_group_tag[] = {
  [DBG_STACK]  = "STACK",
  [DBG_CORE]   = "CORE",
  [DBG_APP]    = "APP",
  [DBG_ZCL]    = "ZCL",
  [DBG_ROUTE]  = "ROUTE",
  [DBG_APS_IN] = "APS",
  [DBG_HB]     = "HB",
};

static uint32_t uptime_ms(void)
{
  uint64_t ticks = sl_sleeptimer_get_tick_count64();
  uint32_t freq  = sl_sleeptimer_get_timer_frequency();
  if (freq == 0) return 0;
  return (uint32_t)((ticks * 1000u) / freq);
}

/* Count route-table entries whose status is not UNUSED. */
static uint8_t route_table_fill_percent(void)
{
  uint8_t size = sl_zigbee_get_route_table_size();
  if (size == 0) return 0;
  uint8_t used = 0;
  for (uint8_t i = 0; i < size; i++) {
    sl_zigbee_route_table_entry_t e;
    if (sl_zigbee_get_route_table_entry(i, &e) == SL_STATUS_OK) {
      /* Silabs marks UNUSED with a sentinel destination 0xFFFF. */
      if (e.destination != 0xFFFFu) used++;
    }
  }
  return (uint8_t)((uint16_t)used * 100u / size);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

void dbg_print(enum dbg_group group, const char *fmt, ...)
{
  if ((s_dbg_groups & (1u << group)) == 0u) return;

  uint32_t ms = uptime_ms();
  uint32_t sec = ms / 1000u;
  uint32_t rem = ms % 1000u;

  /* Header, then formatted body. One call per line to the SDK printer. */
  char buf[192];
  int n = snprintf(buf, sizeof(buf), "[%lu.%03lu] [%s] ",
                   (unsigned long)sec, (unsigned long)rem, s_group_tag[group]);
  if (n < 0 || n >= (int)sizeof(buf)) return;

  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf + n, sizeof(buf) - (size_t)n, fmt, ap);
  va_end(ap);

  /* Route through the APP print-type; text tag in buf already identifies the group. */
  extern void sli_zigbee_debug_print(uint32_t group_type, bool new_line, const char *format, ...);
  sli_zigbee_debug_print((uint32_t)SL_ZIGBEE_DEBUG_PRINT_TYPE_APP, true, "%s", buf);
}

/* ------------------------------------------------------------------ */
/* Heartbeat                                                          */
/* ------------------------------------------------------------------ */

static void heartbeat_handler(sl_zigbee_af_event_t *event);

static void heartbeat_update_attrs(void)
{
  uint32_t up   = uptime_ms() / 1000u;
  uint8_t  fill = route_table_fill_percent();
  uint8_t  nbr  = sl_zigbee_neighbor_count();
  uint16_t buf_free = sli_legacy_buffer_manager_buffer_bytes_remaining();

  (void)sl_zigbee_af_write_manufacturer_specific_server_attribute(
      DBG_ENDPOINT, DBG_CLUSTER, DBG_ATTR_UPTIME_S, DBG_MFG_CODE,
      (uint8_t *)&up, ZCL_INT32U_ATTRIBUTE_TYPE);
  (void)sl_zigbee_af_write_manufacturer_specific_server_attribute(
      DBG_ENDPOINT, DBG_CLUSTER, DBG_ATTR_ROUTE_FILL_PCT, DBG_MFG_CODE,
      (uint8_t *)&fill, ZCL_INT8U_ATTRIBUTE_TYPE);
  (void)sl_zigbee_af_write_manufacturer_specific_server_attribute(
      DBG_ENDPOINT, DBG_CLUSTER, DBG_ATTR_NEIGHBOR_COUNT, DBG_MFG_CODE,
      (uint8_t *)&nbr, ZCL_INT8U_ATTRIBUTE_TYPE);
  (void)sl_zigbee_af_write_manufacturer_specific_server_attribute(
      DBG_ENDPOINT, DBG_CLUSTER, DBG_ATTR_BUFFER_FREE_B, DBG_MFG_CODE,
      (uint8_t *)&buf_free, ZCL_INT16U_ATTRIBUTE_TYPE);
  (void)sl_zigbee_af_write_manufacturer_specific_server_attribute(
      DBG_ENDPOINT, DBG_CLUSTER, DBG_ATTR_LAST_INCOMING_SRC, DBG_MFG_CODE,
      (uint8_t *)&s_last_src, ZCL_INT16U_ATTRIBUTE_TYPE);

  dbg_print(DBG_HB,
            "up=%lus nbr=%u rtFill=%u%% bufFree=%uB lastSrc=0x%04X",
            (unsigned long)up, (unsigned)nbr, (unsigned)fill,
            (unsigned)buf_free, (unsigned)s_last_src);
}

static void heartbeat_handler(sl_zigbee_af_event_t *event)
{
  heartbeat_update_attrs();
  if (s_hb_s > 0u) {
    sl_zigbee_af_event_set_delay_ms(event, (uint32_t)s_hb_s * 1000u);
  }
}

/* ------------------------------------------------------------------ */
/* Hook bodies                                                        */
/* ------------------------------------------------------------------ */

void dbg_init(void)
{
  sl_zigbee_af_event_init(&s_heartbeat_event, heartbeat_handler);
  if (s_hb_s > 0u) {
    sl_zigbee_af_event_set_delay_ms(&s_heartbeat_event,
                                    (uint32_t)s_hb_s * 1000u);
  }
  dbg_print(DBG_APP, "debug_cluster ready, groups=0x%04X hb=%us",
            (unsigned)s_dbg_groups, (unsigned)s_hb_s);
}

void dbg_hook_stack_status(uint8_t status)
{
  const char *name;
  switch (status) {
    case 0x90u: name = "NETWORK_UP";        break;
    case 0x91u: name = "NETWORK_DOWN";      break;
    case 0x92u: name = "JOIN_FAILED";       break;
    case 0x93u: name = "MOVE_FAILED";       break;
    case 0x94u: name = "CANT_JOIN";         break;
    case 0x95u: name = "NODE_ID_CHANGED";   break;
    case 0x96u: name = "PAN_ID_CHANGED";    break;
    case 0x97u: name = "CHANNEL_CHANGED";   break;
    case 0x98u: name = "NO_BEACONS";        break;
    case 0xA2u: name = "NETWORK_OPENED";    break;
    case 0xA3u: name = "NETWORK_CLOSED";    break;
    default:    name = "STATUS"; break;
  }
  dbg_print(DBG_ROUTE, "stack_status: %s (0x%02X)", name, (unsigned)status);
}

void dbg_hook_incoming_message(uint16_t src_short,
                               uint16_t profile_id,
                               uint16_t cluster_id,
                               uint16_t payload_len)
{
  s_last_src = src_short;
  dbg_print(DBG_APS_IN,
            "APS in: src=0x%04X prof=0x%04X clus=0x%04X len=%u",
            (unsigned)src_short, (unsigned)profile_id,
            (unsigned)cluster_id, (unsigned)payload_len);
}

void dbg_hook_post_attribute_change(uint8_t endpoint,
                                    uint16_t cluster,
                                    uint16_t attr_id)
{
  if (endpoint != DBG_ENDPOINT || cluster != DBG_CLUSTER) return;

  if (attr_id == DBG_ATTR_GROUPS) {
    uint8_t buf[2]; uint16_t new_groups = 0;
    if (sl_zigbee_af_read_manufacturer_specific_server_attribute(
            endpoint, cluster, attr_id, DBG_MFG_CODE,
            buf, sizeof(buf)) == SL_ZIGBEE_ZCL_STATUS_SUCCESS) {
      new_groups = (uint16_t)buf[0] | ((uint16_t)buf[1] << 8);
      new_groups &= DBG_ALL_MASK;
      s_dbg_groups = new_groups;
      dbg_print(DBG_APP, "debug_groups -> 0x%04X", (unsigned)new_groups);
    }
  } else if (attr_id == DBG_ATTR_HB_INTERVAL) {
    uint8_t buf[2]; uint16_t v = 0;
    if (sl_zigbee_af_read_manufacturer_specific_server_attribute(
            endpoint, cluster, attr_id, DBG_MFG_CODE,
            buf, sizeof(buf)) == SL_ZIGBEE_ZCL_STATUS_SUCCESS) {
      v = (uint16_t)buf[0] | ((uint16_t)buf[1] << 8);
      if (v > 0u && v < DBG_HB_INTERVAL_MIN)       v = DBG_HB_INTERVAL_MIN;
      else if (v > DBG_HB_INTERVAL_MAX)            v = DBG_HB_INTERVAL_MAX;
      /* Write the clamped value back so Z2M reads the effective value. */
      (void)sl_zigbee_af_write_manufacturer_specific_server_attribute(
          endpoint, cluster, attr_id, DBG_MFG_CODE,
          (uint8_t *)&v, ZCL_INT16U_ATTRIBUTE_TYPE);
      s_hb_s = v;
      if (v == 0u) {
        sl_zigbee_af_event_set_inactive(&s_heartbeat_event);
      } else {
        sl_zigbee_af_event_set_delay_ms(&s_heartbeat_event, (uint32_t)v * 1000u);
      }
      dbg_print(DBG_APP, "heartbeat_interval_s -> %us", (unsigned)v);
    }
  }
}
```

- [ ] **Step 3.3: Rebuild the patch**

Run:
```bash
cd /tmp/zd-upstream
git add src/zigbee_router/debug_cluster.c
git commit --amend --no-edit
# regenerate patch, overwriting Task-1 version
git format-patch -1 HEAD -o /home/alex/Projects/zigbee/zigbee-dense/patches/
cd /home/alex/Projects/zigbee/zigbee-dense/patches/
# the new file comes out as 0001-*; rename back to 0002-*
rm -f 0002-router-add-debug-cluster-0xFC00.patch
mv 0001-router-add-debug-cluster-*.patch 0002-router-add-debug-cluster-0xFC00.patch
```

- [ ] **Step 3.4: Push and build in CI**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add patches/0002-router-add-debug-cluster-0xFC00.patch
git commit -m "patch(router): fill debug_cluster.c — wrapper, heartbeat, hooks"
git push origin main
gh workflow run build.yaml -R AlexMKX/zigbee-dense
gh run watch -R AlexMKX/zigbee-dense
```
Expected: CI green. If a symbol (e.g. `sli_legacy_buffer_manager_buffer_bytes_remaining`) is not linked in a router build, the failure appears as an ld undefined-reference.

Fix path if `buffer-management.h` is not reachable:
- Change the include to `"buffer_manager/buffer-management.h"` (try) or as a last resort comment the line and return a constant 0 for `buf_free` — document it as a known gap in README's Debug Logging section.

- [ ] **Step 3.5: Download new `.gbl` to `task3/`**

Run:
```bash
mkdir -p /tmp/slzb06mu-gbl/task3
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
gh release download "$TAG" -R AlexMKX/zigbee-dense \
    -p 'smlight_slzb06mu_dense_zigbee_router_*.gbl' \
    -D /tmp/slzb06mu-gbl/task3/
```

**No flash yet** — Task 3 firmware has no ZCL cluster declared in ZAP, so writes to `dbg_hook_post_attribute_change` from the coordinator's side would target a non-existent attribute store entry. Calls from the cluster are fine because we never read without the ZAP. We flash in Task 5 after the cluster is declared.

---

## Task 4: Add ZCL cluster 0xFC00 to ZAP + regenerate patch

**Purpose:** declare the seven attributes in `zcl_config.zap` so the attribute store is allocated, and Z2M can see the cluster.

**Files:**
- Edit (in staging dir): upstream `src/zigbee_router/config/zcl/zcl_config.zap`
- Regenerate: `patches/0002-router-add-debug-cluster-0xFC00.patch`

- [ ] **Step 4.1: Resume staging**

Run:
```bash
cd /tmp/zd-upstream
git checkout dbg-cluster-staging
git status
```
Expected: clean.

- [ ] **Step 4.2: Add cluster 0xFC00 to endpoint 1 in `zcl_config.zap`**

`zcl_config.zap` is JSON. Locate the entry under `endpointTypes -> [id=1 "Centralized"] -> clusters`. Currently ends like:
```json
{ "code": 37, "name": "Keep-Alive", "side": "server", ... }
```
Append an eighth cluster object:

```json
{
  "name": "Manufacturer Specific",
  "code": 64512,
  "mfgCode": 4098,
  "define": "SLZB_DEBUG_CLUSTER",
  "side": "server",
  "enabled": 1,
  "attributes": [
    { "name": "debug_groups",           "code": 0,    "mfgCode": 4098,
      "side": "server", "type": "bitmap16", "included": 1, "storageOption": "RAM",
      "singleton": 1, "bounded": 0, "defaultValue": "0x001F",
      "reportable": 0, "minInterval": 0, "maxInterval": 0, "reportableChange": 0 },
    { "name": "heartbeat_interval_s",   "code": 1,    "mfgCode": 4098,
      "side": "server", "type": "int16u",  "included": 1, "storageOption": "RAM",
      "singleton": 1, "bounded": 0, "defaultValue": "60",
      "reportable": 0, "minInterval": 0, "maxInterval": 0, "reportableChange": 0 },
    { "name": "uptime_s",               "code": 16,   "mfgCode": 4098,
      "side": "server", "type": "int32u",  "included": 1, "storageOption": "RAM",
      "singleton": 1, "bounded": 0, "defaultValue": "0",
      "reportable": 0, "minInterval": 0, "maxInterval": 0, "reportableChange": 0 },
    { "name": "route_table_fill_pct",   "code": 17,   "mfgCode": 4098,
      "side": "server", "type": "int8u",   "included": 1, "storageOption": "RAM",
      "singleton": 1, "bounded": 0, "defaultValue": "0",
      "reportable": 0, "minInterval": 0, "maxInterval": 0, "reportableChange": 0 },
    { "name": "neighbor_count",         "code": 18,   "mfgCode": 4098,
      "side": "server", "type": "int8u",   "included": 1, "storageOption": "RAM",
      "singleton": 1, "bounded": 0, "defaultValue": "0",
      "reportable": 0, "minInterval": 0, "maxInterval": 0, "reportableChange": 0 },
    { "name": "buffer_free_bytes",      "code": 19,   "mfgCode": 4098,
      "side": "server", "type": "int16u",  "included": 1, "storageOption": "RAM",
      "singleton": 1, "bounded": 0, "defaultValue": "0",
      "reportable": 0, "minInterval": 0, "maxInterval": 0, "reportableChange": 0 },
    { "name": "last_incoming_src",      "code": 20,   "mfgCode": 4098,
      "side": "server", "type": "int16u",  "included": 1, "storageOption": "RAM",
      "singleton": 1, "bounded": 0, "defaultValue": "0xFFFF",
      "reportable": 0, "minInterval": 0, "maxInterval": 0, "reportableChange": 0 }
  ],
  "commands": []
}
```

Verify JSON validity:
```bash
python3 -m json.tool /tmp/zd-upstream/src/zigbee_router/config/zcl/zcl_config.zap > /dev/null
```
Expected: no output, exit 0.

- [ ] **Step 4.3: Amend the staging commit and regenerate patch**

Run:
```bash
cd /tmp/zd-upstream
git add src/zigbee_router/config/zcl/zcl_config.zap
git commit --amend --no-edit
git format-patch -1 HEAD -o /home/alex/Projects/zigbee/zigbee-dense/patches/
cd /home/alex/Projects/zigbee/zigbee-dense/patches/
rm -f 0002-router-add-debug-cluster-0xFC00.patch
mv 0001-router-add-debug-cluster-*.patch 0002-router-add-debug-cluster-0xFC00.patch
```

- [ ] **Step 4.4: Push + trigger CI**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add patches/0002-router-add-debug-cluster-0xFC00.patch
git commit -m "patch(router): declare cluster 0xFC00 in zcl_config.zap"
git push origin main
gh workflow run build.yaml -R AlexMKX/zigbee-dense
gh run watch -R AlexMKX/zigbee-dense
```

Expected: CI green. The `build.yaml` job re-runs ZAP code generation as part of the SDK build, producing a new `zigbee_af_gen.c` that contains the cluster.

Common failure: ZAP syntax error (missing comma, wrong type name). Fix, re-amend, re-push.

- [ ] **Step 4.5: Download `.gbl` to `task4/`**

Run:
```bash
mkdir -p /tmp/slzb06mu-gbl/task4
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
gh release download "$TAG" -R AlexMKX/zigbee-dense \
    -p 'smlight_slzb06mu_dense_zigbee_router_*.gbl' \
    -D /tmp/slzb06mu-gbl/task4/
ls -lh /tmp/slzb06mu-gbl/task4/
```

---

## Task 5: Wire hooks in `app.c` + flash + verify cluster visible

**Purpose:** make the firmware actually call `dbg_init` + hooks, flash, and verify the cluster appears in Z2M's device list.

**Files:**
- Create: `patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch`

- [ ] **Step 5.1: Staging branch for 0003**

Run:
```bash
cd /tmp/zd-upstream
git checkout sisdk-2025.12.x
git apply /home/alex/Projects/zigbee/zigbee-dense/patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch
git apply /home/alex/Projects/zigbee/zigbee-dense/patches/0002-router-add-debug-cluster-0xFC00.patch
git checkout -b app-c-hooks-staging
git -c user.name=zd -c user.email=build@local commit -am "WIP: base for app.c hooks patch" --allow-empty
```

- [ ] **Step 5.2: Edit `src/zigbee_router/app.c`**

In `/tmp/zd-upstream/src/zigbee_router/app.c`, apply these four edits:

1. After the existing `#include "app/framework/include/af.h"` block (around the top of the file), add:

```c
#include "debug_cluster.h"
```

2. Find `sl_zigbee_af_main_init_cb` (or equivalent init callback — grep the file for `_main_init_cb\|_init_cb`). Inside its body, add as the last line:

```c
  dbg_init();
```

If there is no suitable init callback in `app.c`, add one at the bottom of the file:

```c
void sl_zigbee_af_main_init_cb(void)
{
  dbg_init();
}
```

3. Find `sl_zigbee_af_stack_status_cb` (grep: `stack_status_cb`). Add at the top of its body, before any existing logic:

```c
  dbg_hook_stack_status((uint8_t)status);
```

If the callback does not exist, add at the bottom of `app.c`:

```c
bool sl_zigbee_af_stack_status_cb(sl_status_t status)
{
  dbg_hook_stack_status((uint8_t)status);
  return false;  /* do not mark the event consumed */
}
```

4. Find `sl_zigbee_af_pre_message_received_cb` (grep: `pre_message_received_cb`). If it exists, add to the top of the body:

```c
  dbg_hook_incoming_message(incomingMessage->source,
                            incomingMessage->apsFrame->profileId,
                            incomingMessage->apsFrame->clusterId,
                            incomingMessage->msgLen);
```

If it does not exist, add at the bottom of `app.c`:

```c
bool sl_zigbee_af_pre_message_received_cb(sl_zigbee_af_incoming_message_t *incomingMessage)
{
  dbg_hook_incoming_message(incomingMessage->source,
                            incomingMessage->apsFrame->profileId,
                            incomingMessage->apsFrame->clusterId,
                            incomingMessage->msgLen);
  return false;
}
```

5. Find `sl_zigbee_af_post_attribute_change_cb` (grep: `post_attribute_change_cb`). If exists, add to the top of the body:

```c
  dbg_hook_post_attribute_change(endpoint, clusterId, attributeId);
```

If it does not exist, add at the bottom of `app.c`:

```c
void sl_zigbee_af_post_attribute_change_cb(uint8_t endpoint,
                                           sl_zigbee_af_cluster_id_t clusterId,
                                           sl_zigbee_af_attribute_id_t attributeId,
                                           uint8_t mask,
                                           uint16_t manufacturerCode,
                                           uint8_t type,
                                           uint8_t size,
                                           uint8_t *value)
{
  (void)mask; (void)manufacturerCode; (void)type; (void)size; (void)value;
  dbg_hook_post_attribute_change(endpoint, clusterId, attributeId);
}
```

Note: exact signatures must match the SDK headers. If grep shows one already declared with a different signature, match that signature — do not break the build.

- [ ] **Step 5.3: Build patch 0003**

Run:
```bash
cd /tmp/zd-upstream
git add src/zigbee_router/app.c
git -c user.name=zd -c user.email=build@local commit --amend --no-edit
git format-patch -1 HEAD -o /home/alex/Projects/zigbee/zigbee-dense/patches/
cd /home/alex/Projects/zigbee/zigbee-dense/patches/
mv 0001-WIP-base-*.patch 0003-router-debug-wrapper-and-hooks-in-app-c.patch 2>/dev/null || \
mv "$(ls -t 0001-*.patch | head -1)" 0003-router-debug-wrapper-and-hooks-in-app-c.patch
```

Verify only our edits are in it:
```bash
grep '^+++ \|^--- ' /home/alex/Projects/zigbee/zigbee-dense/patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch
```
Expected: only `a/src/zigbee_router/app.c` and `b/src/zigbee_router/app.c`. No other files.

- [ ] **Step 5.4: Push + CI**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch
git commit -m "patch(router): wire dbg hooks in app.c"
git push origin main
gh workflow run build.yaml -R AlexMKX/zigbee-dense
gh run watch -R AlexMKX/zigbee-dense
```

- [ ] **Step 5.5: Download and flash**

Run:
```bash
mkdir -p /tmp/slzb06mu-gbl/task5
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
gh release download "$TAG" -R AlexMKX/zigbee-dense \
    -p 'smlight_slzb06mu_dense_zigbee_router_*.gbl' \
    -D /tmp/slzb06mu-gbl/task5/
GBL=$(ls /tmp/slzb06mu-gbl/task5/*.gbl | head -1)
./scripts/flash-slzb06mu.sh "$GBL"
```
Expected: `zb_type: 1`.

- [ ] **Step 5.6: Verify cluster 0xFC00 is visible in Z2M**

Run:
```bash
IEEE="0x385c040001a7dd93"   # or the router's actual IEEE from previous sessions
ssh root@hassio.h.xxl.cx mosquitto_pub -h core-mosquitto \
  -t 'zigbee2mqtt/bridge/request/device/interview' \
  -m "{\"id\":\"$IEEE\"}"
sleep 30   # interview takes ~20s
ssh root@hassio.h.xxl.cx mosquitto_sub -h core-mosquitto \
  -t 'zigbee2mqtt/bridge/devices' -C 1 \
  | python3 -c "
import json, sys
for d in json.load(sys.stdin):
    if d.get('ieee_address') == '$IEEE':
        ep1 = d.get('endpoints', {}).get('1', {})
        inp = ep1.get('clusters', {}).get('input', [])
        print('input clusters on ep1:', inp)
        print('has 64512 =', 64512 in inp or 'manuSpecificClusterXFC00' in inp)
"
```
Expected: cluster `64512` (decimal for 0xFC00) appears in the input clusters list.

If not: check Z2M log for interview errors. If interview times out, bind/rejoin may be needed — reboot the router via:
```bash
curl "http://192.168.88.144/api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=1"
```
and wait for it to come back.

---

## Task 6: Manifest `c_defines` pins

**Purpose:** make the manifest explicit about which debug groups are compile-time enabled so that an upstream default change can never silently disable our logs.

**Files:**
- Modify: `manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`

- [ ] **Step 6.1: Add pins to the manifest**

Edit `/home/alex/Projects/zigbee/zigbee-dense/manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`. Append to the `c_defines:` block:

```yaml
c_defines:
  # ...existing keys unchanged...
  # === Debug print compile-time pins (see docs/.../debug-logging spec) ===
  SL_ZIGBEE_DEBUG_STACK_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_STACK_GROUP_RUNTIME_DEFAULT: 1
  SL_ZIGBEE_DEBUG_CORE_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_CORE_GROUP_RUNTIME_DEFAULT: 1
  SL_ZIGBEE_DEBUG_APP_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_APP_GROUP_RUNTIME_DEFAULT: 1
  SL_ZIGBEE_DEBUG_ZCL_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_ZCL_GROUP_RUNTIME_DEFAULT: 1
```

- [ ] **Step 6.2: Commit, push, build, flash**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
git commit -m "manifest: pin debug-print compile-time enables"
git push origin main
gh workflow run build.yaml -R AlexMKX/zigbee-dense
gh run watch -R AlexMKX/zigbee-dense

mkdir -p /tmp/slzb06mu-gbl/task6
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
gh release download "$TAG" -R AlexMKX/zigbee-dense \
    -p 'smlight_slzb06mu_dense_zigbee_router_*.gbl' \
    -D /tmp/slzb06mu-gbl/task6/
./scripts/flash-slzb06mu.sh /tmp/slzb06mu-gbl/task6/smlight_slzb06mu_dense_zigbee_router_*.gbl
```
Expected: `zb_type: 1` again.

---

## Task 7: Z2M external converter

**Purpose:** expose the seven attributes as friendly MQTT fields. Fingerprint by presence of cluster 0xFC00 — not by `modelID`.

**Files:**
- Create: `z2m/slzb06mu_dense_router.js`

- [ ] **Step 7.1: Write the converter**

File: `/home/alex/Projects/zigbee/zigbee-dense/z2m/slzb06mu_dense_router.js`

```javascript
/*
 * Z2M external converter for AlexMKX/zigbee-dense smlight_slzb06mu_dense_zigbee_router firmware.
 * Spec: docs/superpowers/specs/2026-04-19-zigbee-dense-debug-logging-design.md
 *
 * Install:
 *   cp z2m/slzb06mu_dense_router.js <z2m-data>/external_converters/
 *   # then in configuration.yaml:
 *   # external_converters:
 *   #   - slzb06mu_dense_router.js
 */
const { Zcl } = require('zigbee-herdsman');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const e = exposes.presence;  /* may be 'exposes' in older z2m — see install notes below */
const ea = exposes.access;

const CLUSTER = 0xFC00;
const MFG = 0x1002;

const DBG_BITS = {
  stack: 1 << 0, core: 1 << 1, app: 1 << 2, zcl: 1 << 3,
  route: 1 << 4, aps_in: 1 << 5, heartbeat: 1 << 6,
};

const fzDebug = {
  cluster: CLUSTER.toString(),
  type: ['attributeReport', 'readResponse'],
  convert: (model, msg, publish, options, meta) => {
    const out = {};
    const d = msg.data;
    if (d.hasOwnProperty(0x0000)) {
      const g = d[0x0000];
      for (const [k, b] of Object.entries(DBG_BITS)) {
        out[`debug_${k}`] = (g & b) !== 0;
      }
      out.debug_groups_raw = g;
    }
    if (d.hasOwnProperty(0x0001)) out.heartbeat_interval_s = d[0x0001];
    if (d.hasOwnProperty(0x0010)) out.uptime_s = d[0x0010];
    if (d.hasOwnProperty(0x0011)) out.route_table_fill_pct = d[0x0011];
    if (d.hasOwnProperty(0x0012)) out.neighbor_count = d[0x0012];
    if (d.hasOwnProperty(0x0013)) out.buffer_free_bytes = d[0x0013];
    if (d.hasOwnProperty(0x0014)) out.last_incoming_src = d[0x0014];
    return out;
  },
};

const tzDebugBits = {
  key: Object.keys(DBG_BITS).map(k => `debug_${k}`),
  convertSet: async (entity, key, value, meta) => {
    const bit = DBG_BITS[key.replace(/^debug_/, '')];
    // Read current bitmap first, mutate the bit, write back.
    const cur = (await entity.read(CLUSTER, [0x0000], { manufacturerCode: MFG }))[0x0000] || 0;
    const next = value ? (cur | bit) : (cur & ~bit);
    await entity.write(CLUSTER, { 0x0000: { value: next, type: Zcl.DataType.bitmap16 } },
                       { manufacturerCode: MFG });
    const result = {};
    for (const [k, b] of Object.entries(DBG_BITS)) {
      result[`debug_${k}`] = (next & b) !== 0;
    }
    return { state: result };
  },
  convertGet: async (entity, key, meta) => {
    await entity.read(CLUSTER, [0x0000], { manufacturerCode: MFG });
  },
};

const tzHeartbeat = {
  key: ['heartbeat_interval_s'],
  convertSet: async (entity, key, value, meta) => {
    const v = Math.max(0, Math.min(3600, parseInt(value, 10)));
    await entity.write(CLUSTER, { 0x0001: { value: v, type: Zcl.DataType.uint16 } },
                       { manufacturerCode: MFG });
    return { state: { heartbeat_interval_s: v } };
  },
  convertGet: async (entity, key, meta) => {
    await entity.read(CLUSTER, [0x0001], { manufacturerCode: MFG });
  },
};

const tzRO = {
  key: ['uptime_s', 'route_table_fill_pct', 'neighbor_count',
        'buffer_free_bytes', 'last_incoming_src'],
  convertGet: async (entity, key, meta) => {
    const map = {
      uptime_s: 0x0010, route_table_fill_pct: 0x0011,
      neighbor_count: 0x0012, buffer_free_bytes: 0x0013,
      last_incoming_src: 0x0014,
    };
    await entity.read(CLUSTER, [map[key]], { manufacturerCode: MFG });
  },
};

module.exports = [{
  zigbeeModel: [],                  /* match by fingerprint, not model */
  fingerprint: [{
    modelID: undefined,
    endpoints: [{ ID: 1, inputClusters: [CLUSTER] }],
  }],
  model: 'SLZB-06MU-dense-router',
  vendor: 'AlexMKX',
  description: 'zigbee-dense optimized router firmware for SLZB-06MU',
  fromZigbee: [fzDebug],
  toZigbee: [tzDebugBits, tzHeartbeat, tzRO],
  exposes: [
    exposes.binary('debug_stack',    ea.ALL, true, false),
    exposes.binary('debug_core',     ea.ALL, true, false),
    exposes.binary('debug_app',      ea.ALL, true, false),
    exposes.binary('debug_zcl',      ea.ALL, true, false),
    exposes.binary('debug_route',    ea.ALL, true, false),
    exposes.binary('debug_aps_in',   ea.ALL, true, false),
    exposes.binary('debug_heartbeat',ea.ALL, true, false),
    exposes.numeric('heartbeat_interval_s', ea.ALL).withValueMin(0).withValueMax(3600).withUnit('s'),
    exposes.numeric('uptime_s',             ea.STATE_GET).withUnit('s'),
    exposes.numeric('route_table_fill_pct', ea.STATE_GET).withUnit('%'),
    exposes.numeric('neighbor_count',       ea.STATE_GET),
    exposes.numeric('buffer_free_bytes',    ea.STATE_GET),
    exposes.numeric('last_incoming_src',    ea.STATE_GET),
  ],
  configure: async (device, coordinatorEndpoint, logger) => {
    const ep = device.getEndpoint(1);
    await ep.read(CLUSTER, [0x0000, 0x0001, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014],
                  { manufacturerCode: MFG });
  },
}];
```

- [ ] **Step 7.2: Install converter into running Z2M and restart**

Run:
```bash
ssh root@hassio.h.xxl.cx cat > /mnt/data/supervisor/homeassistant/zigbee2mqtt/external_converters/slzb06mu_dense_router.js \
  < /home/alex/Projects/zigbee/zigbee-dense/z2m/slzb06mu_dense_router.js
```
(If the path on the HA host differs, use
`/home/alex/Projects/zigbee/45df7312_zigbee2mqtt/zigbee2mqtt/external_converters/` which is already the Z2M config dir referenced in Supermemory.)

Edit that Z2M's `configuration.yaml`:
```yaml
external_converters:
  - slzb06mu_dense_router.js
```

Restart Z2M:
```bash
ssh root@hassio.h.xxl.cx mosquitto_pub -h core-mosquitto \
  -t 'zigbee2mqtt/bridge/request/restart' -m '{}'
```
Wait ~10s.

- [ ] **Step 7.3: Verify the converter attaches**

Run:
```bash
IEEE="0x385c040001a7dd93"
ssh root@hassio.h.xxl.cx mosquitto_sub -h core-mosquitto \
  -t 'zigbee2mqtt/bridge/devices' -C 1 \
  | python3 -c "
import json, sys
for d in json.load(sys.stdin):
    if d.get('ieee_address') == '$IEEE':
        print('model:', d.get('model_id'))
        print('definition.model:', (d.get('definition') or {}).get('model'))
        print('supported:', d.get('supported'))
"
```
Expected: `definition.model: SLZB-06MU-dense-router`, `supported: True`.

- [ ] **Step 7.4: MQTT write round-trip**

Run:
```bash
FRIENDLY="0x385c040001a7dd93"   # or the device's friendly_name
ssh root@hassio.h.xxl.cx mosquitto_pub -h core-mosquitto \
  -t "zigbee2mqtt/${FRIENDLY}/set" \
  -m '{"debug_heartbeat": true, "heartbeat_interval_s": 5}'
sleep 3
ssh root@hassio.h.xxl.cx mosquitto_sub -h core-mosquitto \
  -t "zigbee2mqtt/${FRIENDLY}" -C 2
```
Expected: a message with `"debug_heartbeat": true` and `"heartbeat_interval_s": 5`.

- [ ] **Step 7.5: Verify uptime_s advances after a poll 10s later**

Run:
```bash
FRIENDLY="0x385c040001a7dd93"
ssh root@hassio.h.xxl.cx mosquitto_pub -h core-mosquitto \
  -t "zigbee2mqtt/${FRIENDLY}/get" -m '{"uptime_s":""}'
sleep 2
T1=$(ssh root@hassio.h.xxl.cx mosquitto_sub -h core-mosquitto \
     -t "zigbee2mqtt/${FRIENDLY}" -C 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["uptime_s"])')
sleep 10
ssh root@hassio.h.xxl.cx mosquitto_pub -h core-mosquitto \
  -t "zigbee2mqtt/${FRIENDLY}/get" -m '{"uptime_s":""}'
sleep 2
T2=$(ssh root@hassio.h.xxl.cx mosquitto_sub -h core-mosquitto \
     -t "zigbee2mqtt/${FRIENDLY}" -C 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["uptime_s"])')
echo "delta=$((T2-T1))"
```
Expected: `delta` is between 9 and 12 — the heartbeat task is actively updating the attribute store.

- [ ] **Step 7.6: Commit converter**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add z2m/slzb06mu_dense_router.js
git commit -m "z2m: external converter for SLZB-06MU-dense-router debug cluster 0xFC00"
git push origin main
```

---

## Task 8: UART read experiment (Component 5 of spec)

**Purpose:** determine empirically whether SLZB-OS exposes the EFR32 UART on TCP 6638 while our router firmware is running.

**Files:** none (documentation only; README updated in Task 9).

- [ ] **Step 8.1: Baseline — port closed**

Run:
```bash
nc -z -w 2 192.168.88.144 6638 && echo OPEN || echo CLOSED
curl -s http://192.168.88.144/ha_info | python3 -c 'import json,sys; d=json.load(sys.stdin); print("coord_mode=", d["Info"]["coord_mode"])'
```
Expected: `CLOSED`, `coord_mode= 2`. (Router mode.)

- [ ] **Step 8.2: Raise heartbeat rate so traffic is easy to spot**

Run:
```bash
FRIENDLY="0x385c040001a7dd93"
ssh root@hassio.h.xxl.cx mosquitto_pub -h core-mosquitto \
  -t "zigbee2mqtt/${FRIENDLY}/set" \
  -m '{"debug_heartbeat": true, "heartbeat_interval_s": 5}'
```

- [ ] **Step 8.3: Switch SLZB-OS coord_mode to Zigbee2MQTT/TCP (coord_mode=0) via UI**

Manual — open `http://192.168.88.144/` in a browser. In "Zigbee → Working mode", select "Zigbee2MQTT / TCP socket". Apply. Wait ~10 s.

- [ ] **Step 8.4: Probe port 6638 and capture stream**

Run:
```bash
nc -z -w 2 192.168.88.144 6638 && echo OPEN || echo CLOSED
if nc -z -w 2 192.168.88.144 6638; then
    timeout 30 nc 192.168.88.144 6638 > /tmp/slzb-uart.bin
    echo "=== captured $(wc -c < /tmp/slzb-uart.bin) bytes ==="
    # Show ASCII lines (filter control/binary):
    python3 -c "
import sys
data = open('/tmp/slzb-uart.bin','rb').read()
buf = bytearray()
for b in data:
    if b in (10, 13) or 32 <= b < 127:
        buf.append(b)
sys.stdout.buffer.write(bytes(buf))
"
fi
```

Expected outcomes and next actions:

- **Stream contains `[N.NNN] [HB] up=...` lines** → SUCCESS. Save a 60 s capture to `docs/debug-logs-sample.txt` in Task 9.
- **Stream is empty or only EZSP/ASH framing (0x7E...0x7E)** → FAILURE A. The EFR32 was reset on mode change and is being probed as an NCP. Our firmware may still be running (check `ha_info.zb_type`), but SLZB-OS is not forwarding its output when it believes the peer is not an NCP. Record outcome in README, move to fallback plan.
- **Port still closed** → FAILURE B. Some SLZB-OS versions gate the bridge differently. Try `coord_mode=1` (Zigbee2MQTT USB?) via the UI. If that also fails, document and escalate to Component 5 alt (Zigbee ring-buffer dump as a separate follow-up task).

- [ ] **Step 8.5: Switch coord_mode back to Zigbee Router**

Manual — SMLIGHT UI, set back to "Zigbee Router". Confirm:
```bash
curl -s http://192.168.88.144/ha_info | python3 -c 'import json,sys; print("coord_mode=", json.load(sys.stdin)["Info"]["coord_mode"])'
```
Expected: `coord_mode= 2`.

- [ ] **Step 8.6: Confirm Z2M sees the router again**

Run:
```bash
FRIENDLY="0x385c040001a7dd93"
ssh root@hassio.h.xxl.cx mosquitto_pub -h core-mosquitto \
  -t "zigbee2mqtt/${FRIENDLY}/get" -m '{"uptime_s":""}'
sleep 3
ssh root@hassio.h.xxl.cx mosquitto_sub -h core-mosquitto \
  -t "zigbee2mqtt/${FRIENDLY}" -C 1
```
Expected: response arrives within a few seconds. If not, the router may be rejoining — wait up to 2 minutes.

- [ ] **Step 8.7: Reset heartbeat to 60s so the mesh is not flooded**

Run:
```bash
FRIENDLY="0x385c040001a7dd93"
ssh root@hassio.h.xxl.cx mosquitto_pub -h core-mosquitto \
  -t "zigbee2mqtt/${FRIENDLY}/set" \
  -m '{"heartbeat_interval_s": 60}'
```

---

## Task 9: README documentation

**Purpose:** capture the flash + Z2M-converter + UART-read procedure for the next person (or next-me) who needs it.

**Files:**
- Modify: `README.md`

- [ ] **Step 9.1: Append Debug Logging section**

Edit `/home/alex/Projects/zigbee/zigbee-dense/README.md`. Append at the end:

````markdown
## Debug logging (SLZB-06MU dense router)

The `smlight_slzb06mu_dense_zigbee_router` firmware ships with a manufacturer-
specific ZCL cluster `0xFC00` (manufacturer `0x1002`) on endpoint 1 that
exposes runtime debug controls and stack health metrics.

### Attributes (cluster 0xFC00)

| ID     | Name                   | Type      | Access | Default |
|--------|------------------------|-----------|--------|---------|
| 0x0000 | debug_groups           | bitmap16  | RW     | 0x001F  |
| 0x0001 | heartbeat_interval_s   | uint16    | RW     | 60      |
| 0x0010 | uptime_s               | uint32    | RO     | —       |
| 0x0011 | route_table_fill_pct   | uint8     | RO     | —       |
| 0x0012 | neighbor_count         | uint8     | RO     | —       |
| 0x0013 | buffer_free_bytes      | uint16    | RO     | —       |
| 0x0014 | last_incoming_src      | uint16    | RO     | 0xFFFF  |

`debug_groups` bits: 0=stack 1=core 2=app 3=zcl 4=route 5=aps_in 6=heartbeat.

Values are in RAM only — they reset to defaults on every power-up.

### Z2M external converter install

```bash
cp z2m/slzb06mu_dense_router.js <z2m-data>/external_converters/
# then in configuration.yaml:
#   external_converters:
#     - slzb06mu_dense_router.js
# and restart z2m.
```

Example MQTT commands:

```bash
# Enable heartbeat + APS trace, set 10s heartbeat
mosquitto_pub -h core-mosquitto \
  -t "zigbee2mqtt/<router>/set" \
  -m '{"debug_heartbeat": true, "debug_aps_in": true, "heartbeat_interval_s": 10}'

# Read current health
mosquitto_pub -h core-mosquitto \
  -t "zigbee2mqtt/<router>/get" \
  -m '{"uptime_s":"", "neighbor_count":"", "route_table_fill_pct":"", "buffer_free_bytes":""}'
```

### Flashing (dev loop)

```bash
gh workflow run build.yaml -R AlexMKX/zigbee-dense
gh run watch   -R AlexMKX/zigbee-dense
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
gh release download "$TAG" -R AlexMKX/zigbee-dense \
    -p 'smlight_slzb06mu_dense_zigbee_router_*.gbl' -D /tmp/
./scripts/flash-slzb06mu.sh /tmp/smlight_slzb06mu_dense_zigbee_router_*.gbl
```

The helper uses `fwCh=1` (ZB_ROUTER). **Never pass `fwCh=2`** — it writes
`model_id=SLZB-06MU` into NVM3 and Z2M will stop recognising the device.

### Reading UART logs

Outcome recorded from Task 8 experiment: **<TO FILL IN>** (set to one of:
SUCCESS with sample, FAILURE A = reset on mode change, FAILURE B = port
still closed).

If SUCCESS — procedure:

1. Raise heartbeat: `{"heartbeat_interval_s": 5, "debug_heartbeat": true}`.
2. SMLIGHT UI → Zigbee → Working mode → "Zigbee2MQTT / TCP socket". Wait ~10 s.
3. `nc 192.168.88.144 6638 | tee /tmp/slzb-debug.log`
4. When finished, in UI switch working mode back to "Zigbee Router".
5. Reset heartbeat: `{"heartbeat_interval_s": 60}`.

If FAILURE — see Spec §Component 5 alt (Zigbee ring-buffer dump), tracked
as a follow-up task.
````

- [ ] **Step 9.2: Fill the `<TO FILL IN>` with actual outcome from Task 8**

Edit the placeholder to reflect whichever SUCCESS / FAILURE A / FAILURE B
outcome you observed. If FAILURE A or B, also paste the first ~200 bytes
of `/tmp/slzb-uart.bin` into a fenced code block for diagnostic value.

- [ ] **Step 9.3: Commit and push**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add README.md
git commit -m "docs: debug-logging usage + UART-read outcome"
git push origin main
```

---

## Task 10: Cleanup / final verification

- [ ] **Step 10.1: Confirm all patches apply clean against fresh upstream**

Run:
```bash
rm -rf /tmp/zd-final-check
git clone --depth 1 --branch sisdk-2025.12.x \
  https://github.com/Nerivec/silabs-firmware-builder /tmp/zd-final-check
cd /tmp/zd-final-check
for p in /home/alex/Projects/zigbee/zigbee-dense/patches/*.patch; do
    echo "=== $p ==="
    git apply --check "$p" && echo OK || { echo "FAIL: $p"; break; }
    git apply "$p"
done
```
Expected: each patch reports `OK`.

- [ ] **Step 10.2: Verify the built `.gbl` boots and cluster still works**

Re-run the Task 5.5-5.6 sequence on the latest release. Skip if already validated in Task 7.

- [ ] **Step 10.3: Inventory unresolved spec open questions**

Re-read the spec section "Open questions (to resolve during implementation)". For each:

1. ZAP tooling vs patch — now resolved: patch directly, ZAP regen runs in the Silabs build. Noted in Task 4.
2. `sl_zigbee_get_neighbor()` on router — resolved: `sl_zigbee_neighbor_count()` is in `stack-info.h` and linked on router builds (confirmed by `grep` in preflight).
3. `sl_sleeptimer_get_tick_count64` — resolved: used directly in Task 3; if CI link fails, swap for `halCommonGetInt32uMillisecondTick` (documented fallback).

If any of the three remains unresolved after this plan executes, add a follow-up note to README.

- [ ] **Step 10.4: Final commit**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git log --oneline -20
```
Expected: a clean trail of ~8 commits since the start of this plan, each for one task.

---

## Summary of deliverables

By the end of Task 10, the repo contains:

- `patches/0002-router-add-debug-cluster-0xFC00.patch` — adds `debug_cluster.{c,h}`, slcp registration, ZAP cluster 0xFC00.
- `patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch` — wires `dbg_init` + three hooks into `app.c`.
- `manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml` — pinned debug-print `c_defines`.
- `scripts/flash-slzb06mu.sh` — one-shot flash helper with fwCh=1 invariant.
- `z2m/slzb06mu_dense_router.js` — Z2M external converter.
- `README.md` — Debug logging section with MQTT examples + UART-read outcome.

Out of scope (tracked as follow-ups only if Task 8 fails):

- Component 5 alt — Zigbee-side ring-buffer dump via manufacturer command.
- Bidirectional UART CLI.
