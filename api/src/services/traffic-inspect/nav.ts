// api/src/services/traffic-inspect/nav.ts
/**
 * Traffic Map drill-down, group "nav" (Task 7):
 *  - `load` (#1205): one page load's calls as a waterfall, from the screens tap's in-memory
 *    per-load buffer, with the page's real-user timings (nivaro_rum_events p75) beside it;
 *  - `search` (#1208): a search box entry resolved to the levels it names;
 *  - the Related rail (#1204): what else shares a level's chain, record, caller, error, page load
 *    or statement shape.
 *
 * Every id is validated before it reaches a query; queries bind values and never interpolate.
 * Search never reads or compares token columns (API keys, static tokens): a credential-shaped entry
 * is refused before any lookup and never echoed back.
 */
import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { instanceKey } from '../instance-key.js'
import { INSTANCE_ID } from '../instance-roster.js'
import { getTrace } from '../request-trace.js'
import { normalizeLoadId, normalizeScreenPath } from '../traffic-client-facts.js'
import { callerKeyFor, classifyRequest, entityKey } from '../traffic-entities.js'
import { type InspectCtx, type InspectPeek, registerInspectSource } from '../traffic-inspect.js'
import { groupOf } from '../traffic-taps/error-groups.js'
import { loadCalls, loadOfRequest, recentLoads } from '../traffic-taps/screens.js'
import type { LoadEntry } from './nav-load-buffer.js'
import {
  buildWaterfall,
  classifySearch,
  finishRelated,
  finishResults,
  p75,
  type RefWire,
  type RelatedDraft,
  type RelatedGroup,
  requestLabel,
  type SearchResult,
  screenMatches,
  splitScreenKey,
  statementLabel,
  statementSha,
  type Waterfall
} from './nav-logic.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INT_RE = /^\d{1,15}$/
const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/
const ITEM_RE = /^[A-Za-z0-9_.-]{1,80}$/
const LOAD_RE = /^[A-Za-z0-9_-]{6,40}$/
const CALLER_RE = /^(?:k\d{1,10}|u[0-9a-f-]{36})$/i
const INT32_MAX = 2_147_483_647
/** API log retention, for the honest "older than" message. */
const API_LOG_RETENTION_DAYS = 14

const isUuid = (s: string) => UUID_RE.test(s)
const isInt = (s: string) => INT_RE.test(s) && Number(s) > 0 && Number(s) <= INT32_MAX

function ms(v: unknown): number | undefined {
  if (v == null) return undefined
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : undefined
}

function windowOf(at: number, windowSec: number): { from: Date; to: Date } {
  return { from: new Date(at - windowSec * 1000), to: new Date(at + windowSec * 1000) }
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p
  } catch {
    return fallback
  }
}

async function count(qb: Knex.QueryBuilder): Promise<number> {
  const row = (await qb.clone().clearSelect().clearOrder().count({ n: '*' }).first()) as
    | { n?: number | string }
    | undefined
  return Number(row?.n ?? 0) || 0
}

// ── names ──

async function personNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const list = [
    ...new Set(ids.filter((x): x is string => !!x && isUuid(x)).map((x) => x.toUpperCase()))
  ]
  if (list.length === 0) return out
  const rows = (await safe(
    db('nivaro_users').whereIn('id', list).select('id', 'first_name', 'last_name', 'email'),
    []
  )) as Array<{
    id: string
    first_name?: string | null
    last_name?: string | null
    email?: string | null
  }>
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
    out.set(String(r.id).toUpperCase(), name || r.email || String(r.id).slice(0, 8))
  }
  return out
}

async function keyName(id: number): Promise<string | null> {
  const row = (await safe(db('nivaro_api_keys').where({ id }).first('name'), undefined)) as
    | { name?: string | null }
    | undefined
  return row?.name ?? null
}

/** A caller key's human label (`k12` → key name, `u<uuid>` → person). */
async function callerLabel(caller: string): Promise<string> {
  if (/^k\d+$/.test(caller))
    return (await keyName(Number(caller.slice(1)))) ?? `API key ${caller.slice(1)}`
  if (/^u/i.test(caller)) {
    const id = caller.slice(1)
    return (await personNames([id])).get(id.toUpperCase()) ?? id.slice(0, 8)
  }
  if (caller === 'anon') return 'Unauthenticated'
  return caller
}

// ── page load (#1205) ──

export interface LoadRum {
  route: string
  app: string | null
  samples: number
  lcp_p75: number | null
  fcp_p75: number | null
  ttfb_p75: number | null
  /** In-app navigations to this page (route changes). */
  nav_p75: number | null
}

/** Real-user timings for a page pattern over the last 7 days (nivaro_rum_events). */
async function rumFor(screen: string): Promise<LoadRum | null> {
  const { app, path } = splitScreenKey(screen)
  if (!path.startsWith('/')) return null
  const since = new Date(Date.now() - 7 * 86_400_000)
  const q = db('nivaro_rum_events')
    .where('route', path)
    .andWhere('created_at', '>=', since)
    .whereIn('kind', ['load', 'route'])
  if (app) q.andWhere((w) => w.where('app', app).orWhereNull('app'))
  const rows = (await q
    .orderBy('id', 'desc')
    .limit(3000)
    .select('kind', 'lcp_ms', 'fcp_ms', 'ttfb_ms', 'duration_ms')) as Array<{
    kind: string
    lcp_ms: number | null
    fcp_ms: number | null
    ttfb_ms: number | null
    duration_ms: number | null
  }>
  if (rows.length === 0) return null
  const loads = rows.filter((r) => r.kind === 'load')
  const navs = rows.filter((r) => r.kind === 'route')
  return {
    route: path,
    app,
    samples: rows.length,
    lcp_p75: p75(loads.map((r) => r.lcp_ms)),
    fcp_p75: p75(loads.map((r) => r.fcp_ms)),
    ttfb_p75: p75(loads.map((r) => r.ttfb_ms)),
    nav_p75: p75(navs.map((r) => r.duration_ms))
  }
}

