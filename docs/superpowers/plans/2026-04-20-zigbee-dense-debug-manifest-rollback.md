# Zigbee-Dense Debug — Manifest Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll back the abandoned runtime-toggle ZCL cluster `0xFC00` experiment and replace it with two manifest-selected builds (production + debug) for `smlight_slzb06mu_dense_zigbee_router`.

**Architecture:** Delete patches 0002/0003, delete the z2m external converter, strip debug-print `c_defines` from the production manifest, add a parallel `_debug.yaml` manifest that re-adds just those `c_defines`. CI matrix picks up both manifests automatically. Side-effect cleanup on the live Z2M addon so the old converter stops loading.

**Tech Stack:** YAML (silabs-firmware-builder manifests), bash, GitHub Actions, mosquitto (Z2M control), Silicon Labs Simplicity SDK 2025.12.2 build via CI.

**Spec:** `docs/superpowers/specs/2026-04-20-zigbee-dense-debug-manifest-rollback-design.md`

---

## File Structure

Files created or modified:

- **Delete:** `patches/0002-router-add-debug-cluster-0xFC00.patch`
- **Delete:** `patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch`
- **Delete:** `z2m/slzb06mu_dense_router.js` (then remove empty `z2m/` directory)
- **Modify:** `manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml` — drop lines 136–144 (debug `c_defines`) and the trailing comment.
- **Create:** `manifests/smlight/smlight_slzb06mu_dense_zigbee_router_debug.yaml` — copy of the edited production manifest + debug `c_defines`.
- **Modify:** `README.md` — append "Debug builds (SLZB-06MU)" section.

Side-effect on `hassio.h.xxl.cx` (addon `45df7312_zigbee2mqtt`):

- **Delete:** `/addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/external_converters/slzb06mu_dense_router.js`
- **Edit:** `/addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/configuration.yaml` — remove the trailing `external_converters:` block.

Local staging dir housekeeping (`/home/alex/Projects/zigbee/zd-upstream`):

- **Delete branches:** `dbg-cluster-staging`, `app-c-hooks-staging`.

---

## Preflight

- [ ] **Step 0.1: Confirm clean working tree on main**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git status
git log --oneline -3
```
Expected: `On branch main`, `working tree clean`, HEAD is commit
`483aaa3 spec: manifest-based debug rollback (supersedes 2026-04-19 runtime spec)`
or later.
Fail action: stash or commit pending work before starting.

- [ ] **Step 0.2: Confirm the spec is in place**

Run:
```bash
test -f docs/superpowers/specs/2026-04-20-zigbee-dense-debug-manifest-rollback-design.md && echo OK
```
Expected: `OK`.

- [ ] **Step 0.3: Confirm the three files we plan to delete actually exist**

Run:
```bash
ls patches/0002-router-add-debug-cluster-0xFC00.patch \
   patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch \
   z2m/slzb06mu_dense_router.js
```
Expected: all three paths listed (no errors).
Fail action: if any are already missing, skip the corresponding delete step later but note it in the commit message.

- [ ] **Step 0.4: Capture the current production GBL size for a later diff**

Run:
```bash
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
echo "Current release tag: $TAG"
mkdir -p /tmp/zd-before
gh release download "$TAG" -R AlexMKX/zigbee-dense \
    -p 'smlight_slzb06mu_dense_zigbee_router_*.gbl' \
    -D /tmp/zd-before/ --clobber
ls -l /tmp/zd-before/
```
Expected: one `.gbl`, size ~230 KiB. Record the exact byte size — we want the production GBL in Task 2 to be **smaller** than this (debug print strings + 4 group enables get removed).

---

## Task 1: Delete experiment artefacts from the repo

**Purpose:** physically remove the three files the 0xFC00 experiment left behind. This is a single atomic change to the repo.

**Files:**
- Delete: `patches/0002-router-add-debug-cluster-0xFC00.patch`
- Delete: `patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch`
- Delete: `z2m/slzb06mu_dense_router.js`

- [ ] **Step 1.1: Delete the three files**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git rm patches/0002-router-add-debug-cluster-0xFC00.patch
git rm patches/0003-router-debug-wrapper-and-hooks-in-app-c.patch
git rm z2m/slzb06mu_dense_router.js
```
Expected: three `rm` lines printed by git; `git status` shows `deleted:` for each plus a pending index change.

