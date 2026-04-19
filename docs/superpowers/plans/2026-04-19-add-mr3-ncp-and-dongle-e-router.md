# Add MR3 NCP and Dongle-E Router Dense Manifests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `AlexMKX/zigbee-dense` CI to build and publish three firmwares per release: the existing SLZB-06MU dense router, a new SLZB-MR3 dense NCP, and a new SONOFF ZBDongle-E dense router.

**Architecture:** Manifests live in `manifests/<vendor>/*.yaml` and are picked up by the existing `find` glob in the workflow matrix. A new `patches/` directory holds upstream patches that the `discover` job applies after cloning upstream and before uploading the source tarball consumed by downstream build jobs. One patch is shipped: it fixes `build_project.py` so manifest overrides replace every matching `*.slcp` entry rather than only the first. No Docker image changes (patch touches `tools/`, not `Dockerfile`/`requirements.txt`), so the cached image at `ghcr.io/alexmkx/zigbee-dense:<hash>` is reused.

**Tech Stack:** GitHub Actions (`workflow_dispatch`), Silabs SLC + SiSDK 2025.12.2 inside upstream-provided Docker image, `tools/build_project.py` from `Nerivec/silabs-firmware-builder`, Bash, YAML manifests, unified-diff patch applied via `git apply`.

**Spec:** `docs/superpowers/specs/2026-04-19-add-mr3-ncp-and-dongle-e-router-design.md`

---

## File Structure

- **Create** `patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch` — single unified-diff patch against `tools/build_project.py` (11 line change around line 608). Responsibility: overwrite every `slcp` entry that matches an override, not only the first.
- **Create** `manifests/smlight/smlight_slzb-mr3_dense_zigbee_ncp.yaml` — manifest for the MR3 dense NCP build, MG24 A020, EUSART @ 460800 sw-flow.
- **Create** `manifests/sonoff/sonoff_zbdonglee_dense_zigbee_router.yaml` — manifest for the ZBDongle-E dense router build, MG21 A020, USART @ 115200 sw-flow.
- **Modify** `.github/workflows/build.yaml` — insert a single step `Apply patches to upstream` in the `discover` job between `Clone upstream` and `Compute image tag`.
- **Existing, unchanged**
  - `manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml` (already builds green in CI)
  - `upstream.conf`, `README.md`, `scripts/build-local.sh`, `LICENSE`, `.gitignore`

No tests are written for this feature because every unit in this repo is
declarative data (YAML manifests, a unified-diff patch) or a CI workflow. The
authoritative integration test is the single `workflow_dispatch` CI run at the
end of the plan, which must produce a GitHub Release containing three `.gbl`
artifacts.

---

### Task 1: Add the build_project.py patch

**Files:**
- Create: `patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch`

- [ ] **Step 1: Create the `patches/` directory and patch file**

Write the file with exactly this content:

```
From d4e6ff670fdd63821932c72353914f81e522b72e Mon Sep 17 00:00:00 2001
From: Alex <alex@example.com>
Date: Sat, 18 Apr 2026 18:35:34 +0300
Subject: [PATCH] build: apply manifest overrides to all matching slcp entries

Port of 686b2dd (from the old 2025.6.2 build_project) to the rewritten
2025.12.x tool. The zigbee_ncp.slcp in SDK 2025.12.2 has per-MCU
conditional entries (xg21=8, xg24=16, xg26=16) for several defines
including SL_ZIGBEE_DISCOVERY_TABLE_SIZE. Without this fix, a
slcp_defines override only touches the first matching entry (xg21)
and the xg24/xg26 entries are left at their defaults. Confirmed
against live CLI dump showing DISCOVERY_TABLE_SIZE=16 despite
manifest having ':32'.
---
 tools/build_project.py | 12 +++++++++---
 1 file changed, 9 insertions(+), 3 deletions(-)

diff --git a/tools/build_project.py b/tools/build_project.py
index 042f332..bace634 100755
--- a/tools/build_project.py
+++ b/tools/build_project.py
@@ -608,12 +608,18 @@ def main():
             # Values are always strings
             value = str(value)
 
-            # First try to replace any existing config entries
+            # Replace ALL existing entries with the same name (not just the
+            # first one). The base zigbee_ncp.slcp has several entries keyed
+            # on MCU family (e.g. SL_ZIGBEE_DISCOVERY_TABLE_SIZE for xg21,
+            # xg24, xg26). Previously we would only overwrite the first one,
+            # leaving the xg24 entry untouched.
+            found_existing = False
             for config in output_config:
                 if config["name"] == name:
                     config["value"] = value
-                    break
-            else:
+                    found_existing = True
+
+            if not found_existing:
                 # Otherwise, append it
                 output_config.append({"name": name, "value": value})
 
-- 
2.51.0

```

