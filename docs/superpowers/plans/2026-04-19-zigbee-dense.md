# zigbee-dense Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `AlexMKX/zigbee-dense` — a minimal manifest-only repo with CI that builds Silabs Zigbee firmware `.gbl` files via upstream `Nerivec/silabs-firmware-builder` toolchain, publishing to GitHub Releases.

**Architecture:** No source/tools/Dockerfile in our repo — upstream is cloned at CI runtime. Our CI builds a Docker image from upstream's Dockerfile into our ghcr (`ghcr.io/alexmkx/zigbee-dense`), content-hashed, cached between runs. Five-job workflow: discover → check-container → build-container (conditional) → build (matrix per manifest) → release (auto-tagged).

**Tech Stack:** GitHub Actions, Docker (buildx), ghcr, upstream Python build tool `tools/build_project.py`, Silabs SLC CLI + Commander + Simplicity SDK 2025.12.x.

**Spec:** `docs/superpowers/specs/2026-04-19-zigbee-dense-design.md`

---

## Environment assumptions

Local dev machine: `/home/alex/Projects/zigbee/zigbee-dense/` already initialized as git repo (main branch, origin=`https://github.com/AlexMKX/zigbee-dense.git`), first commit `28b24cc` contains the spec, commit `4649b8a` updates spec to Option A (own ghcr build). Current fork reference: `/home/alex/Projects/zigbee/zigbee-silabs-firmware/` at commit `afbf1a8`.

Target test device: SLZB-06MU at `http://192.168.88.144/` (do not flash until Task 12).

GitHub account: `AlexMKX`. Repo `AlexMKX/zigbee-dense` does NOT yet exist on GitHub — created in Task 11.

---

## Task 1: Boilerplate files — LICENSE, .gitignore

**Files:**
- Create: `/home/alex/Projects/zigbee/zigbee-dense/LICENSE`
- Create: `/home/alex/Projects/zigbee/zigbee-dense/.gitignore`

- [ ] **Step 1: Write LICENSE (MIT, matching upstream)**

Create file with exact content:
```
MIT License

Copyright (c) 2026 Alex MKX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Write .gitignore**

Create file with exact content:
```
# Local build artefacts
/tmp-build/
/tmp-out/
/zigbee-dense-upstream/

# Editor junk
.vscode/
.idea/
*.swp
*.swo
*~

# Python cache (scripts are pure bash, but guard anyway)
__pycache__/
*.pyc
```

- [ ] **Step 3: Commit**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add LICENSE .gitignore
git commit -m "chore: add MIT LICENSE and .gitignore"
```

Expected: commit succeeds, `git status` clean.

---

## Task 2: Upstream pin configuration (`upstream.conf`)

**Files:**
- Create: `/home/alex/Projects/zigbee/zigbee-dense/upstream.conf`

- [ ] **Step 1: Write upstream.conf**

Content (shell-sourceable key=value format, no export, no comments interfering with `source`):
```
# zigbee-dense upstream toolchain pin
# Change the branch here and open a PR; CI will rebuild the Docker image
# from the new branch's Dockerfile on the next run.
UPSTREAM_REPO=https://github.com/Nerivec/silabs-firmware-builder
UPSTREAM_BRANCH=sisdk-2025.12.x
```

- [ ] **Step 2: Verify it parses with `source`**

