import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'

/**
 * Tool contract tests (#3215): a real MCP tool call saved from the admin console — the tool,
 * the arguments it was given, the input schema it had and the SHAPE of what it answered — and
 * re-run later to prove the tool still takes those arguments and still answers in that shape.
 * Values are never compared (data changes); keys and types are. Stored in
 * nivaro_mcp_contract_tests (migration 509); run from /mcp/console, POST
 * /api/mcp-console/tests/run, or scripts/mcp-contract-tests.mjs in CI.
 */

export const TEST_TABLE = 'nivaro_mcp_contract_tests'
export const MAX_TESTS = 200
const MAX_DEPTH = 6
const MAX_KEYS = 80
const ARRAY_SAMPLE = 25

export type Shape =
  | { t: 'null' }
  | { t: 'string' | 'number' | 'boolean'; n?: true }
  | { t: 'array'; of: Shape | null; n?: true }
  | { t: 'object'; keys: Record<string, Shape>; more?: true; n?: true }

// ─── Shapes (pure) ───────────────────────────────────────────────────────────

/** The shape of a JSON value: types and keys, never values. */
export function shapeOf(v: unknown, depth = 0): Shape {
  if (v === null || v === undefined) return { t: 'null' }
  if (typeof v === 'string') return { t: 'string' }
  if (typeof v === 'number') return { t: 'number' }
  if (typeof v === 'boolean') return { t: 'boolean' }
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH || v.length === 0) return { t: 'array', of: null }
    let of: Shape | null = null
    for (const item of v.slice(0, ARRAY_SAMPLE)) {
      const s = shapeOf(item, depth + 1)
      of = of ? mergeShapes(of, s) : s
    }
    return { t: 'array', of }
  }
  if (typeof v === 'object') {
    if (depth >= MAX_DEPTH) return { t: 'object', keys: {}, more: true }
    const keys: Record<string, Shape> = {}
    const entries = Object.entries(v as Record<string, unknown>)
    for (const [k, val] of entries.slice(0, MAX_KEYS)) keys[k] = shapeOf(val, depth + 1)
    return entries.length > MAX_KEYS ? { t: 'object', keys, more: true } : { t: 'object', keys }
  }
  return { t: 'string' }
}

/** Two shapes seen for one place (array items): keys united, null folded into nullable. */
export function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.t === 'null') return b.t === 'null' ? a : { ...b, n: true }
  if (b.t === 'null') return { ...a, n: true }
  if (a.t !== b.t) return a
  if (a.t === 'array' && b.t === 'array') {
    const of = a.of && b.of ? mergeShapes(a.of, b.of) : (a.of ?? b.of)
    return { ...a, of }
  }
  if (a.t === 'object' && b.t === 'object') {
    const keys: Record<string, Shape> = { ...a.keys }
    for (const [k, s] of Object.entries(b.keys)) keys[k] = keys[k] ? mergeShapes(keys[k], s) : s
    return { ...a, keys, ...(a.more || b.more ? { more: true as const } : {}) }
  }
  return a
}

const typeWord = (s: Shape) =>
  s.t === 'array'
    ? 'a list'
    : s.t === 'object'
      ? 'an object'
      : s.t === 'null'
        ? 'empty'
        : `a ${s.t}`

export interface Verdict {
  problems: string[]
  notes: string[]
}

/** Keys that hold data rows: the record's own fields, not the tool's contract. */
const DATA_KEYS = new Set(['data', 'rows', 'items', 'records', 'result'])

/**
 * Pure: does `now` still answer in the `saved` shape? A key that went missing or a type that
 * changed is a problem; a new key, a value that is empty now or a list with nothing in it to
 * check is a note. Inside rows of data (`data`, `rows`, `items`…) missing keys are only notes:
 * a record's fields depend on the record.
 */
