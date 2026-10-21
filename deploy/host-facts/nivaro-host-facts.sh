#!/usr/bin/env bash
# nivaro-host-facts.sh — host facts for the Nivaro Infrastructure page (#2829 #2831 #2836 #2837).
#
# Writes node_exporter textfile metrics (nivaro_host_*) that the telemetry store scrapes:
#   ${TEXTFILE_DIR:-/var/lib/node_exporter/textfile}/nivaro_host.prom
# Runs as root every minute (cron or nivaro-host-facts.timer), or in a container with no extra
# capability and the host paths it reads mounted read-only under HOST_ROOT (Dockerfile +
# compose.example.yml beside this script; no sudo needed, only the docker group). The slow parts (pending security updates, needs-restarting,
# volume last-write scan) run every HOST_FACTS_HEAVY_SECONDS (30 min) and are cached in
# HOST_FACTS_STATE_DIR. Every probe fails soft: a missing tool or file just leaves its metric out.
# Needs bash, coreutils and awk; docker, openssl, systemctl, journalctl, dnf/yum,
# needs-restarting and apt-get are used when present.
#
# Settings (environment):
#   NIVARO_HOST_NAME         the `host` label; use the name this host has in DOCKER_HOSTS
#                            (default: hostname -s)
#   TEXTFILE_DIR             node_exporter textfile collector directory
#   HOST_FACTS_STATE_DIR     cache for the slow probes (default /var/lib/nivaro-host-facts)
#   HOST_FACTS_HEAVY_SECONDS how often the slow probes run (default 1800)
#   DOCKER_ROOT              Docker data root (default /var/lib/docker)
#   HOST_ROOT                container mode: where host paths are mounted (e.g. /host). Every
#                            host file is read under it; kernel messages come from the host's
#                            journal files (journalctl -D), docker.service from its unit files,
#                            security updates from the host's apt lists (Debian/Ubuntu only);
#                            what cannot be read that way is left out
#   HOST_FACTS_FIXTURE_DIR   test mode: read /proc, /etc/fstab, /boot, the Docker root and
#                            every command's output from this folder (cmd/<name>, optional
#                            cmd/<name>.exit) instead of the live host
#   HOST_FACTS_NOW           test mode: the current time in epoch seconds

set -u
umask 022
export LC_ALL=C

FIX=${HOST_FACTS_FIXTURE_DIR:-}
HOST_ROOT=${HOST_ROOT:-}
HOST_ROOT=${HOST_ROOT%/}
ROOT=${HOST_ROOT:-$FIX}
TEXTFILE_DIR=${TEXTFILE_DIR:-/var/lib/node_exporter/textfile}
STATE_DIR=${HOST_FACTS_STATE_DIR:-/var/lib/nivaro-host-facts}
HEAVY_EVERY=${HOST_FACTS_HEAVY_SECONDS:-1800}
DOCKER_ROOT=${DOCKER_ROOT:-/var/lib/docker}
NOW=${HOST_FACTS_NOW:-$(date +%s)}
HOST=${NIVARO_HOST_NAME:-}
if [ -z "$HOST" ]; then
  if [ -n "$FIX" ] && [ -f "$FIX/cmd/hostname" ]; then
    HOST=$(head -n1 "$FIX/cmd/hostname")
  elif [ -n "$HOST_ROOT" ] && [ -s "$HOST_ROOT/etc/hostname" ]; then
    # In a container hostname(1) names the container; the host's own name is in its /etc.
    HOST=$(head -n1 "$HOST_ROOT/etc/hostname" | cut -d. -f1)
  else
    HOST=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)
  fi
fi

