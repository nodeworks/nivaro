// api/src/services/traffic-inspect/people-ux-logic.ts
/**
 * Pure logic behind the Traffic Map "People and experience" lenses (#2190 #2191 #2194 #2202 #2250
 * #2251 #2149 #2258 #2163). No database, no clock: the readers in people-ux.ts feed rows in.
 *
 * The api log carries no page, so a request is given a page by WHERE THE PERSON WAS: the journey
 * row (nivaro_admin_journeys: user, page, entered_at, duration) that was open when it arrived.
 */

export const MIN = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000
/** A journey row with no stamped duration is assumed open for at most this long. */
export const OPEN_VISIT_CAP_MS = 30 * MIN
/** A request this soon after a visit began counts as part of its page load. */
export const LOAD_WINDOW_MS = 5_000
/** A person is "new" for this long after their account was created. */
export const NEW_USER_DAYS = 7

// ── percentiles ──────────────────────────────────────────────────────────────
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}
export const p50 = (v: number[]) => percentile(v, 0.5)
export const p75 = (v: number[]) => percentile(v, 0.75)
export const p95 = (v: number[]) => percentile(v, 0.95)

// ── visits (journey rows → who was on which page when) ───────────────────────
export interface JourneyRow {
  user: string
  session_id: string
  /** Normalised page pattern (`/collections/:c/:id`). */
  page: string
  app: string
  entered_at: number
  duration_seconds: number | null
}
export interface Visit {
  user: string
  session: string
  page: string
  app: string
  start: number
  end: number
}

/** Visits per person, oldest first. A row's end is its stamped duration, else it stays open to
 *  the person's next row (capped at OPEN_VISIT_CAP_MS). */
export function buildVisits(rows: JourneyRow[]): Map<string, Visit[]> {
  const byUser = new Map<string, JourneyRow[]>()
  for (const r of rows) {
    const list = byUser.get(r.user)
    if (list) list.push(r)
    else byUser.set(r.user, [r])
  }
  const out = new Map<string, Visit[]>()
  for (const [user, list] of byUser) {
    list.sort((a, b) => a.entered_at - b.entered_at)
    out.set(
      user,
      list.map((r, i) => {
        const next = list[i + 1]?.entered_at
        const stamped = r.duration_seconds != null ? r.entered_at + r.duration_seconds * 1000 : null
        const open = Math.min(
          next ?? r.entered_at + OPEN_VISIT_CAP_MS,
          r.entered_at + OPEN_VISIT_CAP_MS
        )
        return {
          user,
          session: r.session_id,
          page: r.page,
          app: r.app,
          start: r.entered_at,
          // A stamped duration can overlap a second tab's later row; the later row wins.
          end: stamped != null ? Math.min(stamped, next ?? stamped) + 1500 : open
        }
      })
    )
  }
  return out
}

/** The visit open for `user` at `t` (the latest one that started at or before it), or null. */
export function visitAt(visits: Map<string, Visit[]>, user: string, t: number): Visit | null {
  const list = visits.get(user)
  if (!list || list.length === 0) return null
  let lo = 0
  let hi = list.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (found < 0) return null
  const v = list[found]
  return t <= v.end ? v : null
}

export const screenId = (app: string, page: string) => `${app} ${page}`

// ── request rows ─────────────────────────────────────────────────────────────
export interface RequestRow {
  user: string
  at: number
  latency_ms: number
  status: number
  path: string
}
/** Calls that are the map or the beacon itself never count as page cost. */
export function isNoisePath(path: string): boolean {
  return /^\/api\/(traffic-map|rum|socket|health|version)/.test(path)
}
/** A status that is a problem for the person: server errors and rejected calls, not 401/404. */
export function isErrorStatus(status: number): boolean {
  return status >= 500 || (status >= 400 && status !== 401 && status !== 404)
}

export interface AttributedRequest extends RequestRow {
  visit: Visit
  offset: number
}
export function attribute(
  visits: Map<string, Visit[]>,
  requests: RequestRow[]
): AttributedRequest[] {
  const out: AttributedRequest[] = []
  for (const r of requests) {
    if (isNoisePath(r.path)) continue
    const visit = visitAt(visits, r.user, r.at)
    if (visit) out.push({ ...r, visit, offset: r.at - visit.start })
  }
  return out
}

