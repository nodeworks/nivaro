#!/bin/sh
# Release image entrypoint (#2786/#2788/#2790/#2792). Runs under tini (PID 1),
# does the per-start setup a Dockerfile cannot, then exec's the command, so
# whatever CMD or `command:` the deployment gives (node api/dist/index.js, or
# a `sh -c "...; exec ..."` wrapper) becomes tini's child and gets SIGTERM.
#
# 1. Node heap from the container memory limit. V8 sizes its heap from the
#    cgroup limit at start (Node 22: about half of it) and cannot change it
#    later, so this sets --max-old-space-size to 75% of the limit in
#    NODE_OPTIONS — exported BEFORE any step-down, so the node started below
#    (by su-exec, sh -c or another wrapper) inherits it. Skipped when
#    NODE_OPTIONS already names a heap size, when there is no limit, or with
#    NIVARO_HEAP_FROM_CGROUP=off.
# 2. Who runs it (postgres/redis style). The image has no USER: it starts as
#    root, prepares /app/work (TMPDIR, HOME) and /app/uploads for uid 1000,
#    then steps down with `su-exec node`. Two cases stay root, each with a
#    WARNING banner in the log (root_warning), so an upgrade never breaks
#    writes but nobody runs as root without being told:
#      - /app/uploads holds files uid 1000 cannot write (a volume an older
#        image wrote as root; NFS with root_squash). It is never chown -R'd
#        here: that can take hours on a big share and root_squash refuses it.
#      - the step-down itself fails (cap_drop ALL removes CAP_SETUID/SETGID).
#    NIVARO_RUN_AS=root skips the step-down on purpose. A deployment that sets
#    `user:` (non-root) gets none of this: dirs are created, a non-writable
#    /app/uploads is reported, and the command runs as given.
# 3. Writable dirs. A read-only root filesystem leaves /app/uploads,
#    /app/work and /tmp writable; /app/work is often an EMPTY tmpfs or a new
#    volume, so TMPDIR (/app/work/tmp) and HOME (/app/work/home) may not exist.
#    Root without capabilities cannot write uid 1000's dirs: then TMPDIR and
#    HOME move under /tmp.
#
# NIVARO_CGROUP_ROOT / NIVARO_MEMINFO move the files read, and
# `docker-entrypoint.sh --uploads-plan <dir>` (with NIVARO_APP_UID) prints the
# uploads decision — tests only.
set -e

APP_UID="${NIVARO_APP_UID:-1000}"
APP_GID="${NIVARO_APP_GID:-1000}"

say() { echo "nivaro: $*" >&2; }

# Staying root is never silent (M31, security audit 2026-10-27): a banner on
# stderr at every start, and NIVARO_RUNNING_AS_ROOT=1 + NIVARO_ROOT_REASON in
# the process environment for the API to report. It never refuses to start —
# an upgrade must keep working; the banner says how to fix it.
root_warning() {
  NIVARO_RUNNING_AS_ROOT=1
  NIVARO_ROOT_REASON="$1"
  export NIVARO_RUNNING_AS_ROOT NIVARO_ROOT_REASON
  {
    echo "nivaro: ************************************************************"
    echo "nivaro: WARNING: RUNNING AS ROOT (uid 0)"
    echo "nivaro: reason: $1"
    echo "nivaro: A bug in the API, an extension or Chromium then has root in the"
    echo "nivaro: container. Fix it so the server steps down to uid $APP_UID:"
    echo "nivaro:   chown -R $APP_UID:$APP_GID on the uploads volume, give back"
    echo "nivaro:   CAP_SETUID/CAP_SETGID, or set user: $APP_UID:$APP_GID."
    echo "nivaro: ************************************************************"
  } >&2
}

# ── 1. heap ────────────────────────────────────────────────────────────────

