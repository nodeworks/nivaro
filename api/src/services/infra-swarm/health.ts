import { type DockerHost, dockerGet, forEachDockerHost, ownerOf } from '../docker-source.js'
import {
  containerName,
  type EngineContainerInspect,
  type EngineContainerSummary,
  iso,
  ms,
  shortId,
  splitImage
} from './engine.js'
import { healthFromStatus } from './stacks.js'

/**
 * #2828 Healthcheck history. The Engine keeps only the last five probes per container, so health
 * TRANSITIONS are kept in a small Redis ring per container (`nvr:infra:health:<host>:<id>`, three
 * days), sampled whenever the Health tab is read and by the `infra-health-sample` cron. Keys are
 * tenant-free: the Infrastructure page is off in cloud mode.
 */

export type HealthStatus = 'healthy' | 'unhealthy' | 'starting'

export interface HealthTransition {
  status: HealthStatus
  at: string
}

/** The Redis calls the ring needs (ioredis satisfies it; tests pass a Map-backed fake). */
export interface HealthStore {
  lindex(key: string, index: number): Promise<string | null>
  lpush(key: string, value: string): Promise<number>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
}

export const HEALTH_RING_TTL_S = 3 * 24 * 3600
export const HEALTH_RING_MAX = 200
const DAY_MS = 24 * 3600 * 1000
/** Docker keeps this many probes in State.Health.Log. */
const ENGINE_HEALTH_LOG_SIZE = 5
const OUTPUT_MAX = 400

export const healthKey = (host: string, container: string): string =>
  `nvr:infra:health:${host}:${shortId(container) ?? container}`

function parseEntry(raw: string): HealthTransition | null {
  try {
    const v = JSON.parse(raw) as { s?: string; at?: string }
    if ((v.s === 'healthy' || v.s === 'unhealthy' || v.s === 'starting') && v.at)
      return { status: v.s, at: v.at }
  } catch {}
  return null
}

/** Appends a transition when the status differs from the last one kept. Returns true if it did. */
export async function recordHealth(
  store: HealthStore,
  host: string,
  container: string,
  status: HealthStatus,
  at: Date = new Date()
): Promise<boolean> {
  const key = healthKey(host, container)
  const last = await store.lindex(key, 0)
  if (last && parseEntry(last)?.status === status) return false
  await store.lpush(key, JSON.stringify({ s: status, at: at.toISOString() }))
  await store.ltrim(key, 0, HEALTH_RING_MAX - 1)
  await store.expire(key, HEALTH_RING_TTL_S)
  return true
}

/** Transitions oldest → newest. */
export async function readTransitions(
  store: HealthStore,
  host: string,
  container: string
): Promise<HealthTransition[]> {
  const raw = await store.lrange(healthKey(host, container), 0, HEALTH_RING_MAX - 1)
  return raw
    .map(parseEntry)
    .filter((t): t is HealthTransition => t != null)
    .reverse()
}

/** How many times the container turned unhealthy at or after `sinceMs`. */
export function unhealthyCount(transitions: HealthTransition[], sinceMs: number): number {
  return transitions.filter((t) => t.status === 'unhealthy' && (ms(t.at) ?? 0) >= sinceMs).length
}

/**
 * When the container first passed its healthcheck after its last start. The engine's log is
 * trusted only while it still holds every probe since the start (fewer than five entries);
 * otherwise the ring's first `healthy` transition after the start answers, if it saw one.
 */
export function firstHealthyAt(
  inspect: Pick<EngineContainerInspect, 'State'>,
  transitions: HealthTransition[]
): string | null {
  const started = ms(inspect.State?.StartedAt)
  if (started == null) return null
  const candidates: number[] = []
  const log = inspect.State?.Health?.Log ?? []
  if (log.length < ENGINE_HEALTH_LOG_SIZE) {
    const ok = log.find((l) => l.ExitCode === 0 && (ms(l.End) ?? 0) >= started)
    const t = ok ? ms(ok.End) : null
    if (t != null) candidates.push(t)
  }
  for (const tr of transitions) {
    const t = ms(tr.at)
    if (tr.status === 'healthy' && t != null && t >= started) {
      candidates.push(t)
      break
    }
  }
  return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null
}

