#!/usr/bin/env bash
# Injects and compiles cloud-only extensions from the private nivaro-cloud repo
# into api/dist/cloud-extensions/ before the API starts (or during Docker build).
#
# Required env vars:
#   CLOUD_EXTENSIONS_REPO        — GitHub repo slug, e.g. "acme/nivaro-cloud"
#   CLOUD_EXTENSIONS_TOKEN_FILE  — file holding a GitHub token with read access
#                                  to the private repo (a BuildKit secret mount:
#                                  Dockerfile.release mounts the build secret
#                                  CLOUD_EXTENSIONS_TOKEN at
#                                  /run/secrets/CLOUD_EXTENSIONS_TOKEN)
#   CLOUD_EXTENSIONS_TOKEN       — the same token as a plain value; DEPRECATED
#                                  (a build ARG is recorded in the build
#                                  metadata and cache). Used only when no
#                                  token file is readable.
#
# The token reaches git through GIT_CONFIG_* environment variables (an
# Authorization header for github.com only): never on argv, never in a clone
# URL, never written to .git/config.
#
# Fail-safe: any error exits 0 so the API builds/starts without extensions.
# The loadCloudExtensions() loader already handles a missing directory gracefully.

set -euo pipefail

REPO="${CLOUD_EXTENSIONS_REPO:-}"
TOKEN=""
TOKEN_FILE="${CLOUD_EXTENSIONS_TOKEN_FILE:-}"
if [ -n "$TOKEN_FILE" ] && [ -r "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
fi
if [ -z "$TOKEN" ] && [ -n "${CLOUD_EXTENSIONS_TOKEN:-}" ]; then
  TOKEN="$CLOUD_EXTENSIONS_TOKEN"
  echo "[cloud-ext] WARNING: CLOUD_EXTENSIONS_TOKEN came in as a build ARG;" \
    "pass it as a build secret (id CLOUD_EXTENSIONS_TOKEN) instead" >&2
fi
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

case "$REPO" in
  *[!A-Za-z0-9._/-]* | */*/* | /* | */ | *..*)
    warn "CLOUD_EXTENSIONS_REPO is not an owner/name slug — skipping cloud extensions"
    exit 0
    ;;
esac

log "Cloning $REPO (depth=1)..."
AUTH_B64="$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
if ! GIT_TERMINAL_PROMPT=0 \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" \
    GIT_CONFIG_VALUE_0="AUTHORIZATION: basic ${AUTH_B64}" \
    git clone --quiet --depth=1 \
    "https://github.com/${REPO}.git" \
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

  prebuilt_js="$ext_dir/index.js"

  if [ -f "$prebuilt_js" ]; then
    # Pre-compiled index.js committed to repo — copy directly, no esbuild needed
    mkdir -p "$out_dir"
    cp "$prebuilt_js" "$out_file"
    log "Copied $ext_name pre-built index.js"
    INJECTED=$((INJECTED + 1))
  elif [ ! -f "$src_file" ]; then
    warn "$ext_name: no index.js or index.ts — skipping"
    continue
  elif [ -z "$ESBUILD" ]; then
    warn "$ext_name: no pre-built index.js and esbuild unavailable — skipping"
    FAILED=$((FAILED + 1))
    continue
  elif $ESBUILD "$src_file" \
      --bundle=true \
      --format=esm \
      --platform=node \
      --target=node22 \
      --packages=external \
      --outfile="$out_file" 2>&1; then
    log "Compiled $ext_name index.ts → $out_file"
    INJECTED=$((INJECTED + 1))
  else
    warn "$ext_name: compile failed — skipping this extension"
    rm -rf "$out_dir"
    FAILED=$((FAILED + 1))
    continue
  fi

  # UI bundle: prefer pre-built ui.js (committed to repo), fall back to compiling ui.ts
  ui_prebuilt="$ext_dir/ui.js"
  ui_src="$ext_dir/ui.ts"
  if [ -f "$ui_prebuilt" ]; then
    cp "$ui_prebuilt" "$out_dir/ui.js"
    log "Copied $ext_name pre-built ui.js"
  elif [ -f "$ui_src" ]; then
    if [ -z "$ESBUILD" ]; then
      warn "$ext_name: no pre-built ui.js and esbuild unavailable — skipping UI bundle"
    elif $ESBUILD "$ui_src" \
        --bundle=true \
        --format=iife \
        --platform=browser \
        --target=es2020 \
        --outfile="$out_dir/ui.js" 2>&1; then
      log "Compiled $ext_name ui.ts → $out_dir/ui.js"
    else
      warn "$ext_name: ui.ts compile failed — extension will have no UI bundle"
    fi
  fi

  # Copy manifest.json if present
  manifest_src="$ext_dir/manifest.json"
  if [ -f "$manifest_src" ]; then
    cp "$manifest_src" "$out_dir/manifest.json"
    log "Copied $ext_name manifest.json"
  fi
done

log "Done: $INJECTED injected, $FAILED failed"
# Always exit 0 — partial success is acceptable; API starts without failed extensions
exit 0
