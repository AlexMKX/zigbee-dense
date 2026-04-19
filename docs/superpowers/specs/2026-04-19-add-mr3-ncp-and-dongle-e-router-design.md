# Design: Add MR3 Dense NCP and Dongle-E Dense Router manifests

Status: approved
Date: 2026-04-19
Related: `2026-04-19-zigbee-dense-design.md`

## Goal

Extend the `zigbee-dense` build pipeline to produce three firmwares per release
instead of one:

1. SMLIGHT SLZB-06MU Dense Zigbee Router (existing — SLZB-06MU on MG24 A020)
2. SMLIGHT SLZB-MR3 Dense Zigbee NCP @ 460800 sw-flow (new — MG24 A020)
3. SONOFF ZBDongle-E Dense Zigbee Router (new — MG21 A020)

No flashing. Build and publish to GitHub Release only.

## Scope

In scope:

- Add two new manifest files under `manifests/`.
- Add a patch to `tools/build_project.py` that is applied at CI time to the
  cloned upstream. The patch makes manifest overrides affect every matching
  entry in `*.slcp` instead of only the first one.
- Add a `Apply patches to upstream` step in the workflow, running in the
  `discover` job after `Clone upstream` and before the upstream tarball is
  uploaded, so downstream `build` jobs receive already-patched sources.

Out of scope:

- Flashing / OTA for any device.
- Changes to the Docker image layer (patch only touches `tools/`, not
  `Dockerfile`/`requirements.txt`, so the image hash is unchanged and cached
  image is reused).
- Supporting multiple upstream SDK versions in parallel. All three manifests
  target `simplicity_sdk:2025.12.2`.

## Upstream patch

Source: `d4e6ff6` on branch `mr3-dense-router-2025.12.x` in the fork
`zigbee-silabs-firmware`. Original upstream path: `tools/build_project.py`,
function `main`, around line 608 in `sisdk-2025.12.x`.

