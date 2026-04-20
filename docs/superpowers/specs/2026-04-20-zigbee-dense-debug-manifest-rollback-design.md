# Zigbee-Dense Debug — Manifest-Based Rollback Design

**Date:** 2026-04-20
**Status:** Approved, ready for implementation
**Supersedes:** `2026-04-19-zigbee-dense-debug-logging-design.md`

## Why this spec exists

The prior spec (2026-04-19) proposed a manufacturer-specific ZCL cluster
`0xFC00` on endpoint 1 for runtime-toggleable debug logging, controlled from
Z2M via an external converter. Implementation attempts revealed that the
Silicon Labs ZAP generator **does not preserve the per-cluster `mfgCode` from
our ZAP config the way we needed**: the compiled attribute-storage tables
end up with a manufacturer code that does not match what the ZCL request
frame carries, so reads come back as `UNSUPPORTED_ATTRIBUTE` (status 0x86)
even though the cluster is registered on the endpoint. Time spent pursuing
a fix through ZAP internals exceeds the value of the feature for a home-lab
router.

We therefore abandon the runtime-control path entirely and replace it with
a simpler compile-time mechanism: **two build manifests — one production,
one debug — selected at flash time.**

## Goals

1. Keep the `zigbee-dense` router behaviour (packet buffers, route table,
   broadcast table, concentrator suppression, TX power) — this is the
   actual reason the firmware exists.
2. Ship a companion *debug* GBL that enables compile-time debug print
   groups so the EFR32 USART0 emits diagnostic output.
3. Revert everything else we added for the 0xFC00 experiment: patches,
   Z2M converter, ZAP cluster definition, `debug_cluster.{c,h}`, `app.c`
   hooks.
4. Let Z2M see the device as a plain SLZB-06MU router — no custom
   definition, `supported: False` acceptable.

## Non-goals

- No runtime toggle of debug groups from Z2M or anywhere else.
- No manufacturer-specific ZCL cluster, no external converter, no
  `slzb_debug_cluster.xml`.
- No attempt to override `SL_ZIGBEE_ZCL_MANUFACTURER_CODE` — upstream
  default (`0x1002`, Silicon Labs) is fine.
- No attempt to change `modelID` reported to Z2M — ESP32 supplies
  `SLZB-06MU` via its ZCL Basic-cluster proxy, we cannot and will not
  fight that.

## Architecture

Repo layout after rollback:

```
zigbee-dense/
├── patches/
│   └── 0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch
├── manifests/
│   └── smlight/
│       ├── smlight_slzb-mr3_dense_zigbee_ncp.yaml                 (unchanged)
│       ├── smlight_slzb06mu_dense_zigbee_router.yaml              (production; debug c_defines removed)
│       └── smlight_slzb06mu_dense_zigbee_router_debug.yaml        (NEW — full copy + debug c_defines)
├── scripts/
│   └── flash-slzb06mu.sh                                          (unchanged)
├── docs/…
├── README.md                                                      (edited: "Debug builds" section)
└── (no z2m/ directory; no patches/0002*; no patches/0003*)
```

Upstream `zd-upstream` working directory — purely a scratchpad for patch
authoring — gets its stale branches pruned:

- `dbg-cluster-staging` — delete
- `app-c-hooks-staging` — delete

CI `build.yaml` is **unchanged**. The manifest matrix is
`find manifests -type f -name "*.yaml"`, so the new debug manifest is
picked up automatically and produces its own GBL in the release.

## Components

### Component 1 — Remove experiment artefacts

Files deleted from the repo:

- `patches/0002-router-add-debug-cluster-0xFC00.patch`
- `patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch`
- `z2m/slzb06mu_dense_router.js` (and its parent `z2m/` directory if empty)

Side-effect cleanup on the live Z2M host (`hassio.h.xxl.cx`, addon
`45df7312_zigbee2mqtt`):

- Remove `external_converters/slzb06mu_dense_router.js`.
- Remove the `external_converters:` key from `configuration.yaml`,
  including the `  - slzb06mu_dense_router.js` list item and any blank
  line introduced above it. The goal is the file back to the state it
  had before we added the key — i.e. `version: 5` as the final line.
- MQTT-trigger a Z2M restart so the removed converter is unloaded.

### Component 2 — Production manifest edit

File: `manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`.