Use the Write tool, not `cat <<EOF`, to avoid accidental heredoc escape.

- [ ] **Step 2: Verify the patch applies against a clean upstream clone**

Run these commands locally (or in a scratch dir) to prove the patch is good before CI runs:

```bash
cd /tmp && rm -rf patch-check && mkdir patch-check && cd patch-check
git clone --depth 1 --branch sisdk-2025.12.x \
    https://github.com/Nerivec/silabs-firmware-builder upstream
git -C upstream apply --check \
    /home/alex/Projects/zigbee/zigbee-dense/patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch
echo "exit=$?"
```

Expected: `exit=0` and no output from `git apply --check`. If it reports "patch does not apply", regenerate the patch from the fork: `cd /home/alex/Projects/zigbee/zigbee-silabs-firmware && git format-patch -1 d4e6ff6 --stdout -- tools/build_project.py > <target>`.

- [ ] **Step 3: Verify the patched file has the expected content**

```bash
cd /tmp/patch-check
git -C upstream apply /home/alex/Projects/zigbee/zigbee-dense/patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch
grep -c 'found_existing' upstream/tools/build_project.py
```

Expected: `3` (one flag declaration, one assignment inside the loop, one `if not found_existing` check).

- [ ] **Step 4: Commit**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch
git commit -m "patch: overwrite all matching slcp entries in manifest overrides

Upstream build_project.py only replaces the first slcp entry with a given
name. SDK 2025.12.2's zigbee_ncp.slcp has per-MCU entries for several
defines (xg21, xg24, xg26), so overrides silently miss xg24/xg26 builds."
```

---

### Task 2: Apply patches in the discover job

**Files:**
- Modify: `.github/workflows/build.yaml` — insert a step in the `discover` job between `Clone upstream` and `Compute image tag`.

- [ ] **Step 1: Read the current discover job**

```bash
sed -n '35,75p' /home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml
```

Expected output starts at the `Clone upstream` step and ends at or after the `Upload upstream tarball for downstream jobs` step. Confirm the line immediately following `Clone upstream`'s final `upstream` argument and its blank line is the `Compute image tag` step.

- [ ] **Step 2: Insert the patch-apply step**

Use the Edit tool to insert between `Clone upstream` and `Compute image tag`.

Find this block:

```yaml
      - name: Clone upstream
        run: |
          git clone --depth 1 \
              --branch "${{ steps.pin.outputs.branch }}" \
              "${{ steps.pin.outputs.repo }}" \
              upstream

      - name: Compute image tag