Why needed: the upstream loop inside `main` iterates both `configuration` and
`slcp_defines`. For each `(name, value)` from the manifest it scans
`output_config` (the base project's list) and at the first match writes the
value and `break`s. Several base projects — notably `src/zigbee_ncp/zigbee_ncp.slcp` — declare the **same** define name multiple times, once per MCU family (xg21, xg24, xg26). Without the patch, our manifest override for
`SL_ZIGBEE_DISCOVERY_TABLE_SIZE` (and several others) lands only in the xg21
entry and the xg24 build silently uses the upstream default.

Patch logic: replace the `for`/`break`/`else` pattern with a `found_existing`
flag that is set inside the loop; after the loop, append only if it is still
false. This overwrites **every** matching entry.

Storage: `patches/0001-build-apply-manifest-overrides-to-all-matching-slcp-entries.patch`, in unified diff format, with the same content as `git
format-patch -1 d4e6ff6 -- tools/build_project.py` produces.

Application: in the `discover` job, after `Clone upstream`, run

```
for p in patches/*.patch; do
  git -C upstream apply --verbose "$GITHUB_WORKSPACE/$p"
done
```

Failure semantics: `git apply` exits non-zero if the patch does not apply
cleanly; the `discover` job fails immediately and nothing downstream runs.

## New manifests

### `manifests/smlight/smlight_slzb-mr3_dense_zigbee_ncp.yaml`

Byte-for-byte copy of
`manifests/smlight/smlight_slzb_mr3_dense_zigbee_ncp_460800_sw_flow.yaml` at
commit `afbf1a8` on branch `mr3-dense-router-2025.12.x`, with these two
changes:

1. `name:` changed to `"SMLIGHT SLZB-MR3 Dense Zigbee NCP"` (the `(Optimized
   for 200+ devices)` tail is kept as a comment, not in `name`, so the
   `gbl_metadata` split on spaces does not break).
2. `filename:` kept as the upstream convention
   `"{manifest_name}_{sdk_version}_{fw_version}_{baudrate}_{fw_variant}"`; the
   baudrate and fw_variant are already parameterized via `gbl.baudrate=460800`
   and `gbl.fw_variant=sw_flow`, so the rendered filename is
   `smlight_slzb-mr3_dense_zigbee_ncp_2025.12.2_<ezsp>_460800_sw_flow.gbl`.

Everything else (device, slcp_defines, c_defines, SLCP structure, comments) is
kept as-is. The long block of NVM3-clearing instructions at the top is kept
for operator reference even though flashing is out of scope for this change.

### `manifests/sonoff/sonoff_zbdonglee_dense_zigbee_router.yaml`

Based on `manifests/sonoff/sonoff_zbdonglee_mega_router.yaml` at commit
`87605e0` on branch `sonoff-zigbee-dongle-e-mega-router`, with these
changes:

1. `name:` `"SONOFF ZBDongle-E Dense Zigbee Router"`.
2. `sdk:` `"simplicity_sdk:2025.6.2"` → `"simplicity_sdk:2025.12.2"`.
3. `filename:` `"{manifest_name}_{ezsp_version}_{baudrate}_{fw_variant}"` →
   `"{manifest_name}_{sdk_version}_{fw_version}_{baudrate}_{fw_variant}"`,
   matching the other two manifests in this repo.
4. `gbl.ezsp_version: dynamic` — **remove**. The upstream reference
   `manifests/sonoff/sonoff_zbdonglee_zigbee_router.yaml` on `sisdk-2025.12.x`
   does not set it; `ezsp_version` is NCP-only metadata.
5. All `c_defines` keep their original values. In particular
   `SL_IOSTREAM_USART_VCOM_*` (USART, not EUSART, on MG21) is unchanged — the
   upstream reference router on `sisdk-2025.12.x` still uses USART for this
   board.

The large-network-tuning block (`SL_ZIGBEE_ROUTE_TABLE_SIZE: 200`,
`DISCOVERY_TABLE_SIZE: 32`, `ADDRESS_TABLE_SIZE: 64`, `BROADCAST_TABLE_SIZE:
64`, `APS_UNICAST_MESSAGE_COUNT: 96`,
`PACKET_BUFFER_HEAP_SIZE: SL_ZIGBEE_LARGE_PACKET_BUFFER_HEAP`) is kept
verbatim. These are the whole point of this manifest.

## Workflow changes

Single edit: in `.github/workflows/build.yaml`, inside the `discover` job,
insert a new step between `Clone upstream` (around line 36) and `Compute
image tag` (around line 42):

```yaml
- name: Apply patches to upstream
  run: |
    shopt -s nullglob
    for p in patches/*.patch; do
      echo "Applying $p"
      git -C upstream apply --verbose "$GITHUB_WORKSPACE/$p"
    done
```

`nullglob` makes the loop a no-op when `patches/` is empty, which is useful if
the directory is removed later.

Nothing else in the workflow changes. The existing `find manifests -type f
\( -name "*.yaml" -o -name "*.yml" \)` in the matrix step picks up both new
manifests automatically. `fail-fast: false` in the build matrix already
ensures one manifest failure does not cancel the others.

## Matrix execution and release bundling

- `build` matrix expands to three parallel jobs, one per manifest.
- Each writes a separate `firmware-<base>` artifact.
- `release` job uses `merge-multiple: true` and `pattern: firmware-*` to pull
  every artifact into a single `artifacts/` directory, then attaches every
  `artifacts/*.gbl` to one release with tag `build-<utc-timestamp>`. No
  change to the release step is needed.

## Risks

1. **Docker image cache hit.** The image hash is computed from
   `Dockerfile + requirements.txt` only. The patch only touches `tools/`.
   Therefore the cached image at `ghcr.io/alexmkx/zigbee-dense:<hash>` is
   reused, `build-container` is skipped, and each new run only pays the
   firmware build cost. This is the intended behavior.
2. **Patch rot.** If upstream refactors `build_project.py` around line 608,
   `git apply` will fail the `discover` job. Fix: regenerate the patch from a
   fresh upstream clone, or update the `upstream.conf` pin to a known-good
   branch head.
3. **MG21 resource budget.** MG21 A020 has 96 KB RAM / 768 KB flash. The
   `LARGE_PACKET_BUFFER_HEAP` + enlarged tables push RAM close to the limit.
   Fork CI built this manifest successfully on SDK 2025.6.2; SDK 2025.12.2
   may have drifted. If the linker runs out of memory the `build` job fails
   with a clear linker error — handle in a follow-up commit (e.g. drop
   `SL_ZIGBEE_PACKET_BUFFER_HEAP_SIZE` back to default on MG21).
4. **MR3 `SL_ZIGBEE_DISCOVERY_TABLE_SIZE` override requires the patch.** If
   the patch fails to apply and the build keeps running on unpatched upstream,
   the MR3 NCP firmware would silently ship with the default table size on
   xg24. Mitigation is Risk 2's hard failure: the unpatched path simply
   cannot execute.

## Testing / acceptance

The change is accepted when a single `workflow_dispatch` run produces, in one
GitHub Release, three artifacts:

- `smlight_slzb06mu_dense_zigbee_router_*.gbl` (existing)
- `smlight_slzb-mr3_dense_zigbee_ncp_*_460800_sw_flow.gbl`
- `sonoff_zbdonglee_dense_zigbee_router_*_115200_sw_flow.gbl`

No flash-and-verify step is performed. Correctness of the MR3 NCP patched
build is inferred indirectly: the `build` step's `build_project.py` run
logs each override it applies, and the CI job log must show the
`SL_ZIGBEE_DISCOVERY_TABLE_SIZE` override landing on every matching entry.
This is inspected once manually after the first green run and is not wired
into production CI.
