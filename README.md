# zigbee-dense

Custom Silabs Zigbee firmware manifests for dense meshes, built via the
[Nerivec/silabs-firmware-builder](https://github.com/Nerivec/silabs-firmware-builder)
toolchain. **Not a fork.** The upstream repository is cloned at CI runtime;
this repository contains only the delta: our manifest YAMLs, a workflow, and
docs.

## Grabbing firmware

1. Open the [Releases page](https://github.com/AlexMKX/zigbee-dense/releases).
2. Pick the latest `build-YYYYMMDD-HHMMSS` release.
3. Download the `.gbl` file matching your device (filename includes manifest
   name, e.g. `smlight_slzb06mu_dense_zigbee_router_*.gbl`).
4. Flash using your vendor's tool. For SMLIGHT SLZB-06 series via the
   device's web UI:
   - Open `http://<device-ip>/` and upload via the Firmware page, **or**
   - Scripted:
     ```bash
     curl -F "update=@firmware.gbl" "http://<device-ip>/fileUpload?customName=/fw.bin"
     curl "http://<device-ip>/api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=1"
     ```

## Adding a manifest

1. Drop `manifests/<vendor>/<name>.yaml` — see the existing dense-router
   manifest as a template. The `base_project` field must reference a
   directory that exists in the upstream branch pinned by `upstream.conf`
   (e.g. `src/zigbee_router`). All customization goes through
   `slcp_defines`, `configuration`, `c_defines`, and `add_components` —
   **no `src/` patches** in this repo.
2. PR, review, merge.
3. Actions → **Build firmwares** → **Run workflow**.

## Building locally

Requires Docker and about 15 GB of free disk for the toolchain image on the
first run. Subsequent runs pull the cached image from our ghcr.

```bash
./scripts/build-local.sh manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```

Output lands in `./tmp-out/`. The script clones upstream, computes the same
Docker image tag CI uses, pulls it from `ghcr.io/alexmkx/zigbee-dense`, and
invokes `tools/build_project.py` in the container. If the image is not yet
in ghcr (e.g. after bumping `upstream.conf` before any CI run), the script
builds it locally from the upstream `Dockerfile`.

## Upstream pinning

`upstream.conf` pins the Nerivec branch:

```
UPSTREAM_REPO=https://github.com/Nerivec/silabs-firmware-builder
UPSTREAM_BRANCH=sisdk-2025.12.x
```

Bump = one-line PR. The first CI run after a bump rebuilds the Docker image
(~15-20 min); subsequent runs reuse it (~5 min).

**If a fix requires changing `src/` in upstream** (`app.c`, zap files, SDK
patches) — open a PR against upstream first. This repository does **not**
carry src/ patches.

## License

MIT. Upstream toolchain and Silabs SDK are licensed by their respective
vendors.


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
