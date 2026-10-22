import type { CatalogFault, FaultTarget, HypothesisRule, ParamSpec } from '../api'

/**
 * The experiment builder's model (#2844): one draft experiment, how it starts from a fault, a
 * preset or a deep link, the caps it must stay inside, and the words the summary uses. Pure —
 * the component and the tests share it.
 *
 * Deep link (Traffic Map "Inject fault here", the resilience matrix, Ask AI's draft):
 *   /chaos?tab=builder&fault=<key>
 *   /chaos?tab=builder&preset=<key>
 *   /chaos?tab=builder&spec=<encodeURIComponent(JSON {fault_key, target, params, seconds, hypothesis, note})>
 * `spec` wins over the preset's own spec, which wins over the fault's defaults.
 */

export type ParamValue = number | string | boolean

export interface DraftSpec {
  fault_key: string
  target: FaultTarget
  params: Record<string, ParamValue>
  seconds: number
  hypothesis: HypothesisRule[]
  note: string
}

/**
 * Per-environment caps (#2862, `effective_caps` of GET /chaos/settings). null or missing = no
 * cap beyond the catalog's. The server applies the same caps (services/chaos/caps.ts applyCaps)
 * whatever the builder sends; the builder only keeps its sliders inside them.
 */
export interface ChaosCaps {
  allowed_faults?: string[] | '*'
  max_share_pct?: number | null
  max_latency_ms?: number | null
  max_seconds?: number | null
  max_replicas?: number | null
}

/** Whether the share cap turns a run on everything into a share (the server does the same). */
export function shareCapNarrowsAll(fault: CatalogFault, caps: ChaosCaps | null): boolean {
  return caps?.max_share_pct != null && caps.max_share_pct < 100 && fault.targets.includes('share')
}

export const TARGET_LABEL: Record<FaultTarget['kind'], string> = {
  all: 'Everything',
  route: 'Routes',
  table: 'A table',
  user: 'One person',
  share: 'A share of traffic',
  node: 'One replica',
  room: 'A socket room'
}

/** Built-in samplers (#2828), used until the server lists its own. */
export const BUILTIN_SAMPLERS: Array<{ key: string; label: string; unit: string }> = [
  { key: 'http.p95_ms', label: 'Request p95', unit: 'ms' },
  { key: 'http.5xx_pct', label: 'Server errors', unit: '%' },
  { key: 'http.rps', label: 'Requests per second', unit: 'req/s' },
  { key: 'pool.main_wait_p95_ms', label: 'Main pool wait p95', unit: 'ms' },
  { key: 'pool.background_wait_p95_ms', label: 'Background pool wait p95', unit: 'ms' },
  { key: 'loop.lag_ms', label: 'Event-loop lag', unit: 'ms' },
  { key: 'gate.queue', label: 'Heavy-read queue', unit: 'waiting' },
  { key: 'socket.reconnects', label: 'Socket reconnects', unit: 'per min' },
  { key: 'records.save_failures', label: 'Failed saves', unit: 'per min' }
]

/** The hypothesis watcher's rule (SEAM §6): a sample every 5 s, three breaches in a row abort. */
export const SAMPLE_EVERY_S = 5
export const BREACHES_TO_ABORT = 3

const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** A latency-like number param (the #2862 latency cap applies to it). */
export function isLatencyParam(spec: ParamSpec): boolean {
  return spec.type === 'number' && spec.unit === 'ms'
}

/** The effective [min, max] of a number param under the caps. */
export function paramRange(spec: ParamSpec, caps: ChaosCaps | null): [number, number] {
  if (spec.type !== 'number') return [0, 0]
  let max = spec.max
  if (caps?.max_latency_ms != null && isLatencyParam(spec))
    max = Math.max(spec.min, Math.min(max, caps.max_latency_ms))
  return [spec.min, max]
}

export function maxSeconds(fault: CatalogFault, caps: ChaosCaps | null): number {
  return caps?.max_seconds != null
    ? Math.max(5, Math.min(fault.max_seconds, caps.max_seconds))
    : fault.max_seconds
}

export function maxShare(caps: ChaosCaps | null): number {
  return caps?.max_share_pct != null ? clampN(caps.max_share_pct, 1, 100) : 100
}

/** Whether the caps allow this fault at all. */
export function faultAllowed(fault: CatalogFault, caps: ChaosCaps | null): boolean {
  const a = caps?.allowed_faults
  return !a || a === '*' || a.includes(fault.key)
}

function defaultTarget(fault: CatalogFault, nodes: string[]): FaultTarget {
  const kind = fault.targets[0] ?? 'all'
  return emptyTarget(kind, nodes)
}

export function emptyTarget(kind: FaultTarget['kind'], nodes: string[] = []): FaultTarget {
  switch (kind) {
    case 'route':
      return { kind, pattern: '' }
    case 'table':
      return { kind, table: '' }
    case 'user':
      return { kind, user_id: '', name: null }
    case 'share':
      return { kind, share_pct: 10 }
    case 'node':
      return { kind, node: nodes[0] ?? '' }
    case 'room':
      return { kind, room: '' }
    default:
      return { kind: 'all' }
  }
}

function defaultParams(fault: CatalogFault): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const [k, s] of Object.entries(fault.params)) {
    if (s.type === 'string') out[k] = s.default ?? ''
    else out[k] = s.default
  }
  return out
}