export function compareShapes(saved: Shape, now: Shape, path = '$', inData = false): Verdict {
  const out: Verdict = { problems: [], notes: [] }
  if (saved.t === 'null') return out
  if (now.t === 'null') {
    if (!saved.n) out.notes.push(`${path} is empty now`)
    return out
  }
  if (saved.t !== now.t) {
    out.problems.push(`${path} was ${typeWord(saved)}, now ${typeWord(now)}`)
    return out
  }
  if (saved.t === 'array' && now.t === 'array') {
    if (!saved.of) return out
    if (!now.of) {
      out.notes.push(`${path} is an empty list now, so its items were not checked`)
      return out
    }
    return compareShapes(saved.of, now.of, `${path}[]`, inData)
  }
  if (saved.t === 'object' && now.t === 'object') {
    for (const [k, s] of Object.entries(saved.keys)) {
      const p = `${path}.${k}`
      const n = now.keys[k]
      if (!n) {
        if (now.more || inData) out.notes.push(`${p} is not in this answer`)
        else out.problems.push(`${p} is gone`)
        continue
      }
      const sub = compareShapes(s, n, p, inData || DATA_KEYS.has(k))
      out.problems.push(...sub.problems)
      out.notes.push(...sub.notes)
    }
    const added = Object.keys(now.keys).filter((k) => !(k in saved.keys))
    if (added.length && !inData)
      out.notes.push(
        `${path} has new ${added.length === 1 ? 'key' : 'keys'}: ${added.slice(0, 8).join(', ')}`
      )
  }
  return out
}

// ─── Input schemas (pure) ────────────────────────────────────────────────────

interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  anyOf?: JsonSchema[]
}

const schemaTypes = (s: JsonSchema | undefined): string[] => {
  if (!s) return []
  if (Array.isArray(s.type)) return s.type
  if (s.type) return [s.type]
  if (s.anyOf) return s.anyOf.flatMap(schemaTypes)
  return []
}

const valueType = (v: unknown) =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'array'
      : typeof v === 'number'
        ? Number.isInteger(v)
          ? 'integer'
          : 'number'
        : typeof v

const fits = (v: unknown, types: string[]) => {
  if (!types.length) return true
  const t = valueType(v)
  return types.includes(t) || (t === 'integer' && types.includes('number'))
}

/**
 * Pure: do the saved arguments still fit the tool's input schema? A required input the test
 * does not give, an input the test gives that is gone, a type or allowed-value change on one
 * it uses are problems; new optional inputs are notes.
 */
export function compareInputSchema(
  saved: JsonSchema | null | undefined,
  now: JsonSchema | null | undefined,
  args: Record<string, unknown>
): Verdict {
  const out: Verdict = { problems: [], notes: [] }
  const sp = saved?.properties ?? {}
  const np = now?.properties ?? {}
  for (const r of now?.required ?? [])
    if (args[r] === undefined) out.problems.push(`It now needs ${r}, which this test does not give`)
  for (const [k, v] of Object.entries(args)) {
    if (k === 'dry_run' && !(k in np)) continue
    const n = np[k]
    if (!n) {
      out.problems.push(`${k} is no longer one of its inputs`)
      continue
    }
    const types = schemaTypes(n)
    if (!fits(v, types)) out.problems.push(`${k} must now be ${types.join(' or ')}`)
    const was = schemaTypes(sp[k])
    if (was.length && types.length && !was.some((t) => types.includes(t)))
      out.problems.push(`${k} was ${was.join(' or ')}, now ${types.join(' or ')}`)
    if (Array.isArray(n.enum) && !n.enum.some((e) => e === v))
      out.problems.push(`${k}: ${JSON.stringify(v)} is no longer allowed`)
  }
  const added = Object.keys(np).filter((k) => !(k in sp) && !(now?.required ?? []).includes(k))
  if (added.length) out.notes.push(`New optional inputs: ${added.slice(0, 8).join(', ')}`)
  const relaxed = (saved?.required ?? []).filter((r) => !(now?.required ?? []).includes(r))
  if (relaxed.length) out.notes.push(`No longer required: ${relaxed.join(', ')}`)
  return out
}

// ─── Store ───────────────────────────────────────────────────────────────────

