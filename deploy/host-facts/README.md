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
