// api/src/services/traffic-digest.ts
/**
 * Daily traffic digest section (#1128): for administrators who turn it on (preference
 * `traffic_digest`, set on the Traffic Map page), a section in the daily summary with the last
 * day's busiest callers, callers new since the week before, error hot spots and integrations
 * that went silent. Read from the request log (traffic-window.ts), computed once per digest run.
 */
import { db } from '../db/index.js'
import type { DigestLine, DigestSection } from './daily-digest.js'
import { selectInChunks } from './db-batch.js'
import { callerKeyFor } from './traffic-entities.js'
import {
  labelCallers,
  readWindowGrouped,
  summarizeWindow,
  type WindowSummary
} from './traffic-window.js'

const DAY_MS = 86_400_000
const CACHE_MS = 10 * 60_000
const LINES = 5

export interface TrafficDigestFacts {
  top: Array<{ key: string; req: number; error: number }>
  fresh: Array<{ key: string; req: number }>
  hotSpots: Array<{ key: string; req: number; error: number; pct: number }>
  silent: Array<{ key: string; priorReq: number }>
  totals: { req: number; error: number }
  truncated: boolean
}

/**
 * What the section says (pure). `priorCallers` = request counts per caller over the seven days
 * before; `machine` = caller keys that are integrations (API keys, machine accounts).
 */
export function digestFacts(
  day: WindowSummary,
  priorCallers: Map<string, number>,
  machine: Set<string>
): TrafficDigestFacts {
  const today = new Map(day.callers.map((c) => [c.key, c]))
  const people = (k: string) => k !== 'cron' && k !== 'anon'
  return {
    top: day.callers
      .filter((c) => people(c.key))
      .slice(0, LINES)
      .map((c) => ({ key: c.key, req: c.req, error: c.error })),
    fresh: day.callers
      .filter((c) => people(c.key) && !priorCallers.has(c.key))
      .slice(0, LINES)
      .map((c) => ({ key: c.key, req: c.req })),
    hotSpots: day.entities
      .filter((e) => e.error > 0)
      .map((e) => ({
        key: e.key,
        req: e.req,
        error: e.error,
        pct: Math.round((100 * e.error) / e.req)
      }))
      .sort((a, b) => b.error - a.error)
      .slice(0, LINES),
    silent: [...priorCallers]
      .filter(([k]) => machine.has(k) && !today.has(k))
      .sort((a, b) => b[1] - a[1])
      .slice(0, LINES)
      .map(([key, priorReq]) => ({ key, priorReq })),
    totals: { req: day.totals.req, error: day.totals.error },
    truncated: day.truncated
  }
}

/** The section's lines from the facts (pure); null when there is nothing to say. */
export function digestSectionOf(
  f: TrafficDigestFacts,
  labels: Record<string, string>,
  url = '/traffic-map'
): DigestSection | null {
  if (f.totals.req === 0 && f.silent.length === 0) return null
  const lab = (k: string) => labels[k] ?? k
  const n = (v: number) => v.toLocaleString('en-US')
  const lines: DigestLine[] = []
  lines.push({
    text: `${n(f.totals.req)} requests in the last day, ${n(f.totals.error)} errors`,
    sub: f.truncated ? 'busiest part of the day only — the log read was capped' : undefined,
    url
  })
  if (f.top.length)
    lines.push({
      text: `Busiest callers: ${f.top.map((c) => `${lab(c.key)} (${n(c.req)})`).join(', ')}`,
      url
    })
  if (f.fresh.length)
    lines.push({
      text: `New since last week: ${f.fresh.map((c) => `${lab(c.key)} (${n(c.req)})`).join(', ')}`,
      url
    })
  if (f.hotSpots.length)
    lines.push({
      text: `Error hot spots: ${f.hotSpots.map((e) => `${e.key} ${n(e.error)} of ${n(e.req)} (${e.pct}%)`).join(', ')}`,
      url
    })
  if (f.silent.length)
    lines.push({
      text: `Silent integrations: ${f.silent.map((c) => `${lab(c.key)} (${n(c.priorReq)} calls the week before, none today)`).join(', ')}`,
      sub: 'an integration that stops calling is often an integration that broke',
      url
    })
  return { title: 'Traffic in the last day', lines }
}

