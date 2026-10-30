import type { FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { excludeStartRows } from '../instance-start.js'
import { memo } from '../overview/data.js'
import { can } from '../permissions.js'
import { sharedGatedRead, withReadGate } from '../read-gate.js'
import { type AccessGates, compileAccessGates, visibleIds } from '../record-access.js'
import { recordIdsInRegion } from './regions.js'
import type { CcScope } from './scope.js'

/**
 * Command Center throughput (CC-8): pipeline transitions per hour of the person's day, today vs
 * yesterday vs the 7-day average, plus deploy / configuration markers for administrators.
 *
 * TIME ZONES — be explicit. Every app timestamp (nivaro_workflow_history.timestamp) is UTC. The
 * person's "today" is their own day: the profile time zone, else the instance's business zone,
 * else America/New_York (services/user-time.ts userTimeZone). SQL groups transitions into UTC
 * hours; this file folds each UTC hour into the local hour it starts in. Zones a whole number of
 * hours from UTC (every US zone) fold exactly; a half-hour zone lands each UTC hour in the local
 * hour it starts in. On a daylight-saving day the repeated local hour adds into one bucket and
 * the skipped one stays empty.
 *
 * A pipeline START is history, not a transition (#1219: excludeStartRows). Counts are gated per
 * collection on read permission; the region lens narrows to records placed in the region where
 * the collection can be placed (recordIdsInRegion), otherwise it answers for everywhere.
 */

export interface ZonedParts {
  y: number
  m: number
  d: number
  h: number
  min: number
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric'
    })
    fmtCache.set(tz, f)
  }
  return f
}

/** The wall-clock parts of instant `ms` in zone `tz`. Pure. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const out: Record<string, number> = {}
  for (const p of fmt(tz).formatToParts(new Date(ms)))
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  return {
    y: out.year,
    m: out.month,
    d: out.day,
    h: out.hour === 24 ? 0 : out.hour,
    min: out.minute
  }
}

/** Zone offset (ms, local - UTC) at instant `ms`. */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
  return asUtc - Math.floor(ms / 60_000) * 60_000
}

/** The UTC instant (ms) of local midnight starting the local day that contains `ms`. Pure. */
export function startOfLocalDay(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  const wall = Date.UTC(p.y, p.m - 1, p.d)
  // Guess with the offset now, then correct with the offset at the guess (DST between).
  const guess = wall - offsetAt(ms, tz)
  return wall - offsetAt(guess, tz)
}

/** Midnight starting the local day before the one starting at `dayStart`. */
export function previousLocalDay(dayStart: number, tz: string): number {
  return startOfLocalDay(dayStart - 3600_000, tz)
}

export interface HourBucket {
  /** UTC hour start (ms). */
  at: number
  n: number
}

export interface ThroughputHours {
  hours: Array<{ hour: number; today: number | null; yesterday: number; avg7: number }>
  today_total: number
  yesterday_same_time: number
}

/**
 * Fold UTC hour buckets into the person's day. `cut` = now (or the rewind instant): today's
 * hours after the cut hour are null (not yet), yesterday's same-time total stops at the same
 * wall-clock point. avg7 = the 7 full local days before today, per local hour, divided by 7. Pure.
 */
