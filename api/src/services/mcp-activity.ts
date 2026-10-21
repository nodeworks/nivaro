import type { FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { hasChainColumns } from './chain-columns.js'
import { selectInChunks } from './db-batch.js'
import { deleteOne, updateOne } from './items.js'
import { CONN_RE, connectionLimit, hasMcpLogColumns, type McpSettings } from './mcp-calls.js'
import { idleDays, revokeOn } from './mcp-idle-review.js'
import { listAllGrants, listGrants, type OAuthGrant } from './oauth-store.js'

/**
 * What connected agents did (#2466 stats, #2498 "What my agents did"), read from the request
 * log's MCP columns (migration 480, services/mcp-calls.ts). The log keeps 14 days, so every
 * figure here is "the last 14 days". A database behind 480 answers empty with `logged: false`.
 */

export const WINDOW_DAYS = 14
const DAY = 86_400_000

export type ConnKind = 'oauth' | 'api_key' | 'token'
export const connKind = (conn: string): ConnKind =>
  conn.startsWith('o') ? 'oauth' : conn.startsWith('k') ? 'api_key' : 'token'

export interface ConnectionStats {
  calls: number
  errors: number
  refused: number
  bytes: number
  last_call_at: string | null
  /** Dense day axis, oldest first. */
  days: Array<{ day: string; calls: number; errors: number; refused: number }>
  top_tools: Array<{ tool: string; calls: number; errors: number; refused: number }>
}

export interface StatsRow {
  mcp_conn: string
  mcp_tool: string | null
  mcp_outcome: string | null
  day: string | Date
  n: number | string
  b: number | string | null
  last_at: string | Date | null
}

const isoDay = (d: string | Date) => new Date(d).toISOString().slice(0, 10)
const iso = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString() : null)

/** Grouped log rows → per-connection stats (pure). */
export function foldStats(
  rows: StatsRow[],
  now = Date.now(),
  windowDays = WINDOW_DAYS,
  topN = 8
): Map<string, ConnectionStats> {
  const acc = new Map<
    string,
    {
      s: ConnectionStats
      byDay: Map<string, { calls: number; errors: number; refused: number }>
      byTool: Map<string, { calls: number; errors: number; refused: number }>
    }
  >()
  for (const r of rows) {
    const conn = String(r.mcp_conn).toLowerCase()
    let a = acc.get(conn)
    if (!a) {
      a = {
        s: {
          calls: 0,
          errors: 0,
          refused: 0,
          bytes: 0,
          last_call_at: null,
          days: [],
          top_tools: []
        },
        byDay: new Map(),
        byTool: new Map()
      }
      acc.set(conn, a)
    }
    const n = Number(r.n) || 0
    const err = r.mcp_outcome === 'error' ? n : 0
    const ref = r.mcp_outcome === 'refused' ? n : 0
    a.s.calls += n
    a.s.errors += err
    a.s.refused += ref
    a.s.bytes += Number(r.b ?? 0) || 0
    const last = iso(r.last_at)
    if (last && (!a.s.last_call_at || last > a.s.last_call_at)) a.s.last_call_at = last
    const day = isoDay(r.day)
    const d = a.byDay.get(day) ?? { calls: 0, errors: 0, refused: 0 }
    d.calls += n
    d.errors += err
    d.refused += ref
    a.byDay.set(day, d)
    const tool = r.mcp_tool ?? 'unknown'
    const t = a.byTool.get(tool) ?? { calls: 0, errors: 0, refused: 0 }
    t.calls += n
    t.errors += err
    t.refused += ref
    a.byTool.set(tool, t)
  }
  const out = new Map<string, ConnectionStats>()
  for (const [conn, a] of acc) {
    for (let i = windowDays - 1; i >= 0; i--) {
      const day = new Date(now - i * DAY).toISOString().slice(0, 10)
      a.s.days.push({ day, ...(a.byDay.get(day) ?? { calls: 0, errors: 0, refused: 0 }) })
    }
    a.s.top_tools = [...a.byTool]
      .map(([tool, v]) => ({ tool, ...v }))
      .sort((x, y) => y.calls - x.calls || x.tool.localeCompare(y.tool))
      .slice(0, topN)
    out.set(conn, a.s)
  }
  return out
}

