import { db } from '../../../db/index.js'
import { activeWindow, type HubFreeze, listFreezes, nextWindow } from '../releases/freeze.js'
import { type DeployWindow, listWindows, windowSpans, windowWords } from '../releases/windows.js'

/**
 * The change calendar (Hub enhancement 26): one list of what changed, changes and may not change,
 * for the apps a person may see — read from the rows the Hub already keeps:
 *
 *   promote / rollback  nivaro_hub_deploys (Hub promotion runs, Apply now included)
 *   scheduled           nivaro_hub_schedules not started yet (a promotion or a train)
 *   train               nivaro_hub_trains
 *   move                nivaro_hub_moves
 *   upgrade             nivaro_hub_shared_deploys (shown with the apps placed on that deployment)
 *   freeze              nivaro_hub_freezes, every occurrence in the range
 *   window              nivaro_hub_deploy_windows, every open span in the range (allowed times)
 *   maintenance / note / tls / …  nivaro_hub_calendar_entries (planned maintenance a person
 *                       entered, and entries other Hub features write with upsertCalendarEntry —
 *                       e.g. a certificate expiry)
 *
 * Read-only; a source whose table is missing (an older install) is skipped, never an error.
 * Admins see every app (appIds null); an owner sees their apps and the Hub-wide rows.
 */

export type CalendarKind =
  | 'promote'
  | 'rollback'
  | 'scheduled'
  | 'train'
  | 'move'
  | 'upgrade'
  | 'freeze'
  | 'window'
  | 'maintenance'
  | 'note'
  | 'tls'
  | 'other'

export type EventStatus = 'planned' | 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'on'

export interface CalendarEvent {
  /** Stable per source row (and occurrence): `deploy:12`, `freeze:3:1767225600000`. */
  id: string
  kind: CalendarKind
  title: string
  app_id: number | null
  app_key: string | null
  environment_id: number | null
  env_key: string | null
  start: string
  end: string | null
  status: EventStatus
  detail: string | null
}

export const ENTRIES = 'nivaro_hub_calendar_entries'
/** The longest range one read covers (a month view with its spill days, a quarter list). */
export const MAX_RANGE_MS = 100 * 86_400_000

const ms = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}
const isoOf = (t: number | null) => (t == null ? null : new Date(t).toISOString())

function runStatus(s: unknown): EventStatus {
  switch (String(s ?? '')) {
    case 'running':
    case 'starting':
    case 'promoting':
    case 'soaking':
    case 'active':
      return 'running'
    case 'failed':
    case 'interrupted':
    case 'missed':
    case 'aborted':
    case 'held':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'planned':
    case 'scheduled':
      return 'planned'
    case 'waiting':
      return 'waiting'
    default:
      return 'done'
  }
}

interface Scope {
  apps: Map<number, string>
  envs: Map<number, { key: string; app_id: number }>
  /** null = every app (an admin). */
  appIds: number[] | null
}

async function scopeOf(appIds: number[] | null): Promise<Scope> {
  const aq = db('nivaro_hub_apps').select('id', 'key')
  if (appIds) aq.whereIn('id', appIds.length ? appIds : [-1])
  const apps = new Map<number, string>()
  for (const r of (await aq) as Array<{ id: number; key: string }>)
    apps.set(Number(r.id), String(r.key))
  const eq = db('nivaro_hub_environments').select('id', 'key', 'app_id')
  if (appIds) eq.whereIn('app_id', [...apps.keys()].length ? [...apps.keys()] : [-1])
  const envs = new Map<number, { key: string; app_id: number }>()
  for (const r of (await eq) as Array<{ id: number; key: string; app_id: number }>)
    envs.set(Number(r.id), { key: String(r.key), app_id: Number(r.app_id) })
  return { apps, envs, appIds }
}

/** Rows that overlap [from, to): started before `to`, not finished before `from`. */
function overlapping(q: ReturnType<typeof db>, from: number, to: number) {
  return q
    .where('started_at', '<', new Date(to))
    .where((w) => w.whereNull('finished_at').orWhere('finished_at', '>=', new Date(from)))
}

async function safe<T>(f: () => Promise<T[]>): Promise<T[]> {
  try {
    return await f()
  } catch {
    return []
  }
}

const LIMIT = 2000