export interface LoadDetail {
  load: string
  screen: string
  app: string | null
  page: string
  caller: string
  caller_label: string
  user: string | null
  user_name: string | null
  started_at: number
  ended_at: number
  calls: number
  dropped: number
  waterfall: Waterfall
  rum: LoadRum | null
  /** The API process holding this load in memory. */
  node: string
  instance: string
}

async function loadDetail(e: LoadEntry): Promise<LoadDetail> {
  const { app, path } = splitScreenKey(e.screen)
  const [label, names, rum] = await Promise.all([
    callerLabel(e.caller),
    personNames([e.user]),
    safe(rumFor(e.screen), null)
  ])
  return {
    load: e.load,
    screen: e.screen,
    app,
    page: path,
    caller: e.caller,
    caller_label: label,
    user: e.user,
    user_name: e.user ? (names.get(e.user.toUpperCase()) ?? null) : null,
    started_at: e.first,
    ended_at: e.last,
    calls: e.calls.length + e.dropped,
    dropped: e.dropped,
    // The load's own span as the origin: dropped calls may start before the first kept one.
    waterfall: buildWaterfall(e.calls, { first: e.first, last: e.last }),
    rum,
    node: INSTANCE_ID,
    instance: instanceKey()
  }
}

registerInspectSource({
  kind: 'load',
  validId: (id) => LOAD_RE.test(id) && normalizeLoadId(id) === id,
  async peek(id): Promise<InspectPeek | null> {
    const e = loadCalls(id)
    if (!e) return null
    const { path } = splitScreenKey(e.screen)
    const n = e.calls.length + e.dropped
    return {
      title: `Page load · ${path}`,
      lines: [`${n} ${n === 1 ? 'call' : 'calls'} in ${Math.max(0, e.last - e.first)} ms`],
      at: e.first
    }
  },
  async detail(id) {
    const e = loadCalls(id)
    return e ? loadDetail(e) : null
  }
})

export interface LoadListRow {
  load: string
  at: number
  calls: number
  ms: number
  user: string | null
  caller: string
}

/** Newest kept loads of a page (screen key or bare pattern), at most 30. */
export async function loadList(page: string): Promise<LoadListRow[]> {
  const loads = recentLoads((e) => screenMatches(e.screen, page), 30)
  const names = await personNames(loads.map((l) => l.user))
  return loads.map((l) => ({
    load: l.load,
    at: l.first,
    calls: l.calls.length + l.dropped,
    ms: Math.max(0, l.last - l.first),
    user: l.user ? (names.get(l.user.toUpperCase()) ?? l.user) : null,
    caller: l.caller
  }))
}

// ── Related rail (#1204) ──

interface Facts {
  at?: number
  chain?: string
  record?: { collection: string; item: string }
  caller?: string
  requestId?: string
  load?: string
  /** For a failed request: method, path, status, error text (the issue match). */
  failure?: { method: string; path: string; status: number; error: string | null }
  /** For an issue level: its fingerprint. */
  fingerprint?: string
  /** For an issue level: its id (excluded from "same error"). */
  issueId?: number
  /** The API process that served the request (from its log row). */
  instance?: string | null
}

const LOG_COLS = [
  'id',
  'method',
  'path',
  'status',
  'user',
  'api_key_id',
  'auth',
  'created_at',
  'chain_id',
  'error',
  'instance'
]

async function logColumns(): Promise<{ cols: string[]; hasRid: boolean }> {
  const hasRid = await safe(hasColumn('nivaro_api_logs', 'request_id'), false)
  return { cols: hasRid ? [...LOG_COLS, 'request_id'] : LOG_COLS, hasRid }
}

interface LogRow {
  id: number | string
  method: string
  path: string
  status: number
  user: string | null
  api_key_id: number | null
  auth: string | null
  created_at: Date | string
  chain_id: string | null
  error: string | null
  instance: string | null
  request_id?: string | null
}

function logCaller(r: LogRow): string {
  return callerKeyFor({
    authMethod: r.api_key_id != null ? 'api_key' : r.auth,
    apiKeyId: r.api_key_id,
    userId: r.user
  })
}

function requestRef(r: LogRow): RefWire | null {
  if (!r.request_id) return null
  return {
    kind: 'request',
    id: String(r.request_id).toLowerCase(),
    label: requestLabel(r),
    at: ms(r.created_at)
  }
}

function factsFromLog(r: LogRow): Facts {
  const f: Facts = {
    at: ms(r.created_at),
    caller: logCaller(r),
    chain: r.chain_id ? String(r.chain_id).toLowerCase() : undefined,
    requestId: r.request_id ? String(r.request_id).toLowerCase() : undefined,
    instance: r.instance
  }
  if (r.status >= 500)
    f.failure = { method: r.method, path: r.path, status: r.status, error: r.error }
  return f
}