// ── cohorts (#2190) ──────────────────────────────────────────────────────────
export function isNewPerson(createdAt: number | undefined, at: number, days = NEW_USER_DAYS) {
  return createdAt != null && at >= createdAt && at - createdAt <= days * DAY
}

export interface CohortStats {
  visits: number
  requests: number
  errors: number
  req_per_visit: number | null
  error_rate: number | null
  p50: number | null
  p95: number | null
  rum_p75: number | null
}
export interface CohortPageRow {
  screen: string
  app: string
  page: string
  new: CohortStats
  experienced: CohortStats
  /** new p95 ÷ experienced p95, null unless both sides have enough requests. */
  slower_by: number | null
}

interface Acc {
  visits: Set<Visit>
  lat: number[]
  errors: number
  rum: number[]
}
const newAcc = (): Acc => ({ visits: new Set(), lat: [], errors: 0, rum: [] })
function finish(a: Acc): CohortStats {
  const requests = a.lat.length
  return {
    visits: a.visits.size,
    requests,
    errors: a.errors,
    req_per_visit: a.visits.size ? Math.round((requests / a.visits.size) * 10) / 10 : null,
    error_rate: requests ? Math.round((1000 * a.errors) / requests) / 10 : null,
    p50: p50(a.lat),
    p95: p95(a.lat),
    rum_p75: p75(a.rum)
  }
}
const MIN_SAMPLES = 5

export interface RumSample {
  user: string | null
  at: number
  app: string
  route: string
  ms: number
}

/** New (first week) against everyone else, per screen. Worst gap first. */
export function newVsExperienced(
  visits: Map<string, Visit[]>,
  requests: RequestRow[],
  rum: RumSample[],
  createdAt: Map<string, number>,
  limit = 40
): CohortPageRow[] {
  const accs = new Map<string, { new: Acc; exp: Acc; app: string; page: string }>()
  const slot = (app: string, page: string) => {
    const id = screenId(app, page)
    let s = accs.get(id)
    if (!s) {
      s = { new: newAcc(), exp: newAcc(), app, page }
      accs.set(id, s)
    }
    return s
  }
  for (const list of visits.values()) {
    for (const v of list) {
      const s = slot(v.app, v.page)
      ;(isNewPerson(createdAt.get(v.user), v.start) ? s.new : s.exp).visits.add(v)
    }
  }
  for (const r of attribute(visits, requests)) {
    const s = slot(r.visit.app, r.visit.page)
    const a = isNewPerson(createdAt.get(r.user), r.at) ? s.new : s.exp
    a.lat.push(r.latency_ms)
    if (isErrorStatus(r.status)) a.errors++
  }
  for (const m of rum) {
    if (!m.user) continue
    const s = slot(m.app, m.route)
    ;(isNewPerson(createdAt.get(m.user), m.at) ? s.new : s.exp).rum.push(m.ms)
  }
  const rows: CohortPageRow[] = []
  for (const [id, s] of accs) {
    const n = finish(s.new)
    if (n.visits === 0) continue
    const e = finish(s.exp)
    const slower =
      n.requests >= MIN_SAMPLES && e.requests >= MIN_SAMPLES && n.p95 != null && e.p95
        ? Math.round((n.p95 / e.p95) * 10) / 10
        : null
    rows.push({ screen: id, app: s.app, page: s.page, new: n, experienced: e, slower_by: slower })
  }
  const score = (r: CohortPageRow) =>
    (r.slower_by ?? 0) * 100 + (r.new.error_rate ?? 0) + Math.min(r.new.visits, 50) / 100
  return rows
    .sort((a, b) => score(b) - score(a) || a.screen.localeCompare(b.screen))
    .slice(0, limit)
}

