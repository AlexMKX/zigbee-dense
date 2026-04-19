# zigbee-dense — Design Spec

**Date:** 2026-04-19
**Repo:** https://github.com/AlexMKX/zigbee-dense
**Status:** Draft — pending user review

## 1. Purpose and scope

`zigbee-dense` is a minimal repository that stores **only** our custom Silabs
Zigbee firmware manifests and the CI that builds them using the upstream
`Nerivec/silabs-firmware-builder` toolchain. The upstream repository is **not
forked**; it is cloned at CI runtime.

### In scope

- Hosting our manifest YAML files (currently one: dense router for SLZB-06MU).
- A GitHub Actions workflow that, on manual dispatch, clones upstream, runs
  upstream's `tools/build_project.py` inside upstream's prebuilt `ghcr.io`
  container image, and publishes the resulting `.gbl` files as a GitHub
  Release with auto-generated timestamp tag.
- Local reproduction instructions (bash one-liner + helper script).
- Pin of upstream branch via a single `upstream.conf` file.

### Out of scope (explicit)

- **Upstream `src/` patches.** If a change requires modifying upstream source
  (app.c, zap files, SDK patches), open an upstream PR first.
- **Copies of upstream tree** (`src/`, `tools/`, `Dockerfile`,
  `requirements.txt`). These live only in the upstream repo and are pulled at
  CI runtime.
- **Docker image builds.** We consume `ghcr.io/nerivec/silabs-firmware-builder`
  as-is; we do not publish our own image.
- **Automatic triggers** (push / PR / schedule / release). Only manual
  `workflow_dispatch`.
- **Migration of other vendor manifests** from the current fork. Only the
  dense router manifest is migrated in v1. Stock manifests stay in upstream;
  their built `.gbl` files remain available from upstream releases.
- **Archival or deletion of the current fork** `AlexMKX/silabs-firmware-builder`.
  Separate decision.
- **GBL signing or checksum artifacts.** Upstream doesn't do this; we don't
  either.

### Success criteria

A `gh workflow run build.yaml` invocation finishes green within ~5 minutes
and a new GitHub Release `build-YYYYMMDD-HHMMSS` appears with one or more
`.gbl` files attached, each matching a manifest under `manifests/`. The
resulting `.gbl` is flashable on the target device (SLZB-06MU at
192.168.88.144) via the SLZB web API and the device joins the MR3 network
visible in Z2M — byte-for-byte equivalent behavior to the current fork's
builds, zero regression.

## 2. Repository structure

```
zigbee-dense/
├── .github/
│   └── workflows/
│       └── build.yaml
├── manifests/
│   └── smlight/
│       └── smlight_slzb06mu_dense_zigbee_router.yaml
├── docs/
│   └── superpowers/
│       ├── specs/
│       │   └── 2026-04-19-zigbee-dense-design.md
│       └── plans/
│           └── 2026-04-19-zigbee-dense.md
├── scripts/
│   └── build-local.sh
├── upstream.conf
├── .gitignore
├── LICENSE
└── README.md
```

### Key decisions

- `manifests/<vendor>/*.yaml` mirrors upstream's layout so manifest files
  migrate by plain copy — no path rewrites.
- `upstream.conf` is a two-key shell-sourceable file:
  ```
  UPSTREAM_REPO=https://github.com/Nerivec/silabs-firmware-builder
  UPSTREAM_BRANCH=sisdk-2025.12.x
  ```
  Changing the pinned branch is a one-line PR with explicit history.
- `docs/superpowers/` keeps spec + plan alongside the code, consistent with
  the working style used in the current fork.
- No top-level `src/`, `tools/`, `Dockerfile`, `requirements.txt` — any such
  file appearing in this repo is a bug.

### Initial content

On project completion, `manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`
is copied verbatim from the current fork HEAD
(`/home/alex/Projects/zigbee/zigbee-silabs-firmware/manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`
as of commit `afbf1a8`), which already includes the four recent fixes:
dict-typed `configuration`, MTORR suppression, TX power 20 dBm, PC0 LED.

## 3. CI workflow

Single workflow: `.github/workflows/build.yaml`. Trigger:
`workflow_dispatch` only. Three jobs.

### 3.1 Job `discover` (ubuntu-latest)

Reads `upstream.conf`, clones upstream shallow, computes the container image
tag, builds the manifest matrix, uploads the upstream tree as an artifact
for downstream jobs.

Steps:

1. `actions/checkout@v6` of our repo.
2. Source `upstream.conf` → expose `repo` and `branch` as job outputs.
3. `git clone --depth 1 --branch "$branch" "$repo" upstream`.
4. Compute image tag: `sha256sum upstream/Dockerfile upstream/requirements.txt | sha256sum | cut -c-16`.
   (The upstream CI uses GitHub Actions' `hashFiles()` which produces a
   SHA-256 of concatenated file contents. We reproduce this with
   `sha256sum` piped through `sha256sum` on the two-line digest output,
   then truncate to 16 hex chars. Verification that both formulas agree
   is an explicit plan step; if they diverge, we fall back to probing
   the last few tags via the ghcr tag-list API.)
5. `docker manifest inspect "ghcr.io/nerivec/silabs-firmware-builder:$TAG"` —
   fails the job loudly if the image doesn't exist.
6. Build matrix from `find manifests -type f \( -name "*.yaml" -o -name "*.yml" \)`
   piped through `jq -R -s -c 'split("\n")[:-1]'`.
7. Record upstream HEAD SHA (`git -C upstream rev-parse HEAD`) as job output.
8. `actions/upload-artifact@v7 { name: upstream-src, path: upstream/, retention-days: 1 }`.

Outputs: `image_tag`, `matrix`, `upstream_sha`, `upstream_branch`.

### 3.2 Job `build` (matrix, ubuntu-latest)

Strategy: `fail-fast: false`, matrix element = one manifest path.
Container: `ghcr.io/nerivec/silabs-firmware-builder:${{ needs.discover.outputs.image_tag }}`,
`options: --user root`.

Steps:

1. `actions/checkout@v6` with `path: ours` — our repo lands in
   `$GITHUB_WORKSPACE/ours`.
2. `actions/download-artifact@v8` of `upstream-src` into `upstream/`.
3. Build:
   ```bash
   cd upstream
   git config --global --add safe.directory "$PWD"
   /opt/venv/bin/python3 tools/build_project.py \
     --manifest "$GITHUB_WORKSPACE/ours/${{ matrix.manifest }}" \
     --build-dir build \
     --output-dir outputs \
     --output gbl --output hex --output out \
     --repo-owner "$GITHUB_REPOSITORY_OWNER" \
     --repo-hash $(git -C "$GITHUB_WORKSPACE/ours" rev-parse --short=8 HEAD)
   out_base=$(basename -- "$(ls -1 outputs/*.gbl | head -n 1)" .gbl)
   echo "out_base=$out_base" >> $GITHUB_OUTPUT
   ```
4. `actions/upload-artifact@v7 { name: firmware-<out_base>, path: upstream/outputs/*, if-no-files-found: error }`.

### 3.3 Job `release` (ubuntu-latest, `needs: [discover, build]`)

Permissions: `contents: write`. Concurrency: `group: release, cancel-in-progress: false`.

Steps:

1. `actions/download-artifact@v8 { path: artifacts, merge-multiple: true, pattern: firmware-* }`.
2. Generate tag: `tag=build-$(date -u +%Y%m%d-%H%M%S)`.
3. `softprops/action-gh-release@v3`:
   - `tag_name: ${{ steps.tag.outputs.tag }}`
   - `name: "Build ${{ steps.tag.outputs.tag }}"`
   - `body` includes upstream branch, upstream SHA, image tag
   - `files: artifacts/*.gbl`
   - `generate_release_notes: false`

### 3.4 Rationales

- **Why `checkout our repo → ours/` path**: keeps absolute manifest paths
  deterministic and prevents working-tree collisions with the upstream clone.
- **Why `--repo-hash` is our HEAD**: GBL metadata should identify the
  manifest revision, not upstream.
- **Why `fail-fast: false`**: a single broken manifest must not block the
  others.
- **Why auto-tag always (vs opt-in)**: user explicitly chose auto-tag; each
  dispatch run produces a release.

### 3.5 Explicitly deferred (YAGNI)

- `pre-commit` check (1 manifest — overkill).
- `debug: true` input to upload `build/` dir (add when first needed).
- `manifest_glob` input for selective builds (add when we have >3 manifests).

## 4. Lifecycle and edge cases

### 4.1 User workflows

**Add a manifest.** PR adding `manifests/<vendor>/<name>.yaml` → review →
merge → Actions → Build firmwares → Run workflow → ~5 min → release with
new `.gbl`.

**Update a manifest.** PR editing an existing yaml → merge → run workflow →
new release.

**Bump upstream branch.** PR changing `UPSTREAM_BRANCH=...` in
`upstream.conf` → merge → run workflow. If the new branch has no ghcr image
yet, the `discover` job fails on `docker manifest inspect`. Wait and retry,
or open an upstream issue. If the new SDK breaks a manifest, the `build`
job fails — fix the manifest or revert the pin.