async function requestFacts(rid: string, notes: string[]): Promise<Facts> {
  const facts: Facts = { requestId: rid }
  const { cols, hasRid } = await logColumns()
  if (hasRid) {
    const row = (await safe(
      db('nivaro_api_logs').where({ request_id: rid }).orderBy('id', 'desc').first(cols),
      undefined
    )) as LogRow | undefined
    if (row) Object.assign(facts, factsFromLog(row))
    else
      notes.push(
        `This request is not in the API log: logs are written in batches (a request from the last few seconds may not be there yet), are kept ${API_LOG_RETENTION_DAYS} days, and some calls (sign-in, health) are never logged.`
      )
  } else notes.push('This database does not store request ids on the API log yet (migration 389).')
  const l = loadOfRequest(rid)
  if (l) facts.load = l.load
  return facts
}

/** A business record a row names (never a nivaro_* / directus_* system row, never a malformed id). */
function recordOf(collection: unknown, item: unknown): Facts['record'] {
  if (typeof collection !== 'string' || item == null) return undefined
  const it = String(item)
  if (!IDENT_RE.test(collection) || /^(nivaro|directus)_/.test(collection) || !ITEM_RE.test(it))
    return undefined
  return { collection, item: it }
}

/**
 * What a level shares with other things. `needAt`: the caller has no anchor, so a level without a
 * time of its own (a record, a caller opened from Search) looks up its newest activity to centre
 * the window on it instead of on now.
 */
async function factsFor(
  kind: string,
  id: string,
  notes: string[],
  needAt = false
): Promise<Facts | null> {
  switch (kind) {
    case 'request':
    case 'trace':
      return isUuid(id) ? requestFacts(id.toLowerCase(), notes) : null
    case 'chain':
      return isUuid(id) ? { chain: id.toLowerCase() } : null
    case 'compare': {
      const first = id.split(',')[0] ?? ''
      return isUuid(first) ? requestFacts(first.toLowerCase(), notes) : null
    }
    case 'write': {
      if (!isInt(id)) return null
      const row = (await safe(
        db('nivaro_activity')
          .where({ id: Number(id) })
          .first(
            'id',
            'action',
            'user',
            'collection',
            'item',
            'timestamp',
            'chain_id',
            'api_key_id',
            'auth_method'
          ),
        undefined
      )) as
        | {
            user: string | null
            collection: string | null
            item: string | null
            timestamp: Date | string
            chain_id?: string | null
            api_key_id?: number | null
            auth_method?: string | null
          }
        | undefined
      if (!row) return {}
      return {
        at: ms(row.timestamp),
        chain: row.chain_id ? String(row.chain_id).toLowerCase() : undefined,
        record: recordOf(row.collection, row.item),
        caller: callerKeyFor({
          authMethod: row.api_key_id != null ? 'api_key' : (row.auth_method ?? null),
          apiKeyId: row.api_key_id ?? null,
          userId: row.user
        })
      }
    }
    case 'record': {
      const cut = id.indexOf(':')
      const collection = id.slice(0, cut)
      const item = id.slice(cut + 1)
      if (cut <= 0 || !IDENT_RE.test(collection) || !ITEM_RE.test(item)) return null
      const facts: Facts = { record: { collection, item } }
      if (needAt) {
        const row = (await safe(
          db('nivaro_activity')
            .where({ collection, item })
            .orderBy('id', 'desc')
            .first('timestamp'),
          undefined
        )) as { timestamp?: Date | string | null } | undefined
        facts.at = ms(row?.timestamp)
      }
      return facts
    }
    case 'caller': {
      if (!CALLER_RE.test(id)) return {}
      const caller = id[0].toLowerCase() === 'u' ? `u${id.slice(1).toUpperCase()}` : id
      const facts: Facts = { caller }
      if (needAt) {
        const qb = db('nivaro_api_logs')
        if (/^k\d+$/.test(caller)) qb.where('api_key_id', Number(caller.slice(1)))
        else {
          const uid = caller.slice(1)
          qb.whereIn('user', [uid.toUpperCase(), uid.toLowerCase()]).whereNull('api_key_id')
        }
        const row = (await safe(qb.orderBy('id', 'desc').first('created_at'), undefined)) as
          | { created_at?: Date | string | null }
          | undefined
        facts.at = ms(row?.created_at)
      }
      return facts
    }
    case 'load': {
      if (!LOAD_RE.test(id)) return null
      const e = loadCalls(id)
      return e ? { load: id, caller: e.caller, at: e.first } : { load: id }
    }
    case 'issue': {
      if (!isInt(id)) return null
      const row = (await safe(
        db('nivaro_issues')
          .where({ id: Number(id) })
          .first('id', 'fingerprint', 'collection', 'item', 'last_seen_at', 'created_at'),
        undefined
      )) as
        | {
            fingerprint?: string | null
            collection?: string | null
            item?: string | null
            last_seen_at?: Date | null
            created_at?: Date | null
          }
        | undefined
      if (!row) return {}
      return {
        at: ms(row.last_seen_at ?? row.created_at),
        fingerprint: row.fingerprint ?? undefined,
        issueId: Number(id),
        record: recordOf(row.collection, row.item)
      }
    }
    case 'job': {
      if (!isInt(id)) return null
      const hasChain = await safe(hasColumn('nivaro_job_runs', 'chain_id'), false)
      const row = (await safe(
        db('nivaro_job_runs')
          .where({ id: Number(id) })
          .first(hasChain ? ['started_at', 'chain_id'] : ['started_at']),
        undefined
      )) as { started_at?: Date | null; chain_id?: string | null } | undefined
      return row
        ? {
            at: ms(row.started_at),
            chain: row.chain_id ? String(row.chain_id).toLowerCase() : undefined
          }
        : {}
    }
    case 'flow': {
      if (!isUuid(id)) return null
      const row = (await safe(
        db('nivaro_flow_runs').where({ id }).first('started_at', 'chain_id'),
        undefined
      )) as { started_at?: Date | null; chain_id?: string | null } | undefined
      return row
        ? {
            at: ms(row.started_at),
            chain: row.chain_id ? String(row.chain_id).toLowerCase() : undefined
          }
        : {}
    }
    case 'submission': {
      if (!isInt(id)) return null
      const row = (await safe(
        db('nivaro_erp_submissions')
          .where({ id: Number(id) })
          .first('created_at', 'chain_id', 'collection', 'item'),
        undefined
      )) as
        | {
            created_at?: Date | null
            chain_id?: string | null
            collection?: string | null
            item?: string | null
          }
        | undefined
      if (!row) return {}
      return {
        at: ms(row.created_at),
        chain: row.chain_id ? String(row.chain_id).toLowerCase() : undefined,
        record: recordOf(row.collection, row.item)
      }
    }
    case 'ai': {
      if (!INT_RE.test(id)) return null
      const row = (await safe(
        db('nivaro_ai_calls').where({ id }).first('request_id', 'created_at', 'user'),
        undefined
      )) as
        | { request_id?: string | null; created_at?: Date | null; user?: string | null }
        | undefined
      if (!row) return {}
      const base: Facts = {
        at: ms(row.created_at),
        caller: row.user ? `u${String(row.user).toUpperCase()}` : undefined
      }
      return row.request_id && isUuid(String(row.request_id))
        ? { ...base, ...(await requestFacts(String(row.request_id).toLowerCase(), notes)) }
        : base
    }
    default:
      return {}
  }
}