/** Tool-call stats per connection over the window, for one person or everyone. */
export async function readConnectionStats(
  opts: { userId?: string } = {}
): Promise<Map<string, ConnectionStats> | null> {
  if (!(await hasMcpLogColumns().catch(() => false))) return null
  const from = new Date(Date.now() - WINDOW_DAYS * DAY)
  const dayExpr = 'CAST(created_at AS date)'
  const q = db('nivaro_api_logs')
    .whereNotNull('mcp_conn')
    .whereNotNull('mcp_outcome')
    .where('created_at', '>=', from)
    .groupBy('mcp_conn', 'mcp_tool', 'mcp_outcome', db.raw(dayExpr))
    .select(
      'mcp_conn',
      'mcp_tool',
      'mcp_outcome',
      db.raw(`${dayExpr} as day`),
      db.raw('COUNT(*) as n'),
      db.raw('SUM(COALESCE(mcp_bytes, 0)) as b'),
      db.raw('MAX(created_at) as last_at')
    )
    .limit(50_000)
  if (opts.userId) q.where('user', opts.userId)
  return foldStats((await q) as StatsRow[])
}

export interface IdleInfo {
  idle_days: number
  flagged_at: string | null
  notice_at: string | null
  /** When it will be disconnected if it stays unused. */
  revoke_on: string
  status: 'active' | 'idle' | 'notice'
}

export interface ConnectionInfo {
  conn: string
  kind: ConnKind
  /** The app's registered name, the key's name, or "<person> token". */
  name: string
  user_id: string
  user_name?: string
  created_at: string | null
  last_used_at: string | null
  /** Tool-call limit a minute (0 = none) and whether it is this connection's own. */
  rate_limit_per_minute: number
  rate_limit_custom: boolean
  idle: IdleInfo | null
  stats: ConnectionStats | null
}

export function idleInfo(g: OAuthGrant, s: McpSettings, now = Date.now()): IdleInfo {
  const days = idleDays(g, now)
  return {
    idle_days: days,
    flagged_at: g.idle_flagged_at ?? null,
    notice_at: g.idle_notice_at ?? null,
    revoke_on: revokeOn(g, s),
    status: g.idle_notice_at ? 'notice' : days >= s.idle_flag_days ? 'idle' : 'active'
  }
}

interface KeyRow {
  id: number
  name: string
  user: string
  created_at?: Date | string | null
  last_used_at?: Date | string | null
}

async function keysById(ids: number[]): Promise<Map<number, KeyRow>> {
  const rows = ids.length
    ? await selectInChunks(ids, 1000, (chunk) =>
        Promise.resolve(
          db('nivaro_api_keys')
            .whereIn('id', chunk)
            .select('id', 'name', 'user', 'created_at', 'last_used_at') as unknown as Promise<
            KeyRow[]
          >
        )
      ).catch(() => [] as KeyRow[])
    : []
  return new Map(rows.map((r) => [Number(r.id), r]))
}