export interface HealthRow {
  id: string
  name: string
  image: string | null
  version: string | null
  stack: string | null
  service: string | null
  project: string | null
  health: HealthStatus
  state: string | null
  status: string | null
  unhealthy_24h: number
  last_change_at: string | null
}

export interface HealthTrend {
  version: string
  image: string | null
  containers: number
  unhealthy_now: number
  unhealthy_3d: number
  /** Average starting → healthy time seen in the rings, ms. */
  avg_to_healthy_ms: number | null
}

export interface HostHealth {
  containers: HealthRow[]
  trend: HealthTrend[]
  counts: { with_healthcheck: number; healthy: number; unhealthy: number; starting: number }
}

export function deriveHealthList(
  containers: EngineContainerSummary[],
  rings: Map<string, HealthTransition[]>,
  now = Date.now()
): HostHealth {
  const rows: HealthRow[] = []
  const trend = new Map<string, HealthTrend & { samples: number[] }>()
  for (const c of containers) {
    const health = healthFromStatus(c.Status)
    if (!health) continue
    const id = shortId(c.Id) ?? c.Id
    const ring = rings.get(id) ?? []
    const o = ownerOf(c.Labels)
    const version = c.Labels?.['org.opencontainers.image.version'] ?? null
    const image = splitImage(c.Image).image
    rows.push({
      id,
      name: containerName(c),
      image,
      version,
      stack: o.stack,
      service: o.service ?? o.compose_service,
      project: o.compose_project,
      health,
      state: c.State ?? null,
      status: c.Status ?? null,
      unhealthy_24h: unhealthyCount(ring, now - DAY_MS),
      last_change_at: ring.at(-1)?.at ?? null
    })
    if (!version) continue
    const key = `${image ?? ''}|${version}`
    const t = trend.get(key) ?? {
      version,
      image,
      containers: 0,
      unhealthy_now: 0,
      unhealthy_3d: 0,
      avg_to_healthy_ms: null,
      samples: []
    }
    t.containers++
    if (health === 'unhealthy') t.unhealthy_now++
    t.unhealthy_3d += unhealthyCount(ring, now - 3 * DAY_MS)
    for (let i = 1; i < ring.length; i++) {
      if (ring[i].status !== 'healthy' || ring[i - 1].status !== 'starting') continue
      const d = (ms(ring[i].at) ?? 0) - (ms(ring[i - 1].at) ?? 0)
      if (d >= 0) t.samples.push(d)
    }
    trend.set(key, t)
  }
  const healthOrder = { unhealthy: 0, starting: 1, healthy: 2 }
  rows.sort(
    (a, b) =>
      healthOrder[a.health] - healthOrder[b.health] ||
      b.unhealthy_24h - a.unhealthy_24h ||
      a.name.localeCompare(b.name)
  )
  return {
    containers: rows,
    trend: [...trend.values()]
      .map(({ samples, ...t }) => ({
        ...t,
        avg_to_healthy_ms: samples.length
          ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
          : null
      }))
      .sort((a, b) => b.unhealthy_3d - a.unhealthy_3d || a.version.localeCompare(b.version)),
    counts: {
      with_healthcheck: rows.length,
      healthy: rows.filter((r) => r.health === 'healthy').length,
      unhealthy: rows.filter((r) => r.health === 'unhealthy').length,
      starting: rows.filter((r) => r.health === 'starting').length
    }
  }
}

export interface HealthDetail {
  id: string
  name: string
  image: string | null
  version: string | null
  state: string | null
  health: string | null
  failing_streak: number
  restart_count: number
  started_at: string | null
  first_healthy_at: string | null
  to_healthy_ms: number | null
  unhealthy_24h: number
  probes: Array<{
    start: string | null
    end: string | null
    duration_ms: number | null
    exit_code: number | null
    output: string
  }>
  transitions: HealthTransition[]
}

