# Nivaro host facts

`nivaro-host-facts.sh` collects the facts about a Docker host that the Docker Engine API cannot
give: kernel and reboot state, pending security updates, `/boot` space, processes stuck on IO,
NFS servers that stopped answering, remote mounts in `/etc/fstab` and whether Docker waits for
them at boot, container log file sizes, the newest write under each volume, and the swarm node
certificate expiry.

It writes them as node_exporter textfile metrics (`nivaro_host_*`) to
`/var/lib/node_exporter/textfile/nivaro_host.prom`. Your collector (node_exporter's textfile
collector, or Grafana Alloy's `prometheus.exporter.unix` with a textfile directory) ships them to
the telemetry store, and the Nivaro Infrastructure page reads them from there (the Hosts, Reboot
and Logs tabs). Until the metrics arrive those tabs say "Host facts are not collected".

The Nivaro API never runs this script and never talks to the host directly.

## Requirements

- bash (3.2 or later), coreutils, awk, find. Runs on RHEL / Rocky / Alma 8+ and Debian / Ubuntu.
- Root, so it can read container log files, Docker volumes and `dmesg`.
- Used when present (each probe is skipped when its tool is missing): `docker`, `openssl`,
  `systemctl`, `dnf` or `yum` (with `needs-restarting` from dnf-utils / yum-utils), `apt-get`.

## Install

```bash
install -m 0755 nivaro-host-facts.sh /usr/local/sbin/nivaro-host-facts.sh
install -m 0644 nivaro-host-facts.service nivaro-host-facts.timer /etc/systemd/system/
mkdir -p /var/lib/node_exporter/textfile

# The host label must match this host's name in DOCKER_HOSTS on the Nivaro instance.
echo 'NIVARO_HOST_NAME=staging' > /etc/default/nivaro-host-facts

systemctl daemon-reload
systemctl enable --now nivaro-host-facts.timer
systemctl start nivaro-host-facts.service   # first run now
cat /var/lib/node_exporter/textfile/nivaro_host.prom
```

Without systemd timers, use cron (the lock stops a slow run from overlapping the next one):

```cron
* * * * * root NIVARO_HOST_NAME=staging flock -n /run/nivaro-host-facts.lock /usr/local/sbin/nivaro-host-facts.sh
```

## Run as a container (no sudo)

When you cannot install anything as root on the host, run the collector as a container, the way
node_exporter and cAdvisor run. Being in the `docker` group is enough.

```bash
cd deploy/host-facts
# edit NIVARO_HOST_NAME, DOCKER_HOST and the optional mounts in compose.example.yml first
docker compose -f compose.example.yml up -d --build
docker compose -f compose.example.yml exec host-facts cat /textfile/nivaro_host.prom
```

What the example does:

- Sets `HOST_ROOT=/host` and mounts only the host paths the script reads, each read-only at the
  same place under `/host`: `/proc`, `/etc/hostname`, `/etc/fstab`, `/boot`,
  `/etc/systemd/system`, `/usr/lib/systemd/system`, `/var/lib/docker/containers`,
  `/var/lib/docker/volumes`, and `/var/log/journal`. The optional mounts (the runtime journal,
  the apt lists and dpkg status on Debian / Ubuntu, the rpm database on RHEL) are listed in the
  file: remove any whose source does not exist on the host. They use `create_host_path: false`,
  so a missing one fails at start instead of Docker creating an empty folder on the host.
- Runs the script every 60 seconds (`HOST_FACTS_INTERVAL`); the slow probes stay cached for
  30 minutes in the `host-facts-state` volume.
- Writes `nivaro_host.prom` to the `host-facts` volume. Mount it read-only into the node_exporter
  (or Alloy) you already run and use it as the textfile directory.
- Talks to Docker for `docker ps` and `docker inspect` only, through `DOCKER_HOST`: the GET-only
  Docker socket proxy Nivaro already reads (it needs the CONTAINERS section).

### Security

- **No extra capability.** `cap_drop: [ALL]` with nothing added, a read-only root filesystem and
  `no-new-privileges`. The container runs as uid 0, so it reads root-owned files through their
  owner bits (container log files, journal files, root-owned folders) without `DAC_OVERRIDE` or
  `DAC_READ_SEARCH`. Do not add `DAC_READ_SEARCH`: it allows `open_by_handle_at`, which can read
  any file on the host, outside the mounts too.
- **Narrow mounts, never `/`.** Only the paths in the list above. They still expose more than the
  script needs: `/var/lib/docker/containers` also holds each container's `config.v2.json`
  (environment variables included) and `/var/lib/docker/volumes` the volume contents. Drop either
  mount to give up the log-size or volume-write metrics instead.
- **Not mounted on purpose:** `/var/lib/docker/swarm/certificates` (it also holds the node's private
  key, so the swarm certificate expiry is left out in a container) and `/run` (it holds the Docker
  socket, so `/run/reboot-required` is not read; the running vs installed kernel decides).
- **The Docker socket stays behind the GET-only proxy.** Do not mount `/var/run/docker.sock`:
  `:ro` on a socket only stops the file being replaced, and the API behind it can still start
  privileged containers. There is no `pid: host` either: the host's `/proc` mounted read-only is
  enough to read processes and the host mount table, and the container cannot signal host
  processes.

What cannot be read without a capability is left out: a volume whose data folder belongs to
another user with mode 0700 (a database volume, for example) reports only that folder's own
change time.

### Where each fact comes from

| Fact | On the host | In the container |
|---|---|---|
| Kernel messages (hung tasks, NFS) | `dmesg` | The host's journal files (`journalctl -D /host/var/log/journal`, this boot only). Without a journal mounted under `/host`, the hung-task and NFS-message metrics are left out. |
| docker.service mounts | `systemctl show docker` | Parsed from `docker.service` and its drop-ins under `/host` (`RequiresMountsFor=`, `After=` in `[Unit]`). |
| Installed kernel | `/boot/vmlinuz-*` | The same under `/host/boot`, else the host's rpm database (`rpm --root /host`, optional mount). |
| Security updates | `dnf` / `yum` / `apt-get` | Debian / Ubuntu: `apt-get -s` against the host's own lists (optional mounts). RPM hosts: left out (dnf needs the host's repositories). |
| Reboot required | `/run/reboot-required`, `needs-restarting -r` | Running kernel ≠ newest installed kernel. |
| Swarm node certificate | `openssl` on `swarm-node.crt` | Left out (see Security). |
| Host name | `hostname -s` | `NIVARO_HOST_NAME`, else `/host/etc/hostname`. |

