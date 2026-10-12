import { createHash } from 'node:crypto'
import type { Socket } from 'socket.io'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { normalizeWidgetFilters } from './dashboard-widgets.js'
import { collectionChangeOf, onJournalEntry } from './journal-listeners.js'
import { can } from './permissions.js'
import type { DateRange, EntityFilter, WidgetQueryConfig } from './report-studio.js'
import { inSocketTenant } from './socket-tenant.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Pushed dashboard and report widgets (#1675).
 *
 * A widget on screen asks to be watched over its socket (`widgets:watch`). The server notes the
 * collections it reads; when a write on one of them arrives (from this replica or, over the
 * Redis event stream, from any other) the widget is recomputed — at most once every 10 seconds
 * per widget — AS EACH WATCHING SOCKET'S OWN SIGN-IN (its user, role, row filters, User Scopes
 * and, for an API-key socket, the key's narrowing), and the new figure goes to that socket
 * alone (`widget:data`). One person's result is never another's: there is no shared room, and
 * two sign-ins of the same person (a session and an API key) are computed apart.
 *
 * The gate is the data route's own, re-run on every recompute: the dashboard or report must
 * still be readable (owner, shared, role, admin) and — stricter than the classic dashboard
 * route — the socket must be able to read every collection the widget reads. A watch that
 * stops passing is dropped with `widget:unwatched` and the client goes back to polling.
 *
 * Not watched (they keep their poll): raw-SQL query widgets, AI insight and narrative text,
 * calc formulas over sibling widgets, metric-catalog widgets and queue stats. Recomputes are capped per process (WIDGET_LIVE_MAX_PER_MIN, default 300
 * a minute, three at a time); a widget over the budget waits for the next minute.
 *
 * Watches live in this process with the socket. The client re-sends its watch list every
 * minute (and after a reconnect), and a watch not renewed for 150 seconds lapses.
 */

export type WidgetKind = 'dashboard' | 'report'

export interface WatchSpec {
  key: string
  kind: WidgetKind
  widget: string
  report?: string | null
  params?: Record<string, unknown> | null
}

export const DEBOUNCE_MS = 10_000
const FIRST_DELAY_MS = 1_000
const WATCH_TTL_MS = 150_000
const MAX_PER_SOCKET = 60
const MAX_PER_PAYLOAD = 30
const MAX_WATCHES = 5_000
const MAX_PARAMS_CHARS = 4_000
const MAX_DATA_CHARS = 256_000
const CONCURRENCY = 3

const KEY_RE = /^[A-Za-z0-9_-]{4,64}$/
const ID_RE = /^[0-9A-Za-z_-]{1,64}$/

/** Dashboard widget types computed live (all of them read as the viewer). */
const DASHBOARD_LIVE = new Set([
  'count',
  'sum',
  'avg',
  'latest',
  'bar_chart',
  'line_chart',
  'saved_view'
])
/** Report widget types that keep polling: raw SQL, AI text, sibling formulas, catalogs, queues. */
const REPORT_NOT_LIVE = new Set([
  'divider',
  'query',
  'ai_insight',
  'narrative',
  'calc',
  'metric',
  'queue'
])

function maxPerMinute(): number {
  const n = Number(process.env.WIDGET_LIVE_MAX_PER_MIN)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300
}

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

function parseJson<T>(raw: unknown): T | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// ── Gate + compute (dependencies injectable for tests) ──────────────────────

export interface DashboardWidgetRow {
  id: string
  dashboard: string
  type: string
  collection: string | null
  field: string | null
  filters: string | null
}
export interface DashboardRow {
  id: string
  user: string | null
  is_shared: boolean | number
}
export interface ReportWidgetRow {
  id: string
  report: string
  type: string
  collection: string | null
  config: string | null
}
export interface ReportRow {
  id: string
  owner: string
  is_shared: boolean | number
  role_id: string | null
  global_filters: string | null
}

