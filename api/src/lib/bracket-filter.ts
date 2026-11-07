/**
 * `filter[field][_op]=value` query keys (the Directus bracket form) → the JSON filter
 * object the items routes read from `filter=<JSON>`.
 *
 * The routes only ever read `filter` as JSON text, and the query parser keeps a key
 * like `filter[po_total][_gt]` flat — so a bracket-form filter was silently ignored
 * and the caller got the WHOLE list back as if it were filtered (army 8 b10: a filter
 * on a hidden field, and even on a field that does not exist, answered 200 with every
 * row). Folding the brackets into the one filter object means the same gates judge it
 * as the JSON form: 403 FIELD_NOT_READABLE for a field the caller may not read, 400
 * UNKNOWN_FIELD for one that does not exist — the same answer whatever the value, so
 * it is never an oracle.
 *
 * Accepted shapes (Directus-compatible):
 * - `filter[field][_op]=value`, relation paths `filter[rel][field][_op]=value`, groups
 *   `filter[_or][0][field][_op]=value`;
 * - `filter[field]=value` with no operator = `_eq` (shorthand partners and scripts send);
 * - `filter=<JSON>` together with bracket keys = both must hold (`{_and:[json, brackets]}`).
 * Refused (400): malformed keys, `__proto__` / `prototype` / `constructor` segments, a
 * group index with no condition (`filter[_or][0]=x`), conflicting keys, more than 50
 * keys or 8 levels, and a JSON part that is not an object.
 */

const KEY_RE = /^filter((?:\[[^[\]]*\])+)$/
const SEGMENT_RE = /^[A-Za-z0-9_$.-]{1,128}$/
const MAX_KEYS = 50
const MAX_DEPTH = 8
const LIST_OPS = new Set(['_in', '_nin', '_between', '_nbetween'])
const BOOL_OPS = new Set(['_null', '_nnull', '_empty', '_nempty'])
const GROUP_OPS = new Set(['_and', '_or'])
/** Never a key of the built object: `filter[__proto__][x]=1` would walk into
 *  Object.prototype (prototype pollution). Refused as a 400. */
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])

const has = (o: object, k: string) => Object.hasOwn(o, k)
const emptyNode = (): Node => Object.create(null) as Node

export class BracketFilterError extends Error {
  readonly statusCode = 400
  readonly code = 'INVALID_FILTER'
}

type Node = Record<string, unknown>

function coerce(op: string, raw: unknown): unknown {
  const values = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')]
  if (LIST_OPS.has(op)) return values.flatMap((v) => v.split(',')).map((v) => v.trim())
  const v = values[values.length - 1]
  if (BOOL_OPS.has(op)) return v !== 'false' && v !== '0'
  return v
}

/** Objects whose keys are all array indexes under `_and` / `_or` → arrays (in index order). */
function arraysUnderGroups(node: unknown, parentKey: string | null): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const entries = Object.entries(node as Node)
  if (parentKey && GROUP_OPS.has(parentKey) && entries.every(([k]) => /^\d+$/.test(k))) {
    return entries
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, v]) => arraysUnderGroups(v, null))
  }
  const out = emptyNode()
  for (const [k, v] of entries) out[k] = arraysUnderGroups(v, k)
  return out
}

/**
 * The filter the bracket keys of a query spell, or null when the query has none.
 * Throws BracketFilterError (400) for a malformed key, both forms at once, or too many
 * / too deep keys.
 */
export function bracketFilter(query: Record<string, unknown> | null | undefined): Node | null {
  if (!query) return null
  const keys = Object.keys(query).filter((k) => k.startsWith('filter['))
  if (keys.length === 0) return null
  if (keys.length > MAX_KEYS) throw new BracketFilterError('Too many filter conditions')
  const root = emptyNode()
  for (const key of keys) {
    const m = KEY_RE.exec(key)
    if (!m) throw new BracketFilterError(`Invalid filter key "${key.slice(0, 80)}"`)
    const segs = m[1].slice(1, -1).split('][')
    if (segs.length > MAX_DEPTH) throw new BracketFilterError('Filter is nested too deeply')
    if (segs.some((s) => !SEGMENT_RE.test(s) || FORBIDDEN.has(s)))
      throw new BracketFilterError(`Invalid filter key "${key.slice(0, 80)}"`)
    // `filter[field]=x` (no operator) is `_eq`, as Directus reads it. A group index or
    // a bare operator with nothing to compare (`filter[_or][0]=x`, `filter[_eq]=x`) is not.
    const last = segs[segs.length - 1]
    if (!last.startsWith('_')) {
      if (/^\d+$/.test(last))
        throw new BracketFilterError(
          `Filter key "${key.slice(0, 80)}" needs a field and an operator, e.g. filter[_or][0][field][_eq]=value`
        )
      segs.push('_eq')
    }
    const op = segs[segs.length - 1]
    if (segs.length < 2 || GROUP_OPS.has(op))
      throw new BracketFilterError(
        `Filter key "${key.slice(0, 80)}" needs a field, e.g. filter[field][_eq]=value`
      )
    let node = root
    for (const seg of segs.slice(0, -1)) {
      const next = has(node, seg) ? node[seg] : undefined
      if (next != null && (typeof next !== 'object' || Array.isArray(next)))
        throw new BracketFilterError(`Conflicting filter keys at "${seg}"`)
      const child = (next as Node | undefined) ?? emptyNode()
      node[seg] = child
      node = child
    }
    if (has(node, op)) throw new BracketFilterError(`Conflicting filter keys at "${op}"`)
    node[op] = coerce(op, query[key])
  }
  const brackets = arraysUnderGroups(root, null) as Node
  if (query.filter == null || query.filter === '') return brackets
  // Both forms at once: both must hold.
  let json: unknown = query.filter
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json)
    } catch {
      throw new BracketFilterError('filter=<JSON> is not valid JSON')
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new BracketFilterError('filter=<JSON> must be an object')
  const and = emptyNode()
  and._and = [json, brackets]
  return and
}

/**
 * Rewrite a request query in place: bracket keys out, `filter` = their JSON (AND'd with
 * a `filter=<JSON>` sent alongside). Returns
 * false when the query had no bracket keys (nothing changed).
 */
export function foldBracketFilter(query: Record<string, unknown> | null | undefined): boolean {
  const filter = bracketFilter(query)
  if (!filter || !query) return false
  for (const k of Object.keys(query)) if (k.startsWith('filter[')) delete query[k]
  query.filter = JSON.stringify(filter)
  return true
}
