/**
 * Host facts (#2829 #2831 #2836 #2837): what deploy/host-facts/nivaro-host-facts.sh writes on each
 * Docker host as node_exporter textfile metrics (`nivaro_host_*`, label `host` = the Docker host
 * name), read back from the telemetry store, plus the node_exporter signals the hung-host check
 * needs. The API never runs anything on a host; missing metrics mean "not collected", never an
 * error.
 */
import { type MetricSample, metricsQuery, storeEnabled } from './telemetry-store.js'

/** A host whose collector last ran longer ago than this is shown as stale. */
export const FACTS_STALE_MS = 10 * 60_000
/** /boot below this much free space is a warning (a kernel update needs room). */
export const BOOT_FREE_WARN_BYTES = 100 * 1024 * 1024

export interface HostMount {
  mountpoint: string
  fstype: string
  nofail: boolean
  /** null = docker.service could not be read on that host. */
  docker_waits: boolean | null
}

export interface HostFacts {
  host: string
  /** When the collector last ran (ms), from up to 30 days back. */
  collected_at: number | null
  stale: boolean
  kernel_running: string | null
  kernel_installed: string | null
  reboot_required: boolean | null
  boot_time: number | null
  security_updates: number | null
  boot_free_bytes: number | null
  dstate_processes: number | null
  hung_task_events: number | null
  nfs: Array<{ server: string; not_responding: boolean }>
  mounts: HostMount[]
  container_log_bytes: Record<string, number>
  volume_last_write: Record<string, number>
  swarm_cert_expiry: number | null
}

function blank(host: string): HostFacts {
  return {
    host,
    collected_at: null,
    stale: true,
    kernel_running: null,
    kernel_installed: null,
    reboot_required: null,
    boot_time: null,
    security_updates: null,
    boot_free_bytes: null,
    dstate_processes: null,
    hung_task_events: null,
    nfs: [],
    mounts: [],
    container_log_bytes: {},
    volume_last_write: {},
    swarm_cert_expiry: null
  }
}

const num = (v: number): number | null => (Number.isFinite(v) ? v : null)

/** Builds per-host facts from the store's samples (pure; the tests feed it directly). */
export function parseHostFacts(
  samples: MetricSample[],
  lastRun: MetricSample[],
  nowMs = Date.now()
): Map<string, HostFacts> {
  const out = new Map<string, HostFacts>()
  const get = (host: string) => {
    let f = out.get(host)
    if (!f) {
      f = blank(host)
      out.set(host, f)
    }
    return f
  }
  const waits = new Map<string, boolean>()
  for (const s of samples) {
    const host = s.labels.host
    const name = s.labels.__name__
    if (!host || !name) continue
    const f = get(host)
    const v = s.value
    switch (name) {
      case 'nivaro_host_kernel_running_info':
        f.kernel_running = s.labels.version ?? null
        break
      case 'nivaro_host_kernel_installed_info':
        f.kernel_installed = s.labels.version ?? null
        break
      case 'nivaro_host_reboot_required':
        f.reboot_required = Number.isFinite(v) ? v === 1 : null
        break
      case 'nivaro_host_boot_time_seconds':
        f.boot_time = num(v) == null ? null : v * 1000
        break
      case 'nivaro_host_security_updates':
        f.security_updates = num(v)
        break
      case 'nivaro_host_boot_free_bytes':
        f.boot_free_bytes = num(v)
        break
      case 'nivaro_host_dstate_processes':
        f.dstate_processes = num(v)
        break
      case 'nivaro_host_hung_task_events':
        f.hung_task_events = num(v)
        break
      case 'nivaro_host_nfs_not_responding':
        if (s.labels.server) f.nfs.push({ server: s.labels.server, not_responding: v === 1 })
        break
      case 'nivaro_host_mount_nofail':
        if (s.labels.mountpoint)
          f.mounts.push({
            mountpoint: s.labels.mountpoint,
            fstype: s.labels.fstype ?? '',
            nofail: v === 1,
            docker_waits: null
          })
        break
      case 'nivaro_host_docker_waits_for_mounts':
        if (s.labels.mountpoint) waits.set(`${host}|${s.labels.mountpoint}`, v === 1)
        break
      case 'nivaro_host_container_log_bytes':
        if (s.labels.container && Number.isFinite(v)) f.container_log_bytes[s.labels.container] = v
        break
      case 'nivaro_host_volume_last_write_seconds':
        if (s.labels.volume && Number.isFinite(v)) f.volume_last_write[s.labels.volume] = v * 1000
        break
      case 'nivaro_host_swarm_node_cert_expiry_seconds':
        f.swarm_cert_expiry = num(v) == null ? null : v * 1000
        break
      case 'nivaro_host_facts_last_run_seconds':
        if (Number.isFinite(v)) f.collected_at = Math.max(f.collected_at ?? 0, v * 1000)
        break
    }
  }
  for (const s of lastRun) {
    const host = s.labels.host
    if (!host || !Number.isFinite(s.value)) continue
    const f = get(host)
    f.collected_at = Math.max(f.collected_at ?? 0, s.value * 1000)
  }
  for (const f of out.values()) {
    const seen = new Set<string>()
    f.mounts = f.mounts
      .filter((m) => !seen.has(m.mountpoint) && seen.add(m.mountpoint))
      .map((m) => ({ ...m, docker_waits: waits.get(`${f.host}|${m.mountpoint}`) ?? null }))
      .sort((a, b) => a.mountpoint.localeCompare(b.mountpoint))
    const servers = new Map<string, boolean>()
    for (const n of f.nfs)
      servers.set(n.server, (servers.get(n.server) ?? false) || n.not_responding)
    f.nfs = [...servers].map(([server, not_responding]) => ({ server, not_responding }))
    f.stale = f.collected_at == null || nowMs - f.collected_at > FACTS_STALE_MS
  }
  return out
}