export interface WidgetLiveDeps {
  isAdmin(user: User): Promise<boolean>
  canRead(user: User, collection: string): Promise<boolean>
  dashboardWidget(
    id: string
  ): Promise<{ widget: DashboardWidgetRow; dashboard: DashboardRow | null } | null>
  savedViewCollection(viewId: string): Promise<string | null>
  reportWidget(
    reportId: string,
    widgetId: string
  ): Promise<{ widget: ReportWidgetRow; report: ReportRow } | null>
  computeDashboard(
    widget: DashboardWidgetRow,
    extraFilters: ReturnType<typeof normalizeWidgetFilters>,
    user: User
  ): Promise<{ data: unknown } | { error: string; status: number }>
  computeReport(
    user: User,
    reportId: string,
    widget: {
      id: string
      type: string
      collection: string | null
      config: WidgetQueryConfig | null
    },
    dateRange: DateRange | null,
    entityFilters: EntityFilter[]
  ): Promise<unknown>
}

export const defaultDeps: WidgetLiveDeps = {
  async isAdmin(user) {
    if (!user.role) return false
    const role = await db('nivaro_roles').where({ id: user.role }).first('admin_access')
    return !!role?.admin_access
  },
  async canRead(user, collection) {
    return can(user, 'read', collection).catch(() => false)
  },
  async dashboardWidget(id) {
    const widget = (await db('nivaro_dashboard_widgets').where({ id }).first()) as
      | DashboardWidgetRow
      | undefined
    if (!widget) return null
    const dashboard = (await db('nivaro_dashboards').where({ id: widget.dashboard }).first()) as
      | DashboardRow
      | undefined
    return { widget, dashboard: dashboard ?? null }
  },
  async savedViewCollection(viewId) {
    const n = Number(viewId)
    if (!Number.isInteger(n)) return null
    const row = (await db('nivaro_saved_views').where({ id: n }).first('collection')) as
      | { collection: string }
      | undefined
    return row?.collection ?? null
  },
  async reportWidget(reportId, widgetId) {
    const report = (await db('nivaro_report_defs').where({ id: reportId }).first()) as
      | ReportRow
      | undefined
    if (!report) return null
    const widget = (await db('nivaro_report_widgets')
      .where({ id: widgetId, report: reportId })
      .first()) as ReportWidgetRow | undefined
    return widget ? { widget, report } : null
  },
  async computeDashboard(widget, extraFilters, user) {
    const { computeWidgetData } = await import('./dashboard-widgets.js')
    return computeWidgetData(widget, extraFilters, { user })
  },
  async computeReport(user, reportId, widget, dateRange, entityFilters) {
    const { resolveWidgetDataFull } = await import('./report-studio.js')
    return resolveWidgetDataFull(user, reportId, widget, dateRange, entityFilters)
  }
}

export type GateResult =
  | { ok: true; collections: string[]; compute: () => Promise<ComputeResult> }
  | { ok: false; reason: string }

export type ComputeResult = { ok: true; data: unknown } | { ok: false; reason: string }

/**
 * May `user` watch this widget, and what does it read? Re-run before every recompute, so a
 * dashboard unshared, a role changed or a collection permission revoked ends the push.
 */