- [ ] **Step 1.2: Remove the now-empty `z2m/` directory**

`git rm` does not remove the parent directory if it becomes empty. Clean it:
```bash
rmdir z2m 2>/dev/null && echo "z2m/ removed" || echo "z2m/ not empty or already gone"
```
Expected: `z2m/ removed`. If `not empty`, run `ls z2m/` to see what's left and delete anything we missed (we expect nothing — the directory was created solely for that converter).

- [ ] **Step 1.3: Verify patches directory is back to just 0001**

Run:
```bash
ls patches/
```
Expected: a single file, `0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch`.

- [ ] **Step 1.4: Commit**

Run:
```bash
git commit -m "chore: drop cluster 0xFC00 experiment (patches 0002/0003 + z2m converter)"
git log --oneline -1
```
Expected: new commit SHA appears; message as above.

**Do NOT push yet** — Task 2 edits the production manifest in the same CI build.

---

## Task 2: Strip debug `c_defines` from production manifest

**Purpose:** remove the now-useless debug-print enables from the production router manifest so the production GBL has no debug print cost. The debug build gets its own manifest in Task 3.

**Files:**
- Modify: `manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`

- [ ] **Step 2.1: Verify the exact lines we intend to remove**

Run:
```bash
sed -n '136,144p' manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```
Expected output (exactly these 9 lines):
```
  # === Debug print compile-time pins (see docs/superpowers/specs/2026-04-19-zigbee-dense-debug-logging-design.md) ===
  SL_ZIGBEE_DEBUG_STACK_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_STACK_GROUP_RUNTIME_DEFAULT: 1
  SL_ZIGBEE_DEBUG_CORE_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_CORE_GROUP_RUNTIME_DEFAULT: 1
  SL_ZIGBEE_DEBUG_APP_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_APP_GROUP_RUNTIME_DEFAULT: 1
  SL_ZIGBEE_DEBUG_ZCL_GROUP_ENABLED: 1
  SL_ZIGBEE_DEBUG_ZCL_GROUP_RUNTIME_DEFAULT: 1
```
Fail action: if line numbers have shifted, find the block with `grep -n "Debug print compile-time pins" manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml` and adjust the sed range below accordingly. The *content* of the block is what matters, not the line numbers.

- [ ] **Step 2.2: Delete the block**

Run:
```bash
sed -i '/# === Debug print compile-time pins/,/SL_ZIGBEE_DEBUG_ZCL_GROUP_RUNTIME_DEFAULT: 1/d' \
    manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```
Note: this sed range uses content anchors (comment header … last debug macro) rather than raw line numbers. It is safe even if the block has shifted slightly.

- [ ] **Step 2.3: Verify the block is gone, nothing else changed**

