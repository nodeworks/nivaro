import { Liquid } from 'liquidjs'
import type { ImportIssue } from './import-templates.js'
import type { ImportHeaderRule, ImportLineConfig } from './import-templates-config.js'
import { registerPayloadFilters } from './workflow-actions.js'

// ─── Inbound mapping bench (#624 fixtures, #824 children, #825 responses) ───
// The parts of an inbound mapping that are not "map a payload and write it":
// nested child rules, saved partner payloads re-run on every rule edit, and
// the response envelope a partner already parses. Pure except the Liquid
// render, so the routes and the service share one definition of each.

// ── Children (#824) ─────────────────────────────────────────────────────────

/**
 * One nested one-to-many rule: rows found at `source` in the payload become
 * rows of the alias `target_field`, each mapped by `columns` (the import-
 * template line_map column format — `$resolved.*` reads the parent's mapped
 * values). On an upsert that updates, `append` adds the rows and `replace`
 * makes the child set exactly these rows.
 */
export interface InboundChildConfig {
  target_field: string
  source: string
  row_filter: ImportLineConfig['row_filter']
  columns: ImportHeaderRule[]
  on_update: 'append' | 'replace'
}

export function parseChildren(raw: unknown): InboundChildConfig[] {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(v)) return []
  return v.filter(
    (c): c is InboundChildConfig =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as InboundChildConfig).target_field === 'string' &&
      Array.isArray((c as InboundChildConfig).columns)
  )
}

/** Payload keys reachable by dotted path: `order.customer.name`. Arrays keep
 *  their key and value; their members are not flattened (children read them). */
export function flattenPayload(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, unknown> = {},
  depth = 0
): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (!(key in out)) out[key] = v
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && depth < 6)
      flattenPayload(v as Record<string, unknown>, key, out, depth + 1)
  }
  return out
}

/** Walk a dotted path (`order.lines`, `batches.0.items`). */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** The rows at a child's source: an array, or a single object as one row. */
export function childRowsAt(payload: unknown, source: string): Record<string, unknown>[] | null {
  const v = getPath(payload, source)
  if (Array.isArray(v))
    return v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
  if (v && typeof v === 'object') return [v as Record<string, unknown>]
  return null
}

