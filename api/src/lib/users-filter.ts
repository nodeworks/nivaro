/**
 * `GET /api/users` filter reading (army 11 Q2-6 / f4 L6).
 *
 * The route used to read only `filter=<JSON>` and drop everything else without a word:
 * `filter[role][_eq]=…` (the bracket form /items accepts since army 8), a malformed JSON
 * filter, an unknown column, an unsupported operator — each answered 200 with the WHOLE
 * directory (1,087 people), as if filtered. A script that "deactivates the matching user"
 * would act on the first of them. Now the bracket keys fold into the same filter as /items
 * (lib/bracket-filter.ts) and anything the people list cannot apply is a 400 that says why.
 *
 * Supported: `{field: value}` (= `_eq`), `{field: {_eq|_neq|_in|_nin: value}}`, and an
 * `_and` list of such objects (what bracket + JSON together fold into). Fields: the
 * filterable people columns only — the same refusal for a column that does not exist and
 * one that may not be filtered, so the answer never says which columns exist.
 */
import { BracketFilterError, foldBracketFilter } from './bracket-filter.js'

const OPS = new Set(['_eq', '_neq', '_in', '_nin'])

export class UsersFilterError extends Error {
  readonly statusCode = 400
  readonly code = 'INVALID_FILTER'
}

type Flat = Record<string, Record<string, unknown>>

function addCondition(out: Flat, field: string, value: unknown, filterable: ReadonlySet<string>) {
  if (!filterable.has(field))
    throw new UsersFilterError(`People cannot be filtered by "${field.slice(0, 64)}"`)
  const ops =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { _eq: value }
  const entries = Object.entries(ops)
  if (entries.length === 0) throw new UsersFilterError(`Filter on "${field}" has no condition`)
  for (const [op, v] of entries) {
    if (!OPS.has(op))
      throw new UsersFilterError(
        `Filter operator "${op.slice(0, 32)}" is not supported for people (use _eq, _neq, _in or _nin)`
      )
    const list = op === '_in' || op === '_nin'
    if (list && !Array.isArray(v))
      throw new UsersFilterError(`Filter ${op} on "${field}" needs a list of values`)
    if (!list && (v === null || typeof v === 'object'))
      throw new UsersFilterError(`Filter ${op} on "${field}" needs one value`)
    const slot = out[field] ?? {}
    if (Object.hasOwn(slot, op)) throw new UsersFilterError(`Filter repeats ${op} on "${field}"`)
    slot[op] = v
    out[field] = slot
  }
}

function flatten(node: unknown, out: Flat, filterable: ReadonlySet<string>, depth: number) {
  if (depth > 8) throw new UsersFilterError('Filter is nested too deeply')
  if (!node || typeof node !== 'object' || Array.isArray(node))
    throw new UsersFilterError('filter must be an object')
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '_and') {
      if (!Array.isArray(value)) throw new UsersFilterError('_and needs a list of conditions')
      for (const part of value) flatten(part, out, filterable, depth + 1)
      continue
    }
    if (key.startsWith('_'))
      throw new UsersFilterError(`Filter "${key.slice(0, 32)}" is not supported for people`)
    addCondition(out, key, value, filterable)
  }
}

/**
 * The people filter a request query asks for, flattened to `{field: {op: value}}`, or
 * null when it asks for none. Throws UsersFilterError (400) for anything it cannot apply.
 * Rewrites bracket keys in `query` (as the items routes do).
 */
export function readUsersFilter(
  query: Record<string, unknown>,
  filterable: ReadonlySet<string>
): Flat | null {
  try {
    foldBracketFilter(query)
  } catch (err) {
    if (err instanceof BracketFilterError) throw new UsersFilterError(err.message)
    throw err
  }
  const raw = query.filter
  if (raw == null || raw === '') return null
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new UsersFilterError('filter=<JSON> is not valid JSON')
    }
  }
  const out: Flat = {}
  flatten(parsed, out, filterable, 0)
  return Object.keys(out).length ? out : null
}
