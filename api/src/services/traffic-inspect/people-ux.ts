// api/src/services/traffic-inspect/people-ux.ts
/**
 * Database readers for the Traffic Map "People and experience" lenses. Each reads a bounded
 * window of rows (hours capped, row counts capped) and hands them to people-ux-logic.ts. Admin
 * routes only: names and emails leave here, so nothing in this file is reachable without
 * requireAdmin.
 */
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { selectInChunks } from '../db-batch.js'
import { normalizeApp, normalizeScreenPath } from '../traffic-client-facts.js'
import {
  type AiCallRow,
  type AuthEvent,
  aiCostByScreen,
  apdexBy,
  attribute,
  buildFunnels,
  buildVisits,
  DAY,
  type DeviceSample,
  deliveredChannels,
  deviceSplit,
  type ErrorEvent,
  flowEdges,
  HOUR,
  isErrorStatus,
  type JourneyRow,
  type LoadSample,
  MIN,
  type NotificationRow,
  newVsExperienced,
  notificationPressure,
  parseBrowser,
  type RequestRow,
  type RumSample,
  rankErrorPeople,
  screenClass,
  screenId,
  serverWaitByVisit,
  signInStep,
  splitByPage,
  type Visit
} from './people-ux-logic.js'

const ROW_CAP = 150_000
const JOURNEY_CAP = 100_000
const RUM_CAP = 60_000

export function clampHours(v: unknown, fallback: number, max = 14 * 24): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.round(n)) : fallback
}
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const ms = (v: unknown): number => new Date(v as string | number | Date).getTime()

// ── shared reads ─────────────────────────────────────────────────────────────
async function readVisits(sinceMs: number): Promise<Map<string, Visit[]>> {
  const withApp = await hasColumn('nivaro_admin_journeys', 'app')
  // Start a little before the window so a visit open at its edge still catches requests.
  const rows = (await db('nivaro_admin_journeys')
    .where('entered_at', '>=', new Date(sinceMs - 35 * MIN))
    .orderBy('entered_at', 'desc')
    .limit(JOURNEY_CAP)
    .select(
      'user',
      'session_id',
      'path',
      'entered_at',
      'duration_seconds',
      ...(withApp ? ['app'] : [])
    )
    .catch(() => [])) as Array<{
    user: string
    session_id: string
    path: string
    entered_at: Date
    duration_seconds: number | null
    app?: string | null
  }>
  const journeys: JourneyRow[] = []
  for (const r of rows) {
    const page = normalizeScreenPath(r.path)
    if (!page) continue
    journeys.push({
      user: String(r.user).toUpperCase(),
      session_id: String(r.session_id),
      page,
      app: normalizeApp(r.app) ?? 'admin',
      entered_at: ms(r.entered_at),
      duration_seconds: r.duration_seconds == null ? null : num(r.duration_seconds)
    })
  }
  return buildVisits(journeys)
}

async function readRequests(sinceMs: number, onlyErrors = false): Promise<RequestRow[]> {
  const q = db('nivaro_api_logs')
    .where('created_at', '>=', new Date(sinceMs))
    .whereNotNull('user')
    .where('path', 'like', '/api/%')
  if (onlyErrors) void q.where('status', '>=', 400)
  const rows = (await q
    .orderBy('created_at', 'desc')
    .limit(ROW_CAP)
    .select('user', 'created_at', 'latency_ms', 'status', 'path')) as Array<{
    user: string
    created_at: Date
    latency_ms: number
    status: number
    path: string
  }>
  return rows.map((r) => ({
    user: String(r.user).toUpperCase(),
    at: ms(r.created_at),
    latency_ms: num(r.latency_ms),
    status: num(r.status),
    path: String(r.path)
  }))
}