// ── browser and device (#2191) ───────────────────────────────────────────────
/** `Chrome 126`, `Safari 17`, `Edge 126`, `Firefox 127`; a bot or unknown agent is 'Other'. */
export function parseBrowser(ua: string | null | undefined): { browser: string; os: string } {
  const s = String(ua ?? '')
  const ver = (re: RegExp) => re.exec(s)?.[1]?.split('.')[0]?.slice(0, 4)
  let browser = 'Other'
  const edge = ver(/Edg(?:e|A|iOS)?\/(\d+)/)
  const opera = ver(/OPR\/(\d+)/)
  const firefox = ver(/(?:Firefox|FxiOS)\/(\d+)/)
  const chrome = ver(/(?:Chrome|CriOS)\/(\d+)/)
  const safari = /Safari\//.test(s) ? ver(/Version\/(\d+)/) : undefined
  if (edge) browser = `Edge ${edge}`
  else if (opera) browser = `Opera ${opera}`
  else if (firefox) browser = `Firefox ${firefox}`
  else if (chrome) browser = `Chrome ${chrome}`
  else if (safari) browser = `Safari ${safari}`
  let os = 'Other'
  if (/Windows/i.test(s)) os = 'Windows'
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS'
  else if (/Android/i.test(s)) os = 'Android'
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS'
  else if (/CrOS/i.test(s)) os = 'ChromeOS'
  else if (/Linux|X11/i.test(s)) os = 'Linux'
  return { browser, os }
}
/** A viewport width as a class; the exact size is never stored. */
export function screenClass(width: unknown): string | null {
  const w = Number(width)
  if (!Number.isFinite(w) || w <= 0 || w > 20_000) return null
  if (w < 640) return 'phone'
  if (w < 1024) return 'tablet'
  if (w < 1440) return 'laptop'
  if (w < 2200) return 'desktop'
  return 'wide'
}

export interface DeviceSample {
  app: string
  route: string
  kind: string
  ms: number | null
  browser: string | null
  os: string | null
  screen: string | null
}
export interface DeviceRow {
  screen_id: string
  dimension: 'browser' | 'os' | 'screen'
  value: string
  samples: number
  load_p75: number | null
  route_p75: number | null
  /** The page's overall p75 over the same samples. */
  page_p75: number | null
  /** This value is 1.5× or more slower than everyone else on the page (enough samples). */
  outlier: boolean
}

/** Per page and dimension value: p75 load and route time against the page overall. */
export function deviceSplit(samples: DeviceSample[], limit = 60): DeviceRow[] {
  const byPage = new Map<string, DeviceSample[]>()
  for (const s of samples) {
    if (s.ms == null || (s.kind !== 'load' && s.kind !== 'route')) continue
    const id = screenId(s.app, s.route)
    const list = byPage.get(id)
    if (list) list.push(s)
    else byPage.set(id, [s])
  }
  const rows: DeviceRow[] = []
  for (const [id, list] of byPage) {
    const overall = p75(list.map((s) => s.ms as number))
    for (const dim of ['browser', 'os', 'screen'] as const) {
      const groups = new Map<string, DeviceSample[]>()
      for (const s of list) {
        const v = s[dim]
        if (!v) continue
        const g = groups.get(v)
        if (g) g.push(s)
        else groups.set(v, [s])
      }
      // One value is no split at all.
      if (groups.size < 2) continue
      for (const [value, g] of groups) {
        const loads = g.filter((s) => s.kind === 'load').map((s) => s.ms as number)
        const routes = g.filter((s) => s.kind === 'route').map((s) => s.ms as number)
        const mine = p75(g.map((s) => s.ms as number))
        // Against everyone else on the page, so one slow group cannot hide inside the overall p75.
        const rest = p75(list.filter((s) => s[dim] !== value).map((s) => s.ms as number))
        rows.push({
          screen_id: id,
          dimension: dim,
          value,
          samples: g.length,
          load_p75: p75(loads),
          route_p75: p75(routes),
          page_p75: overall,
          outlier:
            g.length >= MIN_SAMPLES &&
            rest != null &&
            rest > 0 &&
            mine != null &&
            mine >= rest * 1.5
        })
      }
    }
  }
  return rows
    .sort(
      (a, b) =>
        Number(b.outlier) - Number(a.outlier) ||
        b.samples - a.samples ||
        a.screen_id.localeCompare(b.screen_id) ||
        a.value.localeCompare(b.value)
    )
    .slice(0, limit)
}

