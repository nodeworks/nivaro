// api/src/services/traffic-inspect/background.ts
/**
 * Traffic Map drill-down, group "background" (#1195 #1196 #1197 #1198): the inspect sources for
 * the work no request carried — an AI call, a background job run, a flow run, a partner push.
 * Each reads its own log table (nivaro_ai_calls, nivaro_job_runs, nivaro_flow_runs,
 * nivaro_erp_submissions); the integration chain id on a row links it to the writes, flows and
 * pushes it caused. Every read beyond the row itself is best-effort: a missing optional column
 * or table leaves that part empty with a reason, never a failed panel.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { INTERNAL_DISPATCH_HEADER, internalDispatchTokens } from '../../plugins/api-logger.js'
import { AI_LOG_RETENTION_DAYS } from '../ai-log.js'
import { CRON_DESCRIPTIONS } from '../cron-descriptions.js'
import { INSTANCE_ID } from '../instance-roster.js'
import { buildSubmissionDetail, gatherSubmissionFacts } from '../submission-detail.js'
import { type InspectCtx, type InspectPeek, registerInspectSource } from '../traffic-inspect.js'
import { resolveFriendlyIds } from '../workflow-transitions.js'
import {
  aiRequestParts,
  aiResponseText,
  isDigitsId,
  iso,
  isUuid,
  maskedBody,
  ms,
  num,
  parseMaybeJson,
  parseRunSource,
  pickCoveringRun,
  type ShapedAttempts,
  shapeAttempts
} from './background-logic.js'

type Row = Record<string, unknown>

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v))
const lower = (v: unknown): string | null =>
  v == null || v === '' ? null : String(v).toLowerCase()

/** Display names for user ids (one read); unknown ids are left out. */
async function userNames(ids: Array<unknown>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((v): v is string => typeof v === 'string' && isUuid(v)))]
  if (!list.length) return new Map()
  const rows = (await db('nivaro_users')
    .whereIn('id', list)
    .select('id', 'first_name', 'last_name', 'email')
    .catch(() => [])) as Row[]
  return new Map(
    rows.map((r) => [
      String(r.id).toLowerCase(),
      [r.first_name, r.last_name].filter(Boolean).join(' ') || String(r.email ?? r.id)
    ])
  )
}

function person(id: unknown, names: Map<string, string>): { id: string; name: string } | null {
  if (typeof id !== 'string' || !id) return null
  return { id, name: names.get(id.toLowerCase()) ?? 'Unknown user' }
}

// ─── Chain neighbours (what a run caused) ───────────────────────────────────

const CHAIN_LIST_CAP = 50

export interface ChainWrite {
  id: number
  action: string
  collection: string | null
  item: string | null
  at: string | null
  user: { id: string; name: string } | null
}

/** Activity rows (= writes) stamped with one chain, newest first, plus the total. */
async function writesInChain(chainId: string): Promise<{ rows: ChainWrite[]; total: number }> {
  if (!(await hasColumn('nivaro_activity', 'chain_id').catch(() => false)))
    return { rows: [], total: 0 }
  const base = () => db('nivaro_activity').where('chain_id', chainId)
  const [rows, total] = await Promise.all([
    base()
      .orderBy('id', 'desc')
      .limit(CHAIN_LIST_CAP)
      .select('id', 'action', 'collection', 'item', 'timestamp', 'user')
      .catch(() => []) as Promise<Row[]>,
    base()
      .count({ n: '*' })
      .first()
      .catch(() => null) as Promise<Row | null>
  ])
  const names = await userNames(rows.map((r) => r.user))
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      action: String(r.action ?? ''),
      collection: str(r.collection),
      item: str(r.item),
      at: iso(r.timestamp),
      user: person(r.user, names)
    })),
    total: Number(total?.n ?? rows.length)
  }
}

/**
 * Writes a cron run made when the run recorded no chain id (rows written before migration 385):
 * activity whose chain step names the job (`cron:<job>`) inside the run's window.
 */
