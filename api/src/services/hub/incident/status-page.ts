import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from '../../../db/index.js'
import { HUB_ACCENT, HUB_BRAND, HUB_PRODUCT_NAME, inkOn } from '../brand.js'
import { HOURS, readFleetStatus } from '../fleet/store.js'
import { type PlannedItem, plannedMaintenance } from './planned.js'
import { type Incident, iso, openIncidents, productionEnvIds, STATUS_PAGES } from './store.js'

/**
 * Hub status pages (Hub enhancement 34): each app's health and the planned maintenance, for
 * people who must never see the Hub itself.
 *
 *   public    a link with a token (`nvs_` + 32 random bytes, base64url). Only its SHA-256 is
 *             stored; it expires (expires_at, at most a year) and can be revoked. Served by
 *             routes/hub-status-public.ts as a server-rendered page: no sign-in, no script,
 *             rate-limited, mounted only with HUB=on.
 *   internal  no token: every signed-in person of the Hub opens it in the Hub (Status tab).
 *
 * What a page says (statusAnswer) carries NO internal detail: the app's display name, one state
 * word, uptime percentages, the incident banner text an administrator wrote for app users (plain
 * text) and generic planned-maintenance lines (planned.ts). Never a hostname, address,
 * environment key, version, error text, person or count of issues.
 *
 * State per app = its PRODUCTION environments (owner-access isProductionEnv, the one rule) from
 * the fleet's last status (services/hub/fleet/store.ts), worsened by an open incident's severity.
 */

export const TOKEN_PREFIX = 'nvs_'
export const DEFAULT_EXPIRY_DAYS = 90
export const MAX_EXPIRY_DAYS = 366
export const STALE_MS = 10 * 60_000
export const DAYS = 30

export type AppState = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'unknown'

export const STATE_WORDS: Record<AppState, string> = {
  operational: 'Operational',
  degraded: 'Degraded performance',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  unknown: 'No recent data'
}

const RANK: Record<AppState, number> = {
  unknown: 0,
  operational: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4
}

export interface StatusPageRow {
  id: number
  name: string
  audience: 'public' | 'internal'
  token_hint: string | null
  app_ids: number[] | null
  expires_at: string | null
  revoked_at: string | null
  last_viewed_at: string | null
  created_by: string | null
  created_at: string | null
}

