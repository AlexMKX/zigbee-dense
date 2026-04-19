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