async function writesInWindow(
  job: string,
  started: number,
  finished: number | null
): Promise<{ rows: ChainWrite[]; total: number }> {
  if (!(await hasColumn('nivaro_activity', 'chain_parent').catch(() => false)))
    return { rows: [], total: 0 }
  const from = new Date(started - 1_000)
  const to = new Date((finished ?? Date.now()) + 1_000)
  const rows = (await db('nivaro_activity')
    .where('chain_parent', `cron:${job}`)
    .whereBetween('timestamp', [from, to])
    .orderBy('id', 'desc')
    .limit(CHAIN_LIST_CAP)
    .select('id', 'action', 'collection', 'item', 'timestamp', 'user')
    .catch(() => [])) as Row[]
  const names = await userNames(rows.map((r) => r.user))
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      action: String(r.action ?? ''),
      collection: str(r.collection),
      item: str(r.item),
      at: iso(r.timestamp),
      user: person(r.user, names)
    })),
    total: rows.length
  }
}

export interface ChainFlowRun {
  id: string
  flow_id: string | null
  flow_name: string | null
  status: string | null
  trigger: string | null
  started_at: string | null
}

async function flowRunsInChain(chainId: string): Promise<ChainFlowRun[]> {
  if (!(await hasColumn('nivaro_flow_runs', 'chain_id').catch(() => false))) return []
  const rows = (await db('nivaro_flow_runs as r')
    .leftJoin('nivaro_flows as f', 'f.id', 'r.flow')
    .where('r.chain_id', chainId)
    .orderBy('r.started_at', 'desc')
    .limit(CHAIN_LIST_CAP)
    .select('r.id', 'r.flow', 'f.name as flow_name', 'r.status', 'r.trigger', 'r.started_at')
    .catch(() => [])) as Row[]
  return rows.map((r) => ({
    id: String(r.id).toLowerCase(),
    flow_id: lower(r.flow),
    flow_name: str(r.flow_name),
    status: str(r.status),
    trigger: str(r.trigger),
    started_at: iso(r.started_at)
  }))
}

export interface SubmissionRow {
  id: number
  api_id: number | null
  api_name: string | null
  status: string | null
  error_class: string | null
  collection: string | null
  item: string | null
  created_at: string | null
}

async function submissionRows(
  build: (q: ReturnType<typeof db>) => unknown,
  limit = CHAIN_LIST_CAP
): Promise<SubmissionRow[]> {
  const errorClass = await hasColumn('nivaro_erp_submissions', 'error_class').catch(() => false)
  const q = db('nivaro_erp_submissions as s').leftJoin(
    'nivaro_external_apis as a',
    'a.id',
    's.external_api'
  )
  build(q)
  const rows = (await q
    .orderBy('s.id', 'desc')
    .limit(limit)
    .select(
      's.id',
      's.external_api',
      'a.name as api_name',
      's.status',
      's.collection',
      's.item',
      's.created_at',
      ...(errorClass ? ['s.error_class'] : [])
    )
    .catch(() => [])) as Row[]
  return rows.map((r) => ({
    id: Number(r.id),
    api_id: num(r.external_api),
    api_name: str(r.api_name),
    status: str(r.status),
    error_class: str(r.error_class),
    collection: str(r.collection),
    item: str(r.item),
    created_at: iso(r.created_at)
  }))
}

async function submissionsInChain(chainId: string): Promise<SubmissionRow[]> {
  if (!(await hasColumn('nivaro_erp_submissions', 'chain_id').catch(() => false))) return []
  return submissionRows((q) => q.where('s.chain_id', chainId))
}

/**
 * Partner pushes for a down node / chain / moment: by chain id when one is given (exact), else
 * by API inside `at ± windowSec` (newest first).
 */
export async function submissionsFor(opts: {
  apiId?: number | null
  chainId?: string | null
  at?: number | null
  windowSec?: number
  limit?: number
}): Promise<{ rows: SubmissionRow[]; matched_by: 'chain' | 'api-time' | null }> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20))
  if (opts.chainId && isUuid(opts.chainId)) {
    const rows = (await hasColumn('nivaro_erp_submissions', 'chain_id').catch(() => false))
      ? await submissionRows((q) => q.where('s.chain_id', opts.chainId as string), limit)
      : []
    if (rows.length || !opts.apiId) return { rows, matched_by: 'chain' }
  }
  if (opts.apiId != null && Number.isSafeInteger(opts.apiId) && opts.apiId > 0) {
    const at = opts.at ?? Date.now()
    const w = (opts.windowSec ?? 300) * 1000
    const rows = await submissionRows(
      (q) =>
        q
          .where('s.external_api', opts.apiId as number)
          .where('s.updated_at', '>=', new Date(at - w))
          .where('s.created_at', '<=', new Date(at + w)),
      limit
    )
    return { rows, matched_by: 'api-time' }
  }
  return { rows: [], matched_by: null }
}