interface RumRow {
  route: string
  kind: string
  ttfb_ms: number | null
  lcp_ms: number | null
  duration_ms: number | null
  app: string | null
  user: string | null
  created_at: Date
  browser?: string | null
  os?: string | null
  screen?: string | null
}
async function readRum(sinceMs: number, withDevice = false): Promise<RumRow[]> {
  const device = withDevice && (await hasColumn('nivaro_rum_events', 'browser'))
  return (await db('nivaro_rum_events')
    .where('created_at', '>=', new Date(sinceMs))
    .whereIn('kind', ['load', 'route'])
    .orderBy('created_at', 'desc')
    .limit(RUM_CAP)
    .select(
      'route',
      'kind',
      'ttfb_ms',
      'lcp_ms',
      'duration_ms',
      'app',
      'user',
      'created_at',
      ...(device ? ['browser', 'os', 'screen'] : [])
    )
    .catch(() => [])) as RumRow[]
}
const rumPage = (r: RumRow) => normalizeScreenPath(r.route) ?? r.route
const rumApp = (r: RumRow) => normalizeApp(r.app) ?? 'admin'
const rumMs = (r: RumRow) => (r.kind === 'load' ? (r.lcp_ms ?? r.duration_ms) : r.duration_ms)

interface PersonRow {
  id: string
  name: string
  email: string | null
}
async function readPeople(ids: string[]): Promise<Map<string, PersonRow & { created_at: number }>> {
  const rows = await selectInChunks(
    ids,
    500,
    (chunk) =>
      db('nivaro_users')
        .whereIn('id', chunk)
        .select('id', 'first_name', 'last_name', 'email', 'created_at') as Promise<
        Array<{
          id: string
          first_name: string | null
          last_name: string | null
          email: string | null
          created_at: Date
        }>
      >
  )
  const out = new Map<string, PersonRow & { created_at: number }>()
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
    out.set(String(r.id).toUpperCase(), {
      id: String(r.id).toUpperCase(),
      name: name || r.email || 'Unknown',
      email: r.email ?? null,
      created_at: ms(r.created_at)
    })
  }
  return out
}

// ── #2190 ────────────────────────────────────────────────────────────────────
export async function readNewVsExperienced(hours: number) {
  const since = Date.now() - hours * HOUR
  const [visits, requests, rumRows] = await Promise.all([
    readVisits(since),
    readRequests(since),
    readRum(since)
  ])
  const inWindow = (t: number) => t >= since
  const people = await readPeople([...visits.keys()])
  const created = new Map([...people].map(([id, p]) => [id, p.created_at]))
  const rum: RumSample[] = rumRows
    .filter((r) => r.user && rumMs(r) != null)
    .map((r) => ({
      user: String(r.user).toUpperCase(),
      at: ms(r.created_at),
      app: rumApp(r),
      route: rumPage(r),
      ms: rumMs(r) as number
    }))
    .filter((r) => inWindow(r.at))
  const rows = newVsExperienced(
    visits,
    requests.filter((r) => inWindow(r.at)),
    rum,
    created
  )
  const newPeople = [...created.values()].filter((c) => Date.now() - c <= 7 * DAY).length
  return { hours, new_people: newPeople, rows }
}

// ── #2191 ────────────────────────────────────────────────────────────────────
export async function readDevices(hours: number) {
  const rows = await readRum(Date.now() - hours * HOUR, true)
  const migrated = rows.length === 0 || rows.some((r) => 'browser' in r)
  const samples: DeviceSample[] = rows.map((r) => ({
    app: rumApp(r),
    route: rumPage(r),
    kind: r.kind,
    ms: rumMs(r),
    browser: r.browser ?? null,
    os: r.os ?? null,
    screen: r.screen ?? null
  }))
  const withDevice = samples.filter((s) => s.browser || s.os || s.screen).length
  return {
    hours,
    migrated,
    samples: samples.length,
    with_device: withDevice,
    rows: deviceSplit(samples)
  }
}

/** Browser, OS and screen class for one RUM beacon (the intake route's helper). */
export function deviceOfBeacon(
  ua: string | null | undefined,
  width: unknown
): { browser: string; os: string; screen: string | null } {
  const { browser, os } = parseBrowser(ua)
  return { browser, os, screen: screenClass(width) }
}

