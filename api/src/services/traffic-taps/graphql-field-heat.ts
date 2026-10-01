// api/src/services/traffic-taps/graphql-field-heat.ts
/**
 * Traffic Map tap `graphql-fields` (#1134) — which `Type.field`s each GraphQL operation selects
 * and who selects them, from the TypeInfo walk the GraphQL plugin already runs per request
 * (describeOperation's `fields`). A field of a touched type that nobody selected in the last
 * 15 minutes is a deprecation CANDIDATE (one process, one window — evidence, not proof).
 */
import { MinuteCounter } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const GRAPHQL_FIELDS_TAP = 'graphql-fields'
/** The one schema call this tap makes (a GraphQLSchema satisfies it). */
export interface SchemaLike {
  getType(name: string): unknown
}
const GLOBAL_CAP = 4000
const PER_OPERATION_CAP = 300
const CALLER_CAP = 2000
const OPERATION_CAP = 200
const SEP = '\u0001'
/** Unused fields are judged over the whole ring, whatever window the inspector shows. */
export const UNUSED_WINDOW_S = 900
const ROOT_TYPES = new Set(['Query', 'Mutation', 'Subscription'])

interface State {
  /** `Type.field` → selections, every operation. */
  fields: MinuteCounter
  /** `Type.field\u0001caller` → selections. */
  callers: MinuteCounter
  /** entityKey → `Type.field` → selections. */
  operations: Map<string, MinuteCounter>
}
const state = () =>
  tapState<State>(GRAPHQL_FIELDS_TAP, () => ({
    fields: new MinuteCounter(GLOBAL_CAP),
    callers: new MinuteCounter(CALLER_CAP),
    operations: new Map()
  }))

/** Count the fields one request selected. */
export function recordSelection(
  entityKey: string,
  caller: string,
  fields: readonly string[],
  sec: number
): void {
  const s = state()
  let op = s.operations.get(entityKey)
  if (!op) {
    if (s.operations.size >= OPERATION_CAP) return
    op = new MinuteCounter(PER_OPERATION_CAP)
    s.operations.set(entityKey, op)
  }
  for (const f of fields) {
    if (typeof f !== 'string' || f.length > 160) continue
    s.fields.bump(f, sec)
    op.bump(f, sec)
    s.callers.bump(`${f}${SEP}${caller}`, sec)
  }
}

/** Every field of `typeName` in the schema the window never saw selected (introspection out). */
export function unusedFieldsOf(schema: SchemaLike, typeName: string, sec: number): string[] | null {
  const t = schema.getType(typeName) as { getFields?: () => Record<string, unknown> } | undefined
  if (!t || typeof t.getFields !== 'function') return null
  const counts = state().fields
  return Object.keys(t.getFields())
    .filter(
      (f) => !f.startsWith('__') && counts.sum(`${typeName}.${f}`, UNUSED_WINDOW_S, sec) === 0
    )
    .sort()
}

function callersOf(field: string, windowS: number, sec: number): Array<{ key: string; n: number }> {
  const out: Array<{ key: string; n: number }> = []
  const prefix = `${field}${SEP}`
  for (const [k, n] of state().callers.top(windowS, sec, CALLER_CAP)) {
    if (k.startsWith(prefix)) out.push({ key: k.slice(prefix.length), n })
    if (out.length >= 3) break
  }
  return out
}

export interface GraphQLFieldsDetail {
  window_s: number
  unused_window_s: number
  fields: Array<{ field: string; n: number; callers: Array<{ key: string; n: number }> }>
  types: Array<{ type: string; selected: number; total: number; unused: string[] }>
}

export async function graphqlFieldsDetail(
  entityKey: string,
  windowS: number,
  sec: number,
  schemaOf: () => Promise<SchemaLike> = async () =>
    (await import('../../plugins/graphql.js')).getGraphQLSchema()
): Promise<GraphQLFieldsDetail | undefined> {
  if (!entityKey.startsWith('graphql/')) return undefined
  const op = state().operations.get(entityKey)
  if (!op) return undefined
  const top = op.top(windowS, sec, 40)
  if (top.length === 0) return undefined
  const fields = top.map(([field, n]) => ({ field, n, callers: callersOf(field, windowS, sec) }))
  const typeNames = [...new Set(top.map(([f]) => f.slice(0, f.indexOf('.'))))].slice(0, 8)
  let schema: SchemaLike | null = null
  try {
    schema = await schemaOf()
  } catch {
    schema = null
  }
  const types: GraphQLFieldsDetail['types'] = []
  for (const type of typeNames) {
    // Root types list every collection's entry points — "unused" there says nothing about a field.
    if (ROOT_TYPES.has(type)) continue
    const unused = schema ? unusedFieldsOf(schema, type, sec) : null
    if (!unused) continue
    const t = schema?.getType(type) as { getFields?: () => Record<string, unknown> } | undefined
    const total = t?.getFields
      ? Object.keys(t.getFields()).filter((f) => !f.startsWith('__')).length
      : 0
    types.push({ type, selected: total - unused.length, total, unused: unused.slice(0, 60) })
  }
  return { window_s: windowS, unused_window_s: UNUSED_WINDOW_S, fields, types }
}

export const graphqlFieldHeatTap: TrafficTap = {
  id: GRAPHQL_FIELDS_TAP,
  onRequest(c) {
    if (c.lane !== 'graphql') return
    const fields = (c.ev.req as { __nvrGql?: { fields?: string[] } } | undefined)?.__nvrGql?.fields
    if (!fields?.length) return
    recordSelection(c.entityKey, c.caller, fields, c.sec)
  },
  entityDetail(key, windowS, sec) {
    return graphqlFieldsDetail(key, windowS, sec)
  },
  sweep(sec) {
    const s = state()
    s.fields.sweep(sec)
    s.callers.sweep(sec)
    for (const [k, op] of s.operations) {
      op.sweep(sec)
      if (op.size === 0) s.operations.delete(k)
    }
  }
}

registerTrafficTap(graphqlFieldHeatTap)
