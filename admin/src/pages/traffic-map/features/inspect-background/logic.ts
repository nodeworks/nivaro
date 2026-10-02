/**
 * Pure helpers for the background investigation panels (AI call, job run, flow run, partner
 * push): wire types of the server details, formatting, tones, and the small decisions the
 * panels and footers make (which run a ref carries, which down node is a partner). No React.
 */

export interface PersonRef {
  id: string
  name: string
}

export interface AiDetail {
  id: string
  created_at: string | null
  request_id: string | null
  calls_in_request: number
  user: PersonRef | null
  feature: string | null
  route: string | null
  provider: string | null
  model: string | null
  status: string | null
  latency_ms: number | null
  tokens: {
    input: number | null
    output: number | null
    cache_read: number | null
    cache_write: number | null
  }
  cost_usd: number | null
  stop_reason: string | null
  tool_calls: number | null
  rounds: number | null
  request: {
    system: string | null
    tools: string[]
    messages: Array<{ role: string; text: string }>
  } | null
  request_raw: string | null
  response_text: string | null
  error: string | null
  kept_days: number
}

export interface AiCallRow {
  id: string
  created_at: string | null
  feature: string | null
  model: string | null
  status: string | null
  latency_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  tool_calls: number | null
}

export interface ChainWrite {
  id: number
  action: string
  collection: string | null
  item: string | null
  at: string | null
  user: PersonRef | null
}

export interface ChainFlowRun {
  id: string
  flow_id: string | null
  flow_name: string | null
  status: string | null
  trigger: string | null
  started_at: string | null
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

export interface JobDetail {
  id: string
  kind: string
  job_id: string
  label: string | null
  extension_id: string | null
  description: string | null
  registry: {
    expression: string | null
    next_run: string | null
    paused: boolean
    heavy: boolean
    idempotent: string
  } | null
  registered: boolean | null
  status: string | null
  trigger_kind: string | null
  triggered_by: PersonRef | null
  instance: string | null
  instance_id: string | null
  this_node: boolean
  lease_holder: string | null
  ticks_enabled: boolean | null
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  progress: unknown
  outcome: string | null
  error: string | null
  chain_id: string | null
  writes: { rows: ChainWrite[]; total: number; via: 'chain' | 'window' | null }
  flows: ChainFlowRun[]
  submissions: SubmissionRow[]
}

export interface FlowOperation {
  key: string
  name: string | null
  type: string | null
  next: string | null
  on_reject: string | null
  halted: boolean
  failed: boolean
}

export interface FlowDetail {
  id: string
  flow: {
    id: string
    name: string | null
    active: boolean
    trigger_type: string | null
    description: string | null
  } | null
  trigger: string | null
  status: string | null
  started_at: string | null
  completed_at: string | null
  duration_ms: number | null
  ops_run: number | null
  matched: boolean | null
  halted_at: string | null
  error: string | null
  user: PersonRef | null
  input: unknown
  output: unknown
  operations: FlowOperation[]
  trace: null
  chain_id: string | null
  chain_parent: string | null
  job: { id: string; job_id: string } | null
  submissions: SubmissionRow[]
}

export interface FlowTestStep {
  key: string
  name: string
  type: string
  status: 'resolve' | 'reject' | 'async'
  preview?: unknown
}

export interface Requester {
  kind: string
  basis: 'recorded' | 'inferred' | 'none'
  label: string
  user: { id: string; name: string; email: string | null; inactive: string | null } | null
  via: string | null
  how: string | null
}

export interface ShapedAttempt {
  attempt: number
  status: string
  http_status: number | null
  error: string | null
  source: string
  at: string | null
  endpoint_path: string | null
  payload: unknown
  response: unknown
  masked: boolean
}

export interface SubmissionDetail {
  id: string
  collection: string | null
  item: string | null
  record_label: string | null
  status: string | null
  error_class: string | null
  last_error: string | null
  external_ref: string | null
  attempts_count: number | null
  created_at: string | null
  updated_at: string | null
  endpoint_path: string | null
  payload: unknown
  response: unknown
  chain_id: string | null
  chain_parent: string | null
  requested_by: string | null
  requested_via: string | null
  partner: { id: number | null; name: string | null; owner: { id: string; name: string } | null }
  endpoint: { method: string; path: string | null }
  obligation: {
    id: number
    kind: string
    outcome: string
    reason: string | null
    due_at: string | null
    resolved_at: string | null
    trigger: string
    trigger_ref: string | null
    open: boolean
  } | null
  trigger: { kind: string; label: string; link: string | null; source: string }
  triggered_by: Requester
  attempt_requesters: Array<{ attempt: number; requester: Requester }>
  call_logs: Array<{
    id: number
    created_at: string
    method: string | null
    url: string | null
    status: number | null
    duration_ms: number | null
    error: string | null
    triggered_by: string | null
    user: { id: string; name: string } | null
  }>
  retry: { eligible: boolean; reason: string | null; warning: string | null }
  attempts: { attempts: ShapedAttempt[]; total: number; unrecorded: number } | null
  attempts_reason: string | null
}

/** Background run kinds a traffic event's `run` can name. */
export function runKindOf(run: unknown): 'cron' | 'flow' | null {
  if (typeof run !== 'string') return null
  if (run.startsWith('cron:') && run.length > 5) return 'cron'
  if (run.startsWith('flow:') && run.length > 5) return 'flow'
  return null
}

/**
 * The `run` a level's detail carries (a write made by a cron tick, a request a flow ran
 * inside…): top level, or under `event` / `source`. null when none.
 */
export function runOfDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  for (const v of [d.run, (d.event as Record<string, unknown> | undefined)?.run, d.source_id]) {
    if (runKindOf(v)) return v as string
  }
  const src = d.source as Record<string, unknown> | string | undefined
  if (typeof src === 'string' && runKindOf(src)) return src
  if (src && typeof src === 'object' && runKindOf(src.id)) return src.id as string
  // A write / step a cron tick made directly carries its chain step `cron:<job>`.
  if (typeof d.chain_parent === 'string' && d.chain_parent.startsWith('cron:'))
    return runKindOf(d.chain_parent) ? d.chain_parent : null
  return null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A detail whose chain step is a flow run (`flow_run:<run id>`) names that run exactly. */
export function flowRunOfDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') return null
  const cp = (detail as Record<string, unknown>).chain_parent
  if (typeof cp !== 'string' || !cp.startsWith('flow_run:')) return null
  const id = cp.slice('flow_run:'.length)
  return UUID.test(id) ? id.toLowerCase() : null
}