export async function gateWatch(
  user: User,
  spec: Pick<WatchSpec, 'kind' | 'widget' | 'report' | 'params'>,
  deps: WidgetLiveDeps = defaultDeps
): Promise<GateResult> {
  const params = spec.params ?? {}
  if (spec.kind === 'dashboard') {
    const found = await deps.dashboardWidget(spec.widget)
    if (!found?.dashboard) return { ok: false, reason: 'not-found' }
    const { widget, dashboard } = found
    const shared = dashboard.is_shared === true || dashboard.is_shared === 1
    if (!shared && !sameId(dashboard.user, user.id) && !(await deps.isAdmin(user)))
      return { ok: false, reason: 'forbidden' }
    if (!DASHBOARD_LIVE.has(widget.type)) return { ok: false, reason: 'not-live' }
    const collection =
      widget.type === 'saved_view'
        ? widget.field
          ? await deps.savedViewCollection(widget.field)
          : null
        : widget.collection
    if (!collection) return { ok: false, reason: 'not-live' }
    if (!(await deps.canRead(user, collection))) return { ok: false, reason: 'forbidden' }
    const extra = normalizeWidgetFilters(params.extra_filters ?? null)
    return {
      ok: true,
      collections: [collection],
      compute: async () => {
        const r = await deps.computeDashboard(widget, extra, user)
        return 'error' in r ? { ok: false, reason: 'error' } : { ok: true, data: r.data }
      }
    }
  }

  if (!spec.report) return { ok: false, reason: 'not-found' }
  const found = await deps.reportWidget(spec.report, spec.widget)
  if (!found) return { ok: false, reason: 'not-found' }
  const { widget, report } = found
  const shared = report.is_shared === true || report.is_shared === 1
  const readable =
    sameId(report.owner, user.id) ||
    (shared && (!report.role_id || sameId(report.role_id, user.role))) ||
    (await deps.isAdmin(user))
  if (!readable) return { ok: false, reason: 'forbidden' }
  if (REPORT_NOT_LIVE.has(widget.type)) return { ok: false, reason: 'not-live' }
  const config = parseJson<WidgetQueryConfig>(widget.config)
  const collections =
    widget.type === 'kpi_group'
      ? [
          ...new Set(
            ((config as { metrics?: Array<{ collection?: unknown }> } | null)?.metrics ?? [])
              .slice(0, 6)
              .map((m) => (typeof m?.collection === 'string' ? m.collection : ''))
              .filter(Boolean)
          )
        ]
      : widget.collection
        ? [widget.collection]
        : []
  if (collections.length === 0) return { ok: false, reason: 'not-live' }
  for (const c of collections) {
    if (!(await deps.canRead(user, c))) return { ok: false, reason: 'forbidden' }
  }
  const dateRange =
    (params.date_range as DateRange | null | undefined) ??
    parseJson<{ date_range?: DateRange }>(report.global_filters)?.date_range ??
    null
  const entityFilters = Array.isArray(params.entity_filters)
    ? (params.entity_filters as EntityFilter[])
    : []
  return {
    ok: true,
    collections,
    compute: async () => {
      try {
        const data = await deps.computeReport(
          user,
          report.id,
          { id: widget.id, type: widget.type, collection: widget.collection, config },
          dateRange,
          entityFilters
        )
        return { ok: true, data }
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        return { ok: false, reason: status === 403 ? 'forbidden' : 'error' }
      }
    }
  }
}