// ── people hitting the most errors (#2194) ───────────────────────────────────
export interface ErrorEvent {
  user: string
  at: number
  kind: 'client' | 'server'
  page: string | null
  text: string
}
export interface ErrorPerson {
  user: string
  client: number
  server: number
  total: number
  pages: Array<{ page: string; n: number }>
  errors: Array<{ text: string; n: number }>
  last_at: number
}

const top = (m: Map<string, number>, n: number) =>
  [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)

export function rankErrorPeople(events: ErrorEvent[], limit = 25): ErrorPerson[] {
  const by = new Map<
    string,
    {
      client: number
      server: number
      pages: Map<string, number>
      texts: Map<string, number>
      last: number
    }
  >()
  for (const e of events) {
    let a = by.get(e.user)
    if (!a) {
      a = { client: 0, server: 0, pages: new Map(), texts: new Map(), last: 0 }
      by.set(e.user, a)
    }
    a[e.kind]++
    if (e.page) a.pages.set(e.page, (a.pages.get(e.page) ?? 0) + 1)
    if (e.text) a.texts.set(e.text, (a.texts.get(e.text) ?? 0) + 1)
    a.last = Math.max(a.last, e.at)
  }
  return [...by.entries()]
    .map(([user, a]) => ({
      user,
      client: a.client,
      server: a.server,
      total: a.client + a.server,
      pages: top(a.pages, 3).map(([page, n]) => ({ page, n })),
      errors: top(a.texts, 3).map(([text, n]) => ({ text, n })),
      last_at: a.last
    }))
    .sort((a, b) => b.total - a.total || b.last_at - a.last_at || a.user.localeCompare(b.user))
    .slice(0, limit)
}

// ── network vs server vs browser (#2202) ─────────────────────────────────────
export interface TimeSplit {
  network: number
  server: number
  browser: number
  total: number
  /** Which side holds the biggest share. */
  verdict: 'network' | 'server' | 'browser'
}
/**
 * Split one page load. `ttfb` is the wait for the first byte (network + the web server),
 * `serverMs` the slowest API call in the load window (the data the page waits on), `total` the
 * time to the largest paint (or the settled render for a route change, where `ttfb` is null).
 * An estimate: the log has server time only, so network is the first-byte wait, and what neither
 * side explains is the browser's own work.
 */
export function splitTime(ttfb: number | null, serverMs: number, total: number): TimeSplit {
  const t = Math.max(0, total)
  const network = Math.min(Math.max(0, ttfb ?? 0), t)
  const server = Math.min(Math.max(0, serverMs), Math.max(0, t - network))
  const browser = Math.max(0, t - network - server)
  const verdict =
    server >= network && server >= browser ? 'server' : network >= browser ? 'network' : 'browser'
  return { network, server, browser, total: t, verdict }
}

export interface LoadSample {
  app: string
  route: string
  kind: 'load' | 'route'
  ttfb: number | null
  total: number
  server: number
}
export interface SplitRow {
  screen_id: string
  kind: 'load' | 'route'
  samples: number
  network: number
  server: number
  browser: number
  total: number
  verdict: TimeSplit['verdict']
}
export function splitByPage(samples: LoadSample[], limit = 40): SplitRow[] {
  const by = new Map<string, LoadSample[]>()
  for (const s of samples) {
    const k = `${screenId(s.app, s.route)}|${s.kind}`
    const l = by.get(k)
    if (l) l.push(s)
    else by.set(k, [s])
  }
  const rows: SplitRow[] = []
  for (const [k, list] of by) {
    const cut = k.lastIndexOf('|')
    const parts = list.map((s) => splitTime(s.ttfb, s.server, s.total))
    const med = (f: (p: TimeSplit) => number) => p50(parts.map(f)) ?? 0
    const mid: TimeSplit = splitTime(
      med((p) => p.network),
      med((p) => p.server),
      med((p) => p.total)
    )
    rows.push({
      screen_id: k.slice(0, cut),
      kind: list[0].kind,
      samples: list.length,
      network: Math.round(mid.network),
      server: Math.round(mid.server),
      browser: Math.round(mid.browser),
      total: Math.round(mid.total),
      verdict: mid.verdict
    })
  }
  return rows
    .sort((a, b) => b.total - a.total || a.screen_id.localeCompare(b.screen_id))
    .slice(0, limit)
}