// ── Node signals for the hung-host check (node_exporter, already in the store) ─────────────────

export interface NodeSignals {
  load1: number | null
  cpus: number | null
  /** 0..1 over the last 5 minutes. */
  idle: number | null
  iowait: number | null
  /** Filesystems node_exporter could not stat (value 1), and every remote one (device = server:path). */
  filesystems: Array<{ mountpoint: string; device: string; fstype: string; error: boolean }>
  /** node_filesystem_avail/size per mountpoint (for the log growth projection). */
  space: Array<{ mountpoint: string; avail_bytes: number; size_bytes: number | null }>
}

const blankSignals = (): NodeSignals => ({
  load1: null,
  cpus: null,
  idle: null,
  iowait: null,
  filesystems: [],
  space: []
})

export function parseNodeSignals(parts: {
  load1: MetricSample[]
  cpus: MetricSample[]
  idle: MetricSample[]
  iowait: MetricSample[]
  deviceError: MetricSample[]
  avail: MetricSample[]
  size: MetricSample[]
}): Map<string, NodeSignals> {
  const out = new Map<string, NodeSignals>()
  const get = (host: string) => {
    let s = out.get(host)
    if (!s) {
      s = blankSignals()
      out.set(host, s)
    }
    return s
  }
  const scalar = (rows: MetricSample[], key: 'load1' | 'cpus' | 'idle' | 'iowait') => {
    for (const r of rows)
      if (r.labels.host && Number.isFinite(r.value)) get(r.labels.host)[key] = r.value
  }
  scalar(parts.load1, 'load1')
  scalar(parts.cpus, 'cpus')
  scalar(parts.idle, 'idle')
  scalar(parts.iowait, 'iowait')
  for (const r of parts.deviceError) {
    if (!r.labels.host || !r.labels.mountpoint) continue
    get(r.labels.host).filesystems.push({
      mountpoint: r.labels.mountpoint,
      device: r.labels.device ?? '',
      fstype: r.labels.fstype ?? '',
      error: r.value === 1
    })
  }
  const sizes = new Map<string, number>()
  for (const r of parts.size)
    if (r.labels.host && r.labels.mountpoint && Number.isFinite(r.value))
      sizes.set(`${r.labels.host}|${r.labels.mountpoint}`, r.value)
  for (const r of parts.avail) {
    if (!r.labels.host || !r.labels.mountpoint || !Number.isFinite(r.value)) continue
    get(r.labels.host).space.push({
      mountpoint: r.labels.mountpoint,
      avail_bytes: r.value,
      size_bytes: sizes.get(`${r.labels.host}|${r.labels.mountpoint}`) ?? null
    })
  }
  return out
}