### 4.2 Edge cases

**E1 — upstream ghcr image tag missing.**
`discover` fails on `docker manifest inspect`. Causes: upstream pushed a
Dockerfile change but CI hasn't built yet, or our sha256sum formula
diverges from GitHub's `hashFiles()`. Mitigation v1: fail loudly, README
explains the error. v2 (only if it actually bites): probe
`GET /v2/nerivec/silabs-firmware-builder/tags/list` anonymously and select
the most recent cacheable tag — already proven feasible (ghcr responds with
anonymous token flow).

**E2 — manifest references missing `base_project`.**
`build_project.py` assertion at line 521 trips. Developer's fault; fix the
manifest or bump `upstream.conf`.

**E3 — concurrent dispatches collide on auto-tag.**
`concurrency: group: release, cancel-in-progress: false` on the `release`
job serializes. Manual dispatch — unlikely in practice.

**E4 — upstream ghcr image becomes private.**
Verified anonymous pullable at spec time. If it changes, add
`docker/login-action@v4` with `${{ secrets.GITHUB_TOKEN }}` (works for
public ghcr read of foreign namespaces in most cases).

**E5 — upstream revision traceability.**
Release body includes upstream branch, upstream SHA, image tag.
`build_project.py` embeds our repo hash in GBL metadata (`--repo-hash`).

**E6 — manifest filename collisions.**
Each matrix step uploads to `firmware-<out_base>` artifact; collision only
surfaces on final release asset upload. v1: not solved; if it happens,
rename manifests. Release body SHOULD include `sha256sum *.gbl` for
diagnostics.

**E7 — local build reproduction.**
README documents the bash one-liner. `scripts/build-local.sh` wraps it:
```bash
#!/usr/bin/env bash
set -euo pipefail
MANIFEST="${1:?usage: $0 <manifests/vendor/name.yaml>}"
source ./upstream.conf
CLONE=/tmp/zigbee-dense-upstream
rm -rf "$CLONE"
git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_REPO" "$CLONE"
TAG=$(sha256sum "$CLONE/Dockerfile" "$CLONE/requirements.txt" | sha256sum | cut -c-16)
docker run --rm \
  -v "$PWD:/ours" -v "$CLONE:/ws" -w /ws \
  "ghcr.io/nerivec/silabs-firmware-builder:$TAG" \
  /opt/venv/bin/python3 tools/build_project.py \
    --manifest "/ours/$MANIFEST" \
    --build-dir /tmp/build --output-dir /tmp/out \
    --output gbl --output hex --output out \
    --repo-owner local --repo-hash $(git rev-parse --short=8 HEAD)
echo "Outputs in /tmp/out/"
```

### 4.3 Security / permissions

- `contents: write` only on the `release` job.
- No secrets beyond stock `GITHUB_TOKEN`.
- `actions/checkout@v6` uses default settings (token auto-injected for our
  repo, which is fine — we need it for `release` to push tags/assets).
- No `packages: write` — we never push to ghcr.

## 5. README content

Five short sections:

1. **What this is** — one paragraph: custom manifests built with upstream
   toolchain, not a fork, upstream cloned at CI runtime.
2. **Grabbing firmware** — Releases page, pick the device, flash via vendor
   tool (example: SLZB-06 web UI).
3. **Adding a manifest** — drop file, PR, run workflow.
4. **Building locally** — invocation of `scripts/build-local.sh` and the
   underlying bash one-liner.
5. **Upstream pinning** — how `upstream.conf` works, what to do if a fix
   needs `src/` changes (upstream PR first).

## 6. Definition of done

1. Repo `AlexMKX/zigbee-dense` exists on GitHub (public, MIT).
2. Structure laid out as in section 2, with the initial dense router
   manifest copied from current fork HEAD.
3. First successful workflow_dispatch run produces a green release
   `build-YYYYMMDD-HHMMSS` with the expected `.gbl` attached.
4. That `.gbl` flashes successfully on SLZB-06MU (192.168.88.144) via the
   documented SLZB web API flow
   (`POST /fileUpload?customName=/fw.bin` + `GET /api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=1`),
   the device boots, joins the MR3 network, and is visible in Z2M. Baseline
   for comparison is the fork build at commit `afbf1a8` (
   `AlexMKX/silabs-firmware-builder:mr3-dense-router-2025.12.x` HEAD as of
   spec date): same manifest content, so a regression here means a CI-wiring
   bug in this new repo.
5. `scripts/build-local.sh manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`
   completes locally and produces a `.gbl` identical to the CI artifact
   modulo the metadata `repo_hash` field.
6. README links point to real releases and every command block is copy-paste
   verified.
