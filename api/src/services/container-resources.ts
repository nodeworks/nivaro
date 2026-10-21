/**
 * Per-container resource view for the Infrastructure page (#2835), from cAdvisor metrics in the
 * telemetry store. Expressions are fixed here; only the window (24h / 7d) and an operator-set
 * container name pattern (GITLAB_CONTAINER) vary, never request text.
 */
import { lq, metricsQuery, metricsRange, storeConfig } from './telemetry-store.js'

export type ResourceWindow = '24h' | '7d'

export const WINDOWS: Record<ResourceWindow, { ms: number; stepS: number; promql: string }> = {
  '24h': { ms: 24 * 3600_000, stepS: 600, promql: '24h' },
  '7d': { ms: 7 * 24 * 3600_000, stepS: 3600, promql: '7d' }
}

export const THROTTLE_FLAG = 0.1
export const MEMORY_FLAG = 0.85

export interface ContainerResource {
  id: string
  host: string
  container: string
  cpu_cores: number | null
  /** Share of CFS periods throttled over the window, 0-1. */
  throttled_share: number | null
  mem_bytes: number | null
  /** null = no limit (cAdvisor reports 0). */
  mem_limit_bytes: number | null
  mem_share: number | null
  oom_events: number | null
  rx_bps: number | null
  tx_bps: number | null
  read_bps: number | null
  write_bps: number | null
  flags: Array<'throttled' | 'memory'>
  cpu_spark: number[]
  mem_spark: number[]
}

const BY = 'by (host, instance, container)'

function sel(containerRe: string | null, extra = ''): string {
  const env = storeConfig()?.env
  const parts = [
    env ? `env=${lq(env)}` : '',
    containerRe ? `container=~${lq(containerRe)}` : 'container!=""',
    extra
  ].filter(Boolean)
  return `{${parts.join(',')}}`
}

export function resourceExprs(window: ResourceWindow, containerRe: string | null = null) {
  const w = WINDOWS[window].promql
  const s = sel(containerRe)
  return {
    cpu: `sum ${BY} (rate(container_cpu_usage_seconds_total${s}[5m]))`,
    throttled: `sum ${BY} (increase(container_cpu_cfs_throttled_periods_total${s}[${w}])) / sum ${BY} (increase(container_cpu_cfs_periods_total${s}[${w}]))`,
    mem: `max ${BY} (container_memory_working_set_bytes${s})`,
    limit: `max ${BY} (container_spec_memory_limit_bytes${s})`,
    oom: `sum ${BY} (increase(container_oom_events_total${s}[${w}]))`,
    rx: `sum ${BY} (rate(container_network_receive_bytes_total${s}[5m]))`,
    tx: `sum ${BY} (rate(container_network_transmit_bytes_total${s}[5m]))`,
    read: `sum ${BY} (rate(container_fs_reads_bytes_total${s}[5m]))`,
    write: `sum ${BY} (rate(container_fs_writes_bytes_total${s}[5m]))`
  }
}

type Labels = Record<string, string>

const hostOf = (l: Labels): string => l.host || (l.instance ?? '').replace(/:\d+$/, '') || ''
const keyOf = (l: Labels): string => `${hostOf(l)}|${l.container ?? ''}`
const finite = (v: number | undefined): number | null =>
  v != null && Number.isFinite(v) ? v : null

/** Spark values kept to a modest count so the response stays small. */
function thin(points: Array<[number, number]>, max = 60): number[] {
  const vals = points.map((p) => p[1]).filter((v) => Number.isFinite(v))
  if (vals.length <= max) return vals
  const every = vals.length / max
  const out: number[] = []
  for (let i = 0; i < max; i++) out.push(vals[Math.floor(i * every)])
  return out
}

export interface ResourceInputs {
  cpu: Array<{ labels: Labels; value: number }>
  throttled: Array<{ labels: Labels; value: number }>
  mem: Array<{ labels: Labels; value: number }>
  limit: Array<{ labels: Labels; value: number }>
  oom: Array<{ labels: Labels; value: number }>
  rx: Array<{ labels: Labels; value: number }>
  tx: Array<{ labels: Labels; value: number }>
  read: Array<{ labels: Labels; value: number }>
  write: Array<{ labels: Labels; value: number }>
  cpuSeries: Array<{ labels: Labels; points: Array<[number, number]> }>
  memSeries: Array<{ labels: Labels; points: Array<[number, number]> }>
}