/** Validate one watch request; null = refused as malformed. */
export function cleanSpec(raw: unknown): WatchSpec | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.key !== 'string' || !KEY_RE.test(r.key)) return null
  if (r.kind !== 'dashboard' && r.kind !== 'report') return null
  if (typeof r.widget !== 'string' || !ID_RE.test(r.widget)) return null
  if (r.kind === 'report' && (typeof r.report !== 'string' || !ID_RE.test(r.report))) return null
  let params: Record<string, unknown> | null = null
  if (r.params != null) {
    if (typeof r.params !== 'object' || Array.isArray(r.params)) return null
    let text = ''
    try {
      text = JSON.stringify(r.params)
    } catch {
      return null
    }
    if (text.length > MAX_PARAMS_CHARS) return null
    params = r.params as Record<string, unknown>
  }
  return {
    key: r.key,
    kind: r.kind,
    widget: r.widget,
    report: r.kind === 'report' ? (r.report as string) : null,
    params
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

interface Watch {
  key: string
  socketId: string
  tenant: string
  spec: WatchSpec
  paramsHash: string
  collections: Set<string>
  expiresAt: number
  lastHash: string | null
  /** Recompute pending for this watch (the group fired while the budget was spent). */
  dirty: boolean
  user: () => User | null
  identity: () => string
  emit: (event: string, payload: unknown) => void
  /** Run inside the socket's tenant context (cloud); a pass-through self-hosted. */
  run: (fn: () => Promise<void>) => Promise<void>
  deps: WidgetLiveDeps
}

interface Group {
  id: string
  tenant: string
  watches: Set<Watch>
  timer: ReturnType<typeof setTimeout> | null
  lastRun: number
}

const bySocket = new Map<string, Map<string, Watch>>()
const groups = new Map<string, Group>()
let watchCount = 0
let unlisten: (() => void) | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null

const budget = { windowStart: 0, used: 0 }
let running = 0
const waiting: Array<() => void> = []

const stats = {
  recomputes: 0,
  pushes: 0,
  unchanged: 0,
  deferred: 0,
  dropped: 0,
  errors: 0
}

function groupId(tenant: string, spec: WatchSpec): string {
  return `${tenant}|${spec.kind}|${spec.report ?? ''}|${spec.widget}`
}

function hashOf(v: unknown): string {
  let text = ''
  try {
    text = JSON.stringify(v ?? null)
  } catch {
    text = String(Math.random())
  }
  return createHash('sha1').update(text).digest('hex')
}

function ensureListening(): void {
  if (unlisten) return
  unlisten = onJournalEntry((entry) => {
    const change = collectionChangeOf(entry)
    if (change) noteCollectionChange(change.tenant, change.collection)
  })
  sweepTimer = setInterval(sweepExpired, 30_000)
  sweepTimer.unref?.()
}

/** A write on `collection` landed: arm every group that reads it. */
export function noteCollectionChange(tenant: string, collection: string): void {
  for (const g of groups.values()) {
    if (g.tenant !== tenant) continue
    let reads = false
    for (const w of g.watches) {
      if (w.collections.has(collection)) {
        reads = true
        break
      }
    }
    if (!reads) continue
    for (const w of g.watches) w.dirty = true
    schedule(g)
  }
}

function schedule(g: Group, at?: number): void {
  if (g.timer) return
  const now = Date.now()
  const due = at ?? Math.max(now + FIRST_DELAY_MS, g.lastRun + DEBOUNCE_MS)
  g.timer = setTimeout(
    () => {
      g.timer = null
      void runGroup(g)
    },
    Math.max(0, due - now)
  )
  g.timer.unref?.()
}

function takeBudget(): boolean {
  const now = Date.now()
  if (now - budget.windowStart >= 60_000) {
    budget.windowStart = now
    budget.used = 0
  }
  if (budget.used >= maxPerMinute()) return false
  budget.used++
  return true
}

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

async function runGroup(g: Group): Promise<void> {
  g.lastRun = Date.now()
  // Same sign-in + same parameters = one compute (two panels of one tab, say). Never shared
  // across sign-ins: the identity names the user AND what signed them in.
  const memo = new Map<string, Promise<ComputeResult>>()
  for (const w of [...g.watches]) {
    if (!w.dirty) continue
    if (w.expiresAt < Date.now()) {
      removeWatch(w)
      continue
    }
    const user = w.user()
    if (!user) {
      removeWatch(w)
      continue
    }
    const memoKey = `${w.identity()}|${w.paramsHash}`
    let pending = memo.get(memoKey)
    if (!pending) {
      if (!takeBudget()) {
        stats.deferred++
        // Over the per-process budget: this watch (and the rest) wait for the next window.
        schedule(g, budget.windowStart + 60_000)
        return
      }
      pending = new Promise<ComputeResult>((resolve) => {
        void w
          .run(() =>
            slot(async () => {
              try {
                stats.recomputes++
                const gate = await gateWatch(user, w.spec, w.deps)
                if (!gate.ok) return resolve({ ok: false, reason: gate.reason })
                resolve(await gate.compute())
              } catch {
                resolve({ ok: false, reason: 'error' })
              }
            })
          )
          .then(() => resolve({ ok: false, reason: 'error' }))
      })
      memo.set(memoKey, pending)
    }
    // Cleared before the result is awaited: a write landing meanwhile marks the watch again.
    w.dirty = false
    const result = await pending
    if (!result.ok) {
      if (result.reason === 'error') {
        stats.errors++
        continue // a failed compute keeps the watch; the next write tries again
      }
      stats.dropped++
      w.emit('widget:unwatched', { key: w.key, reason: result.reason })
      removeWatch(w)
      continue
    }
    const h = hashOf(result.data)
    if (h === w.lastHash) {
      stats.unchanged++
      continue
    }
    w.lastHash = h
    let size = 0
    try {
      size = JSON.stringify(result.data ?? null).length
    } catch {
      size = MAX_DATA_CHARS + 1
    }
    stats.pushes++
    if (size > MAX_DATA_CHARS) w.emit('widget:stale', { key: w.key })
    else w.emit('widget:data', { key: w.key, widget: w.spec.widget, data: result.data })
  }
}

function addWatch(w: Watch): void {
  let mine = bySocket.get(w.socketId)
  if (!mine) {
    mine = new Map()
    bySocket.set(w.socketId, mine)
  }
  const prev = mine.get(w.key)
  if (prev) removeWatch(prev)
  mine.set(w.key, w)
  const id = groupId(w.tenant, w.spec)
  let g = groups.get(id)
  if (!g) {
    g = { id, tenant: w.tenant, watches: new Set(), timer: null, lastRun: 0 }
    groups.set(id, g)
  }
  g.watches.add(w)
  watchCount++
}

function removeWatch(w: Watch): void {
  const mine = bySocket.get(w.socketId)
  if (mine?.get(w.key) !== w) return
  mine.delete(w.key)
  if (mine.size === 0) bySocket.delete(w.socketId)
  watchCount--
  const id = groupId(w.tenant, w.spec)
  const g = groups.get(id)
  if (!g) return
  g.watches.delete(w)
  if (g.watches.size === 0) {
    if (g.timer) clearTimeout(g.timer)
    groups.delete(id)
  }
}

function sweepExpired(): void {
  const now = Date.now()
  for (const mine of [...bySocket.values()])
    for (const w of [...mine.values()]) if (w.expiresAt < now) removeWatch(w)
}

export function dropSocketWatches(socketId: string): void {
  const mine = bySocket.get(socketId)
  if (!mine) return
  for (const w of [...mine.values()]) removeWatch(w)
}

export interface WatchSocket {
  id: string
  data?: Record<string, unknown>
  emit(event: string, payload: unknown): unknown
}

/**
 * Register (or renew) a socket's watches. Returns what was accepted and what was refused, with
 * why — `not-live` means "keep polling", the rest mean the widget is not this socket's to see.
 */
export async function watchWidgets(
  socket: WatchSocket,
  getUser: () => User | null,
  raw: unknown,
  opts: { run?: Watch['run']; tenant?: string; deps?: WidgetLiveDeps } = {}
): Promise<{ accepted: string[]; refused: Array<{ key: string; reason: string }> }> {
  const list = Array.isArray((raw as { watches?: unknown })?.watches)
    ? ((raw as { watches: unknown[] }).watches as unknown[]).slice(0, MAX_PER_PAYLOAD)
    : []
  const accepted: string[] = []
  const refused: Array<{ key: string; reason: string }> = []
  const user = getUser()
  const tenant = opts.tenant ?? currentTenantKey()
  const run = opts.run ?? ((fn) => fn())
  const identity = () => {
    const u = getUser()
    let bind = ''
    try {
      bind = JSON.stringify(socket.data?.nvrBind ?? null)
    } catch {
      bind = ''
    }
    return `${u?.id ?? ''}|${bind}`
  }
  for (const item of list) {
    const spec = cleanSpec(item)
    const key = (item as { key?: unknown })?.key
    if (!spec) {
      if (typeof key === 'string' && KEY_RE.test(key)) refused.push({ key, reason: 'invalid' })
      continue
    }
    if (!user) {
      refused.push({ key: spec.key, reason: 'not-signed-in' })
      continue
    }
    const mine = bySocket.get(socket.id)
    const existing = mine?.get(spec.key)
    const paramsHash = hashOf(spec.params ?? null)
    if (
      existing &&
      existing.paramsHash === paramsHash &&
      existing.spec.widget === spec.widget &&
      existing.spec.kind === spec.kind &&
      existing.spec.report === spec.report
    ) {
      // A renewal: keep the last pushed hash, extend the lease. Access is re-judged on every
      // recompute, so a renewal does not need to run the gate again.
      existing.expiresAt = Date.now() + WATCH_TTL_MS
      accepted.push(spec.key)
      continue
    }
    if (!existing && ((mine?.size ?? 0) >= MAX_PER_SOCKET || watchCount >= MAX_WATCHES)) {
      refused.push({ key: spec.key, reason: 'busy' })
      continue
    }
    let gate: GateResult
    try {
      gate = await gateWatch(user, spec, opts.deps)
    } catch {
      gate = { ok: false, reason: 'error' }
    }
    if (!gate.ok) {
      if (existing) removeWatch(existing)
      refused.push({ key: spec.key, reason: gate.reason })
      continue
    }
    ensureListening()
    addWatch({
      key: spec.key,
      socketId: socket.id,
      tenant,
      spec,
      paramsHash,
      collections: new Set(gate.collections),
      expiresAt: Date.now() + WATCH_TTL_MS,
      lastHash: null,
      dirty: false,
      user: getUser,
      identity,
      emit: (event, payload) => {
        try {
          socket.emit(event, payload)
        } catch {
          /* the socket went away; the disconnect drops its watches */
        }
      },
      run,
      deps: opts.deps ?? defaultDeps
    })
    accepted.push(spec.key)
  }
  return { accepted, refused }
}

export function unwatchWidgets(socketId: string, raw: unknown): void {
  const keys = (raw as { keys?: unknown })?.keys
  const mine = bySocket.get(socketId)
  if (!mine) return
  if (!Array.isArray(keys)) {
    dropSocketWatches(socketId)
    return
  }
  for (const k of keys.slice(0, MAX_PER_SOCKET)) {
    const w = typeof k === 'string' ? mine.get(k) : undefined
    if (w) removeWatch(w)
  }
}

/** Wire `widgets:watch` / `widgets:unwatch` onto one connection (plugins/socketio.ts). */
export function registerWidgetLive(socket: Socket, getUser: () => User | null): void {
  socket.on(
    'widgets:watch',
    inSocketTenant(socket, async (payload: unknown) => {
      const res = await watchWidgets(socket, getUser, payload, {
        // Recomputes run later, outside this handler: carry the socket's tenant context.
        run: (fn) => inSocketTenant(socket, fn)()
      })
      socket.emit('widget:watching', res)
    })
  )
  socket.on('widgets:unwatch', (payload: unknown) => unwatchWidgets(socket.id, payload))
  socket.on('disconnect', () => dropSocketWatches(socket.id))
}

export function widgetLiveStats() {
  return {
    ...stats,
    watches: watchCount,
    widgets: groups.size,
    sockets: bySocket.size,
    budget_per_minute: maxPerMinute(),
    budget_used: budget.used
  }
}

/** Tests only. */
export function __resetWidgetLive(): void {
  for (const g of groups.values()) if (g.timer) clearTimeout(g.timer)
  groups.clear()
  bySocket.clear()
  watchCount = 0
  unlisten?.()
  unlisten = null
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  budget.windowStart = 0
  budget.used = 0
  for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] = 0
}