// ── #2194 ────────────────────────────────────────────────────────────────────
export async function readErrorPeople(hours: number) {
  const since = Date.now() - hours * HOUR
  const [visits, failing] = await Promise.all([readVisits(since), readRequests(since, true)])
  // The error text is on the log row; read it for the failing rows only.
  const texts = (await db('nivaro_api_logs')
    .where('created_at', '>=', new Date(since))
    .whereNotNull('user')
    .where('status', '>=', 400)
    .whereNotNull('error')
    .orderBy('created_at', 'desc')
    .limit(20_000)
    .select('user', 'created_at', 'error', 'status')
    .catch(() => [])) as Array<{ user: string; created_at: Date; error: string; status: number }>
  const textAt = new Map<string, string>()
  for (const t of texts) textAt.set(`${String(t.user).toUpperCase()}|${ms(t.created_at)}`, t.error)

  const events: ErrorEvent[] = []
  const attributed = new Map(attribute(visits, failing).map((a) => [`${a.user}|${a.at}`, a]))
  for (const r of failing) {
    if (!isErrorStatus(r.status) || /^\/api\/(traffic-map|rum|issues\/client)/.test(r.path))
      continue
    const a = attributed.get(`${r.user}|${r.at}`)
    const raw = textAt.get(`${r.user}|${r.at}`) ?? `${r.status} ${r.path.split('?')[0]}`
    events.push({
      user: r.user,
      at: r.at,
      kind: 'server',
      page: a ? screenId(a.visit.app, a.visit.page) : null,
      text: String(raw).replace(/\s+/g, ' ').slice(0, 120)
    })
  }
  const client = (await db('nivaro_issue_occurrences as o')
    .leftJoin('nivaro_issues as i', 'i.id', 'o.issue')
    .where('o.occurred_at', '>=', new Date(since))
    .where('o.source', 'client')
    .whereNotNull('o.user_id')
    .limit(20_000)
    .select('o.user_id', 'o.occurred_at', 'o.route', 'i.title')
    .catch(() => [])) as Array<{
    user_id: string
    occurred_at: Date
    route: string | null
    title: string | null
  }>
  for (const c of client) {
    events.push({
      user: String(c.user_id).toUpperCase(),
      at: ms(c.occurred_at),
      kind: 'client',
      page: c.route ? (normalizeScreenPath(c.route) ?? c.route.slice(0, 100)) : null,
      text: String(c.title ?? 'Client error')
        .replace(/^\[client\]\s*/, '')
        .slice(0, 120)
    })
  }
  const ranked = rankErrorPeople(events)
  const people = await readPeople(ranked.map((r) => r.user))
  return {
    hours,
    rows: ranked.map((r) => ({
      ...r,
      name: people.get(r.user)?.name ?? 'Unknown',
      email: people.get(r.user)?.email ?? null,
      last_at: new Date(r.last_at).toISOString()
    }))
  }
}