## Wire it into the collector

node_exporter:

```bash
node_exporter --collector.textfile.directory=/var/lib/node_exporter/textfile
```

In a container, mount the directory read-only, e.g. `-v /var/lib/node_exporter/textfile:/textfile:ro`
and `--collector.textfile.directory=/textfile`.

Grafana Alloy:

```alloy
prometheus.exporter.unix "host" {
  textfile {
    directory = "/var/lib/node_exporter/textfile"
  }
}
```

Every sample carries its own `host` label, so it lines up with the Docker host name even when
the scraper adds `instance` or `job` labels.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `NIVARO_HOST_NAME` | `hostname -s` | The `host` label. Use the name from `DOCKER_HOSTS`. |
| `TEXTFILE_DIR` | `/var/lib/node_exporter/textfile` | Where `nivaro_host.prom` is written. |
| `HOST_FACTS_STATE_DIR` | `/var/lib/nivaro-host-facts` | Cache for the slow probes. Created with mode 0700; the script refuses to run when it is a symlink or owned by another user. |
| `HOST_FACTS_HEAVY_SECONDS` | `1800` | How often the slow probes run (security updates, needs-restarting, volume scan). |
| `DOCKER_ROOT` | `/var/lib/docker` | Docker data root. |
| `HOST_ROOT` | empty | Container mode: where the host paths are mounted (e.g. `/host`). See "Run as a container". |
| `HOST_FACTS_INTERVAL` | `60` | Container image only: seconds between runs. |

`HOST_FACTS_FIXTURE_DIR` and `HOST_FACTS_NOW` are for the tests
(`api/src/services/host-facts-script.test.ts`): the script then reads `/proc`, `/etc/fstab`,
`/boot` and the Docker root from that folder and every command's output from `cmd/<name>`.

## Metrics

| Metric | Labels | Meaning |
|---|---|---|
| `nivaro_host_kernel_running_info` | `host`, `version` | Kernel running now (value 1). |
| `nivaro_host_kernel_installed_info` | `host`, `version` | Newest kernel under `/boot` (value 1). |
| `nivaro_host_reboot_required` | `host` | 1 = a reboot is needed (`/run/reboot-required`, `needs-restarting -r`, else running ≠ installed kernel). |
| `nivaro_host_boot_time_seconds` | `host` | Last boot (epoch seconds). |
| `nivaro_host_security_updates` | `host` | Pending security updates (left out when the package tool fails). |
| `nivaro_host_boot_free_bytes` | `host` | Free space on the filesystem holding `/boot`. |
| `nivaro_host_dstate_processes` | `host` | Processes in uninterruptible sleep (D state). |
| `nivaro_host_hung_task_events` | `host` | Kernel "blocked for more than N seconds" messages in the last 15 minutes. |
| `nivaro_host_nfs_not_responding` | `host`, `server` | 1 = the kernel's last message for that NFS server was "not responding". |
| `nivaro_host_mount_nofail` | `host`, `mountpoint`, `fstype` | Remote filesystem in `/etc/fstab`: 1 = `nofail` or `_netdev` set. |
| `nivaro_host_docker_waits_for_mounts` | `host`, `mountpoint` | 1 = `docker.service` waits for it (`RequiresMountsFor` covers it, or `After=remote-fs.target`). |
| `nivaro_host_container_log_bytes` | `host`, `container` | Size of the container's log file (json-file / local drivers). |
| `nivaro_host_volume_last_write_seconds` | `host`, `volume` | Newest change under the volume, 3 levels deep (epoch seconds). |
| `nivaro_host_swarm_node_cert_expiry_seconds` | `host` | Swarm node certificate expiry (epoch seconds). |
| `nivaro_host_facts_last_run_seconds` | `host` | When the script last ran (epoch seconds). |

## Making Docker wait for a remote mount

When a container uses a bind mount on NFS or CIFS and Docker starts before that mount is ready,
the container starts against the empty mount point and comes back "broken". Make Docker wait:

```bash
systemctl edit docker
# [Unit]
# RequiresMountsFor=/mnt/data
```

and add `nofail` (plus `_netdev`) to the mount in `/etc/fstab`, so a share that is down does not
stop the host from booting.