// ─── AI call (#1195) ────────────────────────────────────────────────────────

async function aiDetail(id: string) {
  const row = (await db('nivaro_ai_calls').where({ id }).first()) as Row | undefined
  if (!row) return null
  const names = await userNames([row.user])
  const requestParsed = parseMaybeJson(maskedBody(row.request))
  const responseParsed = parseMaybeJson(maskedBody(row.response))
  const requestOk = requestParsed != null && typeof requestParsed === 'object'
  const rid = str(row.request_id)
  const siblings = rid
    ? Number(
        (
          (await db('nivaro_ai_calls')
            .where('request_id', rid)
            .count({ n: '*' })
            .first()
            .catch(() => null)) as Row | null
        )?.n ?? 1
      )
    : 1
  return {
    id: String(row.id),
    created_at: iso(row.created_at),
    request_id: rid,
    calls_in_request: siblings,
    user: person(row.user, names),
    feature: str(row.feature),
    route: str(row.route),
    provider: str(row.provider),
    model: str(row.model),
    status: str(row.status),
    latency_ms: num(row.latency_ms),
    tokens: {
      input: num(row.input_tokens),
      output: num(row.output_tokens),
      cache_read: num(row.cache_read_tokens),
      cache_write: num(row.cache_write_tokens)
    },
    cost_usd: num(row.cost_usd),
    stop_reason: str(row.stop_reason),
    tool_calls: num(row.tool_calls),
    rounds: num(row.rounds),
    request: requestOk ? aiRequestParts(requestParsed) : null,
    /** The stored prompt when it is not JSON any more (cut by the 48 KB cap). */
    request_raw: requestOk ? null : typeof requestParsed === 'string' ? requestParsed : null,
    response_text: responseParsed == null ? null : aiResponseText(responseParsed),
    error: str(row.error),
    kept_days: AI_LOG_RETENTION_DAYS
  }
}

async function aiPeek(id: string): Promise<InspectPeek | null> {
  const r = (await db('nivaro_ai_calls')
    .where({ id })
    .first('id', 'feature', 'model', 'status', 'latency_ms', 'cost_usd', 'created_at')) as
    | Row
    | undefined
  if (!r) return null
  const cost = num(r.cost_usd)
  return {
    title: `AI call #${r.id} · ${str(r.feature) ?? 'unknown feature'}`,
    lines: [
      `${str(r.model) ?? 'unknown model'} · ${str(r.status) ?? '?'}`,
      `${num(r.latency_ms) ?? '?'} ms${cost != null ? ` · $${cost.toFixed(4)}` : ''}`
    ],
    at: iso(r.created_at)
  }
}

/** Every AI call one request made (the request-trace id is the call log's request_id). */
export async function aiCallsForRequest(rid: string) {
  const rows = (await db('nivaro_ai_calls')
    .where('request_id', rid)
    .orderBy('id', 'asc')
    .limit(100)
    .select(
      'id',
      'created_at',
      'feature',
      'model',
      'status',
      'latency_ms',
      'input_tokens',
      'output_tokens',
      'cost_usd',
      'tool_calls'
    )
    .catch(() => [])) as Row[]
  return {
    calls: rows.map((r) => ({
      id: String(r.id),
      created_at: iso(r.created_at),
      feature: str(r.feature),
      model: str(r.model),
      status: str(r.status),
      latency_ms: num(r.latency_ms),
      input_tokens: num(r.input_tokens),
      output_tokens: num(r.output_tokens),
      cost_usd: num(r.cost_usd),
      tool_calls: num(r.tool_calls)
    })),
    kept_days: AI_LOG_RETENTION_DAYS
  }
}

// ─── Job run (#1196) ────────────────────────────────────────────────────────

interface RegistryEntry {
  id: string
  description?: string
  expression?: string
  nextRun?: Date | null
  paused?: boolean
  heavy?: boolean
  idempotent?: string
  extensionId?: string
}

function cronRegistry(req: FastifyRequest): RegistryEntry[] {
  try {
    const cron = (req.server as unknown as { cron?: { list(): RegistryEntry[] } }).cron
    return cron?.list() ?? []
  } catch {
    return []
  }
}