export function buildResourceRows(input: ResourceInputs): ContainerResource[] {
  const rows = new Map<string, ContainerResource>()
  const row = (l: Labels): ContainerResource | null => {
    if (!l.container) return null
    const key = keyOf(l)
    let r = rows.get(key)
    if (!r) {
      r = {
        id: key,
        host: hostOf(l),
        container: l.container,
        cpu_cores: null,
        throttled_share: null,
        mem_bytes: null,
        mem_limit_bytes: null,
        mem_share: null,
        oom_events: null,
        rx_bps: null,
        tx_bps: null,
        read_bps: null,
        write_bps: null,
        flags: [],
        cpu_spark: [],
        mem_spark: []
      }
      rows.set(key, r)
    }
    return r
  }
  const apply = (
    list: Array<{ labels: Labels; value: number }>,
    set: (r: ContainerResource, v: number | null) => void
  ) => {
    for (const s of list) {
      const r = row(s.labels)
      if (r) set(r, finite(s.value))
    }
  }
  apply(input.cpu, (r, v) => {
    r.cpu_cores = v
  })
  apply(input.throttled, (r, v) => {
    r.throttled_share = v == null ? null : Math.min(1, Math.max(0, v))
  })
  apply(input.mem, (r, v) => {
    r.mem_bytes = v
  })
  apply(input.limit, (r, v) => {
    r.mem_limit_bytes = v != null && v > 0 && v < 2 ** 60 ? v : null
  })
  apply(input.oom, (r, v) => {
    r.oom_events = v == null ? null : Math.round(v)
  })
  apply(input.rx, (r, v) => {
    r.rx_bps = v
  })
  apply(input.tx, (r, v) => {
    r.tx_bps = v
  })
  apply(input.read, (r, v) => {
    r.read_bps = v
  })
  apply(input.write, (r, v) => {
    r.write_bps = v
  })
  for (const s of input.cpuSeries) {
    const r = row(s.labels)
    if (r) r.cpu_spark = thin(s.points)
  }
  for (const s of input.memSeries) {
    const r = row(s.labels)
    if (r) r.mem_spark = thin(s.points)
  }
  for (const r of rows.values()) {
    if (r.mem_bytes != null && r.mem_limit_bytes != null)
      r.mem_share = r.mem_bytes / r.mem_limit_bytes
    if (r.throttled_share != null && r.throttled_share > THROTTLE_FLAG) r.flags.push('throttled')
    if (r.mem_share != null && r.mem_share > MEMORY_FLAG) r.flags.push('memory')
  }
  return [...rows.values()].sort((a, b) => a.container.localeCompare(b.container))
}

export const resourcesAvailable = (): boolean => storeConfig() !== null

export async function loadContainerResources(
  window: ResourceWindow,
  containerRe: string | null = null,
  withSparks = true
): Promise<ContainerResource[]> {
  const ex = resourceExprs(window, containerRe)
  const to = Date.now()
  const from = to - WINDOWS[window].ms
  const stepS = WINDOWS[window].stepS
  // A part that fails (a metric the cAdvisor build does not export) leaves its column empty.
  const q = (expr: string) => metricsQuery(expr).catch(() => [])
  const range = (expr: string) =>
    withSparks ? metricsRange(expr, from, to, stepS).catch(() => []) : Promise.resolve([])
  const [cpu, throttled, mem, limit, oom, rx, tx, read, write, cpuSeries, memSeries] =
    await Promise.all([
      metricsQuery(ex.cpu),
      q(ex.throttled),
      q(ex.mem),
      q(ex.limit),
      q(ex.oom),
      q(ex.rx),
      q(ex.tx),
      q(ex.read),
      q(ex.write),
      range(ex.cpu),
      range(ex.mem)
    ])
  return buildResourceRows({
    cpu,
    throttled,
    mem,
    limit,
    oom,
    rx,
    tx,
    read,
    write,
    cpuSeries,
    memSeries
  })
}