/** Partial spec as a preset or a deep link carries it. */
export interface SpecLike {
  fault_key?: string
  target?: FaultTarget | null
  params?: Record<string, ParamValue> | null
  seconds?: number | null
  hypothesis?: HypothesisRule[] | null
  note?: string | null
}

/** A draft for `fault`, layering a preset's spec and then a deep link's spec over the defaults. */
export function initialDraft(
  fault: CatalogFault,
  layers: Array<SpecLike | null | undefined>,
  nodes: string[] = [],
  caps: ChaosCaps | null = null
): DraftSpec {
  const d: DraftSpec = {
    fault_key: fault.key,
    target: defaultTarget(fault, nodes),
    params: defaultParams(fault),
    seconds: fault.default_seconds,
    hypothesis: fault.hypothesis_defaults.map((r) => ({ ...r })),
    note: ''
  }
  for (const l of layers) {
    if (!l || (l.fault_key && l.fault_key !== fault.key)) continue
    if (l.target && fault.targets.includes(l.target.kind)) d.target = { ...l.target }
    if (l.params)
      for (const k of Object.keys(fault.params)) if (k in l.params) d.params[k] = l.params[k]
    if (l.seconds != null) d.seconds = Number(l.seconds)
    if (Array.isArray(l.hypothesis)) d.hypothesis = l.hypothesis.map((r) => ({ ...r }))
    if (l.note) d.note = String(l.note)
  }
  return clampDraft(d, fault, caps)
}

/** Keep every number inside the catalog caps and the environment caps. */
export function clampDraft(d: DraftSpec, fault: CatalogFault, caps: ChaosCaps | null): DraftSpec {
  const params = { ...d.params }
  for (const [k, s] of Object.entries(fault.params)) {
    if (s.type !== 'number') continue
    const [lo, hi] = paramRange(s, caps)
    const n = Number(params[k])
    params[k] = Number.isFinite(n) ? clampN(n, lo, hi) : s.default
  }
  const target: FaultTarget =
    d.target.kind === 'share'
      ? { ...d.target, share_pct: clampN(Number(d.target.share_pct) || 1, 1, maxShare(caps)) }
      : d.target.kind === 'all' && shareCapNarrowsAll(fault, caps)
        ? { kind: 'share', share_pct: maxShare(caps) }
        : d.target
  return {
    ...d,
    target,
    params,
    seconds: Math.round(
      clampN(Number(d.seconds) || fault.default_seconds, 5, maxSeconds(fault, caps))
    )
  }
}

/** A route template from the Traffic Map (`GET /api/items/orders/:id`) as a target pattern. */
export function routePattern(template: string): string {
  const path = template.replace(/^[A-Z]+\s+/, '').split('?')[0]
  return path
    .split('/')
    .map((seg) => (seg.startsWith(':') || seg === '{id}' ? '*' : seg))
    .join('/')
}