export function statusPageFromRow(r: Record<string, unknown>): StatusPageRow {
  let apps: number[] | null = null
  try {
    const v = typeof r.app_ids === 'string' ? JSON.parse(r.app_ids) : r.app_ids
    if (Array.isArray(v)) apps = v.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
  } catch {
    apps = null
  }
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    audience: r.audience === 'internal' ? 'internal' : 'public',
    token_hint: (r.token_hint as string | null) ?? null,
    app_ids: apps,
    expires_at: iso(r.expires_at),
    revoked_at: iso(r.revoked_at),
    last_viewed_at: iso(r.last_viewed_at),
    created_by: (r.created_by as string | null) ?? null,
    created_at: iso(r.created_at)
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function mintToken(): { token: string; hash: string; hint: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  return { token, hash: hashToken(token), hint: token.slice(-4) }
}

const TOKEN_RE = /^nvs_[A-Za-z0-9_-]{43}$/

/** Whether a page may be served now (not revoked, not expired). Pure. */
export function pageLive(
  p: Pick<StatusPageRow, 'revoked_at' | 'expires_at'>,
  now = Date.now()
): boolean {
  if (p.revoked_at) return false
  if (p.expires_at && Date.parse(p.expires_at) <= now) return false
  return true
}

/** The live PUBLIC page a token opens, or null (wrong shape, unknown, expired, revoked). */
export async function pageForToken(
  token: unknown,
  now = Date.now()
): Promise<StatusPageRow | null> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null
  const hash = hashToken(token)
  const row = (await db(STATUS_PAGES).where({ token_hash: hash }).first()) as
    | Record<string, unknown>
    | undefined
  if (!row || typeof row.token_hash !== 'string') return null
  // Constant-time compare of the stored hash (the lookup already matched; this is belt and braces).
  const a = Buffer.from(String(row.token_hash), 'hex')
  const b = Buffer.from(hash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const page = statusPageFromRow(row)
  if (page.audience !== 'public' || !pageLive(page, now)) return null
  return page
}

export async function listStatusPages(): Promise<StatusPageRow[]> {
  const rows = (await db(STATUS_PAGES).orderBy('id', 'asc').select('*')) as Array<
    Record<string, unknown>
  >
  return rows.map(statusPageFromRow)
}

export async function readStatusPage(id: number): Promise<StatusPageRow | null> {
  const r = (await db(STATUS_PAGES).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? statusPageFromRow(r) : null
}

export interface StatusPageInput {
  name: string
  audience: 'public' | 'internal'
  app_ids: number[] | null
  expires_at: Date | null
}

export function validateStatusPage(
  b: Record<string, unknown>,
  now = Date.now()
): StatusPageInput | { error: string } {
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > 120) return { error: 'name is required (at most 120 characters)' }
  const audience =
    b.audience === 'internal'
      ? 'internal'
      : b.audience == null || b.audience === 'public'
        ? 'public'
        : null
  if (!audience) return { error: 'audience is public or internal' }
  let apps: number[] | null = null
  if (b.app_ids != null) {
    if (!Array.isArray(b.app_ids) || b.app_ids.length > 200)
      return { error: 'app_ids is a list of app ids (or null for every app)' }
    apps = [...new Set(b.app_ids.map(Number))]
    if (apps.some((n) => !Number.isSafeInteger(n) || n <= 0))
      return { error: 'app_ids are app ids' }
  }
  let expires: Date | null = null
  if (audience === 'public') {
    const days = b.expires_in_days == null ? DEFAULT_EXPIRY_DAYS : Number(b.expires_in_days)
    if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS)
      return { error: `expires_in_days is 1 to ${MAX_EXPIRY_DAYS}` }
    expires = new Date(now + days * 86_400_000)
  }
  return { name, audience, app_ids: apps, expires_at: expires }
}

// ─── What a page says ───────────────────────────────────────────────────────

export interface StatusAppAnswer {
  name: string
  state: AppState
  state_word: string
  uptime_30d: number | null
  /** Oldest first, DAYS entries; null = no samples that day. */
  days: Array<{ date: string; uptime: number | null }>
  incident: { state: AppState; text: string; since: string } | null
}

export interface StatusAnswer {
  name: string
  overall: AppState
  overall_word: string
  apps: StatusAppAnswer[]
  planned: Array<{
    app: string | null
    title: string
    starts_at: string
    ends_at: string | null
    kind: string
  }>
  updated_at: string
}

/** One environment's state from its fleet row (stale = unknown). Pure. */
export function envState(
  row:
    | {
        up: boolean | null
        state: string | null
        probed_at: string | null
        checked_at: string | null
      }
    | undefined,
  now: number
): AppState {
  if (!row) return 'unknown'
  const seen = Math.max(
    row.probed_at ? Date.parse(row.probed_at) : 0,
    row.checked_at ? Date.parse(row.checked_at) : 0
  )
  if (!seen || now - seen > STALE_MS) return 'unknown'
  if (row.up === false) return 'major_outage'
  if (row.state === 'unreachable') return 'major_outage'
  if (row.state === 'degraded') return 'degraded'
  return 'operational'
}

/** The app's state from its production environments' states (pure). */
export function appStateOf(states: AppState[]): AppState {
  const known = states.filter((s) => s !== 'unknown')
  if (!known.length) return 'unknown'
  const down = known.filter((s) => s === 'major_outage').length
  if (down && down === known.length) return 'major_outage'
  if (down) return 'partial_outage'
  return known.some((s) => s === 'degraded') ? 'degraded' : 'operational'
}

export const SEVERITY_STATE: Record<string, AppState> = {
  sev1: 'major_outage',
  sev2: 'partial_outage',
  sev3: 'degraded'
}

export const worst = (a: AppState, b: AppState): AppState => (RANK[b] > RANK[a] ? b : a)

export const INCIDENT_DEFAULT_TEXT = 'We are looking into a problem with this app.'

