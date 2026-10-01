// api/src/services/traffic-taps/change-markers.ts
/**
 * Traffic Map: what changed, for the sparklines (#1093) — so a jump in latency or errors reads
 * against an API restart / deploy, a configuration write or a maintenance window.
 *
 * - boots: this instance's boot history (services/boot-phases.ts, kept in Redis) + this process;
 *   a boot whose version differs from the one before it is a deploy.
 * - config: configuration-epoch moves this process saw (db/config-epoch.ts has no history, so a
 *   5-second watcher records each move it notices — local writes and other processes' alike).
 * - snapshot: nightly / manual configuration snapshots (nivaro_config_snapshots).
 * - maintenance: maintenance windows overlapping the range (nivaro_maintenance_windows).
 */

import { configEpochState } from '../../db/config-epoch.js'
import { db } from '../../db/index.js'
import { NIVARO_VERSION } from '../../version.js'
import { bootReport, earlierBoots } from '../boot-phases.js'
import { getApp } from '../io-holder.js'
import { instanceKey } from '../settings-overrides.js'

export type MarkerKind = 'boot' | 'deploy' | 'config' | 'snapshot' | 'maintenance'
export interface ChangeMarker {
  kind: MarkerKind
  /** Epoch ms. */
  at: number
  /** Epoch ms (maintenance windows only). */
  until?: number
  label: string
}

const EPOCH_CAP = 300
const epochMoves: ChangeMarker[] = []
let epochTimer: NodeJS.Timeout | null = null
let lastEpoch: { seen: number | null; moved: string | null; writes: number } | null = null

/** Record config-epoch moves from now on (idempotent; never in cloud mode). */
export function startEpochMarkers(intervalMs = 5000): void {
  if (epochTimer || process.env.CLOUD_META_DB_URL) return
  const tick = () => {
    try {
      const s = configEpochState()
      const cur = { seen: s.seen, moved: s.last_moved_at, writes: s.writes_seen }
      if (lastEpoch && (cur.seen !== lastEpoch.seen || cur.moved !== lastEpoch.moved)) {
        const at = cur.moved && cur.moved !== lastEpoch.moved ? Date.parse(cur.moved) : Date.now()
        // #1176: a write this process made names its table; a move with no local write was
        // another process (a replica, a script).
        const local = cur.writes > lastEpoch.writes
        const table = local ? configWriteTable(s.last_statement) : null
        noteEpochMove(
          Number.isFinite(at) ? at : Date.now(),
          cur.seen,
          table ?? (local ? null : 'another process')
        )
      }
      lastEpoch = cur
    } catch {
      /* never */
    }
  }
  tick()
  epochTimer = setInterval(tick, intervalMs)
  epochTimer.unref?.()
}
export function stopEpochMarkers(): void {
  if (epochTimer) clearInterval(epochTimer)
  epochTimer = null
  lastEpoch = null
  epochMoves.length = 0
}

/** The table a configuration write statement touched (`update [nivaro_fields] …`). Pure. */
export function configWriteTable(sql: string | null | undefined): string | null {
  if (!sql) return null
  const m = String(sql).match(
    /\b(?:update|into|from|table)\s+(?:\[?[A-Za-z0-9_]+\]?\.)?\[?([A-Za-z0-9_]+)\]?/i
  )
  return m ? m[1] : null
}

function epochLabel(epoch: number | null, detail?: string | null): string {
  const parts = [detail, epoch != null ? `epoch ${epoch}` : null].filter(Boolean)
  return `Configuration changed${parts.length ? ` (${parts.join(', ')})` : ''}`
}

/** Exported for tests. `detail` = the table the write touched, or who made it. */
export function noteEpochMove(at: number, epoch: number | null, detail?: string | null): void {
  const prev = epochMoves[epochMoves.length - 1]
  // A burst of writes moves the number several times in seconds — one marker per 30 s.
  if (prev && at - prev.at < 30_000) {
    prev.label = epochLabel(epoch, detail)
    return
  }
  epochMoves.push({
    kind: 'config',
    at,
    label: epochLabel(epoch, detail)
  })
  if (epochMoves.length > EPOCH_CAP) epochMoves.shift()
}

/** Config-epoch moves this process saw in a range. */
export function epochMarkersIn(from: number, to: number): ChangeMarker[] {
  return epochMoves.filter((m) => m.at >= from && m.at <= to).map((m) => ({ ...m }))
}

/** Restarts closer together than this fold into one marker. */
const FOLD_MS = 120_000

interface BootLike {
  started_at: string
  ready_at: string | null
  version?: string
}