# The memory limit in bytes, or nothing: cgroup v2 first, then v1.
cgroup_limit() {
  root="${NIVARO_CGROUP_ROOT:-/sys/fs/cgroup}"
  for f in "$root/memory.max" "$root/memory/memory.limit_in_bytes"; do
    if [ -r "$f" ]; then
      v=$(tr -d ' \n' < "$f" 2>/dev/null || true)
      case "$v" in
        '' | max | *[!0-9]*) return 0 ;; # unlimited (v2 "max") or unreadable
      esac
      echo "$v"
      return 0
    fi
  done
}

# Heap in MiB for a limit in bytes: 75%, nothing for no/absurd limits. A v1
# "unlimited" is a page-rounded 2^63 (9223372036854771712): anything of 19+
# digits, at least 2^60 or above the host's RAM means no limit. Under 256 MiB
# the default is left alone (75% would starve everything but the heap).
heap_mb_for() {
  limit="$1"
  [ -z "$limit" ] && return 0
  [ "${#limit}" -ge 19 ] && return 0
  [ "$limit" -ge 1152921504606846976 ] && return 0
  meminfo="${NIVARO_MEMINFO:-/proc/meminfo}"
  if [ -r "$meminfo" ]; then
    total_kb=$(awk '/^MemTotal:/ { print $2; exit }' "$meminfo" 2>/dev/null || true)
    if [ -n "$total_kb" ] && [ "$limit" -gt $((total_kb * 1024)) ]; then
      return 0
    fi
  fi
  mb=$((limit / 1048576))
  [ "$mb" -lt 256 ] && return 0
  echo $((mb * 3 / 4))
}

size_heap() {
  case "${NIVARO_HEAP_FROM_CGROUP:-on}" in
    off | false | 0 | no) return 0 ;;
  esac
  case " ${NODE_OPTIONS:-} " in
    *--max-old-space-size* | *--max_old_space_size*) return 0 ;;
  esac
  heap=$(heap_mb_for "$(cgroup_limit)")
  if [ -n "$heap" ]; then
    NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$heap"
    export NODE_OPTIONS
  fi
}

# ── 2. uploads ─────────────────────────────────────────────────────────────

# May uid APP_UID write this path? By mode bits, as root cannot ask access()
# (`ls -ldn`: busybox and BSD agree on it, `stat -c` they do not).
owner_of() {
  set -- $(ls -ldn "$1" 2>/dev/null)
  echo "${3:-}"
}
app_can_write() {
  set -- $(ls -ldn "$1" 2>/dev/null)
  perms="${1:-----------}"
  if [ "${3:-}" = "$APP_UID" ]; then
    [ "$(printf '%s' "$perms" | cut -c3)" = w ]
    return
  fi
  if [ "${4:-}" = "$APP_GID" ]; then
    [ "$(printf '%s' "$perms" | cut -c6)" = w ]
    return
  fi
  [ "$(printf '%s' "$perms" | cut -c9)" = w ]
}

# What to do with an uploads dir: `ok` (uid APP_UID can write it), `chown`
# (empty, or only its top dir is someone else's: chown that one dir) or `stay`
# (holds entries uid APP_UID cannot write: stay root). The first 50 entries
# stand for the rest: a full scan of a big share at every start is too slow.
uploads_plan() {
  dir="$1"
  [ -d "$dir" ] || { echo ok; return; }
  first=$(ls -A "$dir" 2>/dev/null | head -n 50)
  if [ -n "$first" ]; then
    printf '%s\n' "$first" | while IFS= read -r e; do
      app_can_write "$dir/$e" || { echo stay; break; }
    done | grep -q stay && { echo stay; return; }
  fi
  if app_can_write "$dir"; then echo ok; else echo chown; fi
}

if [ "${1:-}" = "--uploads-plan" ]; then
  uploads_plan "$2"
  exit 0
fi
if [ "${1:-}" = "--root-warning" ]; then
  root_warning "$2"
  echo "$NIVARO_RUNNING_AS_ROOT $NIVARO_ROOT_REASON"
  exit 0
fi