Remove exactly these keys from the bottom of the `c_defines:` block (they
were added when we pursued the runtime path):

```
SL_ZIGBEE_DEBUG_STACK_GROUP_ENABLED
SL_ZIGBEE_DEBUG_STACK_GROUP_RUNTIME_DEFAULT
SL_ZIGBEE_DEBUG_CORE_GROUP_ENABLED
SL_ZIGBEE_DEBUG_CORE_GROUP_RUNTIME_DEFAULT
SL_ZIGBEE_DEBUG_APP_GROUP_ENABLED
SL_ZIGBEE_DEBUG_APP_GROUP_RUNTIME_DEFAULT
SL_ZIGBEE_DEBUG_ZCL_GROUP_ENABLED
SL_ZIGBEE_DEBUG_ZCL_GROUP_RUNTIME_DEFAULT
```

Also remove the trailing comment block:
`# === Debug print compile-time pins (see docs/...) ===`

Everything else — dense-router `slcp_defines` (route/discovery tables),
concentrator config, TX power, pin/clock/UART/LED `c_defines`, packet
buffer heap, broadcast table, key table, APS duplicate rejection — stays.

Result: production GBL is a pure dense router, no debug print hooks
compiled in, minimum code size.

### Component 3 — Debug manifest (new file)

File: `manifests/smlight/smlight_slzb06mu_dense_zigbee_router_debug.yaml`.

Authoring rule: **exact line-for-line copy of the production manifest**
with the following three changes only:

1. `name:` — append ` (debug build, UART tracing enabled)`.

2. A prominent header comment:

   ```
   # DEBUG BUILD — DO NOT EDIT INDEPENDENTLY.
   #
   # This file is a copy of smlight_slzb06mu_dense_zigbee_router.yaml
   # with debug-print compile-time groups enabled. When you change pin
   # config, clock, TX power, or dense-router tuning in the production
   # manifest, mirror the same change here.
   #
   # The only intentional diff is the debug group c_defines at the bottom
   # of this file.
   ```

3. Append to the end of the `c_defines:` block:

   ```yaml
     # === Debug print compile-time enables ===
     # STACK: network / routing / trust-center events.
     SL_ZIGBEE_DEBUG_STACK_GROUP_ENABLED: 1
     SL_ZIGBEE_DEBUG_STACK_GROUP_RUNTIME_DEFAULT: 1
     # CORE: component-level diagnostics.
     SL_ZIGBEE_DEBUG_CORE_GROUP_ENABLED: 1
     SL_ZIGBEE_DEBUG_CORE_GROUP_RUNTIME_DEFAULT: 1
     # APP: application-layer prints (e.g. button handler).
     SL_ZIGBEE_DEBUG_APP_GROUP_ENABLED: 1
     SL_ZIGBEE_DEBUG_APP_GROUP_RUNTIME_DEFAULT: 1
     # ZCL: ZCL command tracing.
     SL_ZIGBEE_DEBUG_ZCL_GROUP_ENABLED: 1
     SL_ZIGBEE_DEBUG_ZCL_GROUP_RUNTIME_DEFAULT: 1
   ```

The `filename:` format
`"{manifest_name}_{sdk_version}_{fw_version}_{baudrate}_{fw_variant}"` is
inherited unchanged; because `{manifest_name}` differs, the two GBLs land
in the release as:

- `smlight_slzb06mu_dense_zigbee_router_2025.12.2_9.0.1_115200_sw_flow.gbl`
- `smlight_slzb06mu_dense_zigbee_router_debug_2025.12.2_9.0.1_115200_sw_flow.gbl`

### Component 4 — README

Append a new section (at the end of README, after existing dense-router
documentation):

```markdown
## Debug builds (SLZB-06MU)

Each release publishes two GBLs for the SLZB-06MU router:

| GBL suffix                                           | Debug print |
|------------------------------------------------------|-------------|
| `smlight_slzb06mu_dense_zigbee_router_*.gbl`         | off         |
| `smlight_slzb06mu_dense_zigbee_router_debug_*.gbl`   | on          |

The debug build enables compile-time debug print groups STACK, CORE, APP
and ZCL, so the EFR32 emits diagnostic lines on USART0 (PB1 TX, PB0 RX).

### Reading the debug stream

SLZB-OS only exposes the EFR32 UART on TCP 6638 when the device is in
Zigbee2MQTT-TCP coordinator mode (`coord_mode=1`). To capture logs:

1. In SLZB-OS UI → Zigbee → Working mode → switch to "Zigbee2MQTT / TCP
   socket". Reboot when prompted.
2. `nc <device-ip> 6638 | strings` — text lines will stream as the
   firmware emits them.
3. When done, switch the device back to "Zigbee Router" mode so it
   rejoins the mesh as a router.

Important: while in TCP coordinator mode the device is **not** acting as
a router. Switch back as soon as the capture session is done.
```