async function chainGroup(chain: string): Promise<RelatedDraft> {
  const refs: RefWire[] = [{ kind: 'chain', id: chain, label: 'Event path' }]
  let total = 1
  const { cols, hasRid } = await logColumns()
  const parts = await Promise.all(
    [
      (async () => {
        if (!hasRid) return { refs: [] as RefWire[], n: 0 }
        const qb = db('nivaro_api_logs').where('chain_id', chain).whereNotNull('request_id')
        const [rows, n] = await Promise.all([
          qb.clone().orderBy('id', 'asc').limit(10).select(cols) as Promise<LogRow[]>,
          count(qb)
        ])
        return { refs: rows.map(requestRef).filter((r): r is RefWire => !!r), n }
      })(),
      (async () => {
        const qb = db('nivaro_activity').where('chain_id', chain)
        const [rows, n] = await Promise.all([
          qb
            .clone()
            .orderBy('id', 'asc')
            .limit(10)
            .select('id', 'action', 'collection', 'item', 'timestamp') as Promise<
            Array<{ id: number; action: string; collection: string; item: string; timestamp: Date }>
          >,
          count(qb)
        ])
        return {
          refs: rows.map((r) => ({
            kind: 'write',
            id: String(r.id),
            label: `${r.action} ${r.collection ?? ''} ${r.item ?? ''}`.trim(),
            at: ms(r.timestamp)
          })),
          n
        }
      })(),
      (async () => {
        const qb = db('nivaro_erp_submissions').where('chain_id', chain)
        const [rows, n] = await Promise.all([
          qb.clone().orderBy('id', 'asc').limit(10).select('id', 'status', 'created_at') as Promise<
            Array<{ id: number; status: string; created_at: Date }>
          >,
          count(qb)
        ])
        return {
          refs: rows.map((r) => ({
            kind: 'submission',
            id: String(r.id),
            label: `Partner push ${r.id} · ${r.status}`,
            at: ms(r.created_at)
          })),
          n
        }
      })(),
      (async () => {
        const qb = db('nivaro_flow_runs').where('chain_id', chain)
        const [rows, n] = await Promise.all([
          qb
            .clone()
            .orderBy('started_at', 'asc')
            .limit(10)
            .select('id', 'trigger', 'status', 'started_at') as Promise<
            Array<{ id: string; trigger: string | null; status: string | null; started_at: Date }>
          >,
          count(qb)
        ])
        return {
          refs: rows.map((r) => ({
            kind: 'flow',
            id: String(r.id).toLowerCase(),
            label: `Flow run · ${r.status ?? 'unknown'}${r.trigger ? ` (${r.trigger})` : ''}`,
            at: ms(r.started_at)
          })),
          n
        }
      })(),
      (async () => {
        const qb = db('nivaro_workflow_history as h')
          .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
          .where('h.chain_id', chain)
        const [rows, n] = await Promise.all([
          qb
            .clone()
            .orderBy('h.id', 'asc')
            .limit(10)
            .select('h.id', 'i.collection', 'i.item', 'h.timestamp') as Promise<
            Array<{ id: number; collection: string; item: string; timestamp: Date }>
          >,
          count(qb)
        ])
        return {
          refs: rows
            .filter((r) => r.collection && r.item && IDENT_RE.test(r.collection))
            .map((r) => ({
              kind: 'record',
              id: `${r.collection}:${r.item}`,
              label: `${r.collection} ${r.item} (state change)`,
              at: ms(r.timestamp)
            })),
          n
        }
      })(),
      (async () => {
        if (!(await hasColumn('nivaro_job_runs', 'chain_id')))
          return { refs: [] as RefWire[], n: 0 }
        const qb = db('nivaro_job_runs').where('chain_id', chain)
        const [rows, n] = await Promise.all([
          qb
            .clone()
            .orderBy('id', 'asc')
            .limit(10)
            .select('id', 'job_id', 'status', 'started_at') as Promise<
            Array<{ id: number; job_id: string; status: string; started_at: Date }>
          >,
          count(qb)
        ])
        return {
          refs: rows.map((r) => ({
            kind: 'job',
            id: String(r.id),
            label: `${r.job_id} · ${r.status}`,
            at: ms(r.started_at)
          })),
          n
        }
      })()
    ].map((p) => safe(p, { refs: [] as RefWire[], n: 0 }))
  )
  for (const p of parts) {
    refs.push(...p.refs)
    total += p.n
  }
  return { key: 'chain', label: 'Same chain (everything this event caused)', refs, total }
}