/** Boots in range; a boot whose version differs from the previous one reads as a deploy. */
export function bootMarkers(boots: BootLike[], from: number, to: number): ChangeMarker[] {
  const sorted = boots
    .map((b) => ({ ...b, t: Date.parse(b.ready_at ?? b.started_at) }))
    .filter((b) => Number.isFinite(b.t))
    .sort((a, b) => a.t - b.t)
  const out: Array<ChangeMarker & { n?: number }> = []
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]
    if (b.t < from || b.t > to) continue
    const prev = sorted[i - 1]
    const deploy = !!(b.version && prev?.version && b.version !== prev.version)
    const last = out[out.length - 1]
    // Several processes (replicas, restarts in a row) within FOLD_MS read as one marker.
    if (!deploy && last && last.kind === 'boot' && b.t - last.at < FOLD_MS) {
      last.n = (last.n ?? 1) + 1
      last.label = `API restarted ×${last.n}`
      continue
    }
    if (last && last.at === b.t && last.kind === (deploy ? 'deploy' : 'boot')) continue
    out.push({
      kind: deploy ? 'deploy' : 'boot',
      at: b.t,
      label: deploy
        ? `Deployed ${b.version} (was ${prev?.version})`
        : `API restarted${b.version ? ` (${b.version})` : ''}`
    })
  }
  return out.map(({ n: _n, ...m }) => m)
}

const VERSIONS_KEY = (instance: string) => `nvr:tm:boot-versions:${instance}`

interface HashRedis {
  hset(key: string, field: string, value: string): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  expire(key: string, s: number): Promise<unknown>
}

/** Remember which version this boot ran (boot history carries no version), once per process. */
let versionRecorded = false
export async function recordBootVersion(): Promise<void> {
  if (versionRecorded) return
  const redis = (getApp() as { redis?: HashRedis } | null)?.redis
  if (!redis) return
  versionRecorded = true
  try {
    const key = VERSIONS_KEY(instanceKey())
    await redis.hset(key, bootReport().started_at, NIVARO_VERSION)
    await redis.expire(key, 90 * 86_400)
    const all = await redis.hgetall(key)
    const fields = Object.keys(all).sort()
    if (fields.length > 60) await redis.hdel(key, ...fields.slice(0, fields.length - 60))
  } catch {
    versionRecorded = false
  }
}

async function bootVersions(): Promise<Record<string, string>> {
  const redis = (getApp() as { redis?: HashRedis } | null)?.redis
  if (!redis) return {}
  try {
    return (await redis.hgetall(VERSIONS_KEY(instanceKey()))) ?? {}
  } catch {
    return {}
  }
}

async function rows<T>(fn: () => PromiseLike<unknown>): Promise<T[]> {
  try {
    return ((await fn()) as T[]) ?? []
  } catch {
    return []
  }
}

/** Every marker between `from` and `to` (epoch ms), oldest first. */
export async function changeMarkers(from: number, to: number): Promise<ChangeMarker[]> {
  const redis = (getApp() as { redis?: unknown } | null)?.redis
  const current = { ...bootReport(), version: NIVARO_VERSION }
  const earlier = redis
    ? ((await earlierBoots(redis as Parameters<typeof earlierBoots>[0], instanceKey()).catch(
        () => []
      )) as BootLike[])
    : []
  const versions = await bootVersions()
  for (const b of earlier)
    if (!b.version && versions[b.started_at]) b.version = versions[b.started_at]
  const fromD = new Date(from)
  const toD = new Date(to)
  const [snaps, windows] = await Promise.all([
    rows<{ taken_at: Date | string; trigger: string | null }>(() =>
      db('nivaro_config_snapshots')
        .where('taken_at', '>=', fromD)
        .where('taken_at', '<=', toD)
        .orderBy('taken_at', 'asc')
        .limit(50)
        .select('taken_at', 'trigger')
    ),
    rows<{ title: string; starts_at: Date | string; ends_at: Date | string; status: string }>(() =>
      db('nivaro_maintenance_windows')
        .where('starts_at', '<=', toD)
        .where('ends_at', '>=', fromD)
        .whereNot('status', 'cancelled')
        .orderBy('starts_at', 'asc')
        .limit(20)
        .select('title', 'starts_at', 'ends_at', 'status')
    )
  ])
  const out: ChangeMarker[] = [
    ...bootMarkers([...earlier, current], from, to),
    ...epochMarkersIn(from, to),
    ...snaps.map((s) => ({
      kind: 'snapshot' as const,
      at: new Date(s.taken_at).getTime(),
      label: `Configuration snapshot${s.trigger ? ` (${s.trigger})` : ''}`
    })),
    ...windows.map((w) => ({
      kind: 'maintenance' as const,
      at: Math.max(from, new Date(w.starts_at).getTime()),
      until: Math.min(to, new Date(w.ends_at).getTime()),
      label: `Maintenance: ${String(w.title).slice(0, 120)}`
    }))
  ]
  const seen = new Set<string>()
  return out
    .filter((m) => Number.isFinite(m.at))
    .sort((a, b) => a.at - b.at)
    .filter((m) => {
      const k = `${m.kind}:${m.at}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
}
