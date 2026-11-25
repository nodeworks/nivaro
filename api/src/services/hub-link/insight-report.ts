import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { NIVARO_VERSION } from '../../version.js'

/**
 * Hub insight (enhancements 36 + 37), app side: the two aggregates a Nivaro Hub may read about this
 * app over its link (routes/hub-insight-link.ts serves them on a dedicated app, bearer HUB_TOKEN,
 * and inside the app's tenant on a Hub shared deployment).
 *
 *  - `usageReport`: how many DIFFERENT people used the app per UTC day and which screens are the
 *    busiest, from the browser's own page-load beacons (nivaro_rum_events, kept 14 days). Counts
 *    only — never a person's id, name or email, never a record, never a raw URL: a screen is the
 *    stored route PATTERN, and anything in it that still looks like an id is masked again here.
 *    The privacy floor (k-anonymity) is enforced HERE, before anything leaves the app: a day with
 *    fewer than `floor` people (never below 5) carries no figures at all, only `under_floor`; a
 *    screen fewer than `floor` people opened is not listed (only how many were held back).
 *  - `dependencyReport`: what the app talks to — partner API configs, webhooks, the mail relay,
 *    the sign-in issuer, issue trackers — as HOST names only (`host[:port]`: never a scheme, a
 *    path, a query or a credential), plus the extensions this process loaded (id + version).
 *
 * Read with whatever knex the caller passes (the tenant's on a shared deployment).
 */

export const USAGE_DAYS_MAX = 14
/** The lowest privacy floor there is: a bucket under 5 people never leaves the app. */
export const USAGE_FLOOR_MIN = 5
export const USAGE_SCREENS_MAX = 25
const GROUPS_CAP = 2000
const DAY_MS = 86_400_000

export interface UsageDay {
  /** UTC day, YYYY-MM-DD. */
  day: string
  /** Different people that day; null under the floor. */
  people: number | null
  /** Page loads + screen changes that day; null under the floor. */
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
  days: number
  /** False when this app keeps no page-load beacons (an old install): every figure is empty. */
  available: boolean
  daily: UsageDay[]
  /** Different people over the whole window; null under the floor. */
  people_window: number | null
  /** Different people over the last 7 days; null under the floor. */
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

/** A figure, or null when it is under the floor (0 stays 0: nobody is not a person). */
export function floored(n: number, floor: number): number | null {
  if (n === 0) return 0
  return n >= floor ? n : null
}

const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[^/]*@[^/]*|[A-Za-z0-9_-]{24,})$/i

/** A route pattern with anything that still looks like an id, a token or an address masked. */
export function maskRoute(route: string): string {
  const path = String(route ?? '')
    .split(/[?#]/)[0]
    .slice(0, 300)
  const parts = path.split('/').map((s) => (s && ID_SEGMENT.test(s) ? ':id' : s))
  const out = parts.join('/') || '/'
  return out.startsWith('/') ? out : `/${out}`
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function usageReport(
  opts: { days?: number; floor?: number; now?: Date } = {},
  k: Knex = db
): Promise<UsageReport> {
  const days = Math.max(1, Math.min(USAGE_DAYS_MAX, Math.round(opts.days ?? USAGE_DAYS_MAX)))
  const floor = Math.max(USAGE_FLOOR_MIN, Math.round(opts.floor ?? USAGE_FLOOR_MIN))
  const now = opts.now ?? new Date()
  const today = startOfUtcDay(now)
  const since = new Date(today.getTime() - (days - 1) * DAY_MS)
  const out: UsageReport = {
    version: NIVARO_VERSION,
    floor,
    days,
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

  // One bounded count per day (the created_at index serves each): portable on every engine,
  // where a GROUP BY on a date expression is not.
  for (let i = 0; i < days; i++) {
    const from = new Date(since.getTime() + i * DAY_MS)
    const to = new Date(from.getTime() + DAY_MS)
    const row = (await k('nivaro_rum_events')
      .where('created_at', '>=', from)
      .where('created_at', '<', to)
      .whereNotNull('user')
      .select(k.raw('COUNT(DISTINCT ??) as people', ['user']), k.raw('COUNT(*) as views'))
      .first()) as { people?: unknown; views?: unknown } | undefined
    const people = num(row?.people)
    const under = people > 0 && people < floor
    out.daily.push({
      day: isoDay(from),
      people: under ? null : people,
      views: under ? null : num(row?.views),
      under_floor: under
    })
  }

  const distinctSince = async (from: Date): Promise<number> => {
    const row = (await k('nivaro_rum_events')
      .where('created_at', '>=', from)
      .whereNotNull('user')
      .select(k.raw('COUNT(DISTINCT ??) as people', ['user']))
      .first()) as { people?: unknown } | undefined
    return num(row?.people)
  }
  out.people_window = floored(await distinctSince(since), floor)
  out.people_7d = floored(
    await distinctSince(new Date(today.getTime() - (Math.min(days, 7) - 1) * DAY_MS)),
    floor
  )

  const groups = (await k('nivaro_rum_events')
    .where('created_at', '>=', since)
    .whereNotNull('user')
    .groupBy('route')
    .select('route', k.raw('COUNT(DISTINCT ??) as people', ['user']), k.raw('COUNT(*) as views'))
    .limit(GROUPS_CAP)) as Array<{ route: unknown; people: unknown; views: unknown }>
  const byRoute = new Map<string, UsageScreen>()
  let hidden = 0
  for (const g of groups) {
    const people = num(g.people)
    if (people < floor) {
      hidden++
      continue
    }
    const route = maskRoute(String(g.route ?? ''))
    const hit = byRoute.get(route)
    // Two patterns masked into one: the larger head count stays a true lower bound.
    if (hit) {
      hit.people = Math.max(hit.people, people)
      hit.views += num(g.views)
    } else byRoute.set(route, { route, people, views: num(g.views) })
  }
  out.screens = [...byRoute.values()]
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
    const rows = (await k('nivaro_tracker_connections').select('*').limit(PER_KIND_CAP)) as Array<
      Record<string, unknown>
    >
    for (const r of rows) {
      const host = hostOf(r.base_url)
      if (!host) continue
      out.push({
        kind: 'tracker',
        target: host,
        label: label(r.kind ?? r.provider, 40) ?? 'Issue tracker',
        count: null,
        enabled: r.enabled !== false && r.enabled !== 0
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