/** Why the draft cannot run yet, step by step (empty = ready). */
export function draftIssues(
  d: DraftSpec,
  fault: CatalogFault,
  caps: ChaosCaps | null
): Partial<Record<StepId, string>> {
  const out: Partial<Record<StepId, string>> = {}
  if (!faultAllowed(fault, caps)) out.fault = 'This environment does not allow this fault.'
  const t = d.target
  if (t.kind === 'route' && !/^\/[\w./*:-]{0,200}$/.test(t.pattern))
    out.target = 'Pick a route or type a path starting with /'
  if (t.kind === 'table' && !t.table) out.target = 'Pick a table.'
  if (t.kind === 'user' && !/^[0-9a-f-]{36}$/i.test(t.user_id)) out.target = 'Pick a person.'
  if (t.kind === 'node' && !t.node) out.target = 'Pick a replica.'
  if (t.kind === 'room' && !t.room.trim()) out.target = 'Name a room.'
  for (const [k, s] of Object.entries(fault.params)) {
    if (s.type === 'enum' && !s.options.includes(String(d.params[k])))
      out.strength = `${s.label}: choose one of the options.`
  }
  const bad = d.hypothesis.find((r) => !r.sampler || !Number.isFinite(r.limit))
  if (bad) out.hypothesis = 'Every line needs a sampler and a number.'
  return out
}

export type StepId =
  | 'fault'
  | 'target'
  | 'strength'
  | 'duration'
  | 'hypothesis'
  | 'abort'
  | 'blast'
  | 'preflight'

export const STEPS: Array<{ id: StepId; label: string }> = [
  { id: 'fault', label: 'Fault' },
  { id: 'target', label: 'Target' },
  { id: 'strength', label: 'Strength' },
  { id: 'duration', label: 'Duration' },
  { id: 'hypothesis', label: 'What stays true' },
  { id: 'abort', label: 'Abort limits' },
  { id: 'blast', label: 'Blast radius' },
  { id: 'preflight', label: 'Pre-flight' }
]

export function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m ${r}s` : `${m}m`
}

/** The target in words for the summary and the confirm button. */
export function targetWords(t: FaultTarget): string {
  switch (t.kind) {
    case 'all':
      return 'everything'
    case 'route':
      return t.pattern ? `routes ${t.pattern}` : 'some routes'
    case 'table':
      return t.table ? `table ${t.table}` : 'a table'
    case 'user':
      return t.name || 'one person'
    case 'share':
      return `${t.share_pct}% of traffic`
    case 'node':
      return t.node ? `replica ${t.node}` : 'one replica'
    case 'room':
      return t.room ? `room ${t.room}` : 'a room'
  }
}

export function paramWords(fault: CatalogFault, params: Record<string, ParamValue>): string {
  const parts: string[] = []
  for (const [k, s] of Object.entries(fault.params)) {
    const v = params[k]
    // A switch reads as its label when on and drops out when off ("Add jitter", not "Add jitter on").
    if (s.type === 'boolean') {
      if (v) parts.push(s.label)
    } else if (s.type === 'number') parts.push(`${s.label} ${v}${s.unit ? ` ${s.unit}` : ''}`)
    else if (v !== '' && v != null) parts.push(`${s.label} ${v}`)
  }
  return parts.join(' · ')
}

/** The line where a rule aborts the run: limit pushed out by its tolerance. */
export function abortLine(r: HypothesisRule): number {
  const tol = r.tolerance ?? 0
  return r.op === '<' || r.op === '<=' ? r.limit + tol : r.limit - tol
}

const OP_SYMBOL: Record<HypothesisRule['op'], string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥' }

/** One steady-state line in words: "Request p95 < 2500 ms". */
export function ruleWords(r: HypothesisRule, label: string, unit: string): string {
  const u = !unit ? '' : unit === '%' ? '%' : ` ${unit}`
  return `${label} ${OP_SYMBOL[r.op] ?? r.op} ${r.limit}${u}`
}

/** A Traffic Map dependency node as people name it ("ext:7" → "partner #7"). */
export function mapNodeLabel(node: string): string {
  const names: Record<string, string> = {
    db: 'the database',
    redis: 'Redis',
    mail: 'mail',
    store: 'file storage',
    ai: 'the AI provider',
    signin: 'sign-in'
  }
  if (names[node]) return names[node]
  const ext = /^ext:(\d+)$/.exec(node)
  return ext ? `partner #${ext[1]}` : node
}

/** The Traffic Map dependency node simulate-down works out for this fault, if any. */
export function mapNodeFor(fault: CatalogFault, params: Record<string, ParamValue>): string | null {
  const byKey: Record<string, string> = { redis_pause: 'redis', mail_down: 'mail' }
  if (byKey[fault.key]) return byKey[fault.key]
  for (const name of ['external_api_id', 'api_id', 'partner_id']) {
    const v = Number(params[name])
    if (Number.isInteger(v) && v > 0) return `ext:${v}`
  }
  const byArea: Record<string, string> = {
    db: 'db',
    redis: 'redis',
    storage: 'store',
    files: 'store',
    mail: 'mail',
    ai: 'ai',
    oidc: 'signin',
    signin: 'signin'
  }
  if (fault.area && byArea[fault.area]) return byArea[fault.area]
  const k = fault.key
  if (k.startsWith('db_') || k.startsWith('pool_')) return 'db'
  if (k.startsWith('redis_')) return 'redis'
  if (k.startsWith('storage_') || k.startsWith('files_')) return 'store'
  if (k.startsWith('ai_')) return 'ai'
  if (k.startsWith('oidc_') || k.startsWith('signin_')) return 'signin'
  return null
}

/** Deep-link spec from `?spec=` (tolerant: a bad value is ignored). */
export function parseSpecParam(raw: string | null): SpecLike | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as SpecLike
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/** The builder link for a spec (used by Presets "Run" and anyone else). */
export function builderHref(opts: { fault?: string; preset?: string; spec?: SpecLike }): string {
  const q = new URLSearchParams({ tab: 'builder' })
  if (opts.fault) q.set('fault', opts.fault)
  if (opts.preset) q.set('preset', opts.preset)
  if (opts.spec) q.set('spec', JSON.stringify(opts.spec))
  return `/chaos?${q.toString()}`
}

/** A preset key from a label: lower-case words joined by dashes. */
export function slugKey(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** The body the run and preset endpoints take. */
export function runBody(d: DraftSpec) {
  return {
    fault_key: d.fault_key,
    target: d.target,
    params: d.params,
    seconds: d.seconds,
    hypothesis: d.hypothesis,
    note: d.note.trim() || null
  }
}