async function recordGroup(
  rec: { collection: string; item: string },
  at: number,
  windowSec: number
): Promise<RelatedDraft> {
  const { from, to } = windowOf(at, windowSec)
  const refs: RefWire[] = [
    { kind: 'record', id: `${rec.collection}:${rec.item}`, label: `${rec.collection} ${rec.item}` }
  ]
  const qb = db('nivaro_activity')
    .where({ collection: rec.collection, item: rec.item })
    .andWhere('timestamp', '>=', from)
    .andWhere('timestamp', '<=', to)
  const [rows, n] = await Promise.all([
    qb
      .clone()
      .orderBy('id', 'desc')
      .limit(10)
      .select('id', 'action', 'user', 'timestamp') as Promise<
      Array<{ id: number; action: string; user: string | null; timestamp: Date }>
    >,
    count(qb)
  ])
  const names = await personNames(rows.map((r) => r.user))
  for (const r of rows)
    refs.push({
      kind: 'write',
      id: String(r.id),
      label: `${r.action}${r.user ? ` by ${names.get(String(r.user).toUpperCase()) ?? 'someone'}` : ''}`,
      at: ms(r.timestamp)
    })
  return { key: 'record', label: 'Same record (changes around this time)', refs, total: 1 + n }
}

async function callerGroup(
  caller: string,
  at: number,
  windowSec: number
): Promise<RelatedDraft | null> {
  const { cols, hasRid } = await logColumns()
  const refs: RefWire[] = [{ kind: 'caller', id: caller, label: await callerLabel(caller) }]
  if (!hasRid) return { key: 'caller', label: 'Same caller', refs, total: 1 }
  const { from, to } = windowOf(at, windowSec)
  const qb = db('nivaro_api_logs')
    .whereNotNull('request_id')
    .andWhere('created_at', '>=', from)
    .andWhere('created_at', '<=', to)
  if (/^k\d+$/.test(caller)) qb.andWhere('api_key_id', Number(caller.slice(1)))
  else if (/^u/i.test(caller)) {
    const id = caller.slice(1)
    qb.whereIn('user', [id.toUpperCase(), id.toLowerCase()]).whereNull('api_key_id')
  } else return null
  const [rows, n] = await Promise.all([
    qb.clone().orderBy('id', 'desc').limit(11).select(cols) as Promise<LogRow[]>,
    count(qb)
  ])
  for (const r of rows) {
    const ref = requestRef(r)
    if (ref) refs.push(ref)
  }
  return { key: 'caller', label: 'Same caller (around this time)', refs, total: 1 + n }
}

interface IssueRow {
  id: number
  title: string
  status: string
  last_seen_at: Date
}

const ISSUE_COLS = ['id', 'title', 'status', 'last_seen_at']

const issueRef = (r: IssueRow): RefWire => ({
  kind: 'issue',
  id: String(r.id),
  label: `${r.status} · ${r.title}`.slice(0, 140),
  at: ms(r.last_seen_at)
})

/** Issues sharing a fingerprint (indexed; the way issues dedupe). */
async function issuesByFingerprint(fingerprint: string): Promise<IssueRow[]> {
  return (await db('nivaro_issues')
    .where({ fingerprint })
    .orderBy('id', 'desc')
    .limit(11)
    .select(ISSUE_COLS)) as IssueRow[]
}

/**
 * Does an issue title name this failure? Titles are `[server] METHOD /route/:template: message`
 * (error-tracking.ts). Tested here, not in SQL: `[server]` inside a LIKE pattern is a character
 * class on SQL Server, so a title LIKE would match nothing on the main dialect.
 */
export function issueTitleMatches(title: unknown, method: string, needle: string): boolean {
  if (typeof title !== 'string') return false
  const m = method.toUpperCase().replace(/[^A-Z]/g, '')
  return title.startsWith(`[server] ${m} `) && title.includes(needle)
}

async function errorGroup(f: Facts, at: number): Promise<RelatedDraft | null> {
  if (f.fingerprint) {
    return {
      key: 'error',
      label: 'Same error (earlier and later issues)',
      refs: (await issuesByFingerprint(f.fingerprint)).map(issueRef)
    }
  }
  if (!f.failure) return null
  // The fingerprint the error handler would have given this failure, from the same rule the
  // error-groups tap uses. The log row holds the raw path, not the route template, so this
  // matches exactly only for routes without parameters — hence the title scan below.
  const g = groupOf({
    method: f.failure.method,
    routeUrl: null,
    path: f.failure.path,
    route: f.failure.path,
    status: f.failure.status,
    code: null,
    body: f.failure.error
  })
  if (g.meta.fingerprint) {
    const exact = await issuesByFingerprint(g.meta.fingerprint)
    if (exact.length)
      return { key: 'error', label: 'Same error (issue)', refs: exact.map(issueRef) }
  }
  const needle = g.meta.message.slice(0, 120)
  const rows = (await db('nivaro_issues')
    .where({ source: 'server' })
    .andWhere('last_seen_at', '>=', new Date(at - 86_400_000))
    .orderBy('last_seen_at', 'desc')
    .limit(100)
    .select(ISSUE_COLS)) as IssueRow[]
  const hits = rows.filter((r) => issueTitleMatches(r.title, f.failure?.method ?? '', needle))
  return { key: 'error', label: 'Same error (issue)', refs: hits.map(issueRef) }
}