async function jobDetail(id: string, ctx: InspectCtx) {
  const row = (await db('nivaro_job_runs')
    .where({ id: Number(id) })
    .first()) as Row | undefined
  if (!row) return null
  const kind = String(row.kind ?? '')
  const jobId = String(row.job_id ?? '')
  const names = await userNames([row.triggered_by])
  const reg = kind === 'cron' ? cronRegistry(ctx.req).find((c) => c.id === jobId) : undefined
  const started = ms(row.started_at)
  const finished = ms(row.finished_at)
  const chainId = lower(row.chain_id)

  let writes: { rows: ChainWrite[]; total: number } = { rows: [], total: 0 }
  let writesVia: 'chain' | 'window' | null = null
  let flows: ChainFlowRun[] = []
  let submissions: SubmissionRow[] = []
  if (chainId) {
    ;[writes, flows, submissions] = await Promise.all([
      writesInChain(chainId),
      flowRunsInChain(chainId),
      submissionsInChain(chainId)
    ])
    writesVia = 'chain'
  } else if (kind === 'cron' && started != null) {
    writes = await writesInWindow(jobId, started, finished)
    writesVia = 'window'
  }

  const instanceId = str(row.instance_id)
  return {
    id: String(row.id),
    kind,
    job_id: jobId,
    label: str(row.label),
    extension_id: str(row.extension_id) ?? reg?.extensionId ?? null,
    description: reg?.description ?? CRON_DESCRIPTIONS[jobId] ?? null,
    registry: reg
      ? {
          expression: reg.expression ?? null,
          next_run: iso(reg.nextRun),
          paused: reg.paused ?? false,
          heavy: reg.heavy ?? false,
          idempotent: reg.idempotent ?? 'unknown'
        }
      : null,
    /** False for a cron job no process here has registered (renamed, removed, other node). */
    registered: kind === 'cron' ? !!reg : null,
    status: str(row.status),
    trigger_kind: str(row.trigger_kind),
    triggered_by: person(row.triggered_by, names),
    instance: str(row.instance),
    instance_id: instanceId,
    this_node: instanceId != null && instanceId === INSTANCE_ID,
    lease_holder: str(row.lease_holder),
    ticks_enabled:
      row.ticks_enabled == null ? null : row.ticks_enabled === true || row.ticks_enabled === 1,
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    duration_ms: num(row.duration_ms),
    progress: parseMaybeJson(row.progress),
    outcome: str(row.outcome),
    error: str(row.error),
    chain_id: chainId,
    writes: { ...writes, via: writesVia },
    flows,
    submissions
  }
}

async function jobPeek(id: string): Promise<InspectPeek | null> {
  const r = (await db('nivaro_job_runs')
    .where({ id: Number(id) })
    .first('id', 'kind', 'job_id', 'status', 'duration_ms', 'started_at')) as Row | undefined
  if (!r) return null
  const d = num(r.duration_ms)
  return {
    title: `${str(r.job_id) ?? 'Job'} · run #${r.id}`,
    lines: [`${str(r.kind) ?? 'job'} · ${str(r.status) ?? '?'}${d != null ? ` · ${d} ms` : ''}`],
    at: iso(r.started_at)
  }
}

/**
 * The run a background source id points at for a moment: `cron:<job>` → the job run covering
 * it, `flow:<flow id>` → the flow run covering it. null when nothing near it was recorded.
 */
export async function runForSource(
  source: string,
  at: number
): Promise<{
  kind: 'job' | 'flow'
  id: string
  covering: boolean
  started_at: string | null
} | null> {
  const parsed = parseRunSource(source)
  if (!parsed) return null
  const lo = new Date(at - 30 * 60_000)
  const hi = new Date(at + 5_000)
  if (parsed.kind === 'cron') {
    const rows = (await db('nivaro_job_runs')
      .where({ kind: 'cron', job_id: parsed.job })
      .whereBetween('started_at', [lo, hi])
      .orderBy('started_at', 'desc')
      .limit(200)
      .select('id', 'started_at', 'finished_at')
      .catch(() => [])) as Row[]
    const pick = pickCoveringRun(
      rows.map((r) => ({
        id: Number(r.id),
        started: ms(r.started_at) ?? 0,
        finished: ms(r.finished_at)
      })),
      at
    )
    return pick
      ? { kind: 'job', id: pick.id, covering: pick.covering, started_at: iso(pick.started) }
      : null
  }
  const rows = (await db('nivaro_flow_runs')
    .where('flow', parsed.flowId)
    .whereBetween('started_at', [lo, hi])
    .orderBy('started_at', 'desc')
    .limit(200)
    .select('id', 'started_at', 'completed_at')
    .catch(() => [])) as Row[]
  const pick = pickCoveringRun(
    rows.map((r) => ({
      id: String(r.id).toLowerCase(),
      started: ms(r.started_at) ?? 0,
      finished: ms(r.completed_at)
    })),
    at
  )
  return pick
    ? { kind: 'flow', id: pick.id, covering: pick.covering, started_at: iso(pick.started) }
    : null
}