let cache: { at: number; section: DigestSection | null } | null = null

async function priorCallerCounts(from: Date, to: Date): Promise<Map<string, number>> {
  const rows = (await db('nivaro_api_logs')
    .where('created_at', '>=', from)
    .where('created_at', '<', to)
    .groupBy('auth', 'api_key_id', 'user')
    .select('auth', 'api_key_id', 'user', db.raw('COUNT(*) as n'))
    .limit(20_000)) as Array<{
    auth: string | null
    api_key_id: number | null
    user: string | null
    n: number
  }>
  const out = new Map<string, number>()
  for (const r of rows) {
    const k = callerKeyFor({ authMethod: r.auth, apiKeyId: r.api_key_id, userId: r.user })
    out.set(k, (out.get(k) ?? 0) + Number(r.n))
  }
  return out
}

async function machineCallers(keys: string[]): Promise<Set<string>> {
  const out = new Set(keys.filter((k) => /^k\d+$/.test(k)))
  const userIds = keys.filter((k) => k.startsWith('u')).map((k) => k.slice(1))
  if (userIds.length) {
    const rows = (await selectInChunks(userIds, 1000, (chunk) =>
      Promise.resolve(
        db('nivaro_users').whereIn('id', chunk).whereNotNull('account_kind').select('id')
      )
    ).catch(() => [])) as Array<{ id: string }>
    for (const r of rows) out.add(`u${String(r.id).toUpperCase()}`)
  }
  return out
}

/** The section for the current digest run (shared by every opted-in admin, 10 min cache). */
export async function buildTrafficDigestSection(now = new Date()): Promise<DigestSection | null> {
  if (cache && now.getTime() - cache.at < CACHE_MS) return cache.section
  const dayFrom = new Date(now.getTime() - DAY_MS)
  const [grouped, prior] = await Promise.all([
    readWindowGrouped(dayFrom, now),
    priorCallerCounts(new Date(now.getTime() - 8 * DAY_MS), dayFrom)
  ])
  const day = summarizeWindow(grouped.rows, dayFrom, now, grouped.truncated)
  const machine = await machineCallers([...prior.keys()])
  const facts = digestFacts(day, prior, machine)
  const keys = [...new Set([...facts.top, ...facts.fresh, ...facts.silent].map((c) => c.key))]
  const labels = await labelCallers(keys).catch(() => ({}) as Record<string, string>)
  const section = digestSectionOf(facts, labels)
  cache = { at: now.getTime(), section }
  return section
}

function prefOn(raw: unknown): boolean {
  if (raw == null) return false
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw
    return (p as { traffic_digest?: unknown })?.traffic_digest === true
  } catch {
    return false
  }
}

/** Opted-in administrators (active, not redacted). */
export async function trafficDigestAudience(): Promise<string[]> {
  if (process.env.CLOUD_META_DB_URL) return []
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .where('u.preferences', 'like', '%traffic_digest%')
    .select('u.id', 'u.preferences')
    .catch(() => [])) as Array<{ id: string; preferences: unknown }>
  return rows.filter((r) => prefOn(r.preferences)).map((r) => String(r.id))
}

let registered = false
/** Register the section + its audience with the daily summary (once per process). */
export async function registerTrafficDigest(): Promise<void> {
  if (registered || process.env.CLOUD_META_DB_URL) return
  registered = true
  const { registerDigestAudience, registerDigestSection } = await import('./daily-digest.js')
  registerDigestAudience(trafficDigestAudience)
  registerDigestSection(async (userId): Promise<DigestSection | null> => {
    const me = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('u.id', userId)
      .first('r.admin_access', 'u.preferences')) as
      | { admin_access?: boolean; preferences?: unknown }
      | undefined
    if (!me?.admin_access || !prefOn(me.preferences)) return null
    return buildTrafficDigestSection()
  })
}