/** Every occurrence of a freeze overlapping [from, to). */
export function freezeOccurrences(f: HubFreeze, from: number, to: number) {
  const out: Array<{ start: number; end: number }> = []
  let w = activeWindow(f, from) ?? nextWindow(f, from)
  for (let i = 0; w && w.start < to && i < 24; i++) {
    out.push(w)
    w = nextWindow(f, w.start)
  }
  return out
}

export async function calendarEvents(o: {
  from: number
  to: number
  appIds: number[] | null
  now?: number
}): Promise<CalendarEvent[]> {
  const { from, to } = o
  const scope = await scopeOf(o.appIds)
  const appIds = [...scope.apps.keys()]
  const inScope = <Q extends ReturnType<typeof db>>(q: Q, col = 'app_id'): Q =>
    (scope.appIds ? q.whereIn(col, appIds.length ? appIds : [-1]) : q) as Q
  const envOf = (id: unknown) => (id == null ? undefined : scope.envs.get(Number(id)))
  const where = (appId: unknown, envId: unknown) => {
    const env = envOf(envId)
    const a = appId == null ? (env?.app_id ?? null) : Number(appId)
    return {
      app_id: a,
      app_key: a == null ? null : (scope.apps.get(a) ?? null),
      environment_id: envId == null ? null : Number(envId),
      env_key: env?.key ?? null
    }
  }
  const label = (appId: unknown, envId: unknown) => {
    const w = where(appId, envId)
    return [w.app_key, w.env_key].filter(Boolean).join(' · ') || 'an app'
  }
  const events: CalendarEvent[] = []

  for (const r of await safe(
    async () =>
      (await inScope(overlapping(db('nivaro_hub_deploys'), from, to))
        .orderBy('id', 'asc')
        .limit(LIMIT)
        .select(
          'id',
          'app_id',
          'environment_id',
          'kind',
          'version',
          'from_version',
          'status',
          'started_at',
          'finished_at'
        )) as Array<Record<string, unknown>>
  )) {
    const rollback = r.kind === 'rollback'
    events.push({
      id: `deploy:${r.id}`,
      kind: rollback ? 'rollback' : 'promote',
      title: `${rollback ? 'Roll back' : 'Promote'} ${label(r.app_id, r.environment_id)} to ${r.version}`,
      ...where(r.app_id, r.environment_id),
      start: isoOf(ms(r.started_at)) as string,
      end: isoOf(ms(r.finished_at)),
      status: runStatus(r.status),
      detail: r.from_version ? `From ${r.from_version}` : null
    })
  }

  for (const r of await safe(
    async () =>
      (await inScope(db('nivaro_hub_schedules'))
        .whereIn('status', ['scheduled', 'waiting', 'starting', 'failed', 'missed'])
        .where('run_at', '>=', new Date(from))
        .where('run_at', '<', new Date(to))
        .limit(LIMIT)
        .select(
          'id',
          'app_id',
          'environment_id',
          'kind',
          'version',
          'run_at',
          'status',
          'note'
        )) as Array<Record<string, unknown>>
  )) {
    const train = r.kind === 'train'
    events.push({
      id: `schedule:${r.id}`,
      kind: 'scheduled',
      title: train
        ? `Scheduled release train of ${r.version} (${label(r.app_id, null)})`
        : `Scheduled: promote ${label(r.app_id, r.environment_id)} to ${r.version}`,
      ...where(r.app_id, r.environment_id),
      start: isoOf(ms(r.run_at)) as string,
      end: null,
      status: runStatus(r.status),
      detail: r.note ? String(r.note) : null
    })
  }

  for (const r of await safe(
    async () =>
      (await inScope(overlapping(db('nivaro_hub_trains'), from, to))
        .limit(LIMIT)
        .select('id', 'app_id', 'version', 'status', 'started_at', 'finished_at')) as Array<
        Record<string, unknown>
      >
  )) {
    events.push({
      id: `train:${r.id}`,
      kind: 'train',
      title: `Release train of ${r.version} (${label(r.app_id, null)})`,
      ...where(r.app_id, null),
      start: isoOf(ms(r.started_at)) as string,
      end: isoOf(ms(r.finished_at)),
      status: runStatus(r.status),
      detail: null
    })
  }

  for (const r of await safe(
    async () =>
      (await inScope(overlapping(db('nivaro_hub_moves'), from, to))
        .limit(LIMIT)
        .select(
          'id',
          'app_id',
          'environment_id',
          'kind',
          'status',
          'started_at',
          'finished_at'
        )) as Array<Record<string, unknown>>
  )) {
    events.push({
      id: `move:${r.id}`,
      kind: 'move',
      title: `Move ${label(r.app_id, r.environment_id)}${r.kind ? ` (${String(r.kind).replace(/_/g, ' ')})` : ''}`,
      ...where(r.app_id, r.environment_id),
      start: isoOf(ms(r.started_at)) as string,
      end: isoOf(ms(r.finished_at)),
      status: runStatus(r.status),
      detail: null
    })
  }

  // Shared deployment upgrades: an owner sees the ones of deployments their apps are placed on.
  const sharedVisible = new Map<number, string[]>()
  for (const r of await safe(
    async () =>
      (await db('nivaro_hub_environments as e')
        .join('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
        .whereNotNull('p.shared_deployment_id')
        .select('p.shared_deployment_id as sid', 'e.app_id')) as Array<{
        sid: number
        app_id: number
      }>
  )) {
    if (scope.appIds && !scope.apps.has(Number(r.app_id))) continue
    const keys = sharedVisible.get(Number(r.sid)) ?? []
    const k = scope.apps.get(Number(r.app_id))
    if (k && !keys.includes(k)) keys.push(k)
    sharedVisible.set(Number(r.sid), keys)
  }
  const sharedNames = new Map<number, string>()
  for (const r of await safe(
    async () =>
      (await db('nivaro_hub_shared_deployments').select('id', 'key')) as Array<{
        id: number
        key: string
      }>
  ))
    sharedNames.set(Number(r.id), String(r.key))
  for (const r of await safe(
    async () =>
      (await overlapping(db('nivaro_hub_shared_deploys'), from, to)
        .limit(LIMIT)
        .select(
          'id',
          'shared_deployment_id',
          'kind',
          'version',
          'status',
          'started_at',
          'finished_at'
        )) as Array<Record<string, unknown>>
  )) {
    const sid = Number(r.shared_deployment_id)
    if (scope.appIds && !sharedVisible.has(sid)) continue
    const apps = sharedVisible.get(sid) ?? []
    events.push({
      id: `upgrade:${r.id}`,
      kind: 'upgrade',
      title: `${r.kind === 'rollback' ? 'Roll back' : 'Upgrade'} shared deployment ${sharedNames.get(sid) ?? `#${sid}`} to ${r.version}`,
      app_id: null,
      app_key: null,
      environment_id: null,
      env_key: null,
      start: isoOf(ms(r.started_at)) as string,
      end: isoOf(ms(r.finished_at)),
      status: runStatus(r.status),
      detail: apps.length ? `Apps on it: ${apps.join(', ')}` : null
    })
  }

  const now = o.now ?? Date.now()
  const freezes = await safe(listFreezes)
  for (const f of freezes) {
    if (f.app_id != null && scope.appIds && !scope.apps.has(f.app_id)) continue
    for (const w of freezeOccurrences(f, from, to))
      events.push({
        id: `freeze:${f.id}:${w.start}`,
        kind: 'freeze',
        title: `Freeze: ${f.name}${f.app_id == null ? ' (every app)' : ''}`,
        ...where(f.app_id, null),
        start: new Date(w.start).toISOString(),
        end: new Date(w.end).toISOString(),
        status: now >= w.start && now < w.end ? 'on' : w.end <= now ? 'done' : 'planned',
        detail:
          'Promotions, Apply now, moves and shared upgrades are refused; rollbacks to an older version are allowed.'
      })
  }

  const windows: DeployWindow[] = await safe(listWindows)
  for (const w of windows) {
    if (!w.enabled) continue
    if (w.app_id != null && scope.appIds && !scope.apps.has(w.app_id)) continue
    for (const s of windowSpans(w, from, to))
      events.push({
        id: `window:${w.id}:${s.start}`,
        kind: 'window',
        title: `Deploy window: ${w.name}${w.app_id == null ? ' (every app without its own)' : ''}`,
        ...where(w.app_id, null),
        start: new Date(s.start).toISOString(),
        end: new Date(s.end).toISOString(),
        status: now >= s.start && now < s.end ? 'on' : s.end <= now ? 'done' : 'planned',
        detail: `${w.env_scope === 'production' ? 'Production' : 'Every environment'}: ${windowWords(w)}`
      })
  }

  for (const r of await safe(
    async () =>
      (await db(ENTRIES)
        .where('starts_at', '<', new Date(to))
        .where((q) =>
          q
            .where((a) => a.whereNull('ends_at').where('starts_at', '>=', new Date(from)))
            .orWhere('ends_at', '>=', new Date(from))
        )
        .where((q) =>
          scope.appIds
            ? q.whereNull('app_id').orWhereIn('app_id', appIds.length ? appIds : [-1])
            : q
        )
        .limit(LIMIT)
        .select('*')) as Array<Record<string, unknown>>
  )) {
    const start = ms(r.starts_at)
    if (start == null) continue
    const end = ms(r.ends_at)
    const kind = (
      ['maintenance', 'note', 'tls'].includes(String(r.kind)) ? r.kind : 'other'
    ) as CalendarKind
    events.push({
      id: `entry:${r.id}`,
      kind,
      title: String(r.title ?? ''),
      ...where(r.app_id, r.environment_id),
      start: new Date(start).toISOString(),
      end: isoOf(end),
      status:
        end != null && now >= start && now < end
          ? 'on'
          : (end ?? start) <= now
            ? 'done'
            : 'planned',
      detail: r.description ? String(r.description) : null
    })
  }

  return events
    .filter((e) => !!e.start)
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
}

export interface EntryInput {
  app_id: number | null
  environment_id: number | null
  kind: 'maintenance' | 'note'
  title: string
  description: string | null
  starts_at: Date
  ends_at: Date | null
}

/** Validates a person's calendar entry (planned maintenance or a note). */
export function validateEntry(b: Record<string, unknown>): EntryInput | { error: string } {
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title || title.length > 200) return { error: 'title is required (at most 200 characters)' }
  const kind =
    b.kind == null || b.kind === 'maintenance' ? 'maintenance' : b.kind === 'note' ? 'note' : null
  if (!kind) return { error: 'kind is maintenance or note' }
  const desc =
    typeof b.description === 'string' && b.description.trim() ? b.description.trim() : null
  if (desc && desc.length > 1000) return { error: 'description is at most 1000 characters' }
  const idOrNull = (v: unknown) => {
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isSafeInteger(n) && n > 0 ? n : Number.NaN
  }
  const appId = idOrNull(b.app_id)
  const envId = idOrNull(b.environment_id)
  if (Number.isNaN(appId) || Number.isNaN(envId))
    return { error: 'app_id / environment_id are ids' }
  const s = typeof b.starts_at === 'string' ? new Date(b.starts_at) : null
  if (!s || Number.isNaN(s.getTime())) return { error: 'starts_at is an ISO time' }
  let e: Date | null = null
  if (b.ends_at != null && b.ends_at !== '') {
    e = typeof b.ends_at === 'string' ? new Date(b.ends_at) : null
    if (!e || Number.isNaN(e.getTime())) return { error: 'ends_at is an ISO time' }
    if (e.getTime() <= s.getTime()) return { error: 'ends_at must be after starts_at' }
    if (e.getTime() - s.getTime() > 31 * 86_400_000)
      return { error: 'an entry lasts at most 31 days' }
  }
  return {
    app_id: appId,
    environment_id: envId,
    kind,
    title,
    description: desc,
    starts_at: s,
    ends_at: e
  }
}

