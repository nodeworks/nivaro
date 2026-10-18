// api/src/services/traffic-taps/realtime-nodes.ts
/**
 * Traffic Map tap `realtime-nodes` — three kinds of request that deserve a node of their own
 * instead of hiding inside "Other":
 *   #2269 Media: help-video streams (viewers) and session-replay uploads (uploaders) as a
 *         downstream node with bandwidth, people active in the last minute and failures;
 *   #2270 Search: omnisearch, the cross-collection / semantic / config searches and the
 *         collection browser's search box as a node with database time and the slowest queries;
 *   #2211 MCP: AI assistants calling through the MCP server as a source node, with the tools
 *         they use, the API keys they sign in with and their errors. The MCP package stamps
 *         `x-nivaro-app: mcp` and `x-nivaro-mcp-tool: <tool>` on every call it makes.
 *
 * Classified from the finished request (the same onRequest seam every tap uses); memory only,
 * bounded, no database work on the request path. Self-hosted only, like the topology taps.
 */

import { requestMeasure } from '../request-trace.js'
import { normalizePath } from '../traffic-entities.js'
import { noteDown, noteSource } from '../traffic-map.js'
import { registerTrafficTap, type TapRequestCtx, tapState } from '../traffic-taps.js'
import { boundedGet, MinuteSlots } from './minute-slots.js'

export const REALTIME_NODES_TAP = 'realtime-nodes'
export const MEDIA_NODE = 'media'
export const SEARCH_NODE = 'search'
export const MCP_SOURCE = 'mcp:clients'
const cloud = (): boolean => !!process.env.CLOUD_META_DB_URL

// ── classification (pure) ────────────────────────────────────────────────────
export type MediaKind = 'video' | 'replay'
const VIDEO_RE = /^\/api\/help-videos\/[^/]+\/stream$/
const REPLAY_RE = /^\/api\/session-recordings\/[^/]+\/events$/

/** Which media traffic a request is, or null. Video = a viewer pulling a stream. */
export function mediaKindOf(method: string, path: string): MediaKind | null {
  const p = normalizePath(path)
  const m = method.toUpperCase()
  if (m === 'GET' && VIDEO_RE.test(p)) return 'video'
  if (m === 'POST' && REPLAY_RE.test(p)) return 'replay'
  return null
}

export type SearchKind = 'omnisearch' | 'records' | 'semantic' | 'config' | 'browser'
export const SEARCH_LABEL: Record<SearchKind, string> = {
  omnisearch: 'Omnisearch',
  records: 'Cross-collection search',
  semantic: 'Meaning search',
  config: 'Settings search',
  browser: 'Collection browser search'
}

/** Which search a request is, or null. `search` = the request's `?search=` value, if any. */
export function searchKindOf(method: string, path: string, search?: unknown): SearchKind | null {
  const p = normalizePath(path)
  const m = method.toUpperCase()
  if (m === 'GET' && p === '/api/global-search') return 'omnisearch'
  if (m === 'GET' && p === '/api/search') return 'records'
  if (m === 'POST' && p === '/api/search/semantic') return 'semantic'
  if (m === 'GET' && p === '/api/config-search') return 'config'
  if (
    m === 'GET' &&
    /^\/api\/items\/[a-z0-9_]+$/i.test(p) &&
    typeof search === 'string' &&
    search.trim() !== ''
  )
    return 'browser'
  return null
}

const TOOL_RE = /^[a-z][a-z0-9_]{0,39}$/
/** The MCP tool a call came through, from the untrusted header; `unknown` when absent / odd. */
export function mcpToolOf(header: unknown): string {
  const v = String(Array.isArray(header) ? header[0] : (header ?? '')).toLowerCase()
  return TOOL_RE.test(v) ? v : 'unknown'
}

const headerOf = (req: unknown, name: string): unknown =>
  (req as { headers?: Record<string, unknown> } | null | undefined)?.headers?.[name]

// ── state ────────────────────────────────────────────────────────────────────
// media slots: requests, bytes, failed, ms
const M = { n: 0, bytes: 1, failed: 2, ms: 3 } as const
// search slots: requests, db ms, total ms, failed
const S = { n: 0, db: 1, ms: 2, failed: 3 } as const
// mcp slots: calls, errors
const C = { n: 0, err: 1 } as const

