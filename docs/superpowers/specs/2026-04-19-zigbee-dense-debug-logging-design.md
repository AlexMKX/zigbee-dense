# Design: Debug Logging for SLZB-06MU Dense Zigbee Router

Date: 2026-04-19
Status: Draft (for review)

## Goal

Add a debug-logging channel to the `smlight_slzb06mu_dense_zigbee_router`
firmware so that when the EFR32 USART is readable (via the ESP32-hosted
TCP-UART bridge on SLZB-06MU) we can see what the router is doing in the
Zigbee network, and can toggle log verbosity at runtime from the Zigbee
side (via a manufacturer-specific ZCL cluster writable by Zigbee2MQTT).

Non-goals:
- Do not touch SMLIGHT ESP (SLZB-OS) firmware.
- Do not change flash topology, bootloader, or NVM3 layout.
- Do not add a bidirectional CLI over UART. The channel is write-only
  from the firmware's point of view. Control comes through Zigbee/ZCL.

## Context

### Hardware / wiring

SLZB-06MU: `EFR32MG21A020F768IM32` (768 KiB flash / 96 KiB RAM) behind an
ESP32 co-processor running SLZB-OS. The EFR32 VCOM USART (PB0/PB1,
`USART0`, 115200 8N1 software flow control) is wired **to the ESP32**,
not to external USB. The only path out is whatever SLZB-OS chooses to
expose.

SLZB-OS exposes the EFR32 UART on TCP port 6638 **only when `coordMode`
selects a coordinator/NCP-oriented mode**. In `coordMode=2` (Zigbee
Router), port 6638 is closed (verified 2026-04-19 against
`192.168.88.144`).

### What already exists in `src/zigbee_router` upstream

Verified in upstream branch `sisdk-2025.12.x` (manifest-only repo clones
this into `upstream/` at CI time):

- `src/zigbee_router/zigbee_router.slcp` declares the components
  `iostream_recommended_stream`, `iostream_usart` (instance `vcom`),
  `zigbee_debug_basic`, and `zigbee_debug_print`.
- The VCOM USART defaults: PB1 TX, PB0 RX, 115200, software flow ctl —
  identical to upstream `smlight_slzb06m_zigbee_router` manifest.
- `sl_zigbee_debug_print_config.h` ships with all four runtime groups
  (stack, core, app, zcl) compiled in AND enabled by default
  (`*_RUNTIME_DEFAULT = 1`).
- `app.c` already uses `sl_zigbee_app_debug_println(...)` in six places
  (commissioning, button handlers, join complete).

So the wire-level plumbing is already there. What is missing is: (a) the
ESP32 does not forward it in router mode, (b) the firmware only prints
six lifecycle events, (c) there is no runtime switch or way to read back
state from Zigbee.

## Architecture

```
┌─────────────────────┐  USART0/PB0-PB1    ┌─────────────────┐   TCP :6638    ┌───────────┐
│  EFR32MG21          │  115200 8N1 sw fc  │ ESP32 (SLZB-OS) │   (only in     │  nc /     │
│  zigbee_router      │───────────────────>│  TCP-UART bridge│    certain      │  socat    │
│  + debug cluster    │                    │                 │    coordModes)  │           │
│    mfg 0x1002       │                    └─────────────────┘                 └───────────┘
│    cluster 0xFC00   │
└─────────────────────┘
         ▲
         │  ZCL write/read over Zigbee  ←  Z2M external converter  ←  MQTT
```

Two independent channels:

- **OUT (firmware → UART → TCP → terminal):** textual debug lines
  `[uptime_s.ms] [GROUP] message`.
- **CTRL (Z2M → Zigbee → cluster 0xFC00 on the router):** read-write
  attributes for toggling log groups and inspecting stack health.

Channels are decoupled: the OUT channel works whenever the ESP32 exposes
the UART; the CTRL channel works whenever the router is joined and the
coordinator can reach it. They don't depend on each other.

## Component 1: Manufacturer-specific ZCL cluster

All changes below are applied to `upstream/src/zigbee_router/` via
patches placed in `zigbee-dense/patches/`. No fork of upstream.

### Cluster identity

