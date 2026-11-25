import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { NIVARO_VERSION } from '../../version.js'
import { KNOWN_ROUTE_SEGMENTS } from './known-route-segments.js'

/**
 * Hub insight (enhancements 36 + 37), app side: the two aggregates a Nivaro Hub may read about this
 * app over its link (routes/hub-insight-link.ts serves them on a dedicated app, bearer HUB_TOKEN,
 * and inside the app's tenant on a Hub shared deployment).
 *
 *  - `usageReport`: how many DIFFERENT people used the app per UTC day and which screens are the
 *    busiest, from the browser's own page views (nivaro_rum_events kind load | route — never the
 *    rage / dead / widget rows, whose `route` carries element text). Counts only — never a
 *    person's id, name or email, never a record, never a raw URL. Privacy (k-anonymity) is enforced
 *    HERE, before anything leaves the app, and so that no two answers can be subtracted into a
 *    small bucket (review H1):
 *      · COMPLETED UTC days only — today is never counted, so two reads on one day are identical;
 *      · FIXED windows, 14 days with the last 7 inside it, whatever the caller asks for;
 *      · every count is rounded DOWN to a multiple of 5; a figure under the floor (never below 5)
 *        is null (a day says only `under_floor`), and `people_7d` is null when it is within the
 *        floor of the 14-day figure (their difference would name a handful of people);
 *      · a screen is the route pattern with every segment that is not a parameter or a known
 *        static route segment (KNOWN_ROUTE_SEGMENTS + this app's collection keys) masked as `:id`,
 *        and people are counted per MASKED screen; a screen under the floor is not listed (only
 *        how many were held back).
 *  - `dependencyReport`: what the app talks to — partner API configs, webhooks, the mail relay,
 *    the sign-in issuer, issue trackers — as HOST names only (`host[:port]`: never a scheme, a
 *    path, a query or a credential), plus the extensions this process loaded (id + version).
 *
 * Read with whatever knex the caller passes (the tenant's on a shared deployment).
 */

/** The window every usage answer covers (completed UTC days); the last 7 are the short window. */
export const USAGE_DAYS = 14
export const USAGE_SHORT_DAYS = 7
/** Kept for callers: the window is fixed, never longer. */
export const USAGE_DAYS_MAX = USAGE_DAYS
/** The lowest privacy floor there is: a bucket under 5 people never leaves the app. */
export const USAGE_FLOOR_MIN = 5
/** Every count is rounded down to this. */
export const USAGE_ROUND = 5
export const USAGE_SCREENS_MAX = 25
/** (screen, person) pairs read for the screen list. */
const PAIRS_CAP = 50_000
const DAY_MS = 86_400_000
const VIEW_KINDS = ['load', 'route'] as const

export interface UsageDay {
  /** UTC day, YYYY-MM-DD (a completed day). */
  day: string
  /** Different people that day, rounded down to 5; null under the floor. */
  people: number | null
  /** Page loads + screen changes that day, rounded down to 5; null under the floor. */
  views: number | null
  under_floor: boolean
}

export interface UsageScreen {
  /** Route pattern (`/collections/:c/:id`), never a raw URL. */
  route: string
  people: number
  views: number
}