export function foldHours(
  buckets: HourBucket[],
  cut: number,
  tz: string,
  /** Exact count for yesterday's partial hour [floorHour(same time), same time); null = count
   *  that whole hour (an estimate, for callers without the exact figure). */
  ySamePartial: number | null = null
): ThroughputHours {
  const today0 = startOfLocalDay(cut, tz)
  const yesterday0 = previousLocalDay(today0, tz)
  let week0 = today0
  for (let i = 0; i < 7; i++) week0 = previousLocalDay(week0, tz)
  const cutHour = zonedParts(cut, tz).h
  const today = new Array<number>(24).fill(0)
  const yesterday = new Array<number>(24).fill(0)
  const week = new Array<number>(24).fill(0)
  // "Same time yesterday" = the same elapsed time into yesterday as the cut is into today.
  const ySameCut = yesterday0 + (cut - today0)
  const ySameHour = Math.floor(ySameCut / 3600_000) * 3600_000
  let ySame = ySamePartial ?? 0
  for (const b of buckets) {
    if (!Number.isFinite(b.at) || b.at >= cut) continue
    const h = zonedParts(b.at, tz).h
    if (b.at >= today0) today[h] += b.n
    else if (b.at >= yesterday0) {
      yesterday[h] += b.n
      if (ySamePartial == null ? b.at < ySameCut : b.at < ySameHour) ySame += b.n
    }
    if (b.at >= week0 && b.at < today0) week[h] += b.n
  }
  return {
    hours: today.map((n, hour) => ({
      hour,
      today: hour > cutHour ? null : n,
      yesterday: yesterday[hour],
      avg7: Math.round((week[hour] / 7) * 10) / 10
    })),
    today_total: today.reduce((s, n) => s + n, 0),
    yesterday_same_time: ySame
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

const HOUR_SQL = 'DATEADD(hour, DATEDIFF(hour, 0, h.timestamp), 0)'

interface RawRow {
  bucket: Date | string
  collection: string
  n: number | string
}

function historyHours(from: Date, to: Date, items?: { collection: string; ids: string[] }) {
  const q = db('nivaro_workflow_history as h')
    .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
    .where('h.timestamp', '>=', from)
    .where('h.timestamp', '<', to)
  excludeStartRows(q, 'h')
  if (items) q.where('i.collection', items.collection).whereIn('i.item', items.ids)
  return (
    q
      .select(db.raw(`${HOUR_SQL} as bucket`), 'i.collection')
      .count('* as n')
      // One raw GROUP BY: knex drops the plain column after a raw first argument.
      .groupByRaw(`${HOUR_SQL}, i.collection`) as unknown as Promise<RawRow[]>
  )
}

const toMs = (v: Date | string) => (v instanceof Date ? v.getTime() : Date.parse(String(v)))

/**
 * Per collection, UTC hour buckets of transitions in [from, to). One shared, gated read per
 * tenant + window (the counts are the same for everyone; each caller then keeps only the
 * collections it may read).
 */
async function allHours(from: Date, to: Date, who: string): Promise<RawRow[]> {
  const key = `cc:throughput:${from.toISOString()}:${Math.floor(to.getTime() / 60_000)}`
  return memo(key, 60_000, async () => {
    const { value } = await sharedGatedRead(key, who, () => historyHours(from, to), {
      label: 'cc:throughput'
    })
    return value
  })
}

export interface ThroughputAnswer extends ThroughputHours {
  time_zone: string
  region_applies: boolean
  live_only?: boolean
}

const NARROW_CANDIDATE_CAP = 20_000

/** Distinct records of one collection with transitions in the window (candidates for a gate check). */
async function transitionedItems(collection: string, from: Date, to: Date): Promise<string[]> {
  const q = db('nivaro_workflow_history as h')
    .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
    .where('h.timestamp', '>=', from)
    .where('h.timestamp', '<', to)
    .where('i.collection', collection)
  excludeStartRows(q, 'h')
  const rows = (await q.distinct('i.item').limit(NARROW_CANDIDATE_CAP)) as Array<{ item: unknown }>
  return rows.map((r) => String(r.item))
}

/**
 * Hour buckets for the collections that need narrowing — a region focus and/or the caller's own
 * row filter / User Scopes — counted only over records the caller can open (the same gates
 * /flow applies through the work index's Viewer). Collections that need neither come from the
 * shared rows.
 */
async function narrowedBuckets(
  user: User,
  readable: Map<string, boolean>,
  gates: Map<string, AccessGates | null>,
  scope: CcScope,
  fromD: Date,
  toD: Date,
  rows: RawRow[]
): Promise<{ buckets: HourBucket[]; regionApplies: boolean }> {
  let regionApplies = !!scope.region
  const buckets: HourBucket[] = []
  const shared = (collection: string) => {
    for (const r of rows)
      if (r.collection === collection) buckets.push({ at: toMs(r.bucket), n: Number(r.n) })
  }
  for (const [collection, ok] of readable) {
    if (!ok) continue
    const g = gates.get(collection)
    // Gates that could not be compiled fail closed: nothing of this collection is counted.
    if (g === null) continue
    const restricted = !!g && (!!g.strict || !!g.rowFilter || g.scopes.length > 0)
    let allowed: Set<string> | null = null
    if (scope.region) {
      const ids = await recordIdsInRegion(collection, scope.region).catch(() => null)
      if (ids == null) regionApplies = false
      else allowed = ids
    }
    if (restricted && g) {
      const candidates = allowed ? [...allowed] : await transitionedItems(collection, fromD, toD)
      allowed = await visibleIds(g, candidates).catch(() => new Set<string>())
    }
    if (allowed == null) {
      // Unplaceable and unrestricted: counted everywhere (and the region lens says so).
      shared(collection)
      continue
    }
    const list = [...allowed]
    for (let i = 0; i < list.length; i += 1000) {
      const part = await historyHours(fromD, toD, { collection, ids: list.slice(i, i + 1000) })
      for (const r of part) buckets.push({ at: toMs(r.bucket), n: Number(r.n) })
    }
  }
  return { buckets, regionApplies }
}

/**
 * Transitions per hour for `user`, honoring the region and rewind lenses and the records the
 * caller can open. `cred` names the credential (session / API key / wallboard link) so a narrowed
 * answer is never shared across credentials.
 */
export async function readThroughput(
  user: User,
  scope: CcScope,
  tz: string,
  now = Date.now(),
  cred = 's'
): Promise<ThroughputAnswer> {
  const cut = scope.at ? scope.at.getTime() : now
  const today0 = startOfLocalDay(cut, tz)
  let from = today0
  for (let i = 0; i < 7; i++) from = previousLocalDay(from, tz)
  const fromD = new Date(from)
  const toD = new Date(cut)
  const rows = await allHours(fromD, toD, String(user.id))
  const readable = new Map<string, boolean>()
  const gates = new Map<string, AccessGates | null>()
  for (const r of rows)
    if (!readable.has(r.collection)) {
      const ok = await can(user, 'read', r.collection).catch(() => false)
      readable.set(r.collection, ok)
      if (ok)
        gates.set(r.collection, await compileAccessGates(user, r.collection).catch(() => null))
    }
  const narrowing =
    !!scope.region ||
    [...gates.values()].some((g) => g === null || g.strict || g.rowFilter || g.scopes.length > 0)
  let regionApplies = !!scope.region
  let buckets: HourBucket[] = []
  if (!narrowing) {
    buckets = rows
      .filter((r) => readable.get(r.collection))
      .map((r) => ({ at: toMs(r.bucket), n: Number(r.n) }))
  } else {
    // Per record work: one gated, briefly cached read per (person, credential, region, window).
    const key = `cc:tp-narrow:${String(user.id).toUpperCase()}:${cred}:${scope.region ?? '-'}:${from}:${Math.floor(cut / 300_000)}`
    const out = await memo(key, 60_000, () =>
      withReadGate(
        String(user.id),
        () => narrowedBuckets(user, readable, gates, scope, fromD, toD, rows),
        { label: 'cc:throughput-narrow' }
      )
    )
    buckets = out.buckets
    regionApplies = out.regionApplies
  }
  // Yesterday's same-time total stops mid-hour: count that partial hour exactly (only when the
  // buckets are the shared, unnarrowed ones; a narrowed answer estimates with the whole hour).
  const ySameCut = previousLocalDay(today0, tz) + (cut - today0)
  const partialFrom = new Date(Math.floor(ySameCut / 3600_000) * 3600_000)
  let partial = 0
  if (!narrowing) {
    try {
      const q = db('nivaro_workflow_history as h')
        .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
        .where('h.timestamp', '>=', partialFrom)
        .where('h.timestamp', '<', new Date(ySameCut))
      excludeStartRows(q, 'h')
      const per = (await q
        .groupBy('i.collection')
        .select('i.collection')
        .count('* as n')) as Array<{
        collection: string
        n: number | string
      }>
      for (const r of per) if (readable.get(r.collection)) partial += Number(r.n)
    } catch {
      partial = 0
    }
  }
  return {
    ...foldHours(buckets, cut, tz, narrowing ? null : partial),
    time_zone: tz,
    region_applies: regionApplies
  }
}

/** Snapshot headline: transitions today vs same time yesterday (the person's day). */
export async function readThroughputHeadline(
  user: User,
  scope: CcScope,
  tz: string,
  cred = 's'
): Promise<{ transitions_today: number; transitions_yesterday_same_time: number }> {
  const t = await readThroughput(user, scope, tz, Date.now(), cred)
  return {
    transitions_today: t.today_total,
    transitions_yesterday_same_time: t.yesterday_same_time
  }
}

// ─── Markers (administrators) ────────────────────────────────────────────────

export interface ThroughputMarker {
  at: string
  kind: 'deploy' | 'config' | 'incident'
  label: string
  href?: string | null
}

/**
 * Deploys (a boot whose version differs from the one before — Traffic Map change markers) and
 * configuration changes (config-table writes in the activity log, the Overview's config-changes
 * source) between `from` and `to`. Administrators only: both name internal versions and config.
 */
export async function readMarkers(from: number, to: number): Promise<ThroughputMarker[]> {
  const out: ThroughputMarker[] = []
  try {
    const { changeMarkers } = await import('../traffic-taps/change-markers.js')
    for (const m of await changeMarkers(from, Math.min(to, from + 25 * 3600_000 - 1)))
      if (m.kind === 'deploy')
        out.push({
          at: new Date(m.at).toISOString(),
          kind: 'deploy',
          label: m.label,
          href: '/environments'
        })
  } catch {
    /* no markers — the chart still draws */
  }
  try {
    const { CONFIG_TABLES } = await import('../config-inventory.js')
    const tables = CONFIG_TABLES.filter((t: string) => t !== 'nivaro_users')
    const rows = (await db('nivaro_activity')
      .whereIn('collection', tables)
      .where('timestamp', '>=', new Date(from))
      .where('timestamp', '<', new Date(to))
      .where((b) => {
        b.whereIn('action', ['create', 'update', 'delete', 'restore', 'publish', 'revert'])
        for (const verb of ['create', 'update', 'delete', 'publish', 'restore'])
          b.orWhere('action', 'like', `%-${verb}`)
      })
      .orderBy([
        { column: 'timestamp', order: 'asc' },
        { column: 'id', order: 'asc' }
      ])
      .limit(200)
      .select('id', 'collection', 'action', 'timestamp')) as Array<{
      id: number
      collection: string
      action: string
      timestamp: Date | string
    }>
    for (const m of foldConfigMarkers(rows))
      out.push({ at: m.at, kind: 'config', label: m.label, href: '/environments/config' })
  } catch {
    /* activity table busy — markers are a nicety */
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

const CONFIG_FOLD_MS = 10 * 60_000

/** Config writes within 10 minutes of each other read as one marker ("12 configuration changes"). Pure. */
export function foldConfigMarkers(
  rows: Array<{ collection: string; timestamp: Date | string }>
): Array<{ at: string; label: string }> {
  const out: Array<{ at: number; n: number; tables: Set<string> }> = []
  for (const r of rows) {
    const t = toMs(r.timestamp)
    if (!Number.isFinite(t)) continue
    const last = out[out.length - 1]
    if (last && t - last.at < CONFIG_FOLD_MS) {
      last.n++
      last.tables.add(r.collection)
      continue
    }
    out.push({ at: t, n: 1, tables: new Set([r.collection]) })
  }
  return out.map((g) => {
    const what = [...g.tables]
      .slice(0, 3)
      .map((t) => t.replace(/^nivaro_/, '').replace(/_/g, ' '))
      .join(', ')
    return {
      at: new Date(g.at).toISOString(),
      label: `${g.n === 1 ? 'Configuration change' : `${g.n} configuration changes`} (${what}${g.tables.size > 3 ? '…' : ''})`
    }
  })
}

/** The /snapshot headline block (one call from routes/command-center.ts). */
export async function snapshotThroughput(
  req: FastifyRequest
): Promise<{ transitions_today: number; transitions_yesterday_same_time: number }> {
  const { userTimeZone } = await import('../user-time.js')
  const { readCcScope } = await import('./scope.js')
  const tz = await userTimeZone(req.user ?? null)
  const { ccCredKey } = await import('./auth.js')
  return readThroughputHeadline(req.user as User, readCcScope(req.query), tz, ccCredKey(req))
}