/** Per visit, the slowest API call inside the load window: what the page had to wait on. */
export function serverWaitByVisit(reqs: AttributedRequest[]): Map<Visit, number> {
  const out = new Map<Visit, number>()
  for (const r of reqs) {
    if (r.offset > LOAD_WINDOW_MS) continue
    out.set(r.visit, Math.max(out.get(r.visit) ?? 0, r.latency_ms))
  }
  return out
}

// ── Apdex (#2250) ────────────────────────────────────────────────────────────
export interface Apdex {
  n: number
  satisfied: number
  tolerating: number
  frustrated: number
  /** 0..1, two decimals; null with no samples. */
  score: number | null
}
/** Satisfied up to T, tolerating up to 4T, frustrated beyond. */
export function apdex(samplesMs: number[], targetMs: number): Apdex {
  let satisfied = 0
  let tolerating = 0
  let frustrated = 0
  for (const ms of samplesMs) {
    if (ms <= targetMs) satisfied++
    else if (ms <= 4 * targetMs) tolerating++
    else frustrated++
  }
  const n = samplesMs.length
  return {
    n,
    satisfied,
    tolerating,
    frustrated,
    score: n ? Math.round(((satisfied + tolerating / 2) / n) * 100) / 100 : null
  }
}
/** Monday 00:00 UTC of the week holding `t`, as YYYY-MM-DD. */
export function weekStart(t: number): string {
  const d = new Date(t)
  const day = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
    .toISOString()
    .slice(0, 10)
}
export interface ApdexRow {
  id: string
  label: string
  page: Apdex
  request: Apdex
  /** Lower of the two scores present: the worst-first sort key. */
  worst: number | null
  weeks: Array<{ week: string; page: number | null; request: number | null }>
}

/**
 * Apdex per key (a screen, or a person). `pageSamples` are browser timings, `requestSamples`
 * API durations; both carry the key and a time for the weekly trend.
 */
export function apdexBy(
  pageSamples: Array<{ key: string; at: number; ms: number }>,
  requestSamples: Array<{ key: string; at: number; ms: number }>,
  pageTarget: number,
  requestTarget: number,
  label: (key: string) => string = (k) => k,
  limit = 40
): ApdexRow[] {
  const keys = new Set([...pageSamples.map((s) => s.key), ...requestSamples.map((s) => s.key)])
  const rows: ApdexRow[] = []
  for (const key of keys) {
    const ps = pageSamples.filter((s) => s.key === key)
    const rs = requestSamples.filter((s) => s.key === key)
    const page = apdex(
      ps.map((s) => s.ms),
      pageTarget
    )
    const request = apdex(
      rs.map((s) => s.ms),
      requestTarget
    )
    const weeks = new Set([...ps, ...rs].map((s) => weekStart(s.at)))
    const trend = [...weeks].sort().map((week) => ({
      week,
      page: apdex(
        ps.filter((s) => weekStart(s.at) === week).map((s) => s.ms),
        pageTarget
      ).score,
      request: apdex(
        rs.filter((s) => weekStart(s.at) === week).map((s) => s.ms),
        requestTarget
      ).score
    }))
    const scores = [page.score, request.score].filter((s): s is number => s != null)
    rows.push({
      id: key,
      label: label(key),
      page,
      request,
      worst: scores.length ? Math.min(...scores) : null,
      weeks: trend
    })
  }
  return rows
    .filter((r) => r.worst != null && r.page.n + r.request.n >= MIN_SAMPLES)
    .sort(
      (a, b) =>
        (a.worst as number) - (b.worst as number) ||
        b.page.n + b.request.n - (a.page.n + a.request.n)
    )
    .slice(0, limit)
}

// ── sign-in funnel (#2251) ───────────────────────────────────────────────────
export type SignInMethod = 'microsoft' | 'saml' | 'password' | 'token'
export const SIGNIN_STEPS: Record<SignInMethod, Array<{ key: string; label: string }>> = {
  microsoft: [
    { key: 'page', label: 'Login page' },
    { key: 'redirect', label: 'Provider redirect' },
    { key: 'callback', label: 'Callback' },
    { key: 'first', label: 'First page' }
  ],
  saml: [
    { key: 'page', label: 'Login page' },
    { key: 'redirect', label: 'Provider redirect' },
    { key: 'callback', label: 'Callback' },
    { key: 'first', label: 'First page' }
  ],
  password: [
    { key: 'submit', label: 'Password submitted' },
    { key: 'first', label: 'First page' }
  ],
  token: [
    { key: 'submit', label: 'Token submitted' },
    { key: 'first', label: 'First page' }
  ]
}