# The state dir holds root's cache: create it private, and refuse one that is a symlink or that
# someone else owns (another user could otherwise point root's writes at any file). Nothing is
# written to a shared temp folder; the few files written are mktemp'd in their final folder.
TMP_FILES=""
cleanup() {
  # shellcheck disable=SC2086
  [ -n "$TMP_FILES" ] && rm -f $TMP_FILES
}
trap cleanup EXIT
if [ ! -e "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ]; then
  (umask 077 && mkdir -p "$STATE_DIR") || {
    echo "nivaro-host-facts: cannot create $STATE_DIR" >&2
    exit 1
  }
fi
if [ -L "$STATE_DIR" ] || [ ! -d "$STATE_DIR" ] || [ ! -O "$STATE_DIR" ]; then
  echo "nivaro-host-facts: refusing $STATE_DIR (a symlink, not a directory, or not owned by this user)" >&2
  exit 1
fi
chmod 0700 "$STATE_DIR" 2>/dev/null

# fx KEY [-t SECONDS] CMD ARGS... — run a command, or in fixture mode print cmd/KEY.
# Returns 127 when the command (or fixture) is missing.
fx() {
  local key=$1 secs=
  shift
  if [ "${1:-}" = "-t" ]; then
    secs=$2
    shift 2
  fi
  if [ -n "$FIX" ]; then
    [ -f "$FIX/cmd/$key" ] || return 127
    cat "$FIX/cmd/$key"
    if [ -f "$FIX/cmd/$key.exit" ]; then return "$(cat "$FIX/cmd/$key.exit")"; fi
    return 0
  fi
  command -v "$1" >/dev/null 2>&1 || return 127
  if [ -n "$secs" ] && command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    "$@"
  fi
}

# In fixture mode a tool "exists" when its fixture does.
have() {
  if [ -n "$FIX" ]; then [ -f "$FIX/cmd/$2" ]; else command -v "$1" >/dev/null 2>&1; fi
}

# Prometheus label value escaping (backslash, double quote, newline).
esc() {
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); if (NR > 1) print "\\n"; print }'
}

# GNU or BSD stat/find, decided once: falling back on a non-zero exit would also fire when GNU
# find merely hit an unreadable folder (and BSD `stat -f` means something else on GNU).
if stat -c %s / >/dev/null 2>&1; then GNU_STAT=1; else GNU_STAT=0; fi
if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then GNU_FIND=1; else GNU_FIND=0; fi

file_size() {
  if [ "$GNU_STAT" = 1 ]; then stat -c %s "$1" 2>/dev/null; else stat -f %z "$1" 2>/dev/null; fi
}

# Newest mtime (epoch seconds) under a directory, at most 3 levels deep. Folders this user may not
# enter (a volume owned by the container's own user) only count with their own mtime.
newest_mtime() {
  if [ "$GNU_FIND" = 1 ]; then
    find "$1" -maxdepth 3 -printf '%T@\n' 2>/dev/null
  else
    find "$1" -maxdepth 3 -exec stat -f %m {} + 2>/dev/null
  fi | awk 'BEGIN { m = 0 } { v = int($1); if (v > m) m = v } END { if (m > 0) print m }'
}

# "Jan  1 00:00:00 2027 GMT" -> epoch seconds (GNU date, else BSD date).
to_epoch() {
  date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%b %e %T %Y %Z' "$1" +%s 2>/dev/null
}

# Bash 3 compatible (no associative arrays): HELP/TYPE once per metric name.
OUT=""
OUT_SEEN=" "
metric() { # metric NAME TYPE HELP LABELS VALUE
  case "$OUT_SEEN" in
    *" $1 "*) ;;
    *)
      OUT+="# HELP $1 $3"$'\n'"# TYPE $1 $2"$'\n'
      OUT_SEEN+="$1 "
      ;;
  esac
  OUT+="$1{$4} $5"$'\n'
}

H="host=\"$(esc "$HOST")\""

# ── Kernel: running vs newest installed ───────────────────────────────────────
running=$(fx uname uname -r 2>/dev/null | head -n1)
[ -n "$running" ] && metric nivaro_host_kernel_running_info gauge \
  'Kernel version this host is running.' "$H,version=\"$(esc "$running")\"" 1

installed=""
if [ -d "$ROOT/boot" ]; then
  installed=$(ls -1 "$ROOT/boot" 2>/dev/null | sed -n 's/^vmlinuz-//p' | grep -v rescue |
    sort -V 2>/dev/null | tail -n1)
fi
if [ -z "$installed" ] && [ -d "$ROOT/var/lib/rpm" ] && have rpm rpm_kernel; then
  installed=$(fx rpm_kernel rpm --root "${ROOT:-/}" -q --qf '%{VERSION}-%{RELEASE}.%{ARCH}\n' \
    kernel-core kernel 2>/dev/null | grep -v 'not installed' | sort -V 2>/dev/null | tail -n1)
fi
[ -n "$installed" ] && metric nivaro_host_kernel_installed_info gauge \
  'Newest kernel installed under /boot (used after the next reboot).' \
  "$H,version=\"$(esc "$installed")\"" 1

# ── Uptime, /boot space ───────────────────────────────────────────────────────
btime=$(awk '$1 == "btime" { print $2; exit }' "$ROOT/proc/stat" 2>/dev/null)
[ -n "$btime" ] && metric nivaro_host_boot_time_seconds gauge \
  'When this host last booted (epoch seconds).' "$H" "$btime"

boot_free=$(fx df_boot df -Pk "${HOST_ROOT}/boot" 2>/dev/null | awk 'NR == 2 { print $4 * 1024 }')
[ -n "$boot_free" ] && metric nivaro_host_boot_free_bytes gauge \
  'Free space on the filesystem holding /boot.' "$H" "$boot_free"