Run:
```bash
grep -c "SL_ZIGBEE_DEBUG_" manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
grep -c "SL_ZIGBEE_APS_DUPLICATE_REJECTION_MAX_ENTRIES" manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
tail -3 manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```
Expected:
- first `grep -c` → `0` (all debug defines gone)
- second `grep -c` → `1` (the last non-debug dense-router define is still present)
- `tail -3` → the last three lines should be the `SL_ZIGBEE_APS_DUPLICATE_REJECTION_MAX_ENTRIES: 64` line plus the two comment lines immediately preceding it (or similar pre-existing tail — just confirm the file doesn't end mid-block).

- [ ] **Step 2.4: Review the full diff before committing**

Run:
```bash
git diff manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```
Expected: only deletions, 9 lines removed, no additions, no unrelated changes.

- [ ] **Step 2.5: Commit**

Run:
```bash
git add manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
git commit -m "manifest(router): strip compile-time debug group c_defines (moved to _debug variant)"
```

- [ ] **Step 2.6: Push both Task 1 and Task 2 commits, trigger CI**

Run:
```bash
git push origin main
gh workflow run build.yaml -R AlexMKX/zigbee-dense
echo "Waiting 30 s for the run to register..."
sleep 30
gh run list -R AlexMKX/zigbee-dense -L 1
```
Expected: latest run is `in_progress` or `queued`. If it's not queued, re-run `gh workflow run build.yaml -R AlexMKX/zigbee-dense`.

- [ ] **Step 2.7: Wait for CI to finish**

Run:
```bash
gh run watch -R AlexMKX/zigbee-dense
```
Expected: terminal output ends with `✓ Build firmwares` success. If it fails, read the log with `gh run view <id> --log-failed` and stop — fix before Task 3.

- [ ] **Step 2.8: Download the new production GBL and confirm it shrank**

Run:
```bash
mkdir -p /tmp/zd-task2
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
echo "New tag: $TAG"
gh release download "$TAG" -R AlexMKX/zigbee-dense \
    -p 'smlight_slzb06mu_dense_zigbee_router_*.gbl' \
    -D /tmp/zd-task2/ --clobber
BEFORE=$(stat -c %s /tmp/zd-before/*.gbl)
AFTER=$(stat -c %s /tmp/zd-task2/*.gbl)
echo "before: $BEFORE  after: $AFTER  delta: $((BEFORE - AFTER))"
```
Expected: `delta` is positive — the GBL got smaller (debug print strings and group metadata removed). A delta of ~1–5 KiB is reasonable. If `delta` is ≤ 0, the build did not actually drop debug print — investigate before proceeding.

- [ ] **Step 2.9: Flash the new production GBL to the device**

Run:
```bash
SLZB_HOST=192.168.88.236 ./scripts/flash-slzb06mu.sh \
    /tmp/zd-task2/smlight_slzb06mu_dense_zigbee_router_2025.12.2_9.0.1_115200_sw_flow.gbl
```
Expected: script ends with `Back online (coord_mode=2 / Zigbee Router)`.
If device IP changed (check with `ping 192.168.88.236` first), adjust `SLZB_HOST`.

- [ ] **Step 2.10: Verify the device rejoins Z2M as a plain SLZB-06MU**

Run:
```bash
sleep 60  # give it time to rejoin
IEEE="0x385c040001a7dd93"
ssh root@hassio.h.xxl.cx "mosquitto_sub -h core-mosquitto -t 'zigbee2mqtt/bridge/devices' -C 1 -W 5 2>/dev/null | python3 -c \"
import json, sys
for d in json.load(sys.stdin):
    if d.get('ieee_address') == '$IEEE':
        eps = d.get('endpoints', {})
        print('model_id:', d.get('model_id'))
        print('ep1 input:', eps.get('1', {}).get('clusters', {}).get('input'))
        print('definition.source:', (d.get('definition') or {}).get('source'))
\""
```
Expected:
- `model_id: SLZB-06MU`
- `ep1 input: ['genBasic', 'genIdentify', 'keepAlive']` (note: no trailing `None` — `quirkAddEndpointCluster` is about to be unloaded, but the forced-added cluster will persist in the Z2M database until we remove the converter in Task 4).
- `definition.source` is still `generated` (our converter is still active on Z2M until Task 4 runs).

Partial match is OK here — the full cleanup happens in Task 4.

---

## Task 3: Add the `_debug` manifest

**Purpose:** create a parallel manifest that produces a second GBL with all four debug-print groups enabled at compile time.

**Files:**
- Create: `manifests/smlight/smlight_slzb06mu_dense_zigbee_router_debug.yaml`

- [ ] **Step 3.1: Copy the production manifest**

Run:
```bash
cp manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml \
   manifests/smlight/smlight_slzb06mu_dense_zigbee_router_debug.yaml
```

- [ ] **Step 3.2: Edit the `name:` field**

Open `manifests/smlight/smlight_slzb06mu_dense_zigbee_router_debug.yaml`. The first line reads:

```
name: SMLIGHT SLZB-06MU Dense Zigbee Router (Optimized for ~150-device mesh)
```

Change it to:

```
name: SMLIGHT SLZB-06MU Dense Zigbee Router — DEBUG build (UART tracing enabled)
```

- [ ] **Step 3.3: Insert the "do not edit" header comment at the very top**

Insert **before** the `name:` line (make it the new first line of the file):

```yaml
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

- [ ] **Step 3.4: Append the debug `c_defines` block to the end of the `c_defines:` block**

The file ends with the `SL_ZIGBEE_APS_DUPLICATE_REJECTION_MAX_ENTRIES: 64` line (and its comment). Append the following, preserving two-space YAML indentation to stay inside `c_defines:`:

```yaml

  # === Debug print compile-time enables (this is the DEBUG build) ===
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

- [ ] **Step 3.5: Verify the debug manifest is a superset of production**

Run:
```bash
diff manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml \
     manifests/smlight/smlight_slzb06mu_dense_zigbee_router_debug.yaml
```
Expected diff structure (shown abstractly):
- Header comment block added at top of `_debug.yaml`
- `name:` line differs (suffix `DEBUG build…`)
- 8 debug `c_defines` lines added at the bottom

No other differences. If there are, re-do Step 3.1 (fresh copy) and re-apply only the three intentional edits.

- [ ] **Step 3.6: Parse the new YAML to make sure it's valid**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('manifests/smlight/smlight_slzb06mu_dense_zigbee_router_debug.yaml'))" \
    && echo "YAML OK"
```
Expected: `YAML OK`.

- [ ] **Step 3.7: Commit**

Run:
```bash
git add manifests/smlight/smlight_slzb06mu_dense_zigbee_router_debug.yaml
git commit -m "manifest(router): add _debug variant with compile-time debug-print groups"
```

- [ ] **Step 3.8: Push and build**

Run:
```bash
git push origin main
gh workflow run build.yaml -R AlexMKX/zigbee-dense
sleep 30
gh run watch -R AlexMKX/zigbee-dense
```
Expected: CI finishes green; the new release now contains **two** SLZB-06MU GBLs.

- [ ] **Step 3.9: Verify both GBLs are published**

Run:
```bash
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
gh release view "$TAG" -R AlexMKX/zigbee-dense --json assets \
    | python3 -c 'import json,sys; [print(a["name"]) for a in json.load(sys.stdin)["assets"]]' \
    | grep slzb06mu
```
Expected: two matching lines —
- `smlight_slzb06mu_dense_zigbee_router_2025.12.2_9.0.1_115200_sw_flow.gbl`
- `smlight_slzb06mu_dense_zigbee_router_debug_2025.12.2_9.0.1_115200_sw_flow.gbl`

- [ ] **Step 3.10: Sanity-check the debug GBL has extra strings**

Run:
```bash
mkdir -p /tmp/zd-task3
gh release download "$TAG" -R AlexMKX/zigbee-dense \
    -p 'smlight_slzb06mu_dense_zigbee_router_*.gbl' \
    -D /tmp/zd-task3/ --clobber
PROD=/tmp/zd-task3/smlight_slzb06mu_dense_zigbee_router_2025.12.2_9.0.1_115200_sw_flow.gbl
DEBUG=/tmp/zd-task3/smlight_slzb06mu_dense_zigbee_router_debug_2025.12.2_9.0.1_115200_sw_flow.gbl
echo "prod  size: $(stat -c %s "$PROD")"
echo "debug size: $(stat -c %s "$DEBUG")"
PROD_MATCHES=$(strings "$PROD"  | grep -c -E 'ERR:|Starting discovery' || true)
DEBUG_MATCHES=$(strings "$DEBUG" | grep -c -E 'ERR:|Starting discovery' || true)
echo "prod  diag-string matches: $PROD_MATCHES"
echo "debug diag-string matches: $DEBUG_MATCHES"
```
Expected: `debug size` > `prod size` by at least 500 bytes, and `DEBUG_MATCHES` > `PROD_MATCHES`. If both equal zero, the debug groups didn't actually enable anything — revisit the debug `c_defines` spellings before proceeding.

**Flashing the debug GBL on the device is optional for this plan.** We're only confirming CI produces the artefact correctly.

---

## Task 4: Clean Z2M addon state

**Purpose:** stop loading the defunct `slzb06mu_dense_router.js` converter. After this runs the device looks like a plain SLZB-06MU Router in Z2M (`supported: False`, generated definition).

**Files (on hassio.h.xxl.cx):**
- Delete: `/addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/external_converters/slzb06mu_dense_router.js`
- Modify: `/addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/configuration.yaml`

- [ ] **Step 4.1: Confirm the converter file and config entry exist**

Run:
```bash
ssh root@hassio.h.xxl.cx "ls /addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/external_converters/slzb06mu_dense_router.js && tail -3 /addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/configuration.yaml"
```
Expected:
- the file path echoed
- last lines of `configuration.yaml` end with:
  ```
  external_converters:
    - slzb06mu_dense_router.js
  ```
  (there may be an empty line just before `external_converters:`).

- [ ] **Step 4.2: Delete the converter file**

Run:
```bash
ssh root@hassio.h.xxl.cx "rm /addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/external_converters/slzb06mu_dense_router.js"
ssh root@hassio.h.xxl.cx "ls /addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/external_converters/" \
    | grep slzb06mu && echo "FAIL" || echo "gone"
```
Expected: `gone`.

- [ ] **Step 4.3: Remove the `external_converters:` block from `configuration.yaml`**

The block we added is **at the very end of the file**, preceded by an empty line. We need the file to end again at `version: 5`.

Run:
```bash
ssh root@hassio.h.xxl.cx "python3 -c \"
import re
p = '/addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/configuration.yaml'
s = open(p).read()
# Strip the trailing external_converters block we added (any leading blank
# lines + the key + one list item + trailing newline)
s2 = re.sub(r'\n*external_converters:\n  - slzb06mu_dense_router\.js\n*$', '\n', s)
if s == s2:
    print('NO-OP — pattern not found; check file manually')
else:
    open(p, 'w').write(s2)
    print('edited')
\""
ssh root@hassio.h.xxl.cx "tail -3 /addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/configuration.yaml"
```
Expected: python prints `edited`. The `tail -3` now ends with `version: 5`, no `external_converters:` in sight. If python prints `NO-OP`, log into the host and remove the block by hand — the file may have had slightly different whitespace.

- [ ] **Step 4.4: Restart Z2M and wait for it to come back online**

Run:
```bash
ssh root@hassio.h.xxl.cx "mosquitto_pub -h core-mosquitto -t 'zigbee2mqtt/bridge/request/restart' -m '{}'"
echo "Waiting 30 s for Z2M to restart..."
sleep 30
ssh root@hassio.h.xxl.cx "mosquitto_sub -h core-mosquitto -t 'zigbee2mqtt/bridge/state' -C 1 -W 10"
```
Expected: `{"state":"online"}`.

- [ ] **Step 4.5: Check the Z2M log for our converter — there should be zero mentions**

Run:
```bash
ssh root@hassio.h.xxl.cx "docker logs --since 2m addon_45df7312_zigbee2mqtt 2>&1 | grep -iE 'slzb06mu_dense|external.*convert|SLZB-06MU-dense-router' | head -10"
```
Expected: no output. The converter is no longer being loaded.

- [ ] **Step 4.6: Confirm the device definition is back to SMLIGHT-generated**

Run:
```bash
sleep 60   # give the device time to reannounce
IEEE="0x385c040001a7dd93"
ssh root@hassio.h.xxl.cx "mosquitto_sub -h core-mosquitto -t 'zigbee2mqtt/bridge/devices' -C 1 -W 5 2>/dev/null | python3 -c \"
import json, sys
for d in json.load(sys.stdin):
    if d.get('ieee_address') == '$IEEE':
        defi = d.get('definition') or {}
        print('model_id:', d.get('model_id'))
        print('definition.vendor:', defi.get('vendor'))
        print('definition.model:', defi.get('model'))
        print('definition.source:', defi.get('source'))
        print('supported:', d.get('supported'))
\""
```
Expected:
- `model_id: SLZB-06MU`
- `definition.vendor: SMLIGHT` (Z2M's auto-generated stub), NOT `AlexMKX`
- `definition.model: SLZB-06MU`
- `definition.source: generated`
- `supported: False`

If `definition.vendor` is still `AlexMKX`, the converter did not get unloaded — check `Step 4.5` log again and restart Z2M once more.

---

## Task 5: Append "Debug builds" section to README

**Purpose:** operators (including future-you) need to know the debug GBL exists and how to read its output.

**Files:**
- Modify: `README.md`

- [ ] **Step 5.1: Append the new section at the end of the file**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
cat >> README.md <<'EOF'

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

1. In SLZB-OS UI → Zigbee → Working mode → switch to
   "Zigbee2MQTT / TCP socket". Reboot when prompted.
2. `nc <device-ip> 6638 | strings` — text lines will stream as the
   firmware emits them.
3. When done, switch the device back to "Zigbee Router" mode so it
   rejoins the mesh as a router.

Important: while in TCP coordinator mode the device is **not** acting as
a router. Switch back as soon as the capture session is done.
EOF
```

- [ ] **Step 5.2: Verify the append landed correctly**

Run:
```bash
tail -30 README.md
```
Expected: the section above is visible at the end, with the table rendered correctly and no duplicate headings.

- [ ] **Step 5.3: Commit and push**

Run:
```bash
git add README.md
git commit -m "doc: document production vs _debug GBLs and UART-capture procedure"
git push origin main
```

CI will build again on push — wait for it and confirm it is still green.

- [ ] **Step 5.4: Watch the CI run**

Run:
```bash
# If the workflow only runs on workflow_dispatch and not on push, this is a no-op.
gh run list -R AlexMKX/zigbee-dense -L 1
```
Expected: if a run is in progress, wait with `gh run watch`. If no new run was triggered by the push (workflow is `workflow_dispatch` only in the current file), manually trigger:
```bash
gh workflow run build.yaml -R AlexMKX/zigbee-dense
gh run watch -R AlexMKX/zigbee-dense
```
Expected: green build.

---

## Task 6: Clean local staging branches in `zd-upstream`

**Purpose:** delete the two scratch branches that held the 0xFC00 work. Purely local housekeeping; does not touch remotes.

**Files:** none (branch deletions only).

- [ ] **Step 6.1: Confirm you're not currently on either branch**

Run:
```bash
cd /home/alex/Projects/zigbee/zd-upstream
git branch --show-current
```
Expected: `sisdk-2025.12.x` (or any branch that isn't one we're about to delete).
If it says `dbg-cluster-staging` or `app-c-hooks-staging`, run
`git checkout sisdk-2025.12.x` first.

- [ ] **Step 6.2: Delete both staging branches**

Run:
```bash
git branch -D dbg-cluster-staging
git branch -D app-c-hooks-staging
```
Expected: two `Deleted branch …` lines. These branches are local-only, so no push cleanup is needed.

If one of them does not exist, that's fine — the experiment left them at different times and one may already have been cleaned up.

- [ ] **Step 6.3: Confirm final branch state**

Run:
```bash
git branch -a
```
Expected: only `sisdk-2025.12.x` (local + remote tracking). No `dbg-cluster-staging`, no `app-c-hooks-staging`.

- [ ] **Step 6.4: Confirm patch 0001 still applies cleanly to upstream HEAD**

Run:
```bash
git checkout sisdk-2025.12.x
git reset --hard origin/sisdk-2025.12.x   # make sure we match what CI clones
git apply --check \
    /home/alex/Projects/zigbee/zigbee-dense/patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch \
    && echo "0001 applies cleanly"
```
Expected: `0001 applies cleanly`. If not, upstream has shifted — open a follow-up task to rebase 0001. It is not expected to be broken by this plan.

---

## Task 7: Final verification checklist

**Purpose:** walk through the spec one more time and confirm every promise was kept.

- [ ] **Step 7.1: Repo state matches the target layout**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
ls patches/ manifests/smlight/
test -d z2m && echo "FAIL: z2m/ still exists" || echo "OK: no z2m/"
```
Expected:
- `patches/` contains exactly `0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch`
- `manifests/smlight/` contains exactly three files:
  - `smlight_slzb-mr3_dense_zigbee_ncp.yaml`
  - `smlight_slzb06mu_dense_zigbee_router.yaml`
  - `smlight_slzb06mu_dense_zigbee_router_debug.yaml`
- `OK: no z2m/`

- [ ] **Step 7.2: Latest release has the expected four GBLs**

Run:
```bash
TAG=$(gh release list -R AlexMKX/zigbee-dense -L 1 --json tagName -q '.[0].tagName')
gh release view "$TAG" -R AlexMKX/zigbee-dense --json assets \
    | python3 -c 'import json,sys; [print(a["name"]) for a in json.load(sys.stdin)["assets"]]' \
    | sort
```
Expected (order by manifest alphabet):
```
smlight_slzb-mr3_dense_zigbee_ncp_2025.12.2_9.0.1_460800_sw_flow.gbl
smlight_slzb06mu_dense_zigbee_router_2025.12.2_9.0.1_115200_sw_flow.gbl
smlight_slzb06mu_dense_zigbee_router_debug_2025.12.2_9.0.1_115200_sw_flow.gbl
sonoff_zbdonglee_dense_zigbee_router_2025.12.2_9.0.1_115200_sw_flow.gbl
```

- [ ] **Step 7.3: Device is alive, plain SLZB-06MU on the Z2M side**

Run:
```bash
IEEE="0x385c040001a7dd93"
ssh root@hassio.h.xxl.cx "mosquitto_sub -h core-mosquitto -t 'zigbee2mqtt/bridge/devices' -C 1 -W 5 2>/dev/null | python3 -c \"
import json, sys
for d in json.load(sys.stdin):
    if d.get('ieee_address') == '$IEEE':
        print('OK' if d.get('model_id') == 'SLZB-06MU' and d.get('interview_completed') and (d.get('definition') or {}).get('source') == 'generated' else 'FAIL', d.get('model_id'), d.get('interview_completed'))
\""
```
Expected: `OK SLZB-06MU True`.

- [ ] **Step 7.4: Z2M config and external-converters dir both clean**

Run:
```bash
ssh root@hassio.h.xxl.cx "grep -c 'external_converters' /addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/configuration.yaml
ls /addon_configs/45df7312_zigbee2mqtt/zigbee2mqtt/external_converters/ | grep slzb06mu_dense_router || echo 'no slzb06mu_dense_router converter'"
```
Expected: `0` (no `external_converters` key) and `no slzb06mu_dense_router converter`.

- [ ] **Step 7.5: Nothing left pending in the working tree**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git status
git log --oneline -8
```
Expected: `working tree clean`. The last six commits should, roughly in order, be: the Task 1 delete, Task 2 manifest strip, Task 3 debug manifest add, Task 5 README update (Task 4 does not touch the repo, Task 6 does not touch the repo).

Plan complete.