Run:
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
bash -c 'source upstream.conf && echo "repo=$UPSTREAM_REPO" && echo "branch=$UPSTREAM_BRANCH"'
```

Expected output (exact):
```
repo=https://github.com/Nerivec/silabs-firmware-builder
branch=sisdk-2025.12.x
```

- [ ] **Step 3: Commit**

```bash
git add upstream.conf
git commit -m "feat: add upstream.conf pinning Nerivec sisdk-2025.12.x"
```

---

## Task 3: Migrate dense router manifest

**Files:**
- Create: `/home/alex/Projects/zigbee/zigbee-dense/manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml`

- [ ] **Step 1: Create directory and copy manifest verbatim from fork HEAD**

Run:
```bash
mkdir -p /home/alex/Projects/zigbee/zigbee-dense/manifests/smlight
cp /home/alex/Projects/zigbee/zigbee-silabs-firmware/manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml \
   /home/alex/Projects/zigbee/zigbee-dense/manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```

- [ ] **Step 2: Verify bit-for-bit match with source**

Run:
```bash
diff -q \
  /home/alex/Projects/zigbee/zigbee-silabs-firmware/manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml \
  /home/alex/Projects/zigbee/zigbee-dense/manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```

Expected output: **nothing** (empty = identical).

- [ ] **Step 3: Confirm fork source commit**

Run:
```bash
git -C /home/alex/Projects/zigbee/zigbee-silabs-firmware log -1 --format='%H %s' -- manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```

Expected output starts with: `afbf1a8` or later commit that touches this file. Record the full SHA in the commit message below.

- [ ] **Step 4: Commit**

Replace `<SHA>` below with the SHA from Step 3.
```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add manifests/
git commit -m "feat: migrate SLZB-06MU dense router manifest

Copied verbatim from AlexMKX/silabs-firmware-builder commit <SHA>.
Manifest uses base_project: src/zigbee_router from upstream. No src/
patches required — all customization is via slcp_defines, configuration,
c_defines, and add_components."
```

---

## Task 4: `scripts/build-local.sh` — local reproduction helper

**Files:**
- Create: `/home/alex/Projects/zigbee/zigbee-dense/scripts/build-local.sh`

- [ ] **Step 1: Write the script**

Create `/home/alex/Projects/zigbee/zigbee-dense/scripts/build-local.sh` with content:

```bash
#!/usr/bin/env bash
# Build one firmware locally using the same image as CI.
# Usage: ./scripts/build-local.sh manifests/smlight/<name>.yaml
set -euo pipefail

MANIFEST="${1:?usage: $0 <manifests/vendor/name.yaml>}"
if [[ ! -f "$MANIFEST" ]]; then
    echo "error: manifest not found: $MANIFEST" >&2
    exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source ./upstream.conf

CLONE="/tmp/zigbee-dense-upstream"
rm -rf "$CLONE"
git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_REPO" "$CLONE"

TAG=$(sha256sum "$CLONE/Dockerfile" "$CLONE/requirements.txt" | sha256sum | cut -c-16)
IMAGE="ghcr.io/alexmkx/zigbee-dense:${TAG}"

echo "==> Target image: $IMAGE"

# Try pulling from our ghcr (same image CI uses). If missing — build locally.
if ! docker pull "$IMAGE" 2>/dev/null; then
    echo "==> Image not in ghcr, building locally from upstream Dockerfile"
    docker build -t "$IMAGE" "$CLONE"
fi

REPO_HASH="local"
if git -C "$ROOT" rev-parse --short=8 HEAD >/dev/null 2>&1; then
    REPO_HASH=$(git -C "$ROOT" rev-parse --short=8 HEAD)
fi

mkdir -p tmp-build tmp-out

docker run --rm \
    -v "$ROOT:/ours:ro" \
    -v "$CLONE:/ws" \
    -v "$ROOT/tmp-build:/build" \
    -v "$ROOT/tmp-out:/out" \
    -w /ws \
    "$IMAGE" \
    /opt/venv/bin/python3 tools/build_project.py \
        --manifest "/ours/$MANIFEST" \
        --build-dir /build \
        --output-dir /out \
        --output gbl --output hex --output out \
        --repo-owner local \
        --repo-hash "$REPO_HASH"

echo "==> Outputs in $ROOT/tmp-out/"
ls -la "$ROOT/tmp-out/"
```

- [ ] **Step 2: Make executable**

Run:
```bash
chmod +x /home/alex/Projects/zigbee/zigbee-dense/scripts/build-local.sh
```

- [ ] **Step 3: Smoke-test script syntax (shellcheck if available, else bash -n)**

Run:
```bash
bash -n /home/alex/Projects/zigbee/zigbee-dense/scripts/build-local.sh && echo "syntax ok"
```

Expected output: `syntax ok`.

- [ ] **Step 4: Commit**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add scripts/
git commit -m "feat: add scripts/build-local.sh for local reproduction"
```

---

## Task 5: Local end-to-end test of the build script