export interface SlowSearch {
  at: number
  kind: SearchKind
  route: string
  ms: number
  db_ms: number
  stmt_ms: number | null
  sql: string | null
  caller: string
  status: number
}
export interface McpError {
  at: number
  tool: string
  status: number
  code: string | null
  caller: string
}
interface State {
  media: Record<MediaKind, MinuteSlots>
  /** caller → last request ms, per media kind (people active in the last minute). */
  active: Record<MediaKind, Map<string, number>>
  search: Map<SearchKind, MinuteSlots>
  slow: SlowSearch[]
  mcpTools: Map<string, MinuteSlots>
  mcpKeys: Map<string, MinuteSlots>
  mcpCodes: Map<string, MinuteSlots>
  mcpErrors: McpError[]
  mcpAll: MinuteSlots
  mcpLast: number
}
const state = (): State =>
  tapState<State>(REALTIME_NODES_TAP, () => ({
    media: { video: new MinuteSlots(4), replay: new MinuteSlots(4) },
    active: { video: new Map(), replay: new Map() },
    search: new Map(),
    slow: [],
    mcpTools: new Map(),
    mcpKeys: new Map(),
    mcpCodes: new Map(),
    mcpErrors: [],
    mcpAll: new MinuteSlots(2),
    mcpLast: 0
  }))

const ACTIVE_MS = 60_000
const ACTIVE_CAP = 1000
const SLOW_KEEP = 10
const SLOW_TTL_MS = 3600_000
const MCP_TOOL_CAP = 60
const MCP_KEY_CAP = 100
const MCP_CODE_CAP = 30
const MCP_ERRORS_KEEP = 10

function pruneActive(m: Map<string, number>, now: number): void {
  for (const [k, t] of m) if (now - t > ACTIVE_MS) m.delete(k)
}