- Manufacturer code: **`0x1002`** (Silicon Labs — already declared in
  `src/zigbee_router/config/zcl/zcl_config.zap` under `manufacturerCodes`,
  so no ZAP-wide change is needed).
- Cluster ID: **`0xFC00`** (manufacturer-specific range `0xFC00-0xFFFF`,
  inside Silabs' private allocation for this manufacturer code).
- Endpoint: **`1`** (the existing "Centralized" endpoint). Adding the
  cluster here avoids creating a new endpoint and keeps the Z2M
  converter simple.
- Role: **server** on the router. Z2M/coordinator reads/writes as client.

### Attributes

All attributes live in RAM only (no `storage: NVM` flag in ZAP). Defaults
below are re-applied on every power-up. This was chosen deliberately
because the NVM3 budget on MG21 is tight and these values are diagnostic
aids; bricking them into tokens would complicate firmware upgrades.

| Attr ID | Name                   | Type        | Access | Default | Notes |
|---------|------------------------|-------------|--------|---------|-------|
| 0x0000  | debug_groups           | bitmap16    | RW     | 0x001F  | bit0=STACK, bit1=CORE, bit2=APP, bit3=ZCL, bit4=ROUTE, bit5=APS_IN, bit6=HEARTBEAT |
| 0x0001  | heartbeat_interval_s   | uint16      | RW     | 60      | 0 disables heartbeat. Clamped to [5, 3600] on write. |
| 0x0010  | uptime_s               | uint32      | RO     | —       | Seconds since boot (wraps at 2^32 s). |
| 0x0011  | route_table_fill_pct   | uint8       | RO     | —       | Used entries × 100 / `SL_ZIGBEE_ROUTE_TABLE_SIZE`. |
| 0x0012  | neighbor_count         | uint8       | RO     | —       | Current entries in neighbor table. |
| 0x0013  | packet_buffer_free     | uint8       | RO     | —       | `sl_zigbee_get_free_buffers()`. |
| 0x0014  | last_incoming_src      | uint16      | RO     | 0xFFFF  | NwkAddr of last APS payload delivered to the app. |

Bitmap bits 0-3 map directly onto
`SL_ZIGBEE_DEBUG_PRINT_TYPE_{STACK,CORE,APP,ZCL}` so
`sl_zigbee_debug_print_enable_group()` can be called with
`(1u << bit)` unchanged. Bits 4-6 are application-level and gated inside
`app.c` (see Component 2).

### Write behavior

`sl_zigbee_af_post_attribute_change_cb` (existing callback from the
zigbee af framework) is extended to react to writes on cluster 0xFC00:

- Write to `debug_groups`: diff new-vs-old bitmap, for each changed bit
  in bits 0-3 call `sl_zigbee_debug_print_enable_group(group, enabled)`.
  Bits 4-6 are consulted at print time, no callback action needed.
- Write to `heartbeat_interval_s`: clamp to `[0, 5..3600]`, then
  `sl_zigbee_af_event_set_delay_ms(new_interval * 1000)` if >0, or
  `sl_zigbee_af_event_set_inactive()` if 0.

### Reporting

We do NOT configure automatic attribute reporting from firmware (no
`configureReporting` response customisation). Z2M polls on demand via
`readAttributes`. Rationale: reporting would eat broadcast budget in a
150-device mesh and the cost/benefit is poor for diagnostic data.

## Component 2: `app.c` additions

Implemented as a single patch file `patches/0003-debug-wrapper-and-heartbeat.patch`.

### Runtime state (static globals)

```c
static uint16_t dbg_groups = 0x001F;         // mirrors cluster attr
static uint16_t dbg_hb_s   = 60;             // mirrors cluster attr
static uint16_t dbg_last_src = 0xFFFF;
static sl_zigbee_af_event_t heartbeat_event;
```

These mirror the ZCL attributes. The ZCL attribute store is the
authoritative source; `dbg_groups` / `dbg_hb_s` are just local caches
updated from the post-attribute-change callback, so the hot path
(`dbg_print`) does not need to go through the attribute store on every
log line.

### Wrapper

```c
// group: one of DBG_* constants (STACK/CORE/APP/ZCL/ROUTE/APS_IN/HB)
static void dbg_print(uint8_t group, const char *fmt, ...)
{
  if ((dbg_groups & (1u << group)) == 0) return;
  uint32_t ms = sli_zigbee_af_ms_to_next_event();  // fallback: halCommonGetInt32uMillisecondTick
  // format "[%lu.%03lu] [%-5s] "  + user fmt
  ...
  sli_zigbee_debug_print(SL_ZIGBEE_DEBUG_PRINT_TYPE_APP, true, "%s", buf);
}
```

The implementation prints via the APP print-type regardless of the
logical group, because that matches the existing runtime gate the
upstream code already uses and keeps the number of `sl_catalog`
dependencies unchanged. The `[GROUP]` text tag lets the reader still
distinguish sources with `grep`.

Timestamp source: `sl_sleeptimer_get_tick_count64()` converted to ms
via `sl_sleeptimer_tick_to_ms()`. The `sleeptimer` component is pulled
in by `zigbee_stack_common` transitively, so no manifest change is
needed — but Open Question #3 below tracks the need to verify this on
the actual link.

### Heartbeat event handler

```c
static void heartbeat_event_handler(sl_zigbee_af_event_t *event)
{
  uint32_t uptime = sl_sleeptimer_get_tick_count64() / tick_per_sec;

  // Update RO attrs (write to attribute store so Z2M reads are fresh)
  uint8_t route_pct = route_table_fill_percent();   // iterates route tbl
  uint8_t nbr       = neighbor_table_count();
  uint8_t bufs      = sl_zigbee_get_free_buffers();

  sl_zigbee_af_write_server_attribute(1, 0xFC00, 0x0010,
                                      ZCL_UINT32_ATTRIBUTE_TYPE,
                                      (uint8_t*)&uptime, sizeof(uptime));
  /* ... same for 0x0011..0x0014 ... */

  if (dbg_groups & (1u << DBG_HB)) {
    dbg_print(DBG_HB, "uptime=%lus rt=%u%% nbr=%u buf=%u lastSrc=0x%04X",
              uptime, route_pct, nbr, bufs, dbg_last_src);
  }

  if (dbg_hb_s > 0) {
    sl_zigbee_af_event_set_delay_ms(event, dbg_hb_s * 1000);
  }
}
```

The event is initialised and armed from the existing init path
(`sl_zigbee_af_main_init_cb` or similar). Heartbeat runs on the Zigbee
event loop; no ISR context.

### Hooked callbacks

- `sl_zigbee_af_incoming_message_cb(...)`: extract source NwkAddr, store
  in `dbg_last_src`, and if `dbg_groups & (1 << DBG_APS_IN)` log profile
  `0x%04X` cluster `0x%04X` src `0x%04X` len `%u`.
- `sl_zigbee_af_stack_status_cb(status)`: decode status enum to string
  (joined, lost-parent, rejoining, up, down) and log at DBG_ROUTE. This
  is the single most useful signal for network troubleshooting.
- `sl_zigbee_af_post_attribute_change_cb(ep, cluster, ...)`: if
  `ep==1 && cluster==0xFC00`, dispatch to write handlers described above
  (mirror to local cache, call
  `sl_zigbee_debug_print_enable_group`, reschedule heartbeat).

### Existing prints in `app.c`

The six existing `sl_zigbee_app_debug_println` calls are left untouched
so that a non-dense-router build still behaves like upstream. We only
add a `dbg_print(DBG_APP, ...)` equivalent alongside the *join complete*
and *stack status* lines, so the timestamp/group header appears without
breaking upstream-compatible format.

## Component 3: Manifest updates

File: `zigbee-dense/manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`

Add to `c_defines:` (explicit, even though these match current defaults —
pin so that an upstream default change does not silently disable logs):

```yaml
c_defines:
  # ... existing dense-tuning c_defines ...
  SL_ZIGBEE_DEBUG_STACK_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_STACK_GROUP_RUNTIME_DEFAULT: 1
  SL_ZIGBEE_DEBUG_CORE_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_CORE_GROUP_RUNTIME_DEFAULT: 1
  SL_ZIGBEE_DEBUG_APP_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_APP_GROUP_RUNTIME_DEFAULT: 1
  SL_ZIGBEE_DEBUG_ZCL_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_ZCL_GROUP_RUNTIME_DEFAULT: 1
```

No slcp_defines change — the cluster is added via ZAP patch, not via
SLC components.

Flash/RAM budget check (to verify during implementation):
- Current `.gbl` size with dense tweaks: ~230 KiB app (headroom on
  MG21 = ~500 KiB flash, ~40 KiB RAM used).
- Estimated cost of additions: ZAP cluster ~1 KiB flash / ~100 B RAM,
  heartbeat + wrapper ~2 KiB flash / ~200 B RAM, print buffer 256 B
  RAM. Total well inside budget.

## Component 4: Z2M external converter

Location: `zigbee-dense/z2m/slzb06mu_dense_router.js`

The converter binds our dense-router firmware (detected by model_id +
software_build_id) with `fromZigbee`/`toZigbee` for manufacturer-
specific cluster `0xFC00`:

- `fz.slzb06mu_debug_groups` → exposes `debug_groups` as an 8-bit
  multi-select in Z2M (labels: stack/core/app/zcl/route/aps_in/hb).
- `tz.slzb06mu_debug_groups` → writes `debug_groups` with
  `manufacturerCode: 0x1002`.
- Similar pairs for `heartbeat_interval_s` and each RO attribute.

The exposed `definition` declares:

```js
exposes: [
  // Per-group toggles exposed individually; the converter composes the
  // bitmap server-side when writing. This is much more usable in the Z2M
  // UI than a raw integer.
  e.binary('debug_stack',    ea.ALL, true, false),
  e.binary('debug_core',     ea.ALL, true, false),
  e.binary('debug_app',      ea.ALL, true, false),
  e.binary('debug_zcl',      ea.ALL, true, false),
  e.binary('debug_route',    ea.ALL, true, false),
  e.binary('debug_aps_in',   ea.ALL, true, false),
  e.binary('debug_heartbeat',ea.ALL, true, false),

  e.numeric('heartbeat_interval_s', ea.ALL).withValueMin(0).withValueMax(3600).withUnit('s'),
  e.numeric('uptime_s', ea.STATE_GET).withUnit('s'),
  e.numeric('route_table_fill_pct', ea.STATE_GET).withUnit('%'),
  e.numeric('neighbor_count', ea.STATE_GET),
  e.numeric('packet_buffer_free', ea.STATE_GET),
  e.numeric('last_incoming_src', ea.STATE_GET),
],
```

Fingerprint matching is based on the presence of the manufacturer
cluster itself: the converter matches any router that advertises
`endpoint 1` with server cluster `0xFC00` under manufacturer code
`0x1002`. This avoids depending on `modelID` or `softwareBuildID`,
which SLZB-OS overwrites in NVM3 depending on the `fwCh` chosen during
flash (see session notes 2026-04-18: `fwCh=1` writes `SLZB-06M`, `fwCh=2`
writes `SLZB-06MU`). Using cluster presence as the signal sidesteps
that whole discrepancy.

In `zigbee-herdsman-converters` terms, the `definition.zigbeeModel` is
left undefined; matching is done via the `fingerprint` array with
`{endpoints: [{inputClusters: [0xFC00]}]}`.

Z2M install documentation goes in `zigbee-dense/README.md`:

```yaml
# Z2M configuration.yaml
external_converters:
  - slzb06mu_dense_router.js
```

## Component 5: Reading logs (operational procedure)

This section is a **plan to validate**, not a guarantee. See also
the "Risks" section below.

Attempt 1 — SLZB-OS coordinator mode:

```
# 1. Note current coord_mode from http://192.168.88.144/ha_info
# 2. In SMLIGHT UI: switch "Zigbee → Zigbee mode" to "Zigbee2MQTT / TCP"
# 3. Wait 5s. Check that port 6638 is now open:
nc -z 192.168.88.144 6638 && echo OPEN
# 4. Consume the stream:
nc 192.168.88.144 6638 | tee /tmp/slzb-debug.log
# 5. When done: switch coord_mode back to "Zigbee Router".
```

Risks to verify empirically:

- **EFR32 reset on coordMode switch.** SLZB-OS may assert the EFR32
  reset line when changing modes. If so, the router will rejoin on
  boot (this is normal; confirmed working from prior sessions where we
  flashed via `/api2?action=6`).
- **ESP32 spamming EZSP init on a non-NCP firmware.** In Z2M/coordinator
  mode, ESP32 likely sends EZSP/ASH reset frames to the EFR32 at
  startup, expecting an NCP. A router firmware will ignore them but the
  bytes will appear interleaved in the TCP stream. This is tolerable
  for log reading (text stands out from ASH framing).
- **UART bridge may still be closed even after coordMode change.** If
  so, we fall back to plan B (Component 5 alt below).

Component 5 alt — if SLZB-OS never exposes UART in any practical mode
while EFR32 is running our firmware: implement a Zigbee-side log dump.
Keep a 2 KiB ring buffer in RAM in `app.c`, `dbg_print` appends to it,
and add a manufacturer ZCL command `ReadLogChunk(offset, len)` on
cluster 0xFC00 that returns up to 80 bytes of log text. Slow and
byte-expensive, but independent of SLZB-OS. Not implemented in the
first patch; left as a documented fallback.

## Error handling

- Out-of-memory in `dbg_print`: the upstream `sli_zigbee_debug_print`
  already handles buffer shortages silently (drops the line). The
  wrapper does not need to do anything extra.
- Invalid `heartbeat_interval_s` write (e.g. 1s): clamp before writing
  to attribute store, reply to the remote with `STATUS_SUCCESS` using
  the clamped value (standard Silabs ZCL behavior for constrained
  attrs).
- Attribute read race during heartbeat update: ZCL attribute store
  writes are atomic at the API level; no locking needed.

## Testing

- **Build test.** `scripts/build-local.sh smlight_slzb06mu_dense_zigbee_router`
  succeeds, `.gbl` under size budget.
- **Boot test.** Flash via existing `/fileUpload` + `/api2?action=6&fwCh=1`
  flow. Device rejoins the network, `ha_info` shows
  `zb_type=1` (ZB_ROUTER), Z2M sees the device as `supported: True`.
- **Cluster presence.** Z2M bind + interview reports cluster `0xFC00`
  on endpoint 1 with the declared attributes.
- **Write round-trip.** From Z2M MQTT:
  `zigbee2mqtt/<router>/set {"debug_groups": 0}` — after completion, a
  subsequent `{"debug_groups": 127}` should re-enable everything, with
  the log stream showing the gap.
- **Heartbeat.** With `heartbeat_interval_s=5` and `debug_groups`
  including HB, a log line appears every ~5 s.
- **UART read.** Attempt to open the UART-over-TCP as in the
  operational procedure; if it works, capture at least one full
  heartbeat cycle to `/tmp/slzb-debug.log`. Record the procedure in
  README with exact steps.

No automated tests — this is firmware running on real hardware and the
only end-to-end harness is the live router.

## Open questions (to resolve during implementation)

1. ZAP tooling vs patch: modifying `zcl_config.zap` as a literal JSON
   patch is fragile. The patch should regenerate
   `zap-generated/*` as part of the build, or we manually craft the
   `.h`/`.c` extensions and skip ZAP for the 0xFC00 cluster.
   Implementation step will pick the approach that builds cleanly in
   CI.
2. Exact API for `neighbor_table_count()` on EmberZNet 9.0.1 — need to
   verify `sl_zigbee_get_neighbor()` iteration is supported on router
   builds (it is on NCP; behaviour on router is less documented).
3. Whether `sl_sleeptimer_get_tick_count64` is linked in the router
   build by default. If not, pull in `sleeptimer` as an added component
   in the manifest. As a safe fallback, `halCommonGetInt32uMillisecondTick()`
   (from HAL) is always linked and returns a 32-bit ms counter — using
   it just limits uptime log wrap to ~49 days, which is acceptable.

## Out of scope

- Bidirectional UART CLI (option C from brainstorming).
- Changing the exposed model ID / fingerprint.
- Power / TX changes.
- Any change to `zigbee-silabs-firmware` (the old fork). All work
  happens in `zigbee-dense`.