/** The filesystem holding `path`: the longest mountpoint that is a prefix of it. */
export function filesystemFor<T extends { mountpoint: string }>(list: T[], path: string): T | null {
  let best: T | null = null
  for (const fs of list) {
    const mp = fs.mountpoint
    const covers = mp === '/' || path === mp || path.startsWith(`${mp.replace(/\/+$/, '')}/`)
    if (covers && (!best || mp.length > best.mountpoint.length)) best = fs
  }
  return best
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────

export interface HostFactsRead {
  store: boolean
  facts: Map<string, HostFacts>
  signals: Map<string, NodeSignals>
  error: string | null
}

const REMOTE_FS = 'nfs.*|cifs|smb.*|glusterfs|ceph|fuse\\\\.sshfs|9p'

let cache: { at: number; value: HostFactsRead } | null = null
let inflight: Promise<HostFactsRead> | null = null

export function resetHostFactsCacheForTests(): void {
  cache = null
  inflight = null
}

async function q(expr: string): Promise<MetricSample[]> {
  return metricsQuery(expr)
}

/** Facts + node signals for every host the store knows; cached 30 s, one read in flight. */
export async function readHostFacts(nowMs = Date.now()): Promise<HostFactsRead> {
  if (!storeEnabled()) return { store: false, facts: new Map(), signals: new Map(), error: null }
  if (cache && nowMs - cache.at < 30_000) return cache.value
  if (inflight) return inflight
  inflight = (async () => {
    const parts = await Promise.allSettled([
      q('last_over_time({__name__=~"nivaro_host_.+"}[1h]) keep_metric_names'),
      q('max by (host) (last_over_time(nivaro_host_facts_last_run_seconds[30d]))'),
      q('max by (host) (node_load1)'),
      q('count by (host) (node_cpu_seconds_total{mode="idle"})'),
      q('avg by (host) (rate(node_cpu_seconds_total{mode="idle"}[5m]))'),
      q('avg by (host) (rate(node_cpu_seconds_total{mode="iowait"}[5m]))'),
      q(
        `max by (host, mountpoint, device, fstype) (node_filesystem_device_error{fstype=~"${REMOTE_FS}"} or node_filesystem_device_error == 1)`
      ),
      q(
        'max by (host, mountpoint) (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"})'
      ),
      q('max by (host, mountpoint) (node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"})')
    ])
    const val = (i: number) => {
      const p = parts[i]
      return p.status === 'fulfilled' ? p.value : []
    }
    const factsRead = parts[0]
    const value: HostFactsRead = {
      store: true,
      facts: parseHostFacts(val(0), val(1), nowMs),
      signals: parseNodeSignals({
        load1: val(2),
        cpus: val(3),
        idle: val(4),
        iowait: val(5),
        deviceError: val(6),
        avail: val(7),
        size: val(8)
      }),
      error:
        factsRead.status === 'rejected'
          ? String((factsRead.reason as Error)?.message ?? 'The metrics store did not answer')
          : null
    }
    cache = { at: nowMs, value }
    return value
  })()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

// ── Verdicts: patch status (#2837) and hung IO (#2836) ───────────────────────────────────────

export type Level = 'ok' | 'warning' | 'critical' | 'unknown'

export interface PatchStatus {
  level: Level
  kernel_running: string | null
  kernel_installed: string | null
  kernel_pending: boolean
  reboot_required: boolean | null
  days_since_boot: number | null
  boot_free_bytes: number | null
  boot_low: boolean
  security_updates: number | null
  notes: string[]
}

export function patchStatus(f: HostFacts | null, nowMs = Date.now()): PatchStatus {
  if (!f || f.collected_at == null)
    return {
      level: 'unknown',
      kernel_running: null,
      kernel_installed: null,
      kernel_pending: false,
      reboot_required: null,
      days_since_boot: null,
      boot_free_bytes: null,
      boot_low: false,
      security_updates: null,
      notes: []
    }
  const notes: string[] = []
  const kernelPending =
    !!f.kernel_running && !!f.kernel_installed && f.kernel_running !== f.kernel_installed
  const bootLow = f.boot_free_bytes != null && f.boot_free_bytes < BOOT_FREE_WARN_BYTES
  const days =
    f.boot_time != null ? Math.max(0, Math.floor((nowMs - f.boot_time) / 86_400_000)) : null
  if (f.reboot_required) notes.push('A reboot is needed to finish installed updates.')
  else if (kernelPending)
    notes.push(`Kernel ${f.kernel_installed} is installed but not running yet.`)
  if (bootLow)
    notes.push(
      `/boot has ${Math.round((f.boot_free_bytes ?? 0) / 1048576)} MB free; the next kernel update may fail.`
    )
  if (f.security_updates != null && f.security_updates > 0)
    notes.push(
      `${f.security_updates} security update${f.security_updates === 1 ? '' : 's'} waiting.`
    )
  if (f.stale) notes.push('Host facts are out of date: the collector has not run recently.')
  const level: Level = bootLow
    ? 'critical'
    : f.reboot_required || kernelPending || (f.security_updates ?? 0) > 0 || f.stale
      ? 'warning'
      : 'ok'
  return {
    level,
    kernel_running: f.kernel_running,
    kernel_installed: f.kernel_installed,
    kernel_pending: kernelPending,
    reboot_required: f.reboot_required,
    days_since_boot: days,
    boot_free_bytes: f.boot_free_bytes,
    boot_low: bootLow,
    security_updates: f.security_updates,
    notes
  }
}

export interface HungStatus {
  level: Level
  /** One plain sentence; null when everything is fine. */
  headline: string | null
  dstate_processes: number | null
  hung_task_events: number | null
  load1: number | null
  cpus: number | null
  idle_pct: number | null
  iowait_pct: number | null
  nfs_not_responding: Array<{ server: string; mountpoint: string | null }>
  device_errors: string[]
  /** The mount most likely to blame, when one can be named. */
  suspect_mount: string | null
}

/** Load at least this many times the CPU count, with the CPU mostly idle, means waiting on IO. */
const LOAD_PER_CPU = 1.5
const IDLE_WAITING = 0.5
const DSTATE_WARN = 5

export function hungStatus(f: HostFacts | null, s: NodeSignals | null): HungStatus {
  const fs = s?.filesystems ?? []
  const serverMount = (server: string) =>
    fs.find((x) => x.device.startsWith(`${server}:`) || x.device.startsWith(`//${server}/`))
      ?.mountpoint ?? null
  const nfsDown = (f?.nfs ?? [])
    .filter((n) => n.not_responding)
    .map((n) => ({ server: n.server, mountpoint: serverMount(n.server) }))
  const deviceErrors = fs.filter((x) => x.error).map((x) => x.mountpoint)
  const suspect = nfsDown.find((n) => n.mountpoint)?.mountpoint ?? deviceErrors[0] ?? null
  const load1 = s?.load1 ?? null
  const cpus = s?.cpus ?? null
  const idle = s?.idle ?? null
  const dstate = f?.dstate_processes ?? null
  const hung = f?.hung_task_events ?? null
  const ioPattern =
    load1 != null &&
    cpus != null &&
    cpus > 0 &&
    idle != null &&
    load1 >= Math.max(4, cpus * LOAD_PER_CPU) &&
    idle >= IDLE_WAITING

  const pct = (v: number | null) => (v == null ? null : Math.round(v * 100))
  const blame = () => {
    if (suspect) {
      const n = nfsDown.find((x) => x.mountpoint === suspect)
      return n
        ? `, likely the mount ${suspect} (NFS server ${n.server} is not responding)`
        : `, likely the mount ${suspect}`
    }
    if (nfsDown.length) return ` — NFS server ${nfsDown[0].server} is not responding`
    return ''
  }

  let level: Level = 'ok'
  let headline: string | null = null
  if (ioPattern) {
    level = 'critical'
    headline = `Load ${Math.round(load1 as number)} while the CPU is ${pct(idle)}% idle — processes are waiting on IO${blame()}.`
  } else if ((hung ?? 0) > 0 && (dstate ?? 0) > 0) {
    level = 'critical'
    headline = `${hung} hung-task message${hung === 1 ? '' : 's'} in the last 15 minutes and ${dstate} process${dstate === 1 ? '' : 'es'} stuck on IO${blame()}.`
  } else if (nfsDown.length) {
    level = 'warning'
    headline = `NFS server ${nfsDown.map((n) => n.server).join(', ')} is not responding${suspect ? ` (mount ${suspect})` : ''}.`
  } else if (deviceErrors.length) {
    level = 'warning'
    headline = `The filesystem at ${deviceErrors.join(', ')} cannot be read.`
  } else if ((hung ?? 0) > 0) {
    level = 'warning'
    headline = `${hung} hung-task message${hung === 1 ? '' : 's'} in the last 15 minutes.`
  } else if ((dstate ?? 0) >= DSTATE_WARN) {
    level = 'warning'
    headline = `${dstate} processes are stuck waiting on IO.`
  } else if (f == null && s == null) {
    level = 'unknown'
  }
  return {
    level,
    headline,
    dstate_processes: dstate,
    hung_task_events: hung,
    load1,
    cpus,
    idle_pct: pct(idle),
    iowait_pct: pct(s?.iowait ?? null),
    nfs_not_responding: nfsDown,
    device_errors: deviceErrors,
    suspect_mount: suspect
  }
}