/**
 * For other Hub features: put (or move) one calendar entry they own, keyed by source + key — e.g.
 * a certificate watch writes `{source: 'tls', key: 'acme-prod', kind: 'tls', title: 'Certificate
 * of acme.example.com expires', starts_at: <expiry>}`. One row per (source, key).
 */
export async function upsertCalendarEntry(e: {
  source: string
  key: string
  kind: string
  title: string
  description?: string | null
  app_id?: number | null
  environment_id?: number | null
  starts_at: Date
  ends_at?: Date | null
}): Promise<void> {
  const row = {
    kind: e.kind.slice(0, 16),
    title: e.title.slice(0, 200),
    description: e.description ? e.description.slice(0, 1000) : null,
    app_id: e.app_id ?? null,
    environment_id: e.environment_id ?? null,
    starts_at: e.starts_at,
    ends_at: e.ends_at ?? null,
    updated_at: new Date()
  }
  const where = { source: e.source.slice(0, 32), source_key: e.key.slice(0, 120) }
  const n = await db(ENTRIES).where(where).update(row)
  if (!n) await db(ENTRIES).insert({ ...where, ...row, created_at: new Date() })
}

/** Removes an entry another feature owns (the certificate was renewed, the watch removed). */
export async function removeCalendarEntry(source: string, key: string): Promise<void> {
  await db(ENTRIES)
    .where({ source: source.slice(0, 32), source_key: key.slice(0, 120) })
    .delete()
}