// ─── Flow run (#1197) ───────────────────────────────────────────────────────

async function flowDetail(id: string) {
  const row = (await db('nivaro_flow_runs').where({ id }).first()) as Row | undefined
  if (!row) return null
  const flowId = String(row.flow ?? '')
  const [flow, ops, names] = await Promise.all([
    db('nivaro_flows')
      .where({ id: flowId })
      .first('id', 'name', 'status', 'trigger', 'description')
      .catch(() => null) as Promise<Row | null>,
    db('nivaro_flow_operations')
      .where({ flow: flowId })
      .orderBy('position_y')
      .orderBy('position_x')
      .select('id', 'key', 'name', 'type', 'resolve', 'reject')
      .catch(() => []) as Promise<Row[]>,
    userNames([row.user])
  ])
  const keyOf = new Map(ops.map((o) => [String(o.id).toLowerCase(), String(o.key)]))
  const haltedAt = str(row.halted_at)
  const chainId = lower(row.chain_id)
  const chainParent = str(row.chain_parent)
  let job: { id: string; job_id: string } | null = null
  let submissions: SubmissionRow[] = []
  if (chainId) {
    const [j, subs] = await Promise.all([
      (await hasColumn('nivaro_job_runs', 'chain_id').catch(() => false))
        ? (db('nivaro_job_runs')
            .where('chain_id', chainId)
            .orderBy('id', 'desc')
            .first('id', 'job_id')
            .catch(() => null) as Promise<Row | null>)
        : Promise.resolve(null),
      submissionsInChain(chainId)
    ])
    if (j) job = { id: String(j.id), job_id: String(j.job_id) }
    submissions = subs
  }
  const output = maskedBody(row.output)
  const status = str(row.status)
  return {
    id: String(row.id).toLowerCase(),
    flow: flow
      ? {
          id: String(flow.id).toLowerCase(),
          name: str(flow.name),
          active: String(flow.status ?? '') === 'active',
          trigger_type: str(flow.trigger),
          description: str(flow.description)
        }
      : null,
    trigger: str(row.trigger),
    status,
    started_at: iso(row.started_at),
    completed_at: iso(row.completed_at),
    duration_ms: num(row.duration_ms),
    ops_run: num(row.ops_run),
    matched: row.matched == null ? null : row.matched === true || row.matched === 1,
    halted_at: haltedAt,
    error: str(row.error_message),
    user: person(row.user, names),
    input: maskedBody(row.input),
    output,
    operations: ops.map((o) => ({
      key: String(o.key),
      name: str(o.name),
      type: str(o.type),
      next: o.resolve ? (keyOf.get(String(o.resolve).toLowerCase()) ?? null) : null,
      on_reject: o.reject ? (keyOf.get(String(o.reject).toLowerCase()) ?? null) : null,
      halted: haltedAt != null && String(o.key) === haltedAt,
      failed:
        status === 'error' &&
        typeof row.error_message === 'string' &&
        row.error_message.startsWith(`${String(o.key)}:`)
    })),
    /** The step-by-step trace is kept only for test runs answered live (never stored). */
    trace: null,
    chain_id: chainId,
    chain_parent: chainParent,
    job,
    submissions
  }
}

async function flowPeek(id: string): Promise<InspectPeek | null> {
  const r = (await db('nivaro_flow_runs as r')
    .leftJoin('nivaro_flows as f', 'f.id', 'r.flow')
    .where('r.id', id)
    .first('r.id', 'f.name as name', 'r.status', 'r.trigger', 'r.duration_ms', 'r.started_at')) as
    | Row
    | undefined
  if (!r) return null
  return {
    title: `Flow run · ${str(r.name) ?? 'deleted flow'}`,
    lines: [
      `${str(r.trigger) ?? '?'} · ${str(r.status) ?? '?'}${num(r.duration_ms) != null ? ` · ${num(r.duration_ms)} ms` : ''}`
    ],
    at: iso(r.started_at)
  }
}