export interface AuthEvent {
  /** ip|user agent: the only thing that ties a sign-in's calls together before there is a user. */
  who: string
  at: number
  method: string
  path: string
  status: number
  user: string | null
}
/** The funnel step an api-log row is, or null when it is not part of one. */
export function signInStep(
  method: string,
  path: string
): { method: SignInMethod; step: string } | null {
  const p = path.split('?')[0].replace(/\/+$/, '')
  const m = method.toUpperCase()
  if (m === 'GET' && p === '/api/auth/providers') return { method: 'microsoft', step: 'page' }
  if (m === 'GET' && p === '/api/auth/login') return { method: 'microsoft', step: 'redirect' }
  if (m === 'GET' && p === '/api/auth/callback') return { method: 'microsoft', step: 'callback' }
  if (m === 'GET' && p === '/api/auth/saml/login') return { method: 'saml', step: 'redirect' }
  if (m === 'POST' && p === '/api/auth/saml/callback') return { method: 'saml', step: 'callback' }
  if (m === 'POST' && p === '/api/auth/login/password')
    return { method: 'password', step: 'submit' }
  if (m === 'POST' && p === '/api/auth/login/token') return { method: 'token', step: 'submit' }
  return null
}

export interface FunnelStep {
  key: string
  label: string
  reached: number
  failed: number
  /** Time from the step before it. */
  p50_ms: number | null
  p95_ms: number | null
}
export interface Funnel {
  method: SignInMethod
  attempts: number
  completed: number
  steps: FunnelStep[]
}

/** Walk one person-at-a-browser's calls into attempts per method and count them down the funnel.
 *  `firstPage` = the first authenticated call that followed (who → time), supplied by the reader. */
export function buildFunnels(
  events: AuthEvent[],
  firstPageAfter: (who: string, at: number) => number | null,
  gapMs = 10 * MIN
): Funnel[] {
  const sorted = [...events].sort((a, b) => a.at - b.at)
  const state = new Map<
    SignInMethod,
    {
      attempts: number
      completed: number
      steps: Map<string, { reached: number; failed: number; ms: number[] }>
    }
  >()
  const stateOf = (m: SignInMethod) => {
    let s = state.get(m)
    if (!s) {
      s = { attempts: 0, completed: 0, steps: new Map() }
      for (const st of SIGNIN_STEPS[m]) s.steps.set(st.key, { reached: 0, failed: 0, ms: [] })
      state.set(m, s)
    }
    return s
  }
  // An attempt per (browser, method): opens on its first step and ends at a gap, a failure or the
  // first page.
  const open = new Map<
    string,
    { last: number; lastStep: number; method: SignInMethod; closed: boolean }
  >()
  const stepIdx = (m: SignInMethod, key: string) => SIGNIN_STEPS[m].findIndex((s) => s.key === key)
  const finishAttempt = (
    a: { last: number; lastStep: number; method: SignInMethod },
    who: string
  ) => {
    const s = stateOf(a.method)
    const steps = SIGNIN_STEPS[a.method]
    const last = steps[steps.length - 1].key
    if (a.lastStep === steps.length - 2) {
      const at = firstPageAfter(who, a.last)
      if (at != null && at - a.last <= gapMs) {
        const b = s.steps.get(last)
        if (b) {
          b.reached++
          b.ms.push(at - a.last)
        }
        s.completed++
      }
    }
  }
  for (const e of sorted) {
    const info = signInStep(e.method, e.path)
    if (!info) continue
    const s = stateOf(info.method)
    const idx = stepIdx(info.method, info.step)
    const k = `${e.who}|${info.method}`
    let a = open.get(k)
    const startsNew = idx === 0 || !a || a.closed || e.at - a.last > gapMs
    if (startsNew) {
      if (a && !a.closed) finishAttempt(a, e.who)
      // A call that is not the first step still opens an attempt (the earlier steps were
      // outside the window or never logged), and counts from where it stands.
      a = { last: e.at, lastStep: idx, method: info.method, closed: false }
      open.set(k, a)
      s.attempts++
      const st = s.steps.get(info.step)
      if (st) st.reached++
    } else if (a) {
      const st = s.steps.get(info.step)
      if (st) {
        st.reached++
        st.ms.push(e.at - a.last)
      }
      a.last = e.at
      a.lastStep = Math.max(a.lastStep, idx)
    }
    if (e.status >= 400) {
      const st = s.steps.get(info.step)
      if (st) st.failed++
      const cur = open.get(k)
      if (cur) cur.closed = true
    }
  }
  for (const [k, a] of open) if (!a.closed) finishAttempt(a, k.slice(0, k.lastIndexOf('|')))
  const order: SignInMethod[] = ['microsoft', 'saml', 'password', 'token']
  return order
    .filter((m) => state.has(m))
    .map((m) => {
      const s = state.get(m) as NonNullable<ReturnType<typeof state.get>>
      return {
        method: m,
        attempts: s.attempts,
        completed: s.completed,
        steps: SIGNIN_STEPS[m].map((st) => {
          const x = s.steps.get(st.key) as { reached: number; failed: number; ms: number[] }
          return {
            key: st.key,
            label: st.label,
            reached: x.reached,
            failed: x.failed,
            p50_ms: p50(x.ms),
            p95_ms: p95(x.ms)
          }
        })
      }
    })
}