/**
 * Same statement shape (#1204): the request's heaviest statements from its kept trace, each a
 * `statement:<sha1>` level (the request group's statement panel: routes that run it, plan, cache).
 * Only while this process keeps the trace; the ring keeps slow requests only.
 */
function statementGroup(rid: string): RelatedDraft | null {
  const t = getTrace(rid)
  if (!t || !Array.isArray(t.top_sql) || t.top_sql.length === 0) return null
  const refs: RefWire[] = []
  const seen = new Set<string>()
  for (const s of t.top_sql) {
    if (!s?.sql) continue
    const sha = statementSha(s.sql)
    if (seen.has(sha)) continue
    seen.add(sha)
    refs.push({ kind: 'statement', id: sha, label: statementLabel(s) })
  }
  return refs.length
    ? { key: 'statement', label: 'Same statement shape (this request’s top SQL)', refs }
    : null
}

function loadGroup(load: string): RelatedDraft | null {
  const e = loadCalls(load)
  if (!e) return null
  const { path } = splitScreenKey(e.screen)
  const n = e.calls.length + e.dropped
  const refs: RefWire[] = [
    { kind: 'load', id: load, label: `Page load · ${path} · ${n} calls`, at: e.first }
  ]
  const withRid = e.calls.filter((c) => c.rid)
  for (const c of withRid.slice(0, 11))
    refs.push({
      kind: 'request',
      id: String(c.rid).toLowerCase(),
      label: `${c.route} · ${c.status}`,
      at: c.start
    })
  return { key: 'load', label: 'Same page load', refs, total: 1 + withRid.length }
}

export interface RelatedResult {
  groups: RelatedGroup[]
  notes: string[]
  /** The page load a request belonged to, when this process still holds it. */
  load: { id: string; page: string; calls: number } | null
  at: number
  window: number
}

/** Everything that shares something with level `kind:id`, grouped (≤ 10 per group). */
export async function relatedFor(
  kind: string,
  id: string,
  ctx: InspectCtx
): Promise<RelatedResult | null> {
  const notes: string[] = []
  const facts = await factsFor(kind, id, notes, ctx.at == null)
  if (facts === null) return null
  const at = ctx.at ?? facts.at ?? Date.now()
  const w = ctx.windowSec
  const drafts: RelatedDraft[] = []
  const tasks: Array<Promise<void>> = []
  const add = (label: string, p: Promise<RelatedDraft | null>) =>
    tasks.push(
      p.then(
        (d) => {
          if (d) drafts.push(d)
        },
        () => {
          notes.push(`${label}: could not be read right now.`)
        }
      )
    )
  if (facts.chain) add('Same chain', chainGroup(facts.chain))
  if (facts.record) add('Same record', recordGroup(facts.record, at, w))
  if (facts.caller && facts.caller !== 'anon') add('Same caller', callerGroup(facts.caller, at, w))
  if (facts.failure || facts.fingerprint) add('Same error', errorGroup(facts, at))
  if (facts.load) {
    const g = loadGroup(facts.load)
    if (g) drafts.push(g)
  }
  if (facts.requestId && kind !== 'statement') {
    const g = statementGroup(facts.requestId)
    if (g) drafts.push(g)
  }
  await Promise.all(tasks)
  if ((kind === 'request' || kind === 'trace' || kind === 'ai') && !facts.load) {
    const elsewhere = facts.instance && facts.instance !== instanceKey()
    notes.push(
      elsewhere
        ? `Page load: not known here — page loads are kept in memory on the API process that served them (this request ran on "${facts.instance}").`
        : 'Page load: not known — page loads are kept in memory (the last 200, on the API process that served them), and calls from scripts or integrations send no page load id.'
    )
  }
  const e = facts.load ? loadCalls(facts.load) : null
  // The level itself never appears in its own rail: a trace, compare or AI call level is also
  // the request the groups name (`request:<rid>`).
  const self = [{ kind, id }]
  if (facts.requestId && kind !== 'request') self.push({ kind: 'request', id: facts.requestId })
  const groups = finishRelated(drafts, self)
  if (groups.length === 0 && notes.length === 0)
    notes.push(`Nothing else is linked to this ${kind} in the ±${Math.round(w / 60)} min window.`)
  return {
    groups,
    notes,
    load: e
      ? { id: e.load, page: splitScreenKey(e.screen).path, calls: e.calls.length + e.dropped }
      : null,
    at,
    window: w
  }
}

// ── Search (#1208) ──

export interface SearchResponse {
  /** The entry as searched; null when it was refused (a credential is never echoed back). */
  q: string | null
  type: string
  refused?: string
  results: SearchResult[]
  hint?: string
}

const SEARCH_HINT =
  'Search takes a request, chain, recording, trace or person id (uuid), an activity / job / issue / partner push / AI call number, an email, a record id (CR26-80329 or workflows/123), or a route path (/api/items/workflows).'