# Can THIS process write the dir? Tried for real: root without
# CAP_DAC_OVERRIDE cannot write uid 1000's dirs, whatever `test -w` says.
can_write_here() {
  probe="$1/.nivaro-write-probe.$$"
  if (: > "$probe") 2>/dev/null; then
    rm -f "$probe"
    return 0
  fi
  return 1
}

ensure_dirs() {
  for d in "${TMPDIR:-}" "${HOME:-}"; do
    [ -n "$d" ] && mkdir -p "$d" 2>/dev/null || true
  done
}

# Root that could not step down: keep TMPDIR and HOME writable (under /tmp
# when uid 1000's dirs refuse us) and say whether uploads can be written.
root_dirs() {
  ensure_dirs
  if [ -n "${TMPDIR:-}" ] && ! can_write_here "$TMPDIR"; then
    TMPDIR=/tmp/nivaro-tmp
    mkdir -p "$TMPDIR"
    export TMPDIR
    say "TMPDIR is not writable here — using $TMPDIR"
  fi
  if [ -n "${HOME:-}" ] && ! can_write_here "$HOME"; then
    HOME=/tmp/nivaro-home
    mkdir -p "$HOME"
    export HOME
  fi
  if [ -d /app/uploads ] && ! can_write_here /app/uploads; then
    say "/app/uploads is not writable by this process (uid 0 without capabilities, owned by uid $(owner_of /app/uploads)) — uploads will fail. Give it back its capabilities, or set user: 1000:1000."
  fi
}

size_heap

uid=$(id -u)

if [ "$uid" != 0 ]; then
  # The deployment chose the user (`user:` / --user).
  ensure_dirs
  if [ -d /app/uploads ] && ! can_write_here /app/uploads; then
    say "/app/uploads is not writable by uid $uid — uploads will fail." \
      "Fix once: docker run --rm -v <volume>:/app/uploads alpine chown -R $uid /app/uploads"
  fi
  exec "$@"
fi

if [ "${NIVARO_RUN_AS:-}" = root ]; then
  root_warning "NIVARO_RUN_AS=root is set"
  root_dirs
  exec "$@"
fi

# Root, stepping down: /app/work and its dirs belong to uid 1000 (a chown -R
# only when something in it does not: a scratch volume a root run wrote).
ensure_dirs
mkdir -p /app/work 2>/dev/null || true
for d in /app/work "${TMPDIR:-}" "${HOME:-}"; do
  [ -n "$d" ] && [ -d "$d" ] || continue
  if [ -n "$(find "$d" -xdev ! -user "$APP_UID" -print 2>/dev/null | head -n 1)" ]; then
    chown -R "$APP_UID:$APP_GID" "$d" 2>/dev/null || true
  fi
done

stay=''
case "$(uploads_plan /app/uploads)" in
  chown) chown "$APP_UID:$APP_GID" /app/uploads 2>/dev/null || stay=chown ;;
  stay) stay=files ;;
esac

if [ -n "$stay" ]; then
  if [ "$stay" = files ]; then
    why="holds files uid $APP_UID cannot write"
  else
    why="belongs to uid $(owner_of /app/uploads) and could not be handed to uid $APP_UID"
  fi
  say "/app/uploads $why — RUNNING AS ROOT so uploads keep working." \
    "Fix once: chown -R $APP_UID:$APP_GID on that volume" \
    "(docker run --rm -v <volume>:/app/uploads alpine chown -R $APP_UID:$APP_GID /app/uploads), or set user: $APP_UID:$APP_GID."
  root_warning "/app/uploads $why"
elif su-exec node true 2>/dev/null; then
  # su-exec resets HOME from /etc/passwd (/home/node, read-only): keep ours.
  exec su-exec node env HOME="$HOME" "$@"
else
  say "could not switch to uid $APP_UID (no CAP_SETUID/CAP_SETGID, e.g. cap_drop: ALL) — running as root."
  root_warning "could not switch to uid $APP_UID (no CAP_SETUID/CAP_SETGID)"
fi
root_dirs
exec "$@"