This task verifies the build pipeline works on your machine before CI exists. If this fails, CI will fail the same way — cheaper to debug locally.

**Files:** none (verification only)

- [ ] **Step 1: Pre-flight — Docker available**

Run:
```bash
docker version --format '{{.Server.Version}}'
```

Expected: version string (e.g., `24.0.x`). If "permission denied" — fix Docker group or run with sudo.

- [ ] **Step 2: Run the build**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
./scripts/build-local.sh manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```

Expected flow:
1. Clone upstream (~2 sec).
2. Compute TAG (short hex string).
3. `docker pull` fails with "manifest unknown" (image not in our ghcr yet — not pushed by any CI run so far).
4. Falls back to `docker build` — **this is the long step, ~15-20 minutes on first run**.
5. Build container, run `tools/build_project.py`, produce `.gbl`.
6. Final output: listing of `tmp-out/` containing `.gbl`, `.hex`, `.out`, `.slpb`, metadata JSON.

Expected artefact name pattern:
`smlight_slzb06mu_dense_zigbee_router_2025.12.2_<fwVer>_115200_sw_flow.gbl`

- [ ] **Step 3: Verify GBL file exists and is non-trivial**

```bash
ls -l /home/alex/Projects/zigbee/zigbee-dense/tmp-out/*.gbl
```

Expected: one .gbl file, size roughly 220-260 KiB (reference: fork's last build was 229 KiB).

If size is dramatically different (e.g., < 100 KiB or > 400 KiB) — stop and investigate, don't proceed.

- [ ] **Step 4: Record baseline image TAG for CI comparison**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
source ./upstream.conf
CLONE=/tmp/zigbee-dense-upstream
sha256sum "$CLONE/Dockerfile" "$CLONE/requirements.txt" | sha256sum | cut -c-16
```

Record the output (e.g., `a1b2c3d4e5f6a7b8`). This is the tag your local build just used, and CI's `discover` job MUST compute the same value.

- [ ] **Step 5: Cleanup (don't commit tmp-out)**

Already handled by .gitignore from Task 1. Verify:
```bash
git -C /home/alex/Projects/zigbee/zigbee-dense status
```
Expected: clean (tmp-out not tracked, not ignored-but-untracked with -u normal).

---

## Task 6: CI workflow — skeleton file with header and discover job

**Files:**
- Create: `/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml`

We build the workflow incrementally across Tasks 6-10, committing between each job addition so you can review isolated diffs.

- [ ] **Step 1: Create directory**

```bash
mkdir -p /home/alex/Projects/zigbee/zigbee-dense/.github/workflows
```

- [ ] **Step 2: Write initial build.yaml with header and discover job**

Create `/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml` with content:

```yaml
name: Build firmwares

on:
  workflow_dispatch:

permissions:
  contents: read
  packages: read

env:
  REGISTRY: ghcr.io
  IMAGE_REPO: zigbee-dense

jobs:
  discover:
    name: Discover — clone upstream, compute image tag, build matrix
    runs-on: ubuntu-latest
    outputs:
      image_tag: ${{ steps.image.outputs.tag }}
      image_name: ${{ steps.image.outputs.name }}
      matrix: ${{ steps.matrix.outputs.matrix }}
      upstream_sha: ${{ steps.upstream.outputs.sha }}
      upstream_branch: ${{ steps.pin.outputs.branch }}
    steps:
      - uses: actions/checkout@v6

      - name: Read upstream pin
        id: pin
        run: |
          # shellcheck disable=SC1091
          source ./upstream.conf
          echo "repo=$UPSTREAM_REPO" >> "$GITHUB_OUTPUT"
          echo "branch=$UPSTREAM_BRANCH" >> "$GITHUB_OUTPUT"

      - name: Clone upstream
        run: |
          git clone --depth 1 \
              --branch "${{ steps.pin.outputs.branch }}" \
              "${{ steps.pin.outputs.repo }}" \
              upstream

      - name: Compute image tag
        id: image
        run: |
          TAG=$(sha256sum upstream/Dockerfile upstream/requirements.txt \
              | sha256sum | cut -c-16)
          OWNER=$(echo "${{ github.repository_owner }}" | tr '[:upper:]' '[:lower:]')
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "name=${{ env.REGISTRY }}/$OWNER/${{ env.IMAGE_REPO }}" >> "$GITHUB_OUTPUT"
          echo "Computed image: ${{ env.REGISTRY }}/$OWNER/${{ env.IMAGE_REPO }}:$TAG"

      - name: Record upstream HEAD SHA
        id: upstream
        run: |
          SHA=$(git -C upstream rev-parse HEAD)
          echo "sha=$SHA" >> "$GITHUB_OUTPUT"

      - name: Build manifest matrix
        id: matrix
        run: |
          MATRIX=$(find manifests -type f \( -name "*.yaml" -o -name "*.yml" \) \
              | sort | jq -R -s -c 'split("\n")[:-1]')
          echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"
          echo "Matrix: $MATRIX"

      - name: Upload upstream tarball for downstream jobs
        uses: actions/upload-artifact@v7
        with:
          name: upstream-src
          path: upstream/
          retention-days: 1
          include-hidden-files: true
```

- [ ] **Step 3: Syntax check with `yq` or python**

Run (use whichever is installed):
```bash
python3 -c "import yaml; yaml.safe_load(open('/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml'))" && echo "yaml ok"
```

Expected output: `yaml ok`.

- [ ] **Step 4: Commit (skeleton, not yet runnable end-to-end)**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add .github/
git commit -m "ci: add build workflow skeleton with discover job

First of five jobs in the CI pipeline. Clones upstream, computes our
image tag from hash of upstream Dockerfile + requirements.txt, builds
manifest matrix, uploads upstream tree as artifact for downstream jobs."
```

---

## Task 7: Add `check-container` job

**Files:**
- Modify: `/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml` (append job)

- [ ] **Step 1: Append check-container job**

Append this block to `build.yaml` (after the `discover:` job, before any job currently in the file):

```yaml
  check-container:
    name: Check if container image exists in ghcr
    runs-on: ubuntu-latest
    needs: discover
    permissions:
      packages: read
    outputs:
      build_image: ${{ steps.check.outputs.build_image }}
    steps:
      - name: Log in to ghcr (for private repo manifest access)
        uses: docker/login-action@v4
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Probe image
        id: check
        run: |
          IMAGE="${{ needs.discover.outputs.image_name }}:${{ needs.discover.outputs.image_tag }}"
          echo "Probing $IMAGE"
          if docker manifest inspect "$IMAGE" > /dev/null 2>&1; then
              echo "build_image=false" >> "$GITHUB_OUTPUT"
              echo "Image exists — will skip build-container"
          else
              echo "build_image=true" >> "$GITHUB_OUTPUT"
              echo "Image missing — build-container will run"
          fi
```

- [ ] **Step 2: YAML syntax check**

```bash
python3 -c "import yaml; yaml.safe_load(open('/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml'))" && echo "yaml ok"
```

Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build.yaml
git commit -m "ci: add check-container job

Probes our ghcr for the image tag computed by discover. Sets
build_image=true only when the image is missing, letting subsequent
build-container job run conditionally."
```

---

## Task 8: Add `build-container` job

**Files:**
- Modify: `/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml`

- [ ] **Step 1: Append build-container job**

Append this block after the `check-container:` job:

```yaml
  build-container:
    name: Build container image from upstream Dockerfile
    runs-on: ubuntu-latest
    needs: [discover, check-container]
    if: needs.check-container.outputs.build_image == 'true'
    permissions:
      packages: write
    steps:
      - name: Download upstream source
        uses: actions/download-artifact@v8
        with:
          name: upstream-src
          path: upstream

      - name: Free up disk space
        run: |
          sudo rm -rf /usr/share/dotnet
          sudo rm -rf /usr/local/lib/android
          sudo rm -rf /opt/ghc
          sudo rm -rf /opt/hostedtoolcache/CodeQL
          df -h

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v4

      - name: Log in to ghcr
        uses: docker/login-action@v4
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push image
        uses: docker/build-push-action@v7
        with:
          context: upstream
          file: upstream/Dockerfile
          platforms: linux/amd64
          tags: ${{ needs.discover.outputs.image_name }}:${{ needs.discover.outputs.image_tag }}
          cache-from: type=registry,ref=${{ needs.discover.outputs.image_name }}:cache
          cache-to: type=registry,ref=${{ needs.discover.outputs.image_name }}:cache,mode=max
          push: true
```

- [ ] **Step 2: YAML syntax check**

```bash
python3 -c "import yaml; yaml.safe_load(open('/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml'))" && echo "yaml ok"
```

Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build.yaml
git commit -m "ci: add conditional build-container job

Builds our ghcr image from upstream Dockerfile when check-container
reports missing. Scoped packages:write only on this job. Uses
buildx with registry-mode cache for faster rebuilds on unchanged
Dockerfile."
```

---

## Task 9: Add `build` job (matrix per manifest)

**Files:**
- Modify: `/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml`

- [ ] **Step 1: Append build job**

Append this block after the `build-container:` job:

```yaml
  build:
    name: Build firmware (${{ matrix.manifest }})
    runs-on: ubuntu-latest
    needs: [discover, check-container, build-container]
    # Run if check-container succeeded AND (build-container succeeded OR was skipped)
    if: |
      always() &&
      needs.check-container.result == 'success' &&
      (needs.build-container.result == 'success' || needs.build-container.result == 'skipped')
    permissions:
      packages: read
    strategy:
      fail-fast: false
      matrix:
        manifest: ${{ fromJson(needs.discover.outputs.matrix) }}
    container:
      image: ${{ needs.discover.outputs.image_name }}:${{ needs.discover.outputs.image_tag }}
      credentials:
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
      options: --user root
    steps:
      - name: Checkout our repo
        uses: actions/checkout@v6
        with:
          path: ours

      - name: Download upstream source
        uses: actions/download-artifact@v8
        with:
          name: upstream-src
          path: upstream

      - name: Build firmware
        id: build
        run: |
          cd upstream
          git config --global --add safe.directory "$PWD"
          REPO_HASH=$(git -C "$GITHUB_WORKSPACE/ours" rev-parse --short=8 HEAD)
          /opt/venv/bin/python3 tools/build_project.py \
              --manifest "$GITHUB_WORKSPACE/ours/${{ matrix.manifest }}" \
              --build-dir build \
              --output-dir outputs \
              --output gbl --output hex --output out \
              --repo-owner "$GITHUB_REPOSITORY_OWNER" \
              --repo-hash "$REPO_HASH"
          OUT_BASE=$(basename -- "$(ls -1 outputs/*.gbl | head -n 1)" .gbl)
          echo "out_base=$OUT_BASE" >> "$GITHUB_OUTPUT"

      - name: Upload firmware artifact
        uses: actions/upload-artifact@v7
        with:
          name: firmware-${{ steps.build.outputs.out_base }}
          path: upstream/outputs/*
          if-no-files-found: error
          compression-level: 9
```

- [ ] **Step 2: YAML syntax check**

```bash
python3 -c "import yaml; yaml.safe_load(open('/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml'))" && echo "yaml ok"
```

Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build.yaml
git commit -m "ci: add build job with matrix per manifest

Pulls our ghcr image, runs upstream tools/build_project.py for each
manifest in the matrix. Our repo checked out into ours/, upstream
downloaded from discover artifact. Uses repo HEAD short SHA as
build-time metadata. fail-fast disabled so one bad manifest does
not block siblings."
```

---

## Task 10: Add `release` job and concurrency guard

**Files:**
- Modify: `/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml`

- [ ] **Step 1: Append release job**

Append this block after the `build:` job:

```yaml
  release:
    name: Publish GitHub Release
    runs-on: ubuntu-latest
    needs: [discover, build]
    permissions:
      contents: write
    concurrency:
      group: release
      cancel-in-progress: false
    steps:
      - name: Download all firmware artifacts
        uses: actions/download-artifact@v8
        with:
          path: artifacts
          merge-multiple: true
          pattern: firmware-*

      - name: Compute sha256sums and prepare body
        id: body
        run: |
          ls -la artifacts/
          SUMS=$(sha256sum artifacts/*.gbl)
          TAG="build-$(date -u +%Y%m%d-%H%M%S)"
          {
            echo "tag=$TAG"
            echo 'body<<BODY_EOF'
            echo "## Build metadata"
            echo ""
            echo "- Upstream branch: \`${{ needs.discover.outputs.upstream_branch }}\`"
            echo "- Upstream SHA: \`${{ needs.discover.outputs.upstream_sha }}\`"
            echo "- Image: \`${{ needs.discover.outputs.image_name }}:${{ needs.discover.outputs.image_tag }}\`"
            echo "- Repo SHA: \`${{ github.sha }}\`"
            echo ""
            echo "## Artifact checksums"
            echo ""
            echo '```'
            echo "$SUMS"
            echo '```'
            echo ""
            echo "## Flashing (SLZB-06 devices)"
            echo ""
            echo "1. Download the \`.gbl\` matching your device model."
            echo "2. \`POST http://<device-ip>/fileUpload?customName=/fw.bin\` (form field \`update\`)."
            echo "3. \`GET http://<device-ip>/api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=1\`."
            echo 'BODY_EOF'
          } >> "$GITHUB_OUTPUT"

      - name: Create release
        uses: softprops/action-gh-release@v3
        with:
          tag_name: ${{ steps.body.outputs.tag }}
          name: "Build ${{ steps.body.outputs.tag }}"
          generate_release_notes: false
          body: ${{ steps.body.outputs.body }}
          files: |
            artifacts/*.gbl
```

- [ ] **Step 2: YAML syntax check**

```bash
python3 -c "import yaml; yaml.safe_load(open('/home/alex/Projects/zigbee/zigbee-dense/.github/workflows/build.yaml'))" && echo "yaml ok"
```

Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build.yaml
git commit -m "ci: add release job with auto-generated timestamp tag

Downloads all firmware-* artifacts, computes sha256sums, creates a
GitHub Release tagged build-YYYYMMDD-HHMMSS with .gbl files attached.
Release body documents upstream branch, upstream SHA, our image
coordinates, and flash instructions. concurrency: group: release
serializes concurrent dispatches."
```

---

## Task 11: README

**Files:**
- Create: `/home/alex/Projects/zigbee/zigbee-dense/README.md`

- [ ] **Step 1: Write README**

Create `/home/alex/Projects/zigbee/zigbee-dense/README.md` with content:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git add README.md
git commit -m "docs: add README with grab / add / build local / pin sections"
```

---

## Task 12: Create GitHub repo and push

**Files:** none (GitHub side)

- [ ] **Step 1: Verify gh CLI is authenticated**

```bash
gh auth status
```

Expected: authenticated as `AlexMKX` (or similar) with scopes that include `repo`, `workflow`, and `write:packages`.

If scopes are insufficient, run `gh auth refresh -s workflow,write:packages` (gh will walk you through adding scopes).

- [ ] **Step 2: Create the repository**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
gh repo create AlexMKX/zigbee-dense \
    --public \
    --description "Custom Silabs Zigbee firmware manifests built via upstream Nerivec/silabs-firmware-builder" \
    --source=. \
    --remote=origin \
    --push
```

This creates the repo on GitHub, sets `origin` to it, and pushes `main`.

Expected: success message with repo URL; `git status` shows branch `main` tracking `origin/main` up to date.

- [ ] **Step 3: Verify push**

```bash
git log --oneline origin/main | head -15
gh repo view AlexMKX/zigbee-dense --web
```

Expected: commits from Tasks 1-11 visible on GitHub; browser opens on the repo homepage (can close immediately).

---

## Task 13: First CI run — validate container build + first firmware release

- [ ] **Step 1: Dispatch the workflow**

```bash
gh workflow run build.yaml -R AlexMKX/zigbee-dense
```

Expected: "✓ Created workflow_dispatch event for build.yaml".

- [ ] **Step 2: Get the run ID and watch progress**

```bash
sleep 5
RUN_ID=$(gh run list -R AlexMKX/zigbee-dense -w build.yaml -L 1 --json databaseId -q '.[0].databaseId')
echo "Run ID: $RUN_ID"
gh run watch "$RUN_ID" -R AlexMKX/zigbee-dense
```

Expected behavior:
- `discover` completes in ~30 sec.
- `check-container` reports image missing → `build_image=true`.
- `build-container` runs ~15-20 min (first-ever image build).
- `build` runs ~3-5 min and produces one `firmware-*.gbl` artifact.
- `release` creates tag `build-YYYYMMDD-HHMMSS`.

If any job fails, use `gh run view $RUN_ID --log-failed -R AlexMKX/zigbee-dense` to diagnose.

- [ ] **Step 3: Verify release created with asset**

```bash
gh release list -R AlexMKX/zigbee-dense | head -3
LATEST_TAG=$(gh release list -R AlexMKX/zigbee-dense --limit 1 --json tagName -q '.[0].tagName')
gh release view "$LATEST_TAG" -R AlexMKX/zigbee-dense
```

Expected: one asset with `.gbl` extension, filename starting with `smlight_slzb06mu_dense_zigbee_router_`.

- [ ] **Step 4: Download and byte-compare to local build baseline**

```bash
cd /tmp
rm -rf ci-gbl && mkdir ci-gbl && cd ci-gbl
gh release download "$LATEST_TAG" -R AlexMKX/zigbee-dense -p '*.gbl'
ls -la
```

Compare to the local build from Task 5:
```bash
LOCAL_GBL=$(ls -1 /home/alex/Projects/zigbee/zigbee-dense/tmp-out/*.gbl | head -1)
CI_GBL=$(ls -1 /tmp/ci-gbl/*.gbl | head -1)
cmp -l "$LOCAL_GBL" "$CI_GBL" | head -20
```

Expected: **differences only in a small range of bytes** corresponding to the GBL metadata block (`repo_hash`, `repo_owner` fields — local passed `local`, CI passed `AlexMKX`). Elsewhere must match. If there are many scattered differences, stop and investigate — means CI computed a different compiled binary.

- [ ] **Step 5: Verify image landed in ghcr**

```bash
source /home/alex/Projects/zigbee/zigbee-dense/upstream.conf
TAG=$(sha256sum /tmp/zigbee-dense-upstream/Dockerfile /tmp/zigbee-dense-upstream/requirements.txt | sha256sum | cut -c-16)
docker pull "ghcr.io/alexmkx/zigbee-dense:$TAG"
```

Expected: successful pull (no rebuild — image was pushed by CI).

---

## Task 14: Second CI run — validate container caching

This task proves the `check-container` optimization works: a second dispatch
with no upstream bump should skip `build-container` entirely.

- [ ] **Step 1: Dispatch again**

```bash
gh workflow run build.yaml -R AlexMKX/zigbee-dense
sleep 5
RUN_ID=$(gh run list -R AlexMKX/zigbee-dense -w build.yaml -L 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" -R AlexMKX/zigbee-dense
```

- [ ] **Step 2: Verify build-container was skipped**

```bash
gh run view "$RUN_ID" -R AlexMKX/zigbee-dense --json jobs | jq '.jobs[] | {name, conclusion}'
```

Expected output contains:
```json
{"name":"Build container image from upstream Dockerfile","conclusion":"skipped"}
```

Total run time should be roughly 4-7 minutes (vs ~20 min in Task 13).

- [ ] **Step 3: Verify second release has distinct tag**

```bash
gh release list -R AlexMKX/zigbee-dense --limit 3
```

Expected: two releases, distinct `build-YYYYMMDD-HHMMSS` tags (the second one a few minutes after the first).

---

## Task 15: Flash and validate on device

Only proceed once Task 13 passed.

- [ ] **Step 1: Download the GBL from latest release**

```bash
cd /tmp
rm -rf flash-gbl && mkdir flash-gbl && cd flash-gbl
LATEST_TAG=$(gh release list -R AlexMKX/zigbee-dense --limit 1 --json tagName -q '.[0].tagName')
gh release download "$LATEST_TAG" -R AlexMKX/zigbee-dense -p '*.gbl'
GBL=$(ls -1 *.gbl | head -1)
echo "About to flash: $GBL (from tag $LATEST_TAG)"
ls -la "$GBL"
```

- [ ] **Step 2: Upload GBL to device**

```bash
curl -v -F "update=@${GBL}" "http://192.168.88.144/fileUpload?customName=/fw.bin"
```

Expected: HTTP 200, short JSON/text response confirming upload.

- [ ] **Step 3: Trigger flash with fwCh=1 (router mode)**

```bash
curl -v "http://192.168.88.144/api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=1"
```

Expected: HTTP 200. Device begins flashing; LED pattern changes (per SLZB-06 docs).

Wait ~30 sec for the flash to complete.

- [ ] **Step 4: Verify device back online**

```bash
curl -s http://192.168.88.144/ha_info | python3 -m json.tool | head -30
```

Expected: JSON including `"zb_type":"1"` (router), non-empty `"zb_version"`, device responsive.

- [ ] **Step 5: Verify Z2M sees the router rejoin**

On the host running Z2M (`slzb-mr3.h.xxl.cx`), tail the log:
```bash
ssh root@hassio.h.xxl.cx 'tail -200 /addon_configs/45df7312_zigbee2mqtt/log/$(ls -t /addon_configs/45df7312_zigbee2mqtt/log/ | head -1)/log.log' | grep -iE 'router|rejoin|0x385c'
```

Expected: within ~1-2 min after flash, a `Device '0x385c...' is rejoining` or `Device announcement` entry for the SLZB-06MU router.

If you're unsure which log path is correct, the session-summary reference is
`/home/alex/Projects/zigbee/45df7312_zigbee2mqtt/zigbee2mqtt/log/` on the
local mirror.

- [ ] **Step 6: Smoke-check the wider mesh is not broken**

```bash
ssh root@hassio.h.xxl.cx 'mosquitto_sub -h core-mosquitto -t "zigbee2mqtt/bridge/state" -C 1 -W 5'
```

Expected: `{"state":"online"}` (or similar). If you get `"offline"` or timeout — this is a bigger issue than the flash; see fork's troubleshooting docs.

---

## Task 16: Final polish — link README to real release, verify copy-paste

- [ ] **Step 1: Check that README release link actually resolves**

```bash
curl -sSfI https://github.com/AlexMKX/zigbee-dense/releases | head -3
```

Expected: HTTP 200.

- [ ] **Step 2: Verify README "Grabbing firmware" curl commands are pasteable**

Sanity-check the HTTP paths in the README against the real SLZB web API endpoints (spec section 6 pt 4 defines them authoritatively).

If README has a typo or mismatch: fix it, commit, push.

- [ ] **Step 3: Verify `./scripts/build-local.sh` still works with the CI-published image**

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
rm -rf tmp-build tmp-out
./scripts/build-local.sh manifests/smlight/smlight_slzb06mu_dense_zigbee_router.yaml
```

Expected: script pulls image from our ghcr (no local docker build this
time — it was pushed by CI), produces `.gbl` in `tmp-out/`. Total time
~3 min.

- [ ] **Step 4: Mark the project done in todo tracking**

Close any GitHub issues, archive the tracking doc, etc. Optional: push
a git tag on our repo marking v1 init:

```bash
cd /home/alex/Projects/zigbee/zigbee-dense
git tag -a v0.1.0 -m "Initial zigbee-dense release"
git push origin v0.1.0
```

---

## Verification summary (Definition of Done mapping)

| Spec DoD item                              | Verified in Task |
|--------------------------------------------|------------------|
| 1. Repo AlexMKX/zigbee-dense exists        | 12               |
| 2. Structure + initial dense router manifest | 1-4, 6-10       |
| 3. First workflow_dispatch → green release | 13               |
| 4. GBL flashes on SLZB-06MU, joins MR3     | 15               |
| 5. `scripts/build-local.sh` identical to CI (mod metadata) | 5 + 13 step 4 + 16 step 3 |
| 6. README links + commands copy-paste verified | 16           |

Also verified (not part of spec DoD but essential):

| Additional verification              | Task |
|--------------------------------------|------|
| Container caching skip path works    | 14   |
| Second release has distinct tag      | 14   |
| Image really is in our ghcr          | 13 step 5 |
| Z2M mesh is not broken by flash      | 15 step 6 |