### Component 5 — Upstream staging cleanup

Purely housekeeping on `/home/alex/Projects/zigbee/zd-upstream`:

- `git branch -D dbg-cluster-staging`
- `git branch -D app-c-hooks-staging`
- Verify working tree is clean on `sisdk-2025.12.x`.
- Verify `git apply --check patches/0001-*.patch` still works against
  upstream HEAD (this is the one patch we keep).

## Data flow

Build-time:

```
CI: workflow_dispatch
 └─ discover job finds manifests/**/*.yaml
     ├─ smlight_slzb06mu_dense_zigbee_router.yaml       → GBL A (prod)
     ├─ smlight_slzb06mu_dense_zigbee_router_debug.yaml → GBL B (debug)
     ├─ smlight_slzb-mr3_dense_zigbee_ncp.yaml          → GBL C
     └─ (…sonoff etc)                                   → GBL D,…
 └─ release job collects all GBLs into a single GitHub Release
```

Flash-time (operator chooses):

```
scripts/flash-slzb06mu.sh <path-to.gbl>
  └─ POST /fileUpload?customName=/fw.bin
  └─ GET  /api2?action=6&...&fwCh=1        # ZB_ROUTER slot
  └─ poll /ha_info until coord_mode=2
```

Runtime in production GBL: plain router, no extra clusters, minimum RAM
footprint.

Runtime in debug GBL: identical router behaviour + debug print strings
written via `sl_iostream` to USART0. Visible on TCP 6638 only while
SLZB-OS is in coordinator mode.

## Error handling

- If only one of the two manifests builds successfully, CI still produces
  the working GBL in the release (existing matrix `fail-fast: false`).
- `flash-slzb06mu.sh` is unchanged; `fwCh=1` continues to be the only
  supported flash channel. Flashing the debug GBL over the production
  one or vice-versa is safe — NVM3 is not touched by the `.gbl` flash
  path.
- If the user flashes the debug GBL and never looks at the UART, the
  device still routes Zigbee traffic normally; debug prints just cost a
  few kB of extra flash and a few cycles per event.

## Testing / verification

After the implementation lands:

1. Push → CI green on both manifests.
2. `strings` on production GBL must **not** contain `debug_cluster`,
   `debug_groups`, or any of the `SL_ZIGBEE_DEBUG_*_GROUP_ENABLED` macros
   as string literals.
3. `strings` on debug GBL **must** be meaningfully larger than production
   (the compile-time-enabled groups pull in printf-style diagnostic
   strings from the EmberZNet stack). Concrete check: GBL size of
   debug is ≥ 500 B larger than production, and `strings … | grep -c
   'ERR:\|Starting discovery'` returns more matches than for production.
4. Flash production GBL on `192.168.88.236`. Verify:
   - device comes back with `coord_mode=2`
   - joins Z2M as `SLZB-06MU` Router, `interview_completed: True`
   - endpoint 1 input clusters reduce back to `[genBasic, genIdentify,
     keepAlive]` (no more trailing `None` from the forced 0xFC00 add)
   - no converter-generated exposes in MQTT state (only `linkquality`)
5. Z2M side: no `external_converters` key in `configuration.yaml`, no
   `slzb06mu_dense_router.js` file, Z2M restart clean.
6. Debug GBL flash is optional for this change; tested only when the
   operator needs UART output.

## Rollout order

1. Remove files + edit production manifest → commit → push → CI build →
   verify production GBL.
2. Flash production GBL to device → confirm rollback of the 0xFC00
   quirks in Z2M.
3. Clean hassio side (external_converters file + config key) → restart
   Z2M.
4. Add debug manifest → commit → push → CI build.
5. Edit README → commit → push.
6. Clean staging branches in `zd-upstream`.

Each step is independently revertable.
