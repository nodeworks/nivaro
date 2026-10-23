#!/usr/bin/env bash
# Realtime CI stack — one command up, one down. See docker-compose.yml for the topology and
# tests/realtime/README.md for the suites.
#
#   rtci.sh up [tier|single] [--image <tag>] [--no-build] [--v2] [--no-seed]
#        tier   (default) web ×2 with SOCKETS=off, realtime ×2, worker ×1
#        single today's shape: web ×2 serving sockets themselves, worker ×1
#        --image  run an existing image tag instead of building the worktree
#        --v2     also start Traefik v2.4 on RTCI_HTTP_V2_PORT
#   rtci.sh build <tag> [<git-ref>]   build the slim release image of the worktree (or of a ref,
#                                     via git archive) — e.g. an "old" image for mixed versions
#   rtci.sh seed [--load-users N]     bootstrap admin (SQL) + seed through the API (idempotent)
#   rtci.sh down                      stop everything and remove the volumes
#   rtci.sh ps | logs <svc> | sql "<query>" | compose <args…>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$HERE/.state"
ENVF="$HERE/rtci.env"
# shellcheck disable=SC1090
set -a; source "$ENVF"; set +a
# The running stack's mode and image (written by `up`), so `compose up -d web-1` after a test
# recreates a service the way it was started.
# shellcheck disable=SC1091
[ -f "$STATE/stack.env" ] && { set -a; source "$STATE/stack.env"; set +a; }
# SQL Server 2022 crashes under qemu (an arm64 Mac whose Docker Desktop has no Rosetta): use the
# arm64-native Azure SQL Edge there unless RTCI_MSSQL_IMAGE says otherwise.
if [ -z "${RTCI_MSSQL_IMAGE:-}" ] && [ "$(uname -m)" = arm64 ]; then
  export RTCI_MSSQL_IMAGE=mcr.microsoft.com/azure-sql-edge:latest RTCI_MSSQL_PLATFORM=linux/arm64
fi

dc() {
  local p=()
  [ "${RTCI_MODE:-tier}" = tier ] && p+=(--profile tier)
  [ "${RTCI_V2:-0}" = 1 ] && p+=(--profile v2)
  docker compose --env-file "$ENVF" -f "$HERE/docker-compose.yml" ${p[@]+"${p[@]}"} "$@"
}

build_image() {
  local tag="$1" ref="${2:-}"
  if [ -n "$ref" ]; then
    echo "rtci: building $tag from $ref (git archive)"
    git -C "$ROOT" archive --format=tar "$ref" |
      docker build -f Dockerfile.release --target runner-slim -t "$tag" -
  else
    echo "rtci: building $tag from the worktree $ROOT"
    docker build -f "$ROOT/Dockerfile.release" --target runner-slim -t "$tag" "$ROOT"
  fi
}

sqlq() {
  dc --profile tools run --rm --no-deps -T sqlcmd -Q "$1"
}

bootstrap_admin() {
  sqlq "$(cat "$HERE/legacy-tables.sql")" | grep -E "^Msg|Level" && return 1
  # The only row written by SQL: the administrator the seed signs in as. Into this stack's own
  # empty database, after the boot migrations created the tables.
  # A fresh self-hosted database has no default workspace row (only cloud provisioning inserts
  # one), and roles/collections carry a FK to it — so the default workspace goes in here too.
  sqlq "
IF NOT EXISTS (SELECT 1 FROM nivaro_workspaces WHERE id = '00000000-0000-0000-0000-000000000001')
  INSERT INTO nivaro_workspaces (id, name, slug) VALUES ('00000000-0000-0000-0000-000000000001', 'Default', 'default');
IF NOT EXISTS (SELECT 1 FROM nivaro_roles WHERE name = 'RTCI Admin')
  INSERT INTO nivaro_roles (id, name, admin_access, app_access) VALUES (NEWID(), 'RTCI Admin', 1, 1);
IF NOT EXISTS (SELECT 1 FROM nivaro_users WHERE email = 'rtci-admin@example.test')
  INSERT INTO nivaro_users (id, email, first_name, last_name, status, static_token, role)
  SELECT NEWID(), 'rtci-admin@example.test', 'RTCI', 'Admin', 'active', '$RTCI_ADMIN_TOKEN', id
  FROM nivaro_roles WHERE name = 'RTCI Admin';" | grep -E "^Msg|Level" && return 1 || true
}

cmd="${1:-}"
shift || true
case "$cmd" in
  up)
    mode=tier image="" build=1 v2=0 seed=1
    while [ $# -gt 0 ]; do
      case "$1" in
        tier | single) mode="$1" ;;
        --image) image="$2"; shift ;;
        --no-build) build=0 ;;
        --v2) v2=1 ;;
        --no-seed) seed=0 ;;
        *) echo "rtci: unknown option $1" >&2; exit 2 ;;
      esac
      shift
    done
    if [ -z "$image" ]; then
      image="nivaro-rtci:local"
      [ "$build" = 1 ] && build_image "$image"
    fi
    export RTCI_MODE="$mode" RTCI_IMAGE="$image"
    if [ "$mode" = tier ]; then export RTCI_WEB_SOCKETS=off; else export RTCI_WEB_SOCKETS=on; fi
    export RTCI_V2="$v2"
    mkdir -p "$STATE"
    printf '{"mode":"%s","image":"%s","v2":%s,"started_at":"%s"}\n' "$mode" "$image" \
      "$([ "$v2" = 1 ] && echo true || echo false)" "$(date -u +%FT%TZ)" >"$STATE/stack.json"
    printf 'RTCI_MODE=%s\nRTCI_IMAGE=%s\nRTCI_WEB_SOCKETS=%s\nRTCI_V2=%s\n' "$mode" "$image" \
      "$RTCI_WEB_SOCKETS" "$v2" >"$STATE/stack.env"
    t0=$(date +%s)
    echo "rtci: starting $mode stack with $image (first boot runs every migration — minutes)"
    dc up -d --wait --wait-timeout 2400
    echo "rtci: healthy after $(($(date +%s) - t0)) s"
    bootstrap_admin
    if [ "$seed" = 1 ]; then node "$ROOT/tests/realtime/seed.mjs"; fi
    echo "rtci: up — http://127.0.0.1:$RTCI_HTTP_PORT (Traefik v3), dashboard :$RTCI_DASH_PORT"
    ;;
  build)
    build_image "${1:?tag}" "${2:-}"
    ;;
  seed)
    bootstrap_admin
    node "$ROOT/tests/realtime/seed.mjs" "$@"
    ;;
  down)
    RTCI_MODE=tier RTCI_V2=1 dc --profile cloud --profile tools down -v --remove-orphans
    rm -rf "$STATE"
    ;;
  ps)
    dc ps
    ;;
  logs)
    dc logs --no-color --tail "${2:-200}" "${1:?service}"
    ;;
  sql)
    sqlq "${1:?query}"
    ;;
  compose)
    dc "$@"
    ;;
  *)
    sed -n '2,15p' "$0"
    exit 2
    ;;
esac