export interface ContractTest {
  id: number
  name: string
  tool: string
  arguments: Record<string, unknown>
  input_schema: JsonSchema
  output_shape: Shape
  expect_error: boolean
  source: string
  source_ref: string | null
  enabled: boolean
  created_by: string | null
  created_at: string | null
  updated_at: string | null
  last_run_at: string | null
  last_status: 'pass' | 'fail' | 'error' | null
  last_result: RunOutcome | null
  last_ms: number | null
}

export interface RunOutcome {
  problems: string[]
  notes: string[]
  message?: string
  /** What the run saw — what "Accept changes" takes as the new contract. */
  observed?: { input_schema: JsonSchema | null; output_shape: Shape | null; is_error: boolean }
}

const parse = <T>(raw: unknown, fallback: T): T => {
  if (raw && typeof raw === 'object') return raw as T
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null)
const bool = (v: unknown) => v === true || v === 1

export function rowToTest(r: Record<string, unknown>): ContractTest {
  const status = r.last_status
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    tool: String(r.tool ?? ''),
    arguments: parse(r.arguments, {}),
    input_schema: parse(r.input_schema, {}),
    output_shape: parse<Shape>(r.output_shape, { t: 'null' }),
    expect_error: bool(r.expect_error),
    source: String(r.source ?? 'console'),
    source_ref: r.source_ref ? String(r.source_ref) : null,
    enabled: bool(r.enabled),
    created_by: r.created_by ? String(r.created_by) : null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    last_run_at: iso(r.last_run_at),
    last_status: status === 'pass' || status === 'fail' || status === 'error' ? status : null,
    last_result: parse<RunOutcome | null>(r.last_result, null),
    last_ms: r.last_ms == null ? null : Number(r.last_ms)
  }
}

export async function testsReady(): Promise<boolean> {
  return hasColumn(TEST_TABLE, 'output_shape').catch(() => false)
}

export async function listTests(ids?: number[]): Promise<ContractTest[]> {
  const q = db(TEST_TABLE).orderBy('tool', 'asc').orderBy('name', 'asc').limit(MAX_TESTS)
  if (ids?.length) q.whereIn('id', ids)
  return ((await q.select('*')) as Array<Record<string, unknown>>).map(rowToTest)
}

export async function readTest(id: number): Promise<ContractTest | null> {
  const r = (await db(TEST_TABLE).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? rowToTest(r) : null
}

export async function countTests(): Promise<number> {
  const r = (await db(TEST_TABLE).count({ n: '*' }).first()) as { n?: number | string } | undefined
  return Number(r?.n ?? 0)
}

export async function insertTest(t: {
  name: string
  tool: string
  arguments: Record<string, unknown>
  input_schema: unknown
  output_shape: Shape
  expect_error: boolean
  source: string
  source_ref: string | null
  created_by: string
}): Promise<ContractTest> {
  const now = new Date()
  await db(TEST_TABLE).insert({
    name: t.name,
    tool: t.tool,
    arguments: JSON.stringify(t.arguments),
    input_schema: JSON.stringify(t.input_schema ?? {}),
    output_shape: JSON.stringify(t.output_shape),
    expect_error: t.expect_error,
    source: t.source,
    source_ref: t.source_ref,
    enabled: true,
    created_by: t.created_by,
    created_at: now,
    updated_at: now
  })
  // Insert-then-select: .returning() shapes differ across dialects.
  const r = (await db(TEST_TABLE)
    .where({ tool: t.tool, name: t.name, created_by: t.created_by })
    .orderBy('id', 'desc')
    .first()) as Record<string, unknown>
  return rowToTest(r)
}

export async function updateTest(id: number, patch: Record<string, unknown>): Promise<void> {
  await db(TEST_TABLE)
    .where({ id })
    .update({ ...patch, updated_at: new Date() })
}

export async function recordRun(
  id: number,
  status: 'pass' | 'fail' | 'error',
  outcome: RunOutcome,
  ms: number
): Promise<void> {
  await db(TEST_TABLE)
    .where({ id })
    .update({
      last_run_at: new Date(),
      last_status: status,
      last_result: JSON.stringify(outcome).slice(0, 200_000),
      last_ms: ms
    })
}

export async function deleteTest(id: number): Promise<boolean> {
  return Number(await db(TEST_TABLE).where({ id }).delete()) > 0
}