// ── screen-to-screen flow (#2149) ────────────────────────────────────────────
export interface FlowEdge {
  from: string
  to: string
  moves: number
  /** API calls inside the destination's load window, summed over the moves. */
  requests: number
  /** Their summed duration. */
  request_ms: number
  per_move: number | null
}
export function flowEdges(
  visits: Map<string, Visit[]>,
  requests: RequestRow[],
  app: string | null,
  limit = 40
): FlowEdge[] {
  const cost = new Map<Visit, { n: number; ms: number }>()
  for (const r of attribute(visits, requests)) {
    if (r.offset > LOAD_WINDOW_MS) continue
    const c = cost.get(r.visit) ?? { n: 0, ms: 0 }
    c.n++
    c.ms += r.latency_ms
    cost.set(r.visit, c)
  }
  const edges = new Map<string, FlowEdge>()
  for (const list of visits.values()) {
    const bySession = new Map<string, Visit[]>()
    for (const v of list) {
      if (app && v.app !== app) continue
      const s = bySession.get(v.session)
      if (s) s.push(v)
      else bySession.set(v.session, [v])
    }
    for (const seq of bySession.values()) {
      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1]
        const b = seq[i]
        if (a.page === b.page) continue
        const k = `${a.page}\u0000${b.page}`
        const e = edges.get(k) ?? {
          from: a.page,
          to: b.page,
          moves: 0,
          requests: 0,
          request_ms: 0,
          per_move: null
        }
        e.moves++
        const c = cost.get(b)
        if (c) {
          e.requests += c.n
          e.request_ms += c.ms
        }
        edges.set(k, e)
      }
    }
  }
  return [...edges.values()]
    .map((e) => ({ ...e, per_move: Math.round((e.requests / e.moves) * 10) / 10 }))
    .sort((a, b) => b.requests - a.requests || b.moves - a.moves || a.from.localeCompare(b.from))
    .slice(0, limit)
}

// ── notification pressure (#2258) ────────────────────────────────────────────
export interface NotificationRow {
  recipient: string
  at: number
  category: string | null
  sender: string | null
  channels: string[]
}
export interface PressureRow {
  user: string
  total: number
  peak_hour: string
  peak: number
  per_hour: number[]
  channels: Record<string, number>
  categories: Array<{ name: string; n: number }>
  senders: Array<{ name: string; n: number }>
}
/** The channels a delivery blob says reached the person: any entry sent or delivered. */
export function deliveredChannels(delivery: unknown): string[] {
  if (!delivery || typeof delivery !== 'object') return []
  const out: string[] = []
  for (const [ch, v] of Object.entries(delivery as Record<string, unknown>)) {
    if (ch === 'escalation' || !v || typeof v !== 'object') continue
    const st = (v as { status?: unknown }).status
    if (st === 'sent' || st === 'delivered') out.push(ch)
  }
  return out
}