/** `ext:<api id>` down node → the external API id; null for any other node. */
export function apiIdOfDown(id: unknown): number | null {
  if (typeof id !== 'string') return null
  const m = /^ext:(\d{1,9})$/.exec(id)
  return m ? Number(m[1]) : null
}

/**
 * A down node that receives partner pushes: `ext:<api id>`, or an extension-declared node
 * (`x:<extension>.<id>`, which the server resolves to its APIs by name). Databases, caches and
 * the like never do.
 */
export function isPartnerDown(id: unknown): boolean {
  if (typeof id !== 'string') return false
  return apiIdOfDown(id) != null || /^x:[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/.test(id)
}

/**
 * The moment a level's detail is about, as epoch ms: `timestamp` / `at` / `created_at` / `t`,
 * as ISO text or a number (top level, else under `event`). null when the detail names none —
 * the caller must not fall back to "now".
 */
export function timeOfDetail(detail: unknown): number | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  const ev = d.event && typeof d.event === 'object' ? (d.event as Record<string, unknown>) : null
  for (const v of [d.timestamp, d.at, d.created_at, d.t, ev?.timestamp, ev?.at, ev?.t]) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    if (typeof v === 'string' && v) {
      const t = Date.parse(v)
      if (Number.isFinite(t)) return t
    }
  }
  return null
}

/** "13 ms", "2.2 s", "3 min 4 s", "1 h 2 min"; "—" for nothing. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`
  const h = Math.floor(m / 60)
  return `${h} h ${m - h * 60} min`
}

/** "$0.0017" below a cent, "$1.24" above; "—" when unknown. */
export function fmtCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '—'
  if (usd === 0) return '$0'
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

export function fmtInt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString()
}

/** "14:02:31 · Oct 1" for an ISO time; "—" for none. */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.toTimeString().slice(0, 8)} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export function isoMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

export type Tone = 'ok' | 'bad' | 'warn' | 'neutral'

/** How a run / call / push status reads: success, failure, still going / partial, other. */
export function statusTone(status: string | null | undefined): Tone {
  const s = String(status ?? '').toLowerCase()
  if (['ok', 'completed', 'success', 'accepted', 'sent', 'resolve'].includes(s)) return 'ok'
  if (['error', 'failed', 'rejected', 'reject'].includes(s)) return 'bad'
  if (['running', 'pending', 'submitted', 'interrupted', 'skipped', 'async'].includes(s))
    return 'warn'
  return 'neutral'
}

const TRIGGER_WORDS: Record<string, string> = {
  schedule: 'On schedule',
  'run-now': 'Run now (someone clicked)',
  chained: 'Chained after another job',
  'catch-up': 'Catch-up after a missed tick',
  manual: 'Started by code (a route or remediation)'
}

/** A job run's trigger in words; rows written before migration 388 have none. */
export function triggerWords(kind: string | null | undefined): string {
  if (!kind) return 'Not recorded (run predates trigger tracking)'
  return TRIGGER_WORDS[kind] ?? kind
}

/** Why a job run looks the way it does, in one sentence, when that needs saying. */
export function jobStatusNote(
  d: Pick<JobDetail, 'status' | 'finished_at' | 'error'>
): string | null {
  const s = String(d.status ?? '')
  if (s === 'interrupted')
    return 'Interrupted: the process running it stopped (a restart or deploy) before it finished.'
  if (s === 'running' && !d.finished_at)
    return 'Still running, or its process stopped without closing the run.'
  if (s === 'error' && !d.error) return 'Failed without an error message.'
  return null
}

/** "update invoices 123" — a write in a list. */
export function writeLabel(w: Pick<ChainWrite, 'action' | 'collection' | 'item'>): string {
  return [w.action, w.collection, w.item].filter(Boolean).join(' ')
}

/** The plain-language answer for a 404 on one of this group's kinds. */
export function notFoundWhy(kind: string, id: string): string {
  switch (kind) {
    case 'ai':
      return `No AI call #${id}. The AI call log keeps 30 days; older calls are pruned.`
    case 'job':
      return `No job run #${id}. Run history keeps the newest 50 runs per job for 30 days; quiet jobs record only their failed ticks.`
    case 'flow':
      return 'No such flow run. Deleting a flow deletes its run history too.'
    case 'submission':
      return `No partner push #${id}.`
    default:
      return 'Nothing to show.'
  }
}

/** A JSON-ish value as indented text; strings as they are. */
export function prettyJson(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** True when the shown value hides at least one masked secret. */
export function hasMask(v: unknown): boolean {
  return prettyJson(v).includes('••••••')
}