const trimOutput = (s: string | undefined): string => {
  const t = (s ?? '').trim()
  return t.length > OUTPUT_MAX ? `${t.slice(0, OUTPUT_MAX)}…` : t
}

export function deriveHealthDetail(
  inspect: EngineContainerInspect,
  transitions: HealthTransition[],
  now = Date.now()
): HealthDetail {
  const h = inspect.State?.Health
  const first = firstHealthyAt(inspect, transitions)
  const started = iso(inspect.State?.StartedAt)
  return {
    id: shortId(inspect.Id) ?? inspect.Id,
    name: containerName(inspect),
    image: splitImage(inspect.Config?.Image).image,
    version: inspect.Config?.Labels?.['org.opencontainers.image.version'] ?? null,
    state: inspect.State?.Status ?? null,
    health: h?.Status ?? null,
    failing_streak: h?.FailingStreak ?? 0,
    restart_count: inspect.RestartCount ?? 0,
    started_at: started,
    first_healthy_at: first,
    to_healthy_ms: first && started ? (ms(first) ?? 0) - (ms(started) ?? 0) : null,
    unhealthy_24h: unhealthyCount(transitions, now - DAY_MS),
    probes: [...(h?.Log ?? [])].reverse().map((l) => {
      const s = ms(l.Start)
      const e = ms(l.End)
      return {
        start: iso(l.Start),
        end: iso(l.End),
        duration_ms: s != null && e != null ? e - s : null,
        exit_code: l.ExitCode ?? null,
        output: trimOutput(l.Output)
      }
    }),
    transitions: transitions.slice(-30)
  }
}

const asHealth = (s: string | null | undefined): HealthStatus | null =>
  s === 'healthy' || s === 'unhealthy' || s === 'starting' ? s : null

async function listContainers(host: DockerHost): Promise<EngineContainerSummary[]> {
  return dockerGet<EngineContainerSummary[]>(host, '/containers/json', {
    query: { all: true },
    cacheMs: 10_000
  })
}

/** Records every container's current health on one host; returns the summaries read. */
export async function sampleHost(
  store: HealthStore,
  host: DockerHost,
  containers?: EngineContainerSummary[]
): Promise<EngineContainerSummary[]> {
  const list = containers ?? (await listContainers(host))
  const now = new Date()
  await Promise.all(
    list.map(async (c) => {
      const h = healthFromStatus(c.Status)
      if (h) await recordHealth(store, host.name, c.Id, h, now)
    })
  )
  return list
}

/** The `infra-health-sample` cron body: every host, failures per host reported, never thrown. */
export async function sampleAllHosts(
  store: HealthStore
): Promise<{ hosts: number; failed: number }> {
  const res = await forEachDockerHost((h) => sampleHost(store, h))
  return { hosts: res.length, failed: res.filter((r) => r.error).length }
}

export async function loadHealthList(store: HealthStore, host: DockerHost): Promise<HostHealth> {
  const containers = await sampleHost(store, host)
  const rings = new Map<string, HealthTransition[]>()
  await Promise.all(
    containers
      .filter((c) => healthFromStatus(c.Status))
      .map(async (c) => {
        rings.set(shortId(c.Id) ?? c.Id, await readTransitions(store, host.name, c.Id))
      })
  )
  return deriveHealthList(containers, rings)
}

export async function loadHealthDetail(
  store: HealthStore,
  host: DockerHost,
  container: string
): Promise<HealthDetail> {
  const inspect = await dockerGet<EngineContainerInspect>(host, `/containers/${container}/json`, {
    cacheMs: 5_000
  })
  const h = asHealth(inspect.State?.Health?.Status)
  if (h) await recordHealth(store, host.name, inspect.Id, h)
  return deriveHealthDetail(inspect, await readTransitions(store, host.name, inspect.Id))
}