/** Declared body / response size in bytes, from a content-length header; 0 when absent. */
export function declaredBytes(v: unknown): number {
  const n = Number(Array.isArray(v) ? v[0] : v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Keep the slowest `keep` searches of the last hour, newest data wins ties. Pure on the array. */
export function keepSlowest(list: SlowSearch[], add: SlowSearch, now: number): SlowSearch[] {
  const next = list.filter((s) => now - s.at <= SLOW_TTL_MS)
  next.push(add)
  next.sort((a, b) => b.db_ms - a.db_ms || b.at - a.at)
  return next.slice(0, SLOW_KEEP)
}

function onMedia(c: TapRequestCtx, kind: MediaKind): void {
  const s = state()
  const now = c.ev.at
  const reply = c.ev.reply as { getHeader?: (n: string) => unknown } | undefined
  const bytes =
    kind === 'video'
      ? declaredBytes(reply?.getHeader?.('content-length'))
      : declaredBytes(headerOf(c.ev.req, 'content-length'))
  const failed = c.ev.status >= 400
  const slots = s.media[kind]
  slots.add(c.sec, M.n, 1)
  if (bytes) slots.add(c.sec, M.bytes, bytes)
  if (failed) slots.add(c.sec, M.failed, 1)
  slots.add(c.sec, M.ms, Math.max(0, c.ev.latencyMs))
  const active = s.active[kind]
  if (active.size >= ACTIVE_CAP) pruneActive(active, now)
  if (active.size < ACTIVE_CAP || active.has(c.caller)) active.set(c.caller, now)
  noteDown({
    id: MEDIA_NODE,
    label: 'Media',
    kind: 'media',
    ok: !failed,
    ms: c.ev.latencyMs,
    at: now,
    entityKey: c.entityKey
  })
}

function onSearch(c: TapRequestCtx, kind: SearchKind): void {
  const s = state()
  const slots = boundedGet(s.search, kind, 10, () => new MinuteSlots(4))
  const measure = requestMeasure(c.ev.req)
  const dbMs = measure?.sqlMs ?? 0
  const failed = c.ev.status >= 400
  if (slots) {
    slots.add(c.sec, S.n, 1)
    slots.add(c.sec, S.db, dbMs)
    slots.add(c.sec, S.ms, Math.max(0, c.ev.latencyMs))
    if (failed) slots.add(c.sec, S.failed, 1)
  }
  s.slow = keepSlowest(
    s.slow,
    {
      at: c.ev.at,
      kind,
      route: c.route,
      ms: Math.round(c.ev.latencyMs),
      db_ms: Math.round(dbMs),
      stmt_ms: measure?.maxStatementMs != null ? Math.round(measure.maxStatementMs) : null,
      sql: measure?.maxStatementSql ? measure.maxStatementSql.slice(0, 240) : null,
      caller: c.caller,
      status: c.ev.status
    },
    c.ev.at
  )
  noteDown({
    id: SEARCH_NODE,
    label: 'Search',
    kind: 'search',
    ok: !failed,
    // The node's latency is what searching costs the database, not the whole request.
    ms: dbMs > 0 ? dbMs : c.ev.latencyMs,
    at: c.ev.at,
    entityKey: c.entityKey
  })
}

function onMcp(c: TapRequestCtx): void {
  const s = state()
  const tool = mcpToolOf(headerOf(c.ev.req, 'x-nivaro-mcp-tool'))
  const failed = c.isError
  const bump = (m: Map<string, MinuteSlots>, key: string, cap: number) => {
    const sl = boundedGet(m, key, cap, () => new MinuteSlots(2))
    if (!sl) return
    sl.add(c.sec, C.n, 1)
    if (failed) sl.add(c.sec, C.err, 1)
  }
  bump(s.mcpTools, tool, MCP_TOOL_CAP)
  bump(s.mcpKeys, c.caller, MCP_KEY_CAP)
  s.mcpAll.add(c.sec, C.n, 1)
  if (failed) {
    s.mcpAll.add(c.sec, C.err, 1)
    bump(s.mcpCodes, c.code ?? `http-${c.ev.status}`, MCP_CODE_CAP)
    s.mcpErrors.push({
      at: c.ev.at,
      tool,
      status: c.ev.status,
      code: c.code,
      caller: c.caller
    })
    if (s.mcpErrors.length > MCP_ERRORS_KEEP) s.mcpErrors.shift()
  }
  s.mcpLast = c.ev.at
  noteSource({
    id: MCP_SOURCE,
    label: 'AI assistants (MCP)',
    kind: 'mcp',
    at: c.ev.at,
    entityKey: c.entityKey,
    ok: !failed
  })
}

registerTrafficTap({
  id: REALTIME_NODES_TAP,
  onRequest(c) {
    if (cloud()) return
    const req = c.ev.req
    // Cheap exits first: header read, then two regexes.
    if (String(headerOf(req, 'x-nivaro-app') ?? '').toLowerCase() === 'mcp') onMcp(c)
    const media = mediaKindOf(c.ev.method, c.ev.path)
    if (media) onMedia(c, media)
    const search = searchKindOf(
      c.ev.method,
      c.ev.path,
      (req as { query?: Record<string, unknown> } | null | undefined)?.query?.search
    )
    if (search) onSearch(c, search)
  },
  // Rides the topology poll so the canvas can badge the nodes without extra requests.
  snapshot(windowS, sec) {
    if (cloud()) return undefined
    const m = mediaFigures(windowS, sec)
    const q = searchFigures(windowS, sec)
    const mcp = mcpFigures(windowS, sec)
    const out: Record<string, unknown> = {}
    if (m.video.requests || m.replay.requests) {
      out.media = {
        failed: m.video.failed + m.replay.failed,
        active: m.video.active + m.replay.active
      }
    }
    if (q.total.requests) out.search = { requests: q.total.requests, avg_db_ms: q.total.avg_db_ms }
    if (mcp.calls) out.mcp = { calls: mcp.calls, errors: mcp.errors }
    return Object.keys(out).length ? out : undefined
  }
})

// ── figures ──────────────────────────────────────────────────────────────────
export interface MediaFigures {
  window_s: number
  video: MediaRow
  replay: MediaRow
}
export interface MediaRow {
  requests: number
  bytes: number
  failed: number
  /** Average request time, ms. */
  avg_ms: number | null
  /** People who made a request in the last minute (viewers / uploaders). */
  active: number
}

export function mediaFigures(windowS: number, sec: number, now = Date.now()): MediaFigures {
  const s = state()
  const row = (k: MediaKind): MediaRow => {
    const v = s.media[k].sum(windowS, sec)
    pruneActive(s.active[k], now)
    return {
      requests: v[M.n],
      bytes: v[M.bytes],
      failed: v[M.failed],
      avg_ms: v[M.n] ? v[M.ms] / v[M.n] : null,
      active: s.active[k].size
    }
  }
  return { window_s: windowS, video: row('video'), replay: row('replay') }
}

export interface SearchRow {
  kind: SearchKind
  label: string
  requests: number
  failed: number
  db_ms: number
  avg_db_ms: number | null
  avg_ms: number | null
}
export interface SearchFigures {
  window_s: number
  total: { requests: number; failed: number; db_ms: number; avg_db_ms: number | null }
  by_kind: SearchRow[]
  slowest: Array<{
    at: string
    kind: SearchKind
    label: string
    route: string
    ms: number
    db_ms: number
    stmt_ms: number | null
    sql: string | null
    caller: string
    status: number
  }>
}

export function searchFigures(windowS: number, sec: number, now = Date.now()): SearchFigures {
  const s = state()
  const by_kind: SearchRow[] = []
  let requests = 0
  let failed = 0
  let dbMs = 0
  for (const [kind, slots] of s.search) {
    const v = slots.sum(windowS, sec)
    if (!v[S.n]) continue
    requests += v[S.n]
    failed += v[S.failed]
    dbMs += v[S.db]
    by_kind.push({
      kind,
      label: SEARCH_LABEL[kind],
      requests: v[S.n],
      failed: v[S.failed],
      db_ms: v[S.db],
      avg_db_ms: v[S.db] / v[S.n],
      avg_ms: v[S.ms] / v[S.n]
    })
  }
  by_kind.sort((a, b) => b.db_ms - a.db_ms)
  const cutoff = now - windowS * 1000
  return {
    window_s: windowS,
    total: { requests, failed, db_ms: dbMs, avg_db_ms: requests ? dbMs / requests : null },
    by_kind,
    slowest: s.slow
      .filter((x) => x.at >= Math.min(cutoff, now - 15 * 60_000))
      .map((x) => ({
        at: new Date(x.at).toISOString(),
        kind: x.kind,
        label: SEARCH_LABEL[x.kind],
        route: x.route,
        ms: x.ms,
        db_ms: x.db_ms,
        stmt_ms: x.stmt_ms,
        sql: x.sql,
        caller: x.caller,
        status: x.status
      }))
  }
}

export interface McpFigures {
  window_s: number
  calls: number
  errors: number
  last_at: string | null
  tools: Array<{ tool: string; calls: number; errors: number }>
  /** Caller keys (`k<apiKeyId>` / `u<userId>`); the route resolves key names. */
  keys: Array<{ caller: string; calls: number; errors: number }>
  codes: Array<{ code: string; n: number }>
  recent_errors: Array<{
    at: string
    tool: string
    status: number
    code: string | null
    caller: string
  }>
}

export function mcpFigures(windowS: number, sec: number): McpFigures {
  const s = state()
  const rows = (m: Map<string, MinuteSlots>) =>
    [...m.entries()]
      .map(([key, sl]) => {
        const v = sl.sum(windowS, sec)
        return { key, calls: v[C.n], errors: v[C.err] }
      })
      .filter((r) => r.calls > 0)
      .sort((a, b) => b.calls - a.calls)
  const all = s.mcpAll.sum(windowS, sec)
  return {
    window_s: windowS,
    calls: all[C.n],
    errors: all[C.err],
    last_at: s.mcpLast ? new Date(s.mcpLast).toISOString() : null,
    tools: rows(s.mcpTools).map((r) => ({ tool: r.key, calls: r.calls, errors: r.errors })),
    keys: rows(s.mcpKeys).map((r) => ({ caller: r.key, calls: r.calls, errors: r.errors })),
    codes: rows(s.mcpCodes).map((r) => ({ code: r.key, n: r.calls })),
    recent_errors: [...s.mcpErrors].reverse().map((e) => ({
      at: new Date(e.at).toISOString(),
      tool: e.tool,
      status: e.status,
      code: e.code,
      caller: e.caller
    }))
  }
}
