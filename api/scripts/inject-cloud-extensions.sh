#!/usr/bin/env bash
# Injects and compiles cloud-only extensions from the private nivaro-cloud repo
# into api/dist/cloud-extensions/ before the API starts (or during Docker build).
#
# Required env vars:
#   CLOUD_EXTENSIONS_REPO   — GitHub repo slug, e.g. "acme/nivaro-cloud"
#   CLOUD_EXTENSIONS_TOKEN  — GitHub PAT with read access to the private repo
#
# Fail-safe: any error exits 0 so the API builds/starts without extensions.
# The loadCloudExtensions() loader already handles a missing directory gracefully.

set -euo pipefail

REPO="${CLOUD_EXTENSIONS_REPO:-}"
TOKEN="${CLOUD_EXTENSIONS_TOKEN:-}"
# Destination: api/dist/cloud-extensions/ (where loader.js resolves at runtime)
DEST="${CLOUD_EXTENSIONS_DEST:-$(dirname "$0")/../cloud-extensions}"

log()  { echo "[cloud-ext] $*"; }
warn() { echo "[cloud-ext] WARNING: $*" >&2; }

# Always create dest so Dockerfile COPY succeeds even in OSS builds
mkdir -p "$DEST"

if [ -z "$REPO" ] || [ -z "$TOKEN" ]; then
  log "CLOUD_EXTENSIONS_REPO/TOKEN not set — skipping cloud extensions"
  exit 0
fi

TMPDIR_WORK=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_WORK"; }
trap cleanup EXIT

log "Cloning $REPO (depth=1)..."
if ! git clone --quiet --depth=1 \
    "https://x-access-token:${TOKEN}@github.com/${REPO}.git" \
    "$TMPDIR_WORK/repo" 2>&1; then
  warn "Clone failed — deploying without cloud extensions"
  exit 0
fi

SRC="$TMPDIR_WORK/repo/extensions"
if [ ! -d "$SRC" ]; then
  warn "No extensions/ directory found in $REPO — skipping"
  exit 0
fi

mkdir -p "$DEST"

# Detect esbuild — prefer local node_modules, fall back to npx
ESBUILD=""
if command -v node >/dev/null 2>&1; then
  ESBUILD_LOCAL="$(dirname "$0")/../../node_modules/.bin/esbuild"
  if [ -x "$ESBUILD_LOCAL" ]; then
    ESBUILD="$ESBUILD_LOCAL"
  elif npx --yes esbuild --version >/dev/null 2>&1; then
    ESBUILD="npx esbuild"
  fi
fi

INJECTED=0
FAILED=0

for ext_dir in "$SRC"/*/; do
  [ -d "$ext_dir" ] || continue
  ext_name=$(basename "$ext_dir")
  src_file="$ext_dir/index.ts"
  out_dir="$DEST/$ext_name"
  out_file="$out_dir/index.js"

  if [ ! -f "$src_file" ]; then
    # Try index.js (pre-compiled)
    src_file="$ext_dir/index.js"
    if [ ! -f "$src_file" ]; then
      warn "$ext_name: no index.ts or index.js — skipping"
      continue
    fi
    mkdir -p "$out_dir"
    cp "$src_file" "$out_file"
    log "Copied $ext_name (pre-compiled)"
    INJECTED=$((INJECTED + 1))
    continue
  fi

  if [ -z "$ESBUILD" ]; then
    warn "$ext_name: esbuild not available — copying TS as-is (may fail at runtime)"
    mkdir -p "$out_dir"
    cp "$src_file" "$out_dir/index.ts"
    INJECTED=$((INJECTED + 1))
    continue
  fi

  mkdir -p "$out_dir"
  if $ESBUILD "$src_file" \
      --bundle=true \
      --format=esm \
      --platform=node \
      --target=node22 \
      --packages=external \
      --outfile="$out_file" 2>&1; then
    log "Compiled $ext_name → $out_file"
    INJECTED=$((INJECTED + 1))
  else
    warn "$ext_name: compile failed — skipping this extension"
    rm -rf "$out_dir"
    FAILED=$((FAILED + 1))
  fi
done

log "Done: $INJECTED injected, $FAILED failed"
# Always exit 0 — partial success is acceptable; API starts without failed extensions
exit 0