async function userNames(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.map((i) => i.toLowerCase()))]
  const rows = uniq.length
    ? ((await selectInChunks(uniq, 1000, (chunk) =>
        Promise.resolve(
          db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
        )
      ).catch(() => [])) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string | null
      }>)
    : []
  return new Map(
    rows.map((u) => [
      String(u.id).toLowerCase(),
      `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() ||
        (u.email ?? '').split('@')[0] ||
        'Someone'
    ])
  )
}

/**
 * Connections: every OAuth grant (with or without calls) plus every API key or token that made
 * MCP tool calls in the window. One person's (`userId`) or everyone's.
 */
export async function listConnections(
  redis: Redis,
  settings: McpSettings,
  opts: { userId?: string } = {}
): Promise<{ logged: boolean; connections: ConnectionInfo[] }> {
  const [grants, stats] = await Promise.all([
    opts.userId ? listGrants(redis, opts.userId) : listAllGrants(redis),
    readConnectionStats(opts)
  ])
  const now = Date.now()
  const out: ConnectionInfo[] = []
  const limitOf = (conn: string) => ({
    rate_limit_per_minute: connectionLimit(settings, conn),
    rate_limit_custom: settings.connection_limits[conn] !== undefined
  })
  for (const g of grants) {
    const conn = `o${g.id.toLowerCase()}`
    out.push({
      conn,
      kind: 'oauth',
      name: g.client_name,
      user_id: g.user_id,
      created_at: g.created_at,
      last_used_at: g.last_used_at,
      ...limitOf(conn),
      idle: idleInfo(g, settings, now),
      stats: stats?.get(conn) ?? null
    })
  }
  const seen = new Set(out.map((c) => c.conn))
  const others = [...(stats?.keys() ?? [])].filter((c) => !seen.has(c) && CONN_RE.test(c))
  const keys = await keysById(
    others.filter((c) => c.startsWith('k')).map((c) => Number(c.slice(1)))
  )
  const tokenUsers = others.filter((c) => c.startsWith('u')).map((c) => c.slice(1))
  for (const conn of others) {
    const st = stats?.get(conn) ?? null
    if (conn.startsWith('o')) {
      // A disconnected app's calls are still in the log for the window.
      out.push({
        conn,
        kind: 'oauth',
        name: 'Disconnected app',
        user_id: opts.userId ?? '',
        created_at: null,
        last_used_at: st?.last_call_at ?? null,
        ...limitOf(conn),
        idle: null,
        stats: st
      })
    } else if (conn.startsWith('k')) {
      const k = keys.get(Number(conn.slice(1)))
      if (opts.userId && k && String(k.user).toLowerCase() !== opts.userId.toLowerCase()) continue
      out.push({
        conn,
        kind: 'api_key',
        name: k?.name ?? `API key ${conn.slice(1)}`,
        user_id: k ? String(k.user) : (opts.userId ?? ''),
        created_at: iso(k?.created_at),
        last_used_at: iso(k?.last_used_at) ?? st?.last_call_at ?? null,
        ...limitOf(conn),
        idle: null,
        stats: st
      })
    } else {
      out.push({
        conn,
        kind: 'token',
        name: 'Personal token',
        user_id: conn.slice(1),
        created_at: null,
        last_used_at: st?.last_call_at ?? null,
        ...limitOf(conn),
        idle: null,
        stats: st
      })
    }
  }
  if (!opts.userId) {
    const names = await userNames([...out.map((c) => c.user_id).filter(Boolean), ...tokenUsers])
    for (const c of out) c.user_name = names.get(c.user_id.toLowerCase()) ?? 'Unknown person'
  }
  out.sort(
    (a, b) =>
      (b.stats?.last_call_at ?? b.last_used_at ?? '').localeCompare(
        a.stats?.last_call_at ?? a.last_used_at ?? ''
      ) || a.name.localeCompare(b.name)
  )
  return { logged: stats != null, connections: out }
}

// ─── What my agents did (#2498) ──────────────────────────────────────────────

export interface AgentWrite {
  activity_id: number
  action: string
  collection: string | null
  item: string | null
  revision_id: number | null
  /** Can be undone now; otherwise `reason` says why not. */
  undoable: boolean
  undone: boolean
  reason?: string
}

export interface AgentCall {
  id: number
  at: string
  conn: string
  app: string
  tool: string | null
  outcome: 'ok' | 'error' | 'refused'
  message: string | null
  bytes: number | null
  ms: number
  /** The record the call read or wrote, when it named one. */
  record: { collection: string; id: string } | null
  /** Calls the tool made into the API (count) and the writes they left. */
  api_calls: number
  writes: AgentWrite[]
}

const ITEM_PATH = /^\/api\/items\/([A-Za-z0-9_]+)\/([^/?]+)/
const COLL_PATH = /^\/api\/items\/([A-Za-z0-9_]+)/

/** The record a tool call touched, from its in-process calls' paths (pure). */
export function recordOfPaths(paths: string[]): { collection: string; id: string } | null {
  for (const p of paths) {
    const m = p.match(ITEM_PATH)
    if (m && !/^(nivaro_|directus_)/i.test(m[1]) && m[2] !== 'batch-read')
      return { collection: m[1], id: decodeURIComponent(m[2]) }
  }
  for (const p of paths) {
    const m = p.match(COLL_PATH)
    if (m && !/^(nivaro_|directus_)/i.test(m[1])) return { collection: m[1], id: '' }
  }
  return null
}

const parse = (raw: unknown): Record<string, unknown> | null => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const UNDO_TAG = (id: number) => `activity:${id}`

/** Newest revision id per item of one collection. */
async function newestRevisions(collection: string, items: string[]): Promise<Map<string, number>> {
  const rows = (await selectInChunks([...new Set(items)], 1000, (chunk) =>
    Promise.resolve(
      db('nivaro_revisions')
        .where('collection', collection)
        .whereIn('item', chunk)
        .groupBy('item')
        .select('item', db.raw('MAX(id) as id'))
    )
  )) as Array<{ item: string; id: number }>
  return new Map(rows.map((r) => [String(r.item), Number(r.id)]))
}

/** One page of the person's tool calls, newest first. */
export async function readAgentActivity(
  userId: string,
  opts: {
    conn?: string | null
    before?: string | null
    limit?: number
    names?: Map<string, string>
  }
): Promise<{ logged: boolean; calls: AgentCall[]; next_before: string | null }> {
  if (!(await hasMcpLogColumns().catch(() => false)))
    return { logged: false, calls: [], next_before: null }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  const chained = await hasChainColumns('nivaro_api_logs')
  const q = db('nivaro_api_logs')
    .where('user', userId)
    .whereNotNull('mcp_conn')
    .whereNotNull('mcp_outcome')
    .where('created_at', '>=', new Date(Date.now() - WINDOW_DAYS * DAY))
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .select(
      'id',
      'created_at',
      'mcp_conn',
      'mcp_client',
      'mcp_tool',
      'mcp_outcome',
      'mcp_bytes',
      'latency_ms',
      'error',
      ...(chained ? ['chain_id'] : [])
    )
  if (opts.conn) q.where('mcp_conn', opts.conn)
  if (opts.before) q.where('created_at', '<', new Date(opts.before))
  const rows = (await q) as Array<{
    id: number
    created_at: Date | string
    mcp_conn: string
    mcp_client: string | null
    mcp_tool: string | null
    mcp_outcome: string
    mcp_bytes: number | null
    latency_ms: number
    error: string | null
    chain_id?: string | null
  }>
  const more = rows.length > limit
  const page = rows.slice(0, limit)
  const chains = [...new Set(page.map((r) => r.chain_id).filter((c): c is string => !!c))]

  // The tool calls' own requests, and the activity rows their writes left.
  const [inner, acts] = chains.length
    ? await Promise.all([
        selectInChunks(chains, 500, (chunk) =>
          Promise.resolve(
            db('nivaro_api_logs')
              .whereIn('chain_id', chunk)
              .whereNotNull('mcp_conn')
              .whereNot('path', '/api/mcp')
              .orderBy('id', 'asc')
              .limit(20_000)
              .select('chain_id', 'method', 'path')
          )
        ) as Promise<Array<{ chain_id: string; method: string; path: string }>>,
        hasChainColumns('nivaro_activity').then((ok) =>
          ok
            ? (selectInChunks(chains, 500, (chunk) =>
                Promise.resolve(
                  db('nivaro_activity')
                    .whereIn('chain_id', chunk)
                    .where('user', userId)
                    .orderBy('id', 'asc')
                    .limit(5_000)
                    .select('id', 'action', 'collection', 'item', 'chain_id')
                )
              ) as Promise<
                Array<{
                  id: number
                  action: string
                  collection: string | null
                  item: string | null
                  chain_id: string
                }>
              >)
            : []
        )
      ])
    : [[], []]

  const key = (c: string | null | undefined) => String(c ?? '').toLowerCase()
  const innerBy = new Map<string, Array<{ method: string; path: string }>>()
  for (const r of inner) innerBy.set(key(r.chain_id), [...(innerBy.get(key(r.chain_id)) ?? []), r])
  const writeActs = acts.filter((a) => a.action !== 'mcp-undo')
  const actIds = writeActs.map((a) => Number(a.id))
  const [revs, undone] = actIds.length
    ? await Promise.all([
        selectInChunks(actIds, 1000, (chunk) =>
          Promise.resolve(
            db('nivaro_revisions').whereIn('activity', chunk).select('id', 'activity')
          )
        ) as Promise<Array<{ id: number; activity: number }>>,
        selectInChunks(actIds.map(UNDO_TAG), 1000, (chunk) =>
          Promise.resolve(
            db('nivaro_activity')
              .where('action', 'mcp-undo')
              .where('user', userId)
              .whereIn('comment', chunk)
              .select('comment')
          )
        ) as Promise<Array<{ comment: string }>>
      ])
    : [[], []]
  const revOf = new Map(revs.map((r) => [Number(r.activity), Number(r.id)]))
  const undoneSet = new Set(undone.map((u) => u.comment))
  // Newest revision per touched record: an undo is only offered while the agent's edit is newest.
  const byColl = new Map<string, string[]>()
  for (const a of writeActs)
    if (a.collection && a.item)
      byColl.set(a.collection, [...(byColl.get(a.collection) ?? []), String(a.item)])
  const newest = new Map<string, number>()
  for (const [c, items] of byColl) {
    const m = await newestRevisions(c, items).catch(() => new Map<string, number>())
    for (const [item, id] of m) newest.set(`${c}\u0000${item}`, id)
  }
  const actsBy = new Map<string, AgentWrite[]>()
  for (const a of writeActs) {
    const rev = revOf.get(Number(a.id)) ?? null
    const w: AgentWrite = {
      activity_id: Number(a.id),
      action: a.action,
      collection: a.collection,
      item: a.item != null ? String(a.item) : null,
      revision_id: rev,
      undoable: false,
      undone: undoneSet.has(UNDO_TAG(Number(a.id)))
    }
    if (w.undone) w.reason = 'Undone'
    else if (a.action !== 'create' && a.action !== 'update')
      w.reason =
        a.action === 'delete' ? 'A deleted record cannot be brought back here' : 'Not undoable'
    else if (rev == null) w.reason = 'No history was kept for this change'
    else if (newest.get(`${a.collection}\u0000${a.item}`) !== rev)
      w.reason = 'The record changed after this'
    else w.undoable = true
    const k = key(a.chain_id)
    actsBy.set(k, [...(actsBy.get(k) ?? []), w])
  }

  const calls: AgentCall[] = page.map((r) => {
    const k = key(r.chain_id)
    const paths = (innerBy.get(k) ?? []).map((i) => i.path)
    const writes = (actsBy.get(k) ?? []).slice(0, 20)
    const first = writes.find((w) => w.collection && w.item)
    return {
      id: Number(r.id),
      at: new Date(r.created_at).toISOString(),
      conn: String(r.mcp_conn).toLowerCase(),
      app:
        opts.names?.get(String(r.mcp_conn).toLowerCase()) ??
        String(r.mcp_client ?? 'Assistant').replace(/_/g, ' '),
      tool: r.mcp_tool,
      outcome: (['ok', 'error', 'refused'].includes(r.mcp_outcome)
        ? r.mcp_outcome
        : 'ok') as AgentCall['outcome'],
      message: r.mcp_outcome === 'ok' ? null : (r.error ?? null),
      bytes: r.mcp_bytes == null ? null : Number(r.mcp_bytes),
      ms: Number(r.latency_ms) || 0,
      record:
        first?.collection && first.item
          ? { collection: first.collection, id: first.item }
          : recordOfPaths(paths),
      api_calls: paths.length,
      writes
    }
  })
  return {
    logged: true,
    calls,
    next_before:
      more && page.length ? new Date(page[page.length - 1].created_at).toISOString() : null
  }
}

export class AgentUndoError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message)
  }
}

/**
 * Undo one write an agent made for this person: put back the record's previous values (an
 * update) or delete the record it created. Only while the agent's edit is still the record's
 * newest revision; through the items service AS THE PERSON, so permissions, validation, hooks
 * and a fresh revision all apply.
 */
export async function undoAgentWrite(
  user: User,
  activityId: number,
  req?: FastifyRequest
): Promise<{ collection: string; item: string; action: 'update' | 'delete' }> {
  const userId = String(user.id)
  if (!(await hasChainColumns('nivaro_activity')) || !(await hasMcpLogColumns()))
    throw new AgentUndoError('Agent history is not available on this database yet', 409)
  const act = (await db('nivaro_activity')
    .where({ id: activityId })
    .where('user', userId)
    .first('id', 'action', 'collection', 'item', 'chain_id')) as
    | {
        id: number
        action: string
        collection: string | null
        item: string | null
        chain_id: string | null
      }
    | undefined
  if (!act?.chain_id || !act.collection || !act.item)
    throw new AgentUndoError('That change was not found', 404)
  const byAgent = await db('nivaro_api_logs')
    .where('chain_id', act.chain_id)
    .where('user', userId)
    .whereNotNull('mcp_outcome')
    .first('id')
  if (!byAgent) throw new AgentUndoError('That change was not made by one of your agents', 404)
  const already = await db('nivaro_activity')
    .where({ action: 'mcp-undo', comment: UNDO_TAG(activityId) })
    .where('user', userId)
    .first('id')
  if (already) throw new AgentUndoError('That change was already undone', 409)
  if (act.action === 'delete')
    throw new AgentUndoError('A deleted record cannot be brought back here', 409)
  if (act.action !== 'create' && act.action !== 'update')
    throw new AgentUndoError('This kind of change cannot be undone here', 409)
  const rev = (await db('nivaro_revisions').where({ activity: act.id }).first('id', 'delta')) as
    | { id: number; delta: unknown }
    | undefined
  if (!rev) throw new AgentUndoError('No history was kept for this change', 409)
  const newest = (await db('nivaro_revisions')
    .where({ collection: act.collection, item: act.item })
    .max('id as id')
    .first()) as { id: number | null } | undefined
  if (Number(newest?.id) !== Number(rev.id))
    throw new AgentUndoError(
      'The record changed after your agent’s edit — open it and change it by hand',
      409
    )
  if (act.action === 'create') {
    await deleteOne(user, act.collection, act.item, req)
  } else {
    const prev = (await db('nivaro_revisions')
      .where({ collection: act.collection, item: act.item })
      .where('id', '<', rev.id)
      .orderBy('id', 'desc')
      .first('data')) as { data: unknown } | undefined
    const before = parse(prev?.data)
    const changed = Object.keys(parse(rev.delta) ?? {}).filter((f) => f !== 'id')
    if (!before || changed.length === 0)
      throw new AgentUndoError('There is no earlier version to put back', 409)
    const patch: Record<string, unknown> = {}
    for (const f of changed) if (f in before) patch[f] = before[f]
    if (Object.keys(patch).length === 0)
      throw new AgentUndoError('There is no earlier version to put back', 409)
    await updateOne(user, act.collection, act.item, patch, req)
  }
  await logActivity({
    action: 'mcp-undo',
    user: userId,
    collection: act.collection,
    item: act.item,
    comment: UNDO_TAG(activityId),
    req
  })
  return {
    collection: act.collection,
    item: act.item,
    action: act.action === 'create' ? 'delete' : 'update'
  }
}