```

Replace with:

```yaml
      - name: Clone upstream
        run: |
          git clone --depth 1 \
              --branch "${{ steps.pin.outputs.branch }}" \
              "${{ steps.pin.outputs.repo }}" \
              upstream

      - name: Apply patches to upstream
        run: |
          shopt -s nullglob
          for p in patches/*.patch; do
            echo "Applying $p"
            git -C upstream apply --verbose "$GITHUB_WORKSPACE/$p"
          done

      - name: Compute image tag
```

- [ ] **Step 3: Verify the workflow is still valid YAML**

```bash
python3 -c 'import yaml; yaml.safe_load(open("/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml"))' && echo OK
```

Expected: `OK` (no stacktrace).

- [ ] **Step 4: Verify step ordering**

```bash
grep -n '^      - name:' /home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml | head -20
```

Expected: the sequence inside the `discover` job is `Read upstream pin`, `Clone upstream`, `Apply patches to upstream`, `Compute image tag`, `Record upstream HEAD SHA`, `Build manifest matrix`, `Upload upstream tarball for downstream jobs`. Confirm `Apply patches to upstream` is between `Clone upstream` and `Compute image tag`, and before the upload step (so the patched sources are what is shipped to build jobs).

- [ ] **Step 5: Commit**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add .github/workflows/build.yaml
git commit -m "ci: apply patches/*.patch to upstream after clone

Runs in the discover job between Clone upstream and Compute image tag,
so the upstream tarball uploaded for downstream build jobs already
contains the patched tools/build_project.py."
```

---

### Task 3: Add the SLZB-MR3 dense NCP manifest

**Files:**
- Create: `manifests/smlight/smlight_slzb-mr3_dense_zigbee_ncp.yaml`

- [ ] **Step 1: Write the manifest file**

Use the Write tool to create `manifests/smlight/smlight_slzb-mr3_dense_zigbee_ncp.yaml` with exactly this content:

```yaml
name: SMLIGHT SLZB-MR3 Dense Zigbee NCP
device: EFR32MG24A020F1024IM40
base_project: src/zigbee_ncp
filename: "{manifest_name}_{sdk_version}_{fw_version}_{baudrate}_{fw_variant}"
sdk: "simplicity_sdk:2025.12.2"
toolchain: "12.2.1.20221205"

gbl:
  fw_type: zigbee_ncp
  baudrate: 460800
  fw_variant: sw_flow


## YOU WILL NEED TO CLEAR NVM3 after flashing. This is safe if you run Zigbee2Mqtt which stores network in config.
## 1. change the EFR port speed to 115200 in SMLight UI
## 2. Enter "Flash mode" from SMLight UI
## 3. Run ember-zli bootloader and do the below:
## 3.1 ✔ Path: tcp://YourIP:6638. Use this config? Yes
## 3.2 ✔ Adapter model SMLight SLZB06mg24
## 3.3 ✔ Menu Clear NVM3 (https://github.com/Nerivec/silabs-firmware-recovery?tab=readme-ov-file#nvm3-clear)
## 3.4 ✔ Confirm adapter is: SMLight SLZB06mg24? Yes
## 3.5 ✔ NVM3 Size (https://github.com/Nerivec/silabs-firmware-recovery?tab=readme-ov-file#nvm3-clear) 32768
## 3.6 ✔ Confirm NVM3 clearing? (Cannot be undone; will reset the adapter to factory defaults.) Yes
## 3.7 ✔ Menu Exit bootloader (run firmware)


# =============================================================================
# SMLIGHT SLZB-MR3 Dense Network NCP, EmberZNet 9.0.1 / SDK 2025.12.2
# =============================================================================
#
# Baseline is the byte-for-byte known-good mr3-large-net-460800-sw-flow
# (sdk 2025.6.2). This revision keeps that baseline and adds a handful of
# extra headroom settings that measurably help dense networks with noisy
# routers (Tuya TS011F/TS110E/TS0601), inside the chip's resource budget.
#
# Chip: EFR32MG24A020F1024IM40
#   Flash 1024 KB (968 KB app area after bootloader + NVM3 reservation)
#   RAM   256 KB
#
# Baseline footprint measured from the previous CI build:
#   App FLASH used ~ 286 KB / 968 KB   => ~682 KB free
#   App RAM used   ~ 127 KB / 256 KB   => ~129 KB free
# The additions below cost ~3 KB RAM and ~1-2 KB flash total.
#
# TX power for an NCP is NOT set in this manifest. It is set at runtime by
# the host (z2m) via EZSP setRadioPower(). For maximum range on MG24 A020
# (High-Power PA +20 dBm capable) set in z2m `configuration.yaml`:
#   advanced:
#     transmit_power: 20
#
# See:
#   https://community.silabs.com/s/article/guidelines-for-large-dense-networks-with-emberznet-pro
# =============================================================================

slcp_defines:
  # ---- Routing ----------------------------------------------------------
  # Concentrator route table. Default 16 is far too small for ~200 devices
  # and is the single biggest cause of ROUTE_ERROR_SOURCE_ROUTE_FAILURE
  # storms we saw in the z2m logs.
  SL_ZIGBEE_ROUTE_TABLE_SIZE: 200

  # Parallel route-discovery slots during MTORR / ZDO bursts.
  SL_ZIGBEE_DISCOVERY_TABLE_SIZE: 32

  # ---- Delivery reliability --------------------------------------------
  # Retry queue for APS-acked unicasts. Default 16 (visible in CLI dump).
  # Doubling gives the stack more slack when many devices are lossy
  # simultaneously (Tuya routers).
  SL_ZIGBEE_RETRY_QUEUE_SIZE: 32

c_defines:
  # ---- Green Power ------------------------------------------------------
  # DISABLED 2026-04-18: bumping SL_ZIGBEE_GP_PROXY_TABLE_SIZE from 5 to 16
  # caused the NCP to hang before ASH RSTACK (adapter reset loop in host).
  # The GP proxy table size is serialized into NVM3 tokens (GP security frame
  # counter table sizing is derived from it), and changing it across firmware
  # updates can put the stack into an init path that never reaches the EZSP
  # layer. Keep the SDK default (5 for zg24).
  # SL_ZIGBEE_GP_PROXY_TABLE_SIZE: 16

  # ---- UART (EUSART @ 460800, software XON/XOFF flow control) -----------
  # SLZB-MR3 PCB does not route CTS/RTS to usable MG24 pins, so SW flow is
  # the only correct option. EUSART is the default on xg24 since sdk 2025.6.2.
  SL_IOSTREAM_EUSART_VCOM_BAUDRATE: 460800
  SL_IOSTREAM_EUSART_VCOM_FLOW_CONTROL_TYPE: SL_IOSTREAM_EUSART_UART_FLOW_CTRL_SOFT

  SL_IOSTREAM_EUSART_VCOM_PERIPHERAL: EUSART0
  SL_IOSTREAM_EUSART_VCOM_PERIPHERAL_NO: 0

  SL_IOSTREAM_EUSART_VCOM_TX_PORT: SL_GPIO_PORT_A
  SL_IOSTREAM_EUSART_VCOM_TX_PIN: 5

  SL_IOSTREAM_EUSART_VCOM_RX_PORT: SL_GPIO_PORT_A
  SL_IOSTREAM_EUSART_VCOM_RX_PIN: 6

  # CTS/RTS pins forced to 0 so the SDK does not claim a GPIO for them.
  SL_IOSTREAM_EUSART_VCOM_CTS_PORT: 0
  SL_IOSTREAM_EUSART_VCOM_CTS_PIN: 0

  SL_IOSTREAM_EUSART_VCOM_RTS_PORT: 0
  SL_IOSTREAM_EUSART_VCOM_RTS_PIN: 0

  # RX FIFO for 460800 burst headroom. Default 128 -> 256 B. Cheap (+128 B RAM).
  SL_IOSTREAM_EUSART_VCOM_RX_BUFFER_SIZE: 256

  # ---- Clocking ---------------------------------------------------------
  # SLZB-MR3 uses an external HFXO; CTUNE 140 matches Nerivec smlight_slzb06Mg24
  # reference and our long-running known-good MR3 builds.
  SL_CLOCK_MANAGER_HFXO_EN: 1
  SL_CLOCK_MANAGER_HFXO_CTUNE: 140
  SL_CLOCK_MANAGER_DEFAULT_HF_CLOCK_SOURCE: SL_CLOCK_MANAGER_DEFAULT_HF_CLOCK_SOURCE_HFXO

  # ---- Radio ------------------------------------------------------------
  # No extra RSSI offset compensation needed on MR3.
  SL_RAIL_UTIL_RSSI_OFFSET: 0

  # ---- Zigbee stack (overrides the defaults in zigbee_ncp.slcp) ---------
  # HUGE packet buffer heap on xg24 (16384 B). Absorbs traffic bursts from
  # chatty Tuya devices without triggering SEND_UNICAST_FAILURE under load.
  SL_ZIGBEE_PACKET_BUFFER_HEAP_SIZE: SL_ZIGBEE_HUGE_PACKET_BUFFER_HEAP

  # Large network table extensions
  SL_ZIGBEE_ADDRESS_TABLE_SIZE: 250         # xg24 default 64 -> 250 (near-max)
  SL_ZIGBEE_BROADCAST_TABLE_SIZE: 100       # xg24 default 30 -> 100 (Tuya broadcast spam)

  # DISABLED 2026-04-18: bumping SL_ZIGBEE_BINDING_TABLE_SIZE from 32 to 64
  # suspected of same class of NCP init hang as GP_PROXY. Binding table is
  # serialized into NVM3 (NVM3KEY_STACK_BINDING_TABLE), and a size mismatch
  # between what the stack was built with and what is persisted can trap the
  # stack before ASH is reachable. Keep the SDK default (32).
  # SL_ZIGBEE_BINDING_TABLE_SIZE: 64          # default 32 -> 64 (TC-side reportable bindings)

  # Anti-duplicate spam (Tuya routers). 2025.12.x xg24 default is already 64;
  # lift to 96 for a bit more slack when many Tuyas transmit at once.
  SL_ZIGBEE_APS_DUPLICATE_REJECTION_MAX_ENTRIES: 96
```

- [ ] **Step 2: Verify the manifest is valid YAML and has the required top-level keys**

```bash
python3 -c '
import yaml
with open("/home/alex/Projects/zigbee/zigbee-dense/manifests/smlight/smlight_slzb-mr3_dense_zigbee_ncp.yaml") as f:
    m = yaml.safe_load(f)
for k in ("name", "device", "base_project", "filename", "sdk", "gbl", "slcp_defines", "c_defines"):
    assert k in m, f"missing key: {k}"
assert m["device"] == "EFR32MG24A020F1024IM40"
assert m["sdk"] == "simplicity_sdk:2025.12.2"
assert m["gbl"]["fw_type"] == "zigbee_ncp"
assert m["gbl"]["baudrate"] == 460800
assert m["slcp_defines"]["SL_ZIGBEE_DISCOVERY_TABLE_SIZE"] == 32
print("OK")
'
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add manifests/smlight/smlight_slzb-mr3_dense_zigbee_ncp.yaml
git commit -m "feat: add SLZB-MR3 dense zigbee NCP manifest

MG24 A020 NCP tuned for 200+ device networks: RouteTable=200,
DiscoveryTable=32, RetryQueue=32, HUGE packet buffer heap,
AddressTable=250, BroadcastTable=100, APS dup rejection=96. EUSART
@ 460800 with software XON/XOFF flow control."
```

---

### Task 4: Add the ZBDongle-E dense router manifest

**Files:**
- Create: `manifests/sonoff/sonoff_zbdonglee_dense_zigbee_router.yaml`

- [ ] **Step 1: Ensure `manifests/sonoff/` exists**

```bash
mkdir -p /home/alex/Projects/zigbee/zigbee-dense/manifests/sonoff
```

- [ ] **Step 2: Write the manifest file**

Use the Write tool to create `manifests/sonoff/sonoff_zbdonglee_dense_zigbee_router.yaml` with exactly this content:

```yaml
name: SONOFF ZBDongle-E Dense Zigbee Router
device: EFR32MG21A020F768IM32
base_project: src/zigbee_router
filename: "{manifest_name}_{sdk_version}_{fw_version}_{baudrate}_{fw_variant}"
sdk: "simplicity_sdk:2025.12.2"
toolchain: "12.2.1.20221205"

gbl:
  fw_type: zigbee_router
  baudrate: 115200
  fw_variant: sw_flow

# Custom configuration for large networks (200+ devices)
# See: https://community.silabs.com/s/article/guidelines-for-large-dense-networks-with-emberznet-pro
slcp_defines:
  SL_ZIGBEE_ROUTE_TABLE_SIZE: 200           # CRITICAL! Default 16 is too small for 200 devices
  SL_ZIGBEE_DISCOVERY_TABLE_SIZE: 32        # Increased from 16

add_components:
  # Status LED
  - id: simple_led
    instance:
      - led0
  # BOOT button
  - id: simple_button
    instance:
      - btn1

c_defines:
  SL_IOSTREAM_USART_VCOM_BAUDRATE: 115200
  SL_IOSTREAM_USART_VCOM_FLOW_CONTROL_TYPE: uartFlowControlSoftware

  SL_IOSTREAM_USART_VCOM_PERIPHERAL: USART0
  SL_IOSTREAM_USART_VCOM_PERIPHERAL_NO: 0

  SL_IOSTREAM_USART_VCOM_TX_PORT: SL_GPIO_PORT_B
  SL_IOSTREAM_USART_VCOM_TX_PIN: 1

  SL_IOSTREAM_USART_VCOM_RX_PORT: SL_GPIO_PORT_B
  SL_IOSTREAM_USART_VCOM_RX_PIN: 0

  SL_IOSTREAM_USART_VCOM_CTS_PORT: 0
  SL_IOSTREAM_USART_VCOM_CTS_PIN: 0

  SL_IOSTREAM_USART_VCOM_RTS_PORT: 0
  SL_IOSTREAM_USART_VCOM_RTS_PIN: 0

  SL_SIMPLE_LED_LED0_POLARITY: SL_SIMPLE_LED_POLARITY_ACTIVE_LOW
  SL_SIMPLE_LED_LED0_PORT: SL_GPIO_PORT_C
  SL_SIMPLE_LED_LED0_PIN: 0

  SL_SIMPLE_BUTTON_BTN1_MODE: SL_SIMPLE_BUTTON_MODE_INTERRUPT
  SL_SIMPLE_BUTTON_BTN1_PORT: SL_GPIO_PORT_A
  SL_SIMPLE_BUTTON_BTN1_PIN: 0

  SL_CLOCK_MANAGER_HFXO_EN: 1
  SL_CLOCK_MANAGER_HFXO_CTUNE: 128
  SL_CLOCK_MANAGER_DEFAULT_HF_CLOCK_SOURCE: SL_CLOCK_MANAGER_DEFAULT_HF_CLOCK_SOURCE_HFXO

  SL_RAIL_UTIL_RSSI_OFFSET: -11

  # Large network optimizations for MG21 (768KB flash, limited RAM)
  SL_ZIGBEE_PACKET_BUFFER_HEAP_SIZE: SL_ZIGBEE_LARGE_PACKET_BUFFER_HEAP
  SL_ZIGBEE_ADDRESS_TABLE_SIZE: 64          # Increased from 32 (MG21 default)
  SL_ZIGBEE_BROADCAST_TABLE_SIZE: 64        # Increased from 30
  SL_ZIGBEE_APS_UNICAST_MESSAGE_COUNT: 96   # Increased from 64 (MG21 default)
```

Key differences vs the fork source (commit `87605e0`) per the spec:

- `name` updated to `SONOFF ZBDongle-E Dense Zigbee Router`
- `sdk` bumped from `simplicity_sdk:2025.6.2` to `simplicity_sdk:2025.12.2`
- `filename` pattern aligned with the other two manifests: added `{sdk_version}_{fw_version}` in place of the old `{ezsp_version}`
- `gbl.ezsp_version: dynamic` removed (NCP-only field; the upstream reference router manifest for this device does not set it)

Everything else kept verbatim.

- [ ] **Step 3: Verify the manifest is valid YAML and has the required top-level keys**

```bash
python3 -c '
import yaml
with open("/home/alex/Projects/zigbee/zigbee-dense/manifests/sonoff/sonoff_zbdonglee_dense_zigbee_router.yaml") as f:
    m = yaml.safe_load(f)
for k in ("name", "device", "base_project", "filename", "sdk", "gbl", "slcp_defines", "c_defines", "add_components"):
    assert k in m, f"missing key: {k}"
assert m["device"] == "EFR32MG21A020F768IM32"
assert m["sdk"] == "simplicity_sdk:2025.12.2"
assert m["gbl"]["fw_type"] == "zigbee_router"
assert m["gbl"]["baudrate"] == 115200
assert "ezsp_version" not in m["gbl"], "ezsp_version should have been removed (NCP-only field)"
assert m["slcp_defines"]["SL_ZIGBEE_ROUTE_TABLE_SIZE"] == 200
print("OK")
'
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add manifests/sonoff/sonoff_zbdonglee_dense_zigbee_router.yaml
git commit -m "feat: add ZBDongle-E dense zigbee router manifest

MG21 A020 router tuned for 200+ device networks: RouteTable=200,
DiscoveryTable=32, LARGE packet buffer heap, AddressTable=64,
BroadcastTable=64, APS unicast queue=96. USART @ 115200 with software
flow control. Targets SDK 2025.12.2 (ported from fork's 2025.6.2
mega_router variant)."
```

---

### Task 5: Run CI and verify release contents

**Files:** none touched.

- [ ] **Step 1: Push all commits**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git push
```

Expected: push succeeds.

- [ ] **Step 2: Trigger the workflow**

```bash
gh workflow run build.yaml -R AlexMKX/zigbee-dense
sleep 5
gh run list -R AlexMKX/zigbee-dense --limit 1
```

Expected: a new row with `in_progress` status.

- [ ] **Step 3: Watch the run to completion**

```bash
RUN_ID=$(gh run list -R AlexMKX/zigbee-dense --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" -R AlexMKX/zigbee-dense
```

Expected: all of these jobs end with a green checkmark:

- `Discover — clone upstream, compute image tag, build matrix`
- `Check if container image exists in ghcr` (should find image already)
- `Build container image from upstream Dockerfile` (should be **skipped** — cached image)
- `Build firmware (manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml)`
- `Build firmware (manifests/smlight/smlight_slzb-mr3_dense_zigbee_ncp.yaml)`
- `Build firmware (manifests/sonoff/sonoff_zbdonglee_dense_zigbee_router.yaml)`
- `Publish GitHub Release`

The three `Build firmware` jobs run in parallel. `fail-fast: false` ensures a single manifest failure does not cancel the others.

- [ ] **Step 4: Confirm the discover job logged the patch application**

```bash
gh run view "$RUN_ID" -R AlexMKX/zigbee-dense --log 2>&1 \
    | grep -E 'Applying patches/0001|Apply patches to upstream' \
    | head -10
```

Expected: at least one line like `Applying patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch` (emitted by the `Apply patches to upstream` step in the `discover` job).

- [ ] **Step 5: List the latest release and confirm three .gbl assets**

```bash
gh release list -R AlexMKX/zigbee-dense --limit 1
LATEST_TAG=$(gh release list -R AlexMKX/zigbee-dense --limit 1 --json tagName -q '.[0].tagName')
gh release view "$LATEST_TAG" -R AlexMKX/zigbee-dense --json assets -q '.assets[].name'
```

Expected exactly three filenames in the output:

1. `smlight_slzb06mu_dense_zigbee_router_2025.12.2_*.gbl`
2. `smlight_slzb-mr3_dense_zigbee_ncp_2025.12.2_*_460800_sw_flow.gbl`
3. `sonoff_zbdonglee_dense_zigbee_router_2025.12.2_*_115200_sw_flow.gbl`

- [ ] **Step 6: (Manual inspection) Verify MR3 NCP picked up the DISCOVERY_TABLE_SIZE override on xg24**

This is the spec's acceptance heuristic for the patch correctness. Download the MR3 build log and grep for the override being applied:

```bash
gh run view "$RUN_ID" -R AlexMKX/zigbee-dense --log 2>&1 \
    | grep -E 'smlight_slzb-mr3.*(SL_ZIGBEE_DISCOVERY_TABLE_SIZE|SL_ZIGBEE_ROUTE_TABLE_SIZE)' \
    | head -20
```

(The `smlight_slzb-mr3` prefix in the grep narrows the match to lines from the MR3 NCP build job's container output, as `gh run view --log` streams logs from every job with a `<job-name> <step-name>` prefix on each line.)

Expected: `build_project.py` log lines showing `SL_ZIGBEE_DISCOVERY_TABLE_SIZE=32` and `SL_ZIGBEE_ROUTE_TABLE_SIZE=200` being written into the generated `.slcp` (the exact log format comes from upstream; what matters is that the values appear with our numbers, not the defaults 16/16).

If this grep is empty, the build tool does not print the overrides by default — in that case download the processed `.slcp` from the build artifact if upstream uploads it, or re-run locally via `scripts/build-local.sh` and inspect `upstream/build/zigbee_ncp.slcp` directly.

- [ ] **Step 7: No commit** (verification-only task)

The `release` commit is implicit — `softprops/action-gh-release@v3` produces a tag and release but does not create a commit on `main`.

---

## Spec coverage check (self-review)

Mapping each spec section to tasks:

- **Goal / Scope — three firmwares, no flash**: Tasks 3, 4 add the two new manifests; existing SLZB-06MU manifest (already in repo) covers the third. Task 5 verifies all three ship as GitHub release assets.
- **Upstream patch — rationale, source, storage, application**: Task 1 writes `patches/0001-*.patch` with the exact format-patch content. Task 2 adds the `Apply patches to upstream` step to the `discover` job.
- **New manifest `smlight_slzb-mr3_dense_zigbee_ncp.yaml`**: Task 3, with the two spec'd mutations vs fork source applied.
- **New manifest `sonoff_zbdonglee_dense_zigbee_router.yaml`**: Task 4, with the four spec'd mutations (name, sdk, filename, drop ezsp_version) applied.
- **Workflow changes — single edit, location, nullglob**: Task 2 Steps 2–4.
- **Matrix execution and release bundling**: Task 5 Step 5 checks the release contains three `.gbl` files.
- **Risks 1 (image cache hit), 2 (patch rot), 3 (MG21 budget), 4 (patch failure hard-fails)**: Task 1 Step 2 proves patch-rot risk is zero for current upstream head. Task 2 Step 2 arranges the patch to hard-fail the `discover` job if it rots in future. Risks 1 and 3 are validated by observation during Task 5: image cache hit shows as `Build container image from upstream Dockerfile` being `skipped`; MG21 budget issue would surface as a linker error inside the ZBDongle-E build job — if that happens, handle as a follow-up commit per spec Risk 3.
- **Testing / acceptance**: Task 5 Step 5 (three-asset release) + Step 6 (patch effect inspection).
