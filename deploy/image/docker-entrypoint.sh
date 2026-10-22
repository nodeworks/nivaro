#!/bin/sh
# Release image entrypoint (#2788/#2792/#2790). Runs under tini (PID 1), does
# the per-start setup a Dockerfile cannot, then exec's the command, so
# whatever CMD or `command:` the deployment gives (node api/dist/index.js, or
# a `sh -c "...; exec ..."` wrapper) becomes tini's child and gets SIGTERM.
#
# 1. Writable dirs. A read-only root filesystem leaves /app/uploads,
#    /app/work and /tmp writable; /app/work is often an EMPTY tmpfs or a new
#    volume, so TMPDIR (/app/work/tmp) and HOME (/app/work/home) may not exist.
# 2. Node heap from the container memory limit. V8 sizes its heap from the
#    cgroup limit at start (Node 22: about half of it) and cannot change it
#    later, so this sets --max-old-space-size to 75% of the limit in NODE_OPTIONS
#    (exported: a node started further down, by sh -c or another wrapper,
#    inherits it). Skipped when NODE_OPTIONS already names a heap size, when
#    there is no limit, or with NIVARO_HEAP_FROM_CGROUP=off.
#
# NIVARO_CGROUP_ROOT / NIVARO_MEMINFO move the files read (tests only).
set -e

for d in "${TMPDIR:-}" "${HOME:-}"; do
  [ -n "$d" ] && mkdir -p "$d" 2>/dev/null || true
done
# A volume created by an image that ran as root (before #2786) keeps root's
# ownership: say so once, plainly, instead of failing on the first upload.
if [ -d /app/uploads ] && [ ! -w /app/uploads ]; then
  echo "nivaro: /app/uploads is not writable by uid $(id -u) — uploads will fail." \
    "Fix once: docker run --rm -v <volume>:/app/uploads alpine chown -R 1000:1000 /app/uploads" >&2
fi

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

case "${NIVARO_HEAP_FROM_CGROUP:-on}" in
  off | false | 0 | no) ;;
  *)
    case " ${NODE_OPTIONS:-} " in
      *--max-old-space-size* | *--max_old_space_size*) ;;
      *)
        heap=$(heap_mb_for "$(cgroup_limit)")
        if [ -n "$heap" ]; then
          NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$heap"
          export NODE_OPTIONS
        fi
        ;;
    esac
    ;;
esac

exec "$@"