// ─── Partner push / submission (#1198) ──────────────────────────────────────

/** The existing attempts route, answered in-process with the caller's own credentials. */
async function attemptsVia(
  req: FastifyRequest,
  id: string
): Promise<{ data: ShapedAttempts | null; reason: string | null }> {
  const token = randomUUID()
  try {
    const headers: Record<string, string> = { [INTERNAL_DISPATCH_HEADER]: token }
    for (const name of ['authorization', 'cookie', 'x-workspace']) {
      const v = req.headers[name]
      if (v) headers[name] = Array.isArray(v) ? v[0] : v
    }
    internalDispatchTokens.add(token)
    const res = await req.server.inject({
      method: 'GET',
      url: `/api/erp-submissions/${id}/attempts`,
      headers
    })
    if (res.statusCode !== 200)
      return { data: null, reason: `The attempts list answered ${res.statusCode}` }
    const body = res.json() as { data?: Parameters<typeof shapeAttempts>[0] }
    return { data: shapeAttempts(body?.data ?? {}), reason: null }
  } catch {
    return { data: null, reason: 'The attempts list could not be read' }
  } finally {
    internalDispatchTokens.delete(token)
  }
}

async function submissionDetailOf(id: string, ctx: InspectCtx) {
  const n = Number(id)
  const facts = await gatherSubmissionFacts(n, async (collection, item) => {
    const labels = await resolveFriendlyIds(collection, [item]).catch(() => new Map())
    return (labels.get(item) as string | undefined) ?? null
  })
  if (!facts) return null
  const raw = facts.raw
  const detail = buildSubmissionDetail(facts)
  const stored = parseMaybeJson(raw.payload) as { endpoint_path?: unknown; body?: unknown } | null
  const attempts = await attemptsVia(ctx.req, id)
  return {
    id: String(raw.id),
    collection: str(raw.collection),
    item: str(raw.item),
    record_label: facts.record_label ?? str(raw.item),
    status: str(raw.status),
    error_class: str(raw.error_class),
    last_error: str(raw.last_error),
    external_ref: str(raw.external_ref),
    attempts_count: num(raw.attempts),
    created_at: iso(raw.created_at),
    updated_at: iso(raw.updated_at),
    endpoint_path:
      stored && typeof stored === 'object' && typeof stored.endpoint_path === 'string'
        ? stored.endpoint_path
        : null,
    /** Masked for reading — Resend sends the stored payload, unmasked, as it was. */
    payload:
      stored && typeof stored === 'object' && 'body' in stored ? maskedBody(stored.body) : null,
    response: maskedBody(raw.response),
    chain_id: lower(raw.chain_id),
    chain_parent: str(raw.chain_parent),
    requested_by: str(raw.requested_by),
    requested_via: str(raw.requested_via),
    ...detail,
    attempts: attempts.data,
    attempts_reason: attempts.reason
  }
}

async function submissionPeek(id: string): Promise<InspectPeek | null> {
  const r = (await db('nivaro_erp_submissions as s')
    .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
    .where('s.id', Number(id))
    .first(
      's.id',
      'a.name as api',
      's.status',
      's.collection',
      's.item',
      's.last_error',
      's.created_at'
    )) as Row | undefined
  if (!r) return null
  const lines = [
    `${str(r.status) ?? '?'} · ${str(r.collection) ?? '?'} ${str(r.item) ?? ''}`.trim()
  ]
  const err = str(r.last_error)
  if (err) lines.push(err.slice(0, 140))
  return {
    title: `Push #${r.id} → ${str(r.api) ?? 'unknown partner'}`,
    lines,
    at: iso(r.created_at)
  }
}

// ─── Registration ───────────────────────────────────────────────────────────

registerInspectSource({
  kind: 'ai',
  validId: isDigitsId,
  peek: (id) => aiPeek(id),
  detail: (id) => aiDetail(id)
})

registerInspectSource({
  kind: 'job',
  validId: isDigitsId,
  peek: (id) => jobPeek(id),
  detail: (id, ctx) => jobDetail(id, ctx)
})

registerInspectSource({
  kind: 'flow',
  validId: isUuid,
  peek: (id) => flowPeek(id),
  detail: (id) => flowDetail(id)
})

registerInspectSource({
  kind: 'submission',
  validId: isDigitsId,
  peek: (id) => submissionPeek(id),
  detail: (id, ctx) => submissionDetailOf(id, ctx)
})