export interface UsageReport {
  version: string
  floor: number
  /** Always USAGE_DAYS. */
  days: number
  /** False when this app keeps no page-load beacons (an old install): every figure is empty. */
  available: boolean
  daily: UsageDay[]
  /** Different people over the 14 completed days; null under the floor. */
  people_window: number | null
  /** Different people over the last 7 completed days; null under the floor or within the floor of
   *  people_window. */
  people_7d: number | null
  /** Active people with an account (no service/machine accounts); null under the floor. */
  accounts: number | null
  screens: UsageScreen[]
  /** Screens left out because fewer than `floor` people opened them. */
  screens_hidden: number
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Rounded down to a multiple of USAGE_ROUND. Pure. */
export function roundDown(n: number): number {
  return Math.max(0, Math.floor(n / USAGE_ROUND) * USAGE_ROUND)
}

/**
 * A count as it may leave the app: 0 stays 0 (nobody is not a person), anything else is rounded
 * down to 5 and null when under the floor. Pure.
 */
export function floored(n: number, floor: number): number | null {
  if (n === 0) return 0
  if (n < floor) return null
  const r = roundDown(n)
  return r >= floor ? r : null
}

/**
 * A route pattern reduced to what is safe to name: anything after ` :: ` (a rage / dead tag) and
 * the query/hash are cut, a `:param` and a known static segment stay, every other segment — an
 * id, a slug, a record key, a name — becomes `:id`. Null for a pseudo-screen (`widget:…`). Pure.
 */
export function maskRoute(route: string, allowed?: ReadonlySet<string>): string | null {
  const known = allowed ?? new Set(KNOWN_ROUTE_SEGMENTS)
  const raw = String(route ?? '')
    .split(' :: ')[0]
    .split(/[?#\s]/)[0]
    .slice(0, 300)
  if (!raw.startsWith('/')) return null
  const parts = raw.split('/').map((s, i) => {
    if (i === 0 || s === '') return s
    if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s
    return known.has(s.toLowerCase()) ? s.toLowerCase() : ':id'
  })
  return parts.join('/').replace(/\/+$/, '') || '/'
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** This app's collection keys: config names, never people — they stay in a screen's route. */
async function collectionKeys(k: Knex): Promise<Set<string>> {
  const out = new Set<string>(KNOWN_ROUTE_SEGMENTS)
  try {
    if (await k.schema.hasTable('nivaro_collections')) {
      const rows = (await k('nivaro_collections').select('collection').limit(5000)) as Array<{
        collection: unknown
      }>
      for (const r of rows)
        if (typeof r.collection === 'string' && /^[a-z][a-z0-9_]*$/.test(r.collection))
          out.add(r.collection)
    }
  } catch {
    // No collection list: the built-in segments only.
  }
  return out
}

/** The usage answer. `opts.days` is ignored (fixed windows); `floor` can only raise the floor. */
export async function usageReport(
  opts: { days?: number; floor?: number; now?: Date } = {},
  k: Knex = db
): Promise<UsageReport> {
  const floor = Math.max(USAGE_FLOOR_MIN, Math.round(opts.floor ?? USAGE_FLOOR_MIN))
  const now = opts.now ?? new Date()
  // Completed days only: the window ends at the start of today (UTC).
  const until = startOfUtcDay(now)
  const since = new Date(until.getTime() - USAGE_DAYS * DAY_MS)
  const shortSince = new Date(until.getTime() - USAGE_SHORT_DAYS * DAY_MS)
  const out: UsageReport = {
    version: NIVARO_VERSION,
    floor,
    days: USAGE_DAYS,
    available: false,
    daily: [],
    people_window: null,
    people_7d: null,
    accounts: null,
    screens: [],
    screens_hidden: 0
  }
  if (await k.schema.hasTable('nivaro_users')) {
    const row = (await k('nivaro_users')
      .where('status', 'active')
      .whereNull('account_kind')
      .count('* as n')
      .first()) as { n?: unknown } | undefined
    out.accounts = floored(num(row?.n), floor)
  }
  if (!(await k.schema.hasTable('nivaro_rum_events'))) return out
  out.available = true

  const views = (from: Date, to: Date) =>
    k('nivaro_rum_events')
      .where('created_at', '>=', from)
      .where('created_at', '<', to)
      .whereIn('kind', [...VIEW_KINDS])
      .whereNotNull('user')

  // One bounded count per day (the created_at index serves each): portable on every engine,
  // where a GROUP BY on a date expression is not.
  for (let i = 0; i < USAGE_DAYS; i++) {
    const from = new Date(since.getTime() + i * DAY_MS)
    const to = new Date(from.getTime() + DAY_MS)
    const row = (await views(from, to)
      .select(k.raw('COUNT(DISTINCT ??) as people', ['user']), k.raw('COUNT(*) as views'))
      .first()) as { people?: unknown; views?: unknown } | undefined
    const people = floored(num(row?.people), floor)
    const under = people === null
    out.daily.push({
      day: isoDay(from),
      people,
      views: under ? null : roundDown(num(row?.views)),
      under_floor: under
    })
  }

  const distinct = async (from: Date): Promise<number> => {
    const row = (await views(from, until)
      .select(k.raw('COUNT(DISTINCT ??) as people', ['user']))
      .first()) as { people?: unknown } | undefined
    return num(row?.people)
  }
  const long = await distinct(since)
  const short = await distinct(shortSince)
  out.people_window = floored(long, floor)
  // The two windows nest: their difference is the people seen only in the first week. When that
  // is a handful (0 < d < floor), the short figure would name them — it is held back.
  const gap = long - short
  out.people_7d = gap > 0 && gap < floor ? null : floored(short, floor)

  // People per MASKED screen (two raw patterns masked into one are counted together).
  const known = await collectionKeys(k)
  const pairs = (await views(since, until)
    .groupBy('route', 'user')
    .select('route', 'user', k.raw('COUNT(*) as views'))
    .limit(PAIRS_CAP)) as Array<{ route: unknown; user: unknown; views: unknown }>
  const byRoute = new Map<string, { people: Set<string>; views: number }>()
  for (const p of pairs) {
    const route = maskRoute(String(p.route ?? ''), known)
    if (!route) continue
    const hit = byRoute.get(route) ?? { people: new Set<string>(), views: 0 }
    hit.people.add(String(p.user).toLowerCase())
    hit.views += num(p.views)
    byRoute.set(route, hit)
  }
  const screens: UsageScreen[] = []
  let hidden = 0
  for (const [route, v] of byRoute) {
    const people = floored(v.people.size, floor)
    if (people === null) {
      hidden++
      continue
    }
    screens.push({ route, people, views: roundDown(v.views) })
  }
  out.screens = screens
    .sort((a, b) => b.people - a.people || b.views - a.views || a.route.localeCompare(b.route))
    .slice(0, USAGE_SCREENS_MAX)
  out.screens_hidden = hidden
  return out
}

// ─── Dependencies ────────────────────────────────────────────────────────────────────────────

export type DependencyKind = 'partner_api' | 'webhook' | 'mail' | 'signin' | 'tracker' | 'extension'

export interface AppDependency {
  kind: DependencyKind
  /** `host[:port]` for a network dependency; the extension id for an extension. */
  target: string
  /** A config's own name (an external API's name, a tracker kind) or the extension version. */
  label: string | null
  /** How many configs point there (webhooks), or null. */
  count: number | null
  enabled: boolean
}

export interface DependencyReport {
  version: string
  dependencies: AppDependency[]
}

const PER_KIND_CAP = 200

/** `host[:port]` of a URL, lower-cased, or null. Never the scheme, user, path, query or hash. */
export function hostOf(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
    const host = u.host.toLowerCase()
    return host && host.length <= 255 ? host : null
  } catch {
    return null
  }
}

const label = (v: unknown, max = 200): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s.slice(0, max) : null
}

export interface DependencyDeps {
  smtpHost?: () => Promise<string | null>
  oidcIssuer?: () => string | null
  extensions?: () => Array<{ id: string; version: string | null }>
}

async function defaultSmtpHost(): Promise<string | null> {
  const { getSmtpConfig } = await import('../mail.js')
  return (await getSmtpConfig()).host || null
}

async function defaultExtensions(): Promise<Array<{ id: string; version: string | null }>> {
  const { extensionRegistry } = await import('../../extensions/loader.js')
  return [...extensionRegistry.values()]
    .filter((e) => e.status === 'loaded' && e.enabled)
    .map((e) => ({
      id: e.id,
      version: label(e.manifest?.version, 64) ?? label(e.build, 12)
    }))
}

export async function dependencyReport(
  deps: DependencyDeps = {},
  k: Knex = db
): Promise<DependencyReport> {
  const out: AppDependency[] = []

  if (await k.schema.hasTable('nivaro_external_apis')) {
    const { resolveInstanceRow } = await import('../external-apis.js')
    const rows = (await k('nivaro_external_apis')
      .select('id', 'name', 'base_url', 'enabled', 'instance_overrides')
      .orderBy('id', 'asc')
      .limit(PER_KIND_CAP)) as Array<Record<string, unknown>>
    for (const r of rows) {
      const resolved = resolveInstanceRow(r as never) as { base_url?: unknown }
      const host = hostOf(resolved.base_url)
      if (!host) continue
      out.push({
        kind: 'partner_api',
        target: host,
        label: label(r.name),
        count: null,
        enabled: r.enabled !== false && r.enabled !== 0
      })
    }
  }

  if (await k.schema.hasTable('nivaro_webhooks')) {
    const rows = (await k('nivaro_webhooks')
      .select('url', 'enabled')
      .limit(PER_KIND_CAP * 5)) as Array<Record<string, unknown>>
    const byHost = new Map<string, { count: number; enabled: number }>()
    for (const r of rows) {
      const host = hostOf(r.url)
      if (!host) continue
      const hit = byHost.get(host) ?? { count: 0, enabled: 0 }
      hit.count++
      if (r.enabled !== false && r.enabled !== 0) hit.enabled++
      byHost.set(host, hit)
    }
    for (const [host, v] of [...byHost.entries()].slice(0, PER_KIND_CAP))
      out.push({
        kind: 'webhook',
        target: host,
        label: null,
        count: v.count,
        enabled: v.enabled > 0
      })
  }

  try {
    const smtp = hostOf(await (deps.smtpHost ?? defaultSmtpHost)())
    if (smtp && !/^localhost(:\d+)?$/.test(smtp))
      out.push({ kind: 'mail', target: smtp, label: 'Mail relay', count: null, enabled: true })
  } catch {
    // No mail settings readable: nothing to name.
  }

  const issuer = hostOf(deps.oidcIssuer ? deps.oidcIssuer() : null)
  if (issuer)
    out.push({ kind: 'signin', target: issuer, label: 'Sign-in', count: null, enabled: true })

  if (await k.schema.hasTable('nivaro_tracker_connections')) {
    // Only what is named: never the sealed token or the webhook secret.
    const rows = (await k('nivaro_tracker_connections')
      .select('base_url', 'provider', 'is_active')
      .limit(PER_KIND_CAP)) as Array<Record<string, unknown>>
    for (const r of rows) {
      const host = hostOf(r.base_url)
      if (!host) continue
      out.push({
        kind: 'tracker',
        target: host,
        label: label(r.provider, 40) ?? 'Issue tracker',
        count: null,
        enabled: r.is_active !== false && r.is_active !== 0 && r.is_active !== '0'
      })
    }
  }

  try {
    const exts = deps.extensions ? deps.extensions() : await defaultExtensions()
    for (const e of exts.slice(0, PER_KIND_CAP)) {
      const id = label(e.id, 100)
      if (!id) continue
      out.push({ kind: 'extension', target: id, label: e.version, count: null, enabled: true })
    }
  } catch {
    // The registry is process state; an old build without it names none.
  }

  return { version: NIVARO_VERSION, dependencies: out }
}