async function searchUuid(id: string): Promise<SearchResult[]> {
  const { cols, hasRid } = await logColumns()
  const tasks: Array<Promise<SearchResult[]>> = [
    (async () => {
      if (!hasRid) return []
      const r = (await db('nivaro_api_logs')
        .where({ request_id: id })
        .orderBy('id', 'desc')
        .first(cols)) as LogRow | undefined
      if (!r) return []
      return [
        {
          ref: { kind: 'request', id, label: requestLabel(r), at: ms(r.created_at) },
          label: requestLabel(r),
          hint: `Request · ${new Date(r.created_at).toISOString()}`
        }
      ]
    })(),
    (async () => {
      const hit =
        (await db('nivaro_api_logs').where('chain_id', id).first('id')) ??
        (await db('nivaro_activity').where('chain_id', id).first('id'))
      return hit
        ? [
            {
              ref: { kind: 'chain', id, label: 'Event path' },
              label: 'Event path',
              hint: 'Chain — everything one event caused'
            }
          ]
        : []
    })(),
    (async () => {
      const r = (await db('nivaro_session_recordings')
        .where({ id })
        .first('id', 'user', 'started_at')) as { user: string | null; started_at: Date } | undefined
      if (!r) return []
      const name = (await personNames([r.user])).get(String(r.user ?? '').toUpperCase())
      return [
        {
          ref: { kind: 'recording', id, at: ms(r.started_at) },
          label: `Recording${name ? ` of ${name}` : ''}`,
          hint: `Session recording · started ${new Date(r.started_at).toISOString()}`
        }
      ]
    })(),
    (async () => {
      const r = (await db('nivaro_users')
        .where({ id })
        .first('id', 'first_name', 'last_name', 'email')) as
        | {
            id: string
            first_name?: string | null
            last_name?: string | null
            email?: string | null
          }
        | undefined
      if (!r) return []
      const name =
        [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email || 'Person'
      return [
        {
          ref: { kind: 'caller', id: `u${String(r.id).toUpperCase()}`, label: name },
          label: name,
          hint: 'Person (as a caller)'
        }
      ]
    })(),
    (async () => {
      const t = getTrace(id)
      return t
        ? [
            {
              ref: { kind: 'trace', id, label: `${t.method} ${t.route}` },
              label: `${t.method} ${t.route}`,
              hint: `Kept trace on this API process · ${t.total_ms} ms`
            }
          ]
        : []
    })(),
    (async () => {
      const r = (await db('nivaro_flow_runs')
        .where({ id })
        .first('id', 'status', 'trigger', 'started_at')) as
        | { status: string | null; trigger: string | null; started_at: Date }
        | undefined
      return r
        ? [
            {
              ref: { kind: 'flow', id, at: ms(r.started_at) },
              label: `Flow run · ${r.status ?? 'unknown'}`,
              hint: `Flow run${r.trigger ? ` (${r.trigger})` : ''}`
            }
          ]
        : []
    })()
  ]
  return (await Promise.all(tasks.map((t) => safe(t, [])))).flat()
}

async function searchInt(n: number): Promise<SearchResult[]> {
  const int32 = n <= INT32_MAX
  const id = String(n)
  const tasks: Array<Promise<SearchResult[]>> = [
    (async () => {
      if (!int32) return []
      const r = (await db('nivaro_activity')
        .where({ id: n })
        .first('action', 'collection', 'item', 'timestamp')) as
        | { action: string; collection: string | null; item: string | null; timestamp: Date }
        | undefined
      if (!r) return []
      const label = `${r.action} ${r.collection ?? ''} ${r.item ?? ''}`.trim()
      return [
        { ref: { kind: 'write', id, label, at: ms(r.timestamp) }, label, hint: `Activity ${id}` }
      ]
    })(),
    (async () => {
      if (!int32) return []
      const r = (await db('nivaro_job_runs')
        .where({ id: n })
        .first('job_id', 'status', 'started_at')) as
        | { job_id: string; status: string; started_at: Date }
        | undefined
      return r
        ? [
            {
              ref: { kind: 'job', id, label: r.job_id, at: ms(r.started_at) },
              label: `${r.job_id} · ${r.status}`,
              hint: `Job run ${id}`
            }
          ]
        : []
    })(),
    (async () => {
      if (!int32) return []
      const r = (await db('nivaro_erp_submissions')
        .where({ id: n })
        .first('status', 'collection', 'item', 'created_at')) as
        | { status: string; collection: string | null; item: string | null; created_at: Date }
        | undefined
      return r
        ? [
            {
              ref: { kind: 'submission', id, at: ms(r.created_at) },
              label: `Partner push ${id} · ${r.status}`,
              hint: `${r.collection ?? ''} ${r.item ?? ''}`.trim() || 'Partner push'
            }
          ]
        : []
    })(),
    (async () => {
      if (!int32) return []
      const r = (await db('nivaro_issues')
        .where({ id: n })
        .first('title', 'status', 'last_seen_at')) as
        | { title: string; status: string; last_seen_at: Date }
        | undefined
      return r
        ? [
            {
              ref: { kind: 'issue', id, at: ms(r.last_seen_at) },
              label: String(r.title).slice(0, 140),
              hint: `Issue ${id} · ${r.status}`
            }
          ]
        : []
    })(),
    (async () => {
      const r = (await db('nivaro_ai_calls')
        .where({ id })
        .first('feature', 'model', 'created_at')) as
        | { feature: string | null; model: string | null; created_at: Date }
        | undefined
      return r
        ? [
            {
              ref: { kind: 'ai', id, at: ms(r.created_at) },
              label: `AI call · ${r.feature ?? 'unknown'}`,
              hint: `AI call ${id}${r.model ? ` · ${r.model}` : ''}`
            }
          ]
        : []
    })()
  ]
  return (await Promise.all(tasks.map((t) => safe(t, [])))).flat()
}

async function searchEmail(email: string): Promise<SearchResult[]> {
  const rows = (await db('nivaro_users')
    .whereRaw('LOWER(email) = ?', [email])
    .limit(5)
    .select('id', 'first_name', 'last_name', 'email', 'status')) as Array<{
    id: string
    first_name?: string | null
    last_name?: string | null
    email: string
    status?: string | null
  }>
  return rows.map((r) => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email
    return {
      ref: { kind: 'caller', id: `u${String(r.id).toUpperCase()}`, label: name },
      label: name,
      hint: `Person · ${r.email}${r.status && r.status !== 'active' ? ` · ${r.status}` : ''}`
    }
  })
}