// ── #2202 ────────────────────────────────────────────────────────────────────
export async function readNetworkServer(hours: number) {
  const since = Date.now() - hours * HOUR
  const [visits, requests, rum] = await Promise.all([
    readVisits(since),
    readRequests(since),
    readRum(since)
  ])
  const wait = serverWaitByVisit(attribute(visits, requests))
  // The slowest-call wait per page (median over its visits) is what a load of that page had to
  // wait on; a beacon takes its page's figure.
  const perPage = new Map<string, number[]>()
  for (const [v, w] of wait) {
    const id = screenId(v.app, v.page)
    const l = perPage.get(id)
    if (l) l.push(w)
    else perPage.set(id, [w])
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0
  const samples: LoadSample[] = []
  for (const r of rum) {
    const total = rumMs(r)
    if (total == null) continue
    const id = screenId(rumApp(r), rumPage(r))
    samples.push({
      app: rumApp(r),
      route: rumPage(r),
      kind: r.kind === 'load' ? 'load' : 'route',
      ttfb: r.kind === 'load' ? r.ttfb_ms : null,
      total,
      server: median(perPage.get(id) ?? [])
    })
  }
  return { hours, rows: splitByPage(samples) }
}

// ── #2250 ────────────────────────────────────────────────────────────────────
export const APDEX_PAGE_MS = Math.max(100, Number(process.env.TRAFFIC_APDEX_PAGE_MS) || 1000)
export const APDEX_REQUEST_MS = Math.max(50, Number(process.env.TRAFFIC_APDEX_REQUEST_MS) || 500)

export async function readApdex(
  hours: number,
  pageMs: number,
  requestMs: number,
  by: 'page' | 'person'
) {
  const since = Date.now() - hours * HOUR
  const [visits, requests, rum] = await Promise.all([
    readVisits(since),
    readRequests(since),
    readRum(since)
  ])
  const pageSamples: Array<{ key: string; at: number; ms: number }> = []
  for (const r of rum) {
    const t = rumMs(r)
    if (t == null) continue
    const key =
      by === 'page' ? screenId(rumApp(r), rumPage(r)) : r.user ? String(r.user).toUpperCase() : ''
    if (key) pageSamples.push({ key, at: ms(r.created_at), ms: t })
  }
  const requestSamples: Array<{ key: string; at: number; ms: number }> = []
  if (by === 'page') {
    for (const a of attribute(visits, requests))
      requestSamples.push({ key: screenId(a.visit.app, a.visit.page), at: a.at, ms: a.latency_ms })
  } else {
    for (const r of requests) {
      if (/^\/api\/(traffic-map|rum|socket|health|version)/.test(r.path)) continue
      requestSamples.push({ key: r.user, at: r.at, ms: r.latency_ms })
    }
  }
  const rows = apdexBy(pageSamples, requestSamples, pageMs, requestMs)
  const people = by === 'person' ? await readPeople(rows.map((r) => r.id)) : null
  return {
    hours,
    by,
    page_target_ms: pageMs,
    request_target_ms: requestMs,
    rows: rows.map((r) => ({
      ...r,
      label: people ? (people.get(r.id)?.name ?? 'Unknown') : r.label
    }))
  }
}

// ── #2251 ────────────────────────────────────────────────────────────────────
export async function readSignInFunnel(hours: number) {
  const since = Date.now() - hours * HOUR
  const rows = (await db('nivaro_api_logs')
    .where('created_at', '>=', new Date(since))
    .where('path', 'like', '/api/auth/%')
    .orderBy('created_at', 'desc')
    .limit(40_000)
    .select('method', 'path', 'status', 'created_at', 'ip', 'user_agent', 'user')) as Array<{
    method: string
    path: string
    status: number
    created_at: Date
    ip: string | null
    user_agent: string | null
    user: string | null
  }>
  const events: AuthEvent[] = []
  const whos = new Set<string>()
  for (const r of rows) {
    if (!signInStep(r.method, r.path)) continue
    const who = `${r.ip ?? '-'}|${(r.user_agent ?? '').slice(0, 120)}`
    whos.add(r.ip ?? '-')
    events.push({
      who,
      at: ms(r.created_at),
      method: r.method,
      path: r.path,
      status: num(r.status),
      user: r.user ? String(r.user).toUpperCase() : null
    })
  }
  // The first signed-in call that followed, per browser: authenticated rows from the same
  // addresses, no auth-path rows.
  const firstRows = await selectInChunks(
    [...whos].slice(0, 1500),
    500,
    (chunk) =>
      db('nivaro_api_logs')
        .where('created_at', '>=', new Date(since))
        .whereIn('ip', chunk)
        .whereNotNull('user')
        .where('path', 'not like', '/api/auth/%')
        .where('path', 'not like', '/api/rum%')
        .orderBy('created_at', 'asc')
        .limit(30_000)
        .select('ip', 'user_agent', 'created_at') as Promise<
        Array<{ ip: string | null; user_agent: string | null; created_at: Date }>
      >
  )
  const byWho = new Map<string, number[]>()
  for (const r of firstRows) {
    const who = `${r.ip ?? '-'}|${(r.user_agent ?? '').slice(0, 120)}`
    const l = byWho.get(who)
    if (l) l.push(ms(r.created_at))
    else byWho.set(who, [ms(r.created_at)])
  }
  for (const l of byWho.values()) l.sort((a, b) => a - b)
  const funnels = buildFunnels(events, (who, at) => {
    const l = byWho.get(who)
    if (!l) return null
    return l.find((t) => t >= at) ?? null
  })
  return { hours, funnels }
}

// ── #2149 ────────────────────────────────────────────────────────────────────
export async function readFlow(hours: number, app: string | null) {
  const since = Date.now() - hours * HOUR
  const [visits, requests] = await Promise.all([readVisits(since), readRequests(since)])
  const inWin = new Map<string, Visit[]>()
  for (const [u, list] of visits)
    inWin.set(
      u,
      list.filter((v) => v.start >= since - 35 * MIN)
    )
  const apps = new Set<string>()
  for (const list of visits.values()) for (const v of list) apps.add(v.app)
  return {
    hours,
    app,
    apps: [...apps].sort(),
    edges: flowEdges(
      inWin,
      requests.filter((r) => r.at >= since),
      app
    )
  }
}

// ── #2258 ────────────────────────────────────────────────────────────────────
export const NOTIFY_FLOOD_PER_HOUR = Math.max(
  2,
  Number(process.env.TRAFFIC_NOTIFY_FLOOD_PER_HOUR) || 10
)

export async function readNotificationPressure(hours: number, threshold: number) {
  const now = Date.now()
  const since = now - hours * HOUR
  const hasCat = await hasColumn('nivaro_notifications', 'category')
  const hasDelivery = await hasColumn('nivaro_notifications', 'delivery')
  const rows = (await db('nivaro_notifications')
    .where('timestamp', '>=', new Date(since))
    .orderBy('timestamp', 'desc')
    .limit(100_000)
    .select(
      'recipient',
      'sender',
      'timestamp',
      ...(hasCat ? ['category'] : []),
      ...(hasDelivery ? ['delivery'] : [])
    )) as Array<{
    recipient: string
    sender: string | null
    timestamp: Date
    category?: string | null
    delivery?: unknown
  }>
  const senderIds = [...new Set(rows.map((r) => r.sender).filter((s): s is string => !!s))]
  const senders = await readPeople(senderIds.map((s) => String(s).toUpperCase()))
  const flat: NotificationRow[] = rows.map((r) => {
    let delivery: unknown = r.delivery
    if (typeof delivery === 'string') {
      try {
        delivery = JSON.parse(delivery)
      } catch {
        delivery = null
      }
    }
    const ch = deliveredChannels(delivery)
    return {
      recipient: String(r.recipient).toUpperCase(),
      at: ms(r.timestamp),
      category: r.category ?? null,
      sender: r.sender ? (senders.get(String(r.sender).toUpperCase())?.name ?? 'Someone') : null,
      channels: ch.length ? ch : ['inapp']
    }
  })
  const pressure = notificationPressure(flat, now, Math.min(hours, 72), threshold)
  const people = await readPeople(pressure.map((p) => p.user))
  return {
    hours,
    threshold,
    total: rows.length,
    rows: pressure.map((p) => ({ ...p, name: people.get(p.user)?.name ?? 'Unknown' }))
  }
}

// ── #2163 ────────────────────────────────────────────────────────────────────
export async function readAiCost(hours: number) {
  const since = Date.now() - hours * HOUR
  const [visits, rows] = await Promise.all([
    readVisits(since),
    db('nivaro_ai_calls')
      .where('created_at', '>=', new Date(since))
      .orderBy('created_at', 'desc')
      .limit(50_000)
      .select(
        'user',
        'created_at',
        'feature',
        'cost_usd',
        'input_tokens',
        'output_tokens',
        'status'
      )
      .catch(() => []) as Promise<
      Array<{
        user: string | null
        created_at: Date
        feature: string
        cost_usd: number | string | null
        input_tokens: number | null
        output_tokens: number | null
        status: string
      }>
    >
  ])
  const calls: AiCallRow[] = rows.map((r) => ({
    user: r.user ? String(r.user).toUpperCase() : null,
    at: ms(r.created_at),
    feature: r.feature,
    cost: num(r.cost_usd),
    tokens: num(r.input_tokens) + num(r.output_tokens),
    ok: r.status === 'ok'
  }))
  const out = aiCostByScreen(visits, calls)
  return {
    hours,
    total_cost: Math.round(calls.reduce((s, c) => s + c.cost, 0) * 10_000) / 10_000,
    total_calls: calls.length,
    rows: out
  }
}