/** The apps a page shows (null = every app), by display name. */
async function pageApps(ids: number[] | null): Promise<Array<{ id: number; name: string }>> {
  const q = db('nivaro_hub_apps').select('id', 'key', 'name')
  if (ids) q.whereIn('id', ids.length ? ids : [-1])
  const rows = (await q) as Array<{ id: number; key: string; name: string }>
  return rows
    .map((r) => ({ id: Number(r.id), name: String(r.name || r.key) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface AnswerDeps {
  now?: number
  production?: (appId: number) => Promise<number[]>
  incidents?: () => Promise<Incident[]>
  planned?: (appIds: number[]) => Promise<PlannedItem[]>
}

/** What one page says right now (no internal detail; see the header). */
export async function statusAnswer(
  page: Pick<StatusPageRow, 'name' | 'app_ids'>,
  deps: AnswerDeps = {}
): Promise<StatusAnswer> {
  const now = deps.now ?? Date.now()
  const apps = await pageApps(page.app_ids)
  const prodOf = new Map<number, number[]>()
  for (const a of apps)
    prodOf.set(a.id, await (deps.production ?? productionEnvIds)(a.id).catch(() => []))
  const envIds = [...prodOf.values()].flat()
  const fleet = envIds.length ? await readFleetStatus(envIds) : new Map()
  // Daily uptime over the last DAYS days (UTC days), summed over each app's production envs.
  const from = new Date(
    Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate() - (DAYS - 1)
    )
  )
  const hours = envIds.length
    ? ((await db(HOURS)
        .whereIn('environment_id', envIds.slice(0, 1000))
        .where('hour', '>=', from)
        .select('environment_id', 'hour', 'samples', 'up_samples')) as Array<
        Record<string, unknown>
      >)
    : []
  const dayKey = (v: unknown) => (iso(v) ?? '').slice(0, 10)
  const perEnvDay = new Map<string, { s: number; u: number }>()
  for (const h of hours) {
    const k = `${Number(h.environment_id)}|${dayKey(h.hour)}`
    const c = perEnvDay.get(k) ?? { s: 0, u: 0 }
    c.s += Number(h.samples) || 0
    c.u += Number(h.up_samples) || 0
    perEnvDay.set(k, c)
  }
  const dates = Array.from({ length: DAYS }, (_, i) =>
    new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10)
  )
  const incidents = (await (deps.incidents ?? openIncidents)().catch(() => [])) as Incident[]
  const pct = (u: number, s: number) => (s ? Math.round((u / s) * 100_000) / 1000 : null)
  const out: StatusAppAnswer[] = apps.map((a) => {
    const prod = prodOf.get(a.id) ?? []
    let state = appStateOf(prod.map((id) => envState(fleet.get(id), now)))
    let total = { s: 0, u: 0 }
    const days = dates.map((d) => {
      const c = prod.reduce(
        (acc, id) => {
          const x = perEnvDay.get(`${id}|${d}`)
          return x ? { s: acc.s + x.s, u: acc.u + x.u } : acc
        },
        { s: 0, u: 0 }
      )
      total = { s: total.s + c.s, u: total.u + c.u }
      return { date: d, uptime: pct(c.u, c.s) }
    })
    const open = incidents
      .filter((i) => i.app_id === a.id && i.status === 'open')
      .sort(
        (x, y) => (RANK[SEVERITY_STATE[y.severity]] ?? 0) - (RANK[SEVERITY_STATE[x.severity]] ?? 0)
      )[0]
    let incident: StatusAppAnswer['incident'] = null
    if (open) {
      const s = SEVERITY_STATE[open.severity] ?? 'degraded'
      state = worst(state === 'unknown' ? 'operational' : state, s)
      incident = {
        state: s,
        text: open.banner_text?.trim() || INCIDENT_DEFAULT_TEXT,
        since: open.opened_at
      }
    }
    return {
      name: a.name,
      state,
      state_word: STATE_WORDS[state],
      uptime_30d: pct(total.u, total.s),
      days,
      incident
    }
  })
  const overall = out.reduce<AppState>(
    (acc, a) => (a.state === 'unknown' ? acc : worst(acc, a.state)),
    out.some((a) => a.state !== 'unknown') ? 'operational' : 'unknown'
  )
  const byId = new Map(apps.map((a) => [a.id, a.name]))
  const planned = (
    await (deps.planned ?? ((ids: number[]) => plannedMaintenance({ appIds: ids, now })))(
      apps.map((a) => a.id)
    ).catch(() => [])
  )
    .filter((p) => p.app_id == null || byId.has(p.app_id))
    .map((p) => ({
      app: p.app_id == null ? null : (byId.get(p.app_id) ?? null),
      title: p.title,
      starts_at: p.starts_at,
      ends_at: p.ends_at,
      kind: p.kind
    }))
  return {
    name: page.name,
    overall,
    overall_word:
      overall === 'operational'
        ? 'All apps operational'
        : overall === 'unknown'
          ? 'No recent data'
          : STATE_WORDS[overall],
    apps: out,
    planned,
    updated_at: new Date(now).toISOString()
  }
}

// ─── The public page (server-rendered, no script) ───────────────────────────

const esc = (v: string) =>
  v.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )

const TONE: Record<AppState, string> = {
  operational: 'ok',
  degraded: 'warn',
  partial_outage: 'bad',
  major_outage: 'bad',
  unknown: 'none'
}

function when(at: string): string {
  return `${at.slice(0, 16).replace('T', ' ')} UTC`
}

/** The whole page. Every value is escaped; the page loads nothing but the Hub favicon. */
export function statusPageHtml(
  a: StatusAnswer,
  brand: { name?: string; accent?: string } = {}
): string {
  const accent = /^#[0-9a-f]{6}$/i.test(brand.accent ?? '') ? (brand.accent as string) : HUB_ACCENT
  const product = brand.name?.trim() || HUB_PRODUCT_NAME
  const bars = (days: StatusAppAnswer['days']) =>
    days
      .map((d) => {
        const tone =
          d.uptime == null ? 'none' : d.uptime >= 99.9 ? 'ok' : d.uptime >= 99 ? 'warn' : 'bad'
        const tip = `${d.date}: ${d.uptime == null ? 'no data' : `${d.uptime.toFixed(2)}% up`}`
        return `<span class="bar ${tone}" title="${esc(tip)}"><span class="sr">${esc(tip)}</span></span>`
      })
      .join('')
  const apps = a.apps.length
    ? a.apps
        .map(
          (x) => `<li class="app">
  <div class="row"><span class="dot ${TONE[x.state]}" aria-hidden="true"></span><span class="name">${esc(x.name)}</span><span class="state ${TONE[x.state]}">${esc(x.state_word)}</span></div>
  ${x.incident ? `<p class="incident ${TONE[x.incident.state]}">${esc(x.incident.text)} <span class="since">Since ${esc(when(x.incident.since))}</span></p>` : ''}
  <div class="bars" role="img" aria-label="${esc(`${x.name}: daily uptime, last ${DAYS} days`)}">${bars(x.days)}</div>
  <div class="legend"><span>${DAYS} days ago</span><span>${x.uptime_30d == null ? 'No data' : `${x.uptime_30d.toFixed(2)}% uptime`}</span><span>Today</span></div>
</li>`
        )
        .join('')
    : '<li class="empty">No apps on this page.</li>'
  const planned = a.planned.length
    ? `<section><h2>Planned maintenance</h2><ul class="planned">${a.planned
        .map(
          (p) =>
            `<li><span class="when">${esc(when(p.starts_at))}${p.ends_at ? ` – ${esc(when(p.ends_at))}` : ''}</span><span class="what">${esc(p.app ? `${p.app}: ` : 'All apps: ')}${esc(p.title)}</span></li>`
        )
        .join('')}</ul></section>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(a.name)} — status</title>
<link rel="icon" type="image/svg+xml" href="${HUB_BRAND.favicon}">
<style>
:root { --bg:#f6f5f2; --card:#ffffff; --ink:#14110a; --muted:#5f594f; --line:#e4e0d7; --accent:${accent}; --on-accent:${inkOn(accent)};
  --ok:#1f8a4c; --warn:#b26b00; --bad:#c4321f; --none:#a7a196; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1726; --card:#13203a; --ink:#eef1f6; --muted:#a3adbd; --line:#25334f;
  --ok:#3ccf7e; --warn:#f2b441; --bad:#ff7a66; --none:#56627a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 28px 16px 48px; }
.brand { display:flex; align-items:center; gap:8px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.brand i { width:10px; height:10px; border-radius:3px; background:var(--accent); display:inline-block; }
h1 { font-size:24px; margin:8px 0 16px; letter-spacing:-.01em; }
.overall { display:flex; align-items:center; gap:10px; padding:14px 16px; border-radius:10px; background:var(--card); border:1px solid var(--line); font-weight:600; }
.overall.ok { border-left:4px solid var(--ok); } .overall.warn { border-left:4px solid var(--warn); } .overall.bad { border-left:4px solid var(--bad); } .overall.none { border-left:4px solid var(--none); }
ul { list-style:none; margin:0; padding:0; }
.apps { margin-top:16px; background:var(--card); border:1px solid var(--line); border-radius:10px; }
.app { padding:14px 16px; border-top:1px solid var(--line); } .app:first-child { border-top:0; }
.row { display:flex; align-items:center; gap:10px; }
.name { font-weight:600; flex:1; min-width:0; overflow-wrap:anywhere; }
.state { font-size:13px; font-weight:600; } .state.ok { color:var(--ok); } .state.warn { color:var(--warn); } .state.bad { color:var(--bad); } .state.none { color:var(--muted); }
.dot { width:10px; height:10px; border-radius:50%; flex:none; } .dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); } .dot.bad { background:var(--bad); transform:rotate(45deg); border-radius:2px; } .dot.none { border:2px solid var(--none); }
.incident { margin:8px 0 0; font-size:14px; padding:8px 10px; border-radius:6px; background:color-mix(in srgb, var(--bad) 10%, transparent); }
.incident.warn { background:color-mix(in srgb, var(--warn) 12%, transparent); }
.since { color:var(--muted); font-size:12.5px; white-space:nowrap; }
.bars { display:flex; gap:2px; margin-top:10px; height:28px; }
.bar { flex:1; border-radius:2px; min-width:3px; } .bar.ok { background:var(--ok); } .bar.warn { background:var(--warn); } .bar.bad { background:var(--bad); } .bar.none { background:var(--line); }
.legend { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin-top:4px; font-variant-numeric:tabular-nums; }
section { margin-top:28px; } h2 { font-size:16px; margin:0 0 8px; }
.planned li { display:flex; flex-wrap:wrap; gap:4px 14px; padding:10px 0; border-top:1px solid var(--line); font-size:14px; }
.when { color:var(--muted); font-variant-numeric:tabular-nums; min-width:15em; }
.empty { padding:16px; color:var(--muted); }
footer { margin-top:28px; font-size:12.5px; color:var(--muted); }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
@media (max-width: 480px) { .bars { gap:1px; } .when { min-width:0; } h1 { font-size:21px; } }
</style></head>
<body><main>
<div class="brand"><i aria-hidden="true"></i>${esc(product)}</div>
<h1>${esc(a.name)}</h1>
<div class="overall ${TONE[a.overall]}" role="status"><span class="dot ${TONE[a.overall]}" aria-hidden="true"></span>${esc(a.overall_word)}</div>
<ul class="apps">${apps}</ul>
${planned}
<footer>Updated ${esc(when(a.updated_at))}. This page refreshes every minute.</footer>
</main></body></html>`
}

/** The page a wrong, expired or revoked link gets (the same for every reason). */
export function statusPageGoneHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Status page</title>
<style>body{margin:0;font:15px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f6f5f2;color:#14110a}main{max-width:520px;margin:15vh auto;padding:0 16px}@media (prefers-color-scheme: dark){body{background:#0d1726;color:#eef1f6}}</style></head>
<body><main><h1 style="font-size:20px">This status page link does not work</h1><p>It may have expired or been replaced. Ask whoever gave it to you for a new link.</p></main></body></html>`
}