/** `lines[3]: reason — nothing was created` → { index: 3, message } */
export function parseNestedError(
  message: string,
  field: string
): { index: number | null; message: string } {
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^${esc}\\[(\\d+)\\]:\\s*`).exec(message)
  return m ? { index: Number(m[1]), message: message.slice(m[0].length) } : { index: null, message }
}

// ── Fixtures (#624) ─────────────────────────────────────────────────────────

export const FIXTURE_CAP = 20
export const FIXTURE_BYTES = 64 * 1024

/**
 * A named partner payload saved with the mapping. `expect` says what a
 * correct mapping does with it: `write` (every entry maps and would write) or
 * `reject` (at least one entry is refused — a known-bad payload kept as a
 * guard). `source_log_id` names the API log row it was taken from.
 */
export interface InboundFixture {
  id: string
  name: string
  payload: unknown
  expect: 'write' | 'reject'
  source_log_id: number | null
  saved_at: string
}

export function parseFixtures(raw: unknown): InboundFixture[] {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(v)) return []
  return v
    .filter(
      (f): f is InboundFixture =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as InboundFixture).id === 'string' &&
        typeof (f as InboundFixture).name === 'string'
    )
    .map((f) => ({ ...f, expect: f.expect === 'reject' ? 'reject' : 'write' }))
}

/** Why a fixture payload cannot be stored, or null. */
export function fixturePayloadProblem(payload: unknown): string | null {
  if (payload == null || typeof payload !== 'object')
    return 'The payload must be a JSON object or array'
  let size = 0
  try {
    size = JSON.stringify(payload).length
  } catch {
    return 'The payload is not serialisable JSON'
  }
  if (size > FIXTURE_BYTES) return `The payload is ${size} bytes — at most ${FIXTURE_BYTES}`
  return null
}

export interface BenchEntry {
  index: number
  action: string
  would?: string | null
  error?: string
  issues: ImportIssue[]
  child_error?: { field: string; index: number | null; message: string }
}

/** Green or red, with the sentence that says why. */
export function judgeFixture(
  expect: 'write' | 'reject',
  out: { results: BenchEntry[] }
): { pass: boolean; reason: string } {
  const entries = out.results
  if (entries.length === 0) return { pass: false, reason: 'The payload held no entries' }
  const refused = entries.filter((e) => e.action === 'rejected')
  const first = refused[0]
  const why = first ? describeRefusal(first) : ''
  if (expect === 'reject') {
    return refused.length > 0
      ? { pass: true, reason: `Refused as expected — ${why}` }
      : { pass: false, reason: 'Expected a refusal, but every entry would be written' }
  }
  if (refused.length > 0) {
    const more = refused.length > 1 ? ` (and ${refused.length - 1} more)` : ''
    return { pass: false, reason: `${why}${more}` }
  }
  const creates = entries.filter((e) => e.would !== 'update').length
  const updates = entries.length - creates
  const parts = [
    creates ? `${creates} would create` : '',
    updates ? `${updates} would update` : ''
  ].filter(Boolean)
  const warns = entries.flatMap((e) => e.issues).filter((i) => i.severity === 'warn').length
  return {
    pass: true,
    reason: `${parts.join(', ')}${warns ? ` · ${warns} warning${warns === 1 ? '' : 's'}` : ''}`
  }
}

function describeRefusal(e: BenchEntry): string {
  const label = `Entry ${e.index + 1}`
  if (e.child_error) {
    const row = e.child_error.index == null ? '' : ` row ${e.child_error.index + 1}`
    return `${label}: ${e.child_error.field}${row} — ${e.child_error.message}`
  }
  const issue = e.issues.find((i) => i.severity === 'error')
  if (issue) return `${label}: ${issue.message}`
  return `${label}: ${e.error ?? 'refused'}`
}

// ── Response shaping (#825) ─────────────────────────────────────────────────

export type InboundOutcome = 'success' | 'partial' | 'rejected'

export interface InboundResponseStatus {
  success?: number
  partial?: number
  rejected?: number
}

export const DEFAULT_STATUS: Required<InboundResponseStatus> = {
  success: 200,
  partial: 207,
  rejected: 422
}

export function parseResponseStatus(raw: unknown): InboundResponseStatus {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: InboundResponseStatus = {}
  for (const k of ['success', 'partial', 'rejected'] as const) {
    const n = Number((v as Record<string, unknown>)[k])
    if (Number.isInteger(n) && n >= 100 && n <= 599) out[k] = n
  }
  return out
}

/** Why a status map cannot be stored, or null. */
export function responseStatusProblem(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw))
    return 'response_status must be an object like {"success": 200}'
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!['success', 'partial', 'rejected'].includes(k))
      return `response_status: unknown outcome "${k}" (success, partial, rejected)`
    if (v == null || v === '') continue
    const n = Number(v)
    if (!Number.isInteger(n) || n < 100 || n > 599)
      return `response_status.${k} must be an HTTP status between 100 and 599`
  }
  return null
}

export function outcomeOf(out: {
  created: number
  updated: number
  rejected: number
}): InboundOutcome {
  if (out.rejected === 0) return 'success'
  return out.created + out.updated === 0 ? 'rejected' : 'partial'
}

const engine = new Liquid({ strictFilters: false, strictVariables: false })
registerPayloadFilters(engine)

/** Why a template does not parse, or null. */
export function templateProblem(template: string | null | undefined): string | null {
  if (!template) return null
  try {
    engine.parse(template)
    return null
  } catch (err) {
    return `response_template: ${err instanceof Error ? err.message : String(err)}`
  }
}

export interface ShapeInput {
  mapping: { key: string; collection: string }
  results: Array<BenchEntry & { id?: string | number | null; values?: Record<string, unknown> }>
  created: number
  updated: number
  rejected: number
  /** The record each entry wrote (or would write), parallel to results. */
  records: Array<Record<string, unknown> | null>
}

export interface ShapedResponse {
  status: number
  outcome: InboundOutcome
  /** Parsed JSON when the rendered text is JSON, else the text. */
  body: unknown
  content_type: string
  shaped: boolean
  template_error?: string
}

/**
 * The response a partner sees. Without a template the body is the default
 * `{data: {results, created, updated, rejected}}`; with one, the Liquid
 * output. A template that fails to render never turns a landed write into an
 * error: the default body goes out and `template_error` says why.
 */
export async function shapeResponse(
  input: ShapeInput,
  template: string | null | undefined,
  statusMap: InboundResponseStatus,
  defaultBody: unknown
): Promise<ShapedResponse> {
  const outcome = outcomeOf(input)
  const status = statusMap[outcome] ?? DEFAULT_STATUS[outcome]
  const plain: ShapedResponse = {
    status: DEFAULT_STATUS[outcome],
    outcome,
    body: defaultBody,
    content_type: 'application/json',
    shaped: false
  }
  if (!template?.trim()) return { ...plain, status }
  const records = input.records.filter((r): r is Record<string, unknown> => !!r)
  const ctx = {
    record: records[0] ?? null,
    records,
    created: input.created,
    updated: input.updated,
    rejected: input.rejected,
    outcome,
    created_ids: input.results.filter((r) => r.action === 'created').map((r) => r.id),
    updated_ids: input.results.filter((r) => r.action === 'updated').map((r) => r.id),
    errors: input.results
      .filter((r) => r.action === 'rejected')
      .map((r) => ({
        index: r.index,
        message: r.child_error
          ? `${r.child_error.field}: ${r.child_error.message}`
          : (r.issues.find((i) => i.severity === 'error')?.message ?? r.error ?? 'refused'),
        issues: r.issues.map((i) => i.message),
        child: r.child_error ?? null
      })),
    results: input.results,
    mapping: { key: input.mapping.key, collection: input.mapping.collection }
  }
  let text: string
  try {
    text = String(await engine.parseAndRender(template, ctx)).trim()
  } catch (err) {
    return {
      ...plain,
      status,
      template_error: err instanceof Error ? err.message : String(err)
    }
  }
  if (text === '') return { status, outcome, body: '', content_type: 'text/plain', shaped: true }
  try {
    return {
      status,
      outcome,
      body: JSON.parse(text),
      content_type: 'application/json',
      shaped: true
    }
  } catch {
    return {
      status,
      outcome,
      body: text,
      content_type: text.startsWith('<') ? 'application/xml' : 'text/plain',
      shaped: true
    }
  }
}