/** People over `floodPerHour` in any one hour, worst first. `hours` = the hourly buckets shown. */
export function notificationPressure(
  rows: NotificationRow[],
  now: number,
  hours: number,
  floodPerHour: number,
  limit = 30
): PressureRow[] {
  const hourStart = Math.floor(now / HOUR) * HOUR - (hours - 1) * HOUR
  const by = new Map<
    string,
    { hours: number[]; ch: Map<string, number>; cat: Map<string, number>; snd: Map<string, number> }
  >()
  for (const r of rows) {
    const h = Math.floor((r.at - hourStart) / HOUR)
    if (h < 0 || h >= hours) continue
    let a = by.get(r.recipient)
    if (!a) {
      a = { hours: new Array(hours).fill(0), ch: new Map(), cat: new Map(), snd: new Map() }
      by.set(r.recipient, a)
    }
    a.hours[h]++
    for (const c of r.channels) a.ch.set(c, (a.ch.get(c) ?? 0) + 1)
    const cat = r.category ?? 'other'
    a.cat.set(cat, (a.cat.get(cat) ?? 0) + 1)
    const snd = r.sender ?? 'system'
    a.snd.set(snd, (a.snd.get(snd) ?? 0) + 1)
  }
  const out: PressureRow[] = []
  for (const [user, a] of by) {
    const peak = Math.max(...a.hours)
    if (peak < floodPerHour) continue
    const peakIdx = a.hours.indexOf(peak)
    out.push({
      user,
      total: a.hours.reduce((x, y) => x + y, 0),
      peak,
      peak_hour: new Date(hourStart + peakIdx * HOUR).toISOString(),
      per_hour: a.hours,
      channels: Object.fromEntries(a.ch),
      categories: top(a.cat, 3).map(([name, n]) => ({ name, n })),
      senders: top(a.snd, 3).map(([name, n]) => ({ name, n }))
    })
  }
  return out
    .sort((a, b) => b.peak - a.peak || b.total - a.total || a.user.localeCompare(b.user))
    .slice(0, limit)
}

// ── AI cost per screen (#2163) ───────────────────────────────────────────────
export interface AiCallRow {
  user: string | null
  at: number
  feature: string
  cost: number
  tokens: number
  ok: boolean
}
export interface AiScreenRow {
  screen: string
  calls: number
  cost: number
  tokens: number
  errors: number
  features: Array<{ feature: string; calls: number; cost: number }>
}
export const NO_SCREEN = '(no screen: background or API)'

/** AI spend per screen: each call lands on the page its caller had open when it was made. */
export function aiCostByScreen(
  visits: Map<string, Visit[]>,
  calls: AiCallRow[],
  limit = 30
): AiScreenRow[] {
  const by = new Map<
    string,
    {
      calls: number
      cost: number
      tokens: number
      errors: number
      f: Map<string, { calls: number; cost: number }>
    }
  >()
  for (const c of calls) {
    const v = c.user ? visitAt(visits, c.user, c.at) : null
    const screen = v ? screenId(v.app, v.page) : NO_SCREEN
    let a = by.get(screen)
    if (!a) {
      a = { calls: 0, cost: 0, tokens: 0, errors: 0, f: new Map() }
      by.set(screen, a)
    }
    a.calls++
    a.cost += c.cost
    a.tokens += c.tokens
    if (!c.ok) a.errors++
    const f = a.f.get(c.feature) ?? { calls: 0, cost: 0 }
    f.calls++
    f.cost += c.cost
    a.f.set(c.feature, f)
  }
  return [...by.entries()]
    .map(([screen, a]) => ({
      screen,
      calls: a.calls,
      cost: Math.round(a.cost * 10_000) / 10_000,
      tokens: a.tokens,
      errors: a.errors,
      features: [...a.f.entries()]
        .map(([feature, x]) => ({
          feature,
          calls: x.calls,
          cost: Math.round(x.cost * 10_000) / 10_000
        }))
        .sort((x, y) => y.cost - x.cost || y.calls - x.calls)
        .slice(0, 3)
    }))
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls || a.screen.localeCompare(b.screen))
    .slice(0, limit)
}