/** A registered business collection (never nivaro_* / directus_*). */
async function isBusinessCollection(collection: string): Promise<boolean> {
  if (!IDENT_RE.test(collection) || /^(nivaro|directus)_/.test(collection)) return false
  const row = await db('nivaro_collections').where({ collection }).first('collection')
  return !!row
}

async function searchRecord(collection: string, id: string): Promise<SearchResult[]> {
  if (!(await isBusinessCollection(collection))) return []
  const { resolveFriendlyId } = await import('../workflow-transitions.js')
  let found: string | null = null
  if (/^\d{1,10}$/.test(id) || isUuid(id)) {
    const hit = await safe(db(collection).where({ id }).first('id'), undefined)
    if (hit) found = String((hit as { id: unknown }).id)
  }
  if (!found) {
    const { resolveAliasId } = await import('../items.js')
    const alias = await safe(resolveAliasId(collection, id), null)
    if (alias != null) found = String(alias)
  }
  if (!found) return []
  const friendly = await safe(resolveFriendlyId(collection, found), found)
  return [
    {
      ref: { kind: 'record', id: `${collection}:${found}`, label: `${collection} ${friendly}` },
      label: `${collection} ${friendly}`,
      hint: 'Record'
    }
  ]
}

async function searchFriendly(value: string): Promise<SearchResult[]> {
  const { friendlyIdField, resolveFriendlyId } = await import('../workflow-transitions.js')
  const fromCollections = (await safe(
    db('nivaro_collections').whereNotNull('friendly_id_field').select('collection'),
    []
  )) as Array<{ collection: string }>
  const fromRooms = (await safe(
    db('nivaro_chat_room_types').where({ is_active: true }).select('collection'),
    []
  )) as Array<{ collection: string }>
  const collections = [...new Set([...fromCollections, ...fromRooms].map((r) => r.collection))]
    .filter((c) => typeof c === 'string' && IDENT_RE.test(c) && !/^(nivaro|directus)_/.test(c))
    .slice(0, 8)
  const out: SearchResult[] = []
  await Promise.all(
    collections.map(async (c) => {
      const field = await safe(friendlyIdField(c), null)
      if (!field || !IDENT_RE.test(field)) return
      const rows = (await safe(db(c).where(field, value).limit(5).select('id'), [])) as Array<{
        id: unknown
      }>
      for (const r of rows) {
        const id = String(r.id)
        const friendly = await safe(resolveFriendlyId(c, id), value)
        out.push({
          ref: { kind: 'record', id: `${c}:${id}`, label: `${c} ${friendly}` },
          label: `${c} ${friendly}`,
          hint: `Record (${field})`
        })
      }
    })
  )
  return out
}

function searchRoute(method: string | null, path: string): SearchResult[] {
  const out: SearchResult[] = []
  if (path === '/api' || path.startsWith('/api/') || path === '/graphql' || path === '/files') {
    const c = classifyRequest({ method: method ?? 'GET', path })
    if (c) {
      const key = entityKey(c.lane, c.entity)
      out.push({
        ref: { kind: 'entity', id: key, label: `${c.lane} · ${c.entity}` },
        label: `${c.lane} · ${c.entity}`,
        hint: 'Map node (route family)'
      })
    }
    return out
  }
  const page = normalizeScreenPath(path)
  if (page)
    out.push({
      ref: { kind: 'page', id: page, label: page },
      label: page,
      hint: 'Screen (page pattern)'
    })
  return out
}

/** Resolve a search box entry. Credentials are refused and never echoed. */
export async function searchInspect(raw: unknown): Promise<SearchResponse> {
  const cls = classifySearch(raw)
  if (cls.type === 'refused') return { q: null, type: 'refused', refused: cls.reason, results: [] }
  const q = typeof raw === 'string' ? raw.trim() : ''
  if (cls.type === 'empty') return { q, type: 'empty', results: [], hint: SEARCH_HINT }
  let rows: SearchResult[] = []
  switch (cls.type) {
    case 'uuid':
      rows = await searchUuid(cls.id)
      break
    case 'int':
      rows = await searchInt(cls.n)
      break
    case 'email':
      rows = await safe(searchEmail(cls.email), [])
      break
    case 'record':
      rows = await safe(searchRecord(cls.collection, cls.id), [])
      break
    case 'route':
      rows = searchRoute(cls.method, cls.path)
      break
    case 'friendly':
      rows = await safe(searchFriendly(cls.value), [])
      break
    default:
      rows = []
  }
  const results = finishResults(rows)
  return results.length
    ? { q, type: cls.type, results }
    : { q, type: cls.type, results, hint: SEARCH_HINT }
}

registerInspectSource({
  kind: 'search',
  validId: (id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 200,
  async peek(id) {
    const cls = classifySearch(id)
    return { title: cls.type === 'refused' ? 'Search' : `Search · ${id.trim()}`, lines: [] }
  },
  detail: (id) => searchInspect(id)
})