# ── Hung host: D-state processes, hung-task and NFS kernel messages ───────────
if [ -d "$ROOT/proc" ]; then
  dstate=$(cat "$ROOT"/proc/[0-9]*/stat 2>/dev/null |
    awk '{ sub(/.*\) /, ""); if ($1 == "D") n++ } END { print n + 0 }')
  metric nivaro_host_dstate_processes gauge \
    'Processes in uninterruptible sleep (D state), usually waiting on IO.' "$H" "$dstate"
fi

# Kernel messages as "[seconds since boot] text" lines. In a container dmesg would need
# CAP_SYSLOG, so read this boot's kernel messages from the host's journal files instead.
kernel_messages() {
  if [ -z "$HOST_ROOT" ]; then
    fx dmesg dmesg
    return
  fi
  local d
  for d in "$ROOT/var/log/journal" "$ROOT/run/log/journal"; do
    if [ -d "$d" ] || [ -n "$FIX" ]; then
      fx journal_kernel -t 60 journalctl -D "$d" -k -b -q --no-pager -o short-monotonic \
        -g 'blocked for more than|nfs: server' && return
    fi
  done
  return 1
}

if dmesg_out=$(kernel_messages 2>/dev/null) && [ -n "$dmesg_out" ]; then
  uptime_s=$(awk '{ print int($1) }' "$ROOT/proc/uptime" 2>/dev/null)
  if [ -n "$uptime_s" ]; then
    hung=$(printf '%s\n' "$dmesg_out" | awk -v since=$((uptime_s - 900)) '
      /blocked for more than [0-9]+ seconds/ {
        if (match($0, /^\[ *[0-9]+(\.[0-9]+)?\]/)) {
          t = substr($0, RSTART + 1, RLENGTH - 2) + 0
          if (t >= since) n++
        }
      }
      END { print n + 0 }')
    metric nivaro_host_hung_task_events gauge \
      'Kernel hung-task messages in the last 15 minutes.' "$H" "$hung"
  fi
fi

# NFS servers: every server mounted from, plus any the kernel complained about. 1 = its last
# kernel message was "not responding".
mounts_file="$ROOT/proc/mounts"
[ -n "$HOST_ROOT" ] && [ -r "$ROOT/proc/1/mounts" ] && mounts_file="$ROOT/proc/1/mounts"
nfs_servers=$(awk '$3 ~ /^nfs4?$/ { split($1, a, ":"); print a[1] }' "$mounts_file" 2>/dev/null)
if [ -n "${dmesg_out:-}" ]; then
  nfs_state=$(printf '%s\n' "$dmesg_out" | awk '
    /nfs: server [^ ]+ not responding/ { for (i = 1; i <= NF; i++) if ($i == "server") s[$(i + 1)] = 1 }
    /nfs: server [^ ]+ OK/ { for (i = 1; i <= NF; i++) if ($i == "server") s[$(i + 1)] = 0 }
    END { for (k in s) print k, s[k] }')
else
  nfs_state=""
fi
while read -r srv; do
  [ -n "$srv" ] || continue
  v=$(printf '%s\n' "$nfs_state" | awk -v s="$srv" '$1 == s { print $2 }')
  metric nivaro_host_nfs_not_responding gauge \
    'NFS server the kernel last reported as not responding (1) or answering (0).' \
    "$H,server=\"$(esc "$srv")\"" "${v:-0}"
done < <(
  printf '%s\n%s\n' "$nfs_servers" "$(printf '%s\n' "$nfs_state" | awk 'NF { print $1 }')" |
    awk 'NF && !seen[$1]++' | sort
)

# ── Remote mounts in /etc/fstab: nofail, and whether docker waits for them ────
remote_mounts=$(awk '
  /^[[:space:]]*#/ || NF < 4 { next }
  $3 ~ /^(nfs|nfs4|cifs|smb3|smbfs|glusterfs|ceph|fuse\.sshfs|sshfs|davfs|9p)$/ || $4 ~ /(^|,)_netdev(,|$)/ {
    nofail = ($4 ~ /(^|,)(nofail|_netdev)(,|$)/) ? 1 : 0
    print $2, $3, nofail
  }' "$ROOT/etc/fstab" 2>/dev/null)

# RequiresMountsFor= / After= of docker.service from its unit file and drop-ins under ROOT, in
# systemd's precedence order (an empty assignment resets the list). Prints systemctl-show lines.
docker_unit_from_files() {
  local base="" d f
  for d in /etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
    if [ -f "$ROOT$d/docker.service" ]; then
      base="$ROOT$d/docker.service"
      break
    fi
  done
  [ -n "$base" ] || return 1
  {
    cat "$base"
    for d in /usr/lib/systemd/system /lib/systemd/system /usr/local/lib/systemd/system /run/systemd/system /etc/systemd/system; do
      for f in "$ROOT$d"/docker.service.d/*.conf; do
        [ -f "$f" ] && cat "$f"
      done
    done
  } | awk -F= '
    /^[[:space:]]*[#;]/ { next }
    /^[[:space:]]*\[/ { unit = ($0 ~ /^[[:space:]]*\[Unit\]/); next }
    unit && $1 ~ /^[[:space:]]*(RequiresMountsFor|After)[[:space:]]*$/ {
      k = $1; gsub(/[[:space:]]/, "", k)
      v = substr($0, index($0, "=") + 1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      if (v == "") val[k] = ""; else val[k] = (val[k] == "" ? v : val[k] " " v)
    }
    END { print "RequiresMountsFor=" val["RequiresMountsFor"]; print "After=" val["After"] }'
}

if [ -n "$HOST_ROOT" ]; then
  docker_show=$(docker_unit_from_files 2>/dev/null)
else
  docker_show=$(fx systemctl_docker systemctl show docker -p RequiresMountsFor -p After 2>/dev/null) ||
    docker_show=$(docker_unit_from_files 2>/dev/null)
fi
docker_known=$?
requires=$(printf '%s\n' "$docker_show" | sed -n 's/^RequiresMountsFor=//p')
after=$(printf '%s\n' "$docker_show" | sed -n 's/^After=//p')

while read -r mp fstype nofail; do
  [ -n "$mp" ] || continue
  metric nivaro_host_mount_nofail gauge \
    'Remote filesystem in /etc/fstab marked nofail or _netdev (1) or not (0).' \
    "$H,mountpoint=\"$(esc "$mp")\",fstype=\"$(esc "$fstype")\"" "$nofail"
  if [ "$docker_known" -eq 0 ] && [ -n "$docker_show" ]; then
    waits=0
    for p in $requires; do
      case "$p" in "$mp" | "$mp"/*) waits=1 ;; esac
    done
    case " $after " in *" remote-fs.target "*) waits=1 ;; esac
    metric nivaro_host_docker_waits_for_mounts gauge \
      'docker.service waits for this mount at boot (RequiresMountsFor or remote-fs.target).' \
      "$H,mountpoint=\"$(esc "$mp")\"" "$waits"
  fi
done < <(printf '%s\n' "$remote_mounts")

# ── Containers: json-file log size ────────────────────────────────────────────
if ids=$(fx docker_ps docker ps -aq 2>/dev/null) && [ -n "$ids" ]; then
  # shellcheck disable=SC2086
  while read -r name path; do
    [ -n "$name" ] && [ -n "$path" ] || continue
    size=$(file_size "$ROOT$path")
    [ -n "$size" ] || continue
    metric nivaro_host_container_log_bytes gauge \
      'Size of the container log file Docker keeps on this host.' \
      "$H,container=\"$(esc "${name#/}")\"" "$size"
  done < <(fx docker_inspect docker inspect -f '{{.Name}} {{.LogPath}}' $ids 2>/dev/null)
fi

# ── Swarm node certificate ────────────────────────────────────────────────────
cert="$ROOT$DOCKER_ROOT/swarm/certificates/swarm-node.crt"
if [ -n "$FIX" ] || [ -f "$cert" ]; then
  enddate=$(fx openssl_enddate openssl x509 -noout -enddate -in "$cert" 2>/dev/null |
    sed -n 's/^notAfter=//p')
  if [ -n "$enddate" ]; then
    exp=$(to_epoch "$enddate")
    [ -n "$exp" ] && metric nivaro_host_swarm_node_cert_expiry_seconds gauge \
      'When this swarm node certificate expires (epoch seconds).' "$H" "$exp"
  fi
fi

# ── Slow probes, cached ──────────────────────────────────────────────────────
heavy() {
  local out="" seen=" " v
  hmetric() {
    case "$seen" in
      *" $1 "*) ;;
      *)
        out+="# HELP $1 $3"$'\n'"# TYPE $1 $2"$'\n'
        seen+="$1 "
        ;;
    esac
    out+="$1{$4} $5"$'\n'
  }

  # Pending security updates (left out when the package tool fails, e.g. no repository access).
  local list="" rc=127
  if [ -n "$HOST_ROOT" ]; then
    # Container mode: apt can simulate against the host's own lists and dpkg status, read only.
    # RPM hosts are left out (dnf needs the host's repositories and cache).
    if [ -f "$ROOT/var/lib/dpkg/status" ] && have apt-get apt_upgrade; then
      list=$(fx apt_upgrade -t 300 apt-get -s -o Debug::NoLocking=1 -o Dir="$ROOT" \
        -o Dir::State::status="$ROOT/var/lib/dpkg/status" -o Dir::Cache::pkgcache= \
        -o Dir::Cache::srcpkgcache= upgrade 2>/dev/null)
      rc=$?
      v=$(printf '%s\n' "$list" | awk 'tolower($0) ~ /^inst .*security/ { n++ } END { print n + 0 }')
    fi
  elif have dnf dnf_security; then
    list=$(fx dnf_security -t 300 dnf -q updateinfo list --security 2>/dev/null)
    rc=$?
    v=$(printf '%s\n' "$list" | awk 'NF >= 3 { n++ } END { print n + 0 }')
  elif have yum yum_security; then
    list=$(fx yum_security -t 300 yum -q updateinfo list security 2>/dev/null)
    rc=$?
    v=$(printf '%s\n' "$list" | awk 'NF >= 3 { n++ } END { print n + 0 }')
  elif have apt-get apt_upgrade; then
    list=$(fx apt_upgrade -t 300 apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null)
    rc=$?
    v=$(printf '%s\n' "$list" | awk 'tolower($0) ~ /^inst .*security/ { n++ } END { print n + 0 }')
  fi
  [ "$rc" -eq 0 ] && hmetric nivaro_host_security_updates gauge \
    'Pending security updates.' "$H" "$v"

  # Reboot required: Debian flag file, RHEL needs-restarting -r, else running != installed.
  local req=""
  if [ -f "$ROOT/var/run/reboot-required" ] || [ -f "$ROOT/run/reboot-required" ]; then
    req=1
  elif [ -z "$HOST_ROOT" ] && have needs-restarting needs_restarting; then
    fx needs_restarting -t 120 needs-restarting -r >/dev/null 2>&1
    case $? in 0) req=0 ;; 1) req=1 ;; esac
  fi
  if [ -z "$req" ] && [ -n "$running" ] && [ -n "$installed" ]; then
    if [ "$running" = "$installed" ]; then req=0; else req=1; fi
  fi
  [ -n "$req" ] && hmetric nivaro_host_reboot_required gauge \
    'This host needs a reboot to finish updates (1) or not (0).' "$H" "$req"

  # Newest write under each Docker volume.
  local vol d m
  for d in "$ROOT$DOCKER_ROOT"/volumes/*/_data; do
    [ -d "$d" ] || continue
    vol=$(basename "$(dirname "$d")")
    m=$(newest_mtime "$d")
    [ -n "$m" ] && hmetric nivaro_host_volume_last_write_seconds gauge \
      'Newest file change under this Docker volume (epoch seconds, 3 levels deep).' \
      "$H,volume=\"$(esc "$vol")\"" "$m"
  done

  printf '%s' "$out"
}

stamp=$(cat "$STATE_DIR/heavy.stamp" 2>/dev/null || echo 0)
case "$stamp" in '' | *[!0-9]*) stamp=0 ;; esac
if [ $((NOW - stamp)) -ge "$HEAVY_EVERY" ] || [ ! -f "$STATE_DIR/heavy.prom" ]; then
  htmp=$(mktemp "$STATE_DIR/heavy.prom.XXXXXX") && TMP_FILES="$TMP_FILES $htmp"
  if [ -n "${htmp:-}" ] && heavy >"$htmp" 2>/dev/null; then
    mv -f "$htmp" "$STATE_DIR/heavy.prom"
    printf '%s\n' "$NOW" >"$STATE_DIR/heavy.stamp"
  fi
fi

metric nivaro_host_facts_last_run_seconds gauge \
  'When nivaro-host-facts last ran on this host (epoch seconds).' "$H" "$NOW"

# ── Write atomically ─────────────────────────────────────────────────────────
mkdir -p "$TEXTFILE_DIR" || exit 1
# mktemp in the textfile dir itself: same filesystem, so the mv is atomic.
out_tmp=$(mktemp "$TEXTFILE_DIR/.nivaro_host.prom.XXXXXX") || exit 1
TMP_FILES="$TMP_FILES $out_tmp"
{
  printf '%s' "$OUT"
  cat "$STATE_DIR/heavy.prom" 2>/dev/null
} >"$out_tmp" && chmod 0644 "$out_tmp" && mv -f "$out_tmp" "$TEXTFILE_DIR/nivaro_host.prom"
exit $?
