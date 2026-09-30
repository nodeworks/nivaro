/**
 * What one logged request USES of the API surface (#608) — the pure half of
 * the partner dependency map. No database access here: the harvester in
 * services/partner-dependencies.ts reads nivaro_api_logs and hands each row
 * to these readers, then folds the results per caller.
 *
 * A usage is (collection, field, read | write). REST writes contribute their
 * body's field names, REST reads their `fields` / `sort` / `filter` /
 * aggregate query parameters (from the logged query string), GraphQL
 * documents every field they select, every filter / sort key and every key
 * of a mutation's `data` argument — resolved against the schema with a
 * TypeInfo walk, the same way plugins/graphql.ts describes an operation.
 */
import {
  type DocumentNode,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLSchema,
  getNamedType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
  Kind,
  parse,
  TypeInfo,
  type ValueNode,
  valueFromASTUntyped,
  visit,
  visitWithTypeInfo
} from 'graphql'

export type UsageMode = 'read' | 'write'
export type UsageVia = 'rest' | 'graphql'

export interface FieldUsage {
  collection: string
  /** `*` = every field of the collection (a read with no `fields`). */
  field: string
  mode: UsageMode
  via: UsageVia
  /** GraphQL type the field was selected on, when it came from a document. */
  gqlType?: string
}

/** A relation row, the shape the resolver needs (nivaro_relations). */
export interface RelationLike {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

/** Relation lookups built once per harvest. */
export interface RelationIndex {
  /** `collection.field` → target collection of an M2O. */
  m2o: Map<string, string>
  /** `collection.alias` → child collection of an O2M. */
  o2m: Map<string, string>
  /** `collection.alias` → target collection of an M2M, and the junction's leg
   *  to it (a path may name that leg: `purchase_orders.purchase_order.number`). */
  m2m: Map<string, { target: string; fkToOther: string }>
  /** GraphQL M2M row type name (`<parent>_<alias>_m2m`) → target + junction legs. */
  m2mTypes: Map<string, { target: string; fkToOther: string }>
}

export function buildRelationIndex(relations: RelationLike[]): RelationIndex {
  const m2o = new Map<string, string>()
  const o2m = new Map<string, string>()
  const m2m = new Map<string, { target: string; fkToOther: string }>()
  const m2mTypes = new Map<string, { target: string; fkToOther: string }>()
  for (const r of relations) {
    if (!r.one_collection) continue
    if (!r.junction_field) {
      m2o.set(`${r.many_collection}.${r.many_field}`, r.one_collection)
      if (r.one_field) o2m.set(`${r.one_collection}.${r.one_field}`, r.many_collection)
      continue
    }
    if (!r.one_field) continue
    const other = relations.find(
      (o) => o.many_collection === r.many_collection && o.many_field === r.junction_field
    )
    if (other?.one_collection) {
      m2m.set(`${r.one_collection}.${r.one_field}`, {
        target: other.one_collection,
        fkToOther: r.junction_field
      })
      m2mTypes.set(`${r.one_collection}_${r.one_field}_m2m`, {
        target: other.one_collection,
        fkToOther: r.junction_field
      })
    }
  }
  return { m2o, o2m, m2m, m2mTypes }
}

/** The collection a relation field leads to, or null for a plain column. */
export function hopTarget(rel: RelationIndex, collection: string, field: string): string | null {
  const k = `${collection}.${field}`
  return rel.m2o.get(k) ?? rel.o2m.get(k) ?? rel.m2m.get(k)?.target ?? null
}

/** A plain field name — a logged path segment like `0` or `id);…` is noise. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `project.project_type.name` on workflows → workflows.project,
 * projects.project_type, project_types.name. A hop that leads nowhere stops
 * the walk (the rest of the path is not attributable).
 */
export function resolveDotted(
  rel: RelationIndex,
  collection: string,
  path: string,
  mode: UsageMode,
  via: UsageVia
): FieldUsage[] {
  const segs = path
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)
  const out: FieldUsage[] = []
  let current: string | null = collection
  let junctionLeg: string | null = null
  for (let i = 0; i < segs.length && current; i++) {
    const seg = segs[i]
    if (seg.startsWith('$')) break
    // `alias.<junction leg>.field` (the Directus shape) = `alias.field`
    if (junctionLeg && seg === junctionLeg) {
      junctionLeg = null
      continue
    }
    junctionLeg = null
    if (seg !== '*' && !FIELD_NAME.test(seg)) break
    out.push({ collection: current, field: seg, mode, via })
    if (seg === '*') break
    if (i < segs.length - 1) {
      const k: string = `${current}.${seg}`
      junctionLeg = rel.m2m.get(k)?.fkToOther ?? null
      current = hopTarget(rel, current, seg)
    }
  }
  return out
}

const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z]{1,6}\d{2}[-A-Za-z0-9]*\d{3,})$/i

/** `/api/items/workflows/366318` → `/api/items/workflows/{id}`; root aliases
 *  (`/items/…`, `/graphql`, `/files`) read as their /api form. */
export function normalizeEndpoint(path: string): string {
  let p = path.split('?')[0] || '/'
  if (!p.startsWith('/api/') && p !== '/api') p = `/api${p.startsWith('/') ? '' : '/'}${p}`
  const segs = p.split('/')
  // ['', 'api', 'items', <collection>, <id>, …] — the collection is a name, never an id
  const firstId = segs[2] === 'items' ? 4 : 3
  return segs.map((seg, i) => (i >= firstId && ID_SEGMENT.test(seg) ? '{id}' : seg)).join('/')
}

const ITEM_ACTIONS = new Set([
  'bulk',
  'batch',
  'aggregate',
  'distinct',
  'resolve-paths',
  'by-slug',
  'export',
  'import'
])

function splitList(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function safeJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Dotted field paths a filter object names (operators, `_and` / `_or`,
 *  `_some` / `_none` wrappers and `$virtual` keys are walked, not reported). */
export function filterPaths(filter: unknown, prefix = ''): string[] {
  const out: string[] = []
  const walk = (node: unknown, pre: string) => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, pre)
      return
    }
    if (!node || typeof node !== 'object') {
      if (pre) out.push(pre)
      return
    }
    const obj = node as Record<string, unknown>
    let hasOperator = false
    for (const [k, v] of Object.entries(obj)) {
      if (k === '_and' || k === '_or' || k === '_some' || k === '_none') {
        walk(v, pre)
        continue
      }
      if (k.startsWith('_') || k.startsWith('$')) {
        hasOperator = true
        continue
      }
      walk(v, pre ? `${pre}.${k}` : k)
    }
    if (hasOperator && pre) out.push(pre)
  }
  walk(filter, prefix)
  return [...new Set(out)]
}

/** Field names a write body carries, recursing into nested O2M rows. */
export function bodyWrites(
  rel: RelationIndex,
  collection: string,
  body: unknown,
  via: UsageVia,
  depth = 0
): FieldUsage[] {
  if (depth > 3 || body == null) return []
  if (Array.isArray(body)) return body.flatMap((b) => bodyWrites(rel, collection, b, via, depth))
  if (typeof body !== 'object') return []
  const out: FieldUsage[] = []
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (k.startsWith('_') || !FIELD_NAME.test(k)) continue
    out.push({ collection, field: k, mode: 'write', via })
    const child = rel.o2m.get(`${collection}.${k}`)
    if (!child || v == null || typeof v !== 'object') continue
    const rows = Array.isArray(v)
      ? v
      : (((v as Record<string, unknown>).create ?? (v as Record<string, unknown>).set) as unknown)
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && typeof row === 'object') out.push(...bodyWrites(rel, child, row, via, depth + 1))
      }
    }
  }
  return out
}

/** Read paths the query string names: fields, sort, filter, conditions and
 *  the aggregate parameters. A record read with no `fields` reads everything
 *  (`defaultAll`); an aggregate or distinct read only what it names. */
export function queryReads(
  rel: RelationIndex,
  collection: string,
  query: string | null,
  defaultAll: boolean
): FieldUsage[] {
  const params = new URLSearchParams(query ?? '')
  const out: FieldUsage[] = []
  const add = (path: string) => out.push(...resolveDotted(rel, collection, path, 'read', 'rest'))
  const fields = [...params.getAll('fields'), ...params.getAll('fields[]')].flatMap((f) =>
    splitList(f)
  )
  if (fields.length === 0 && defaultAll) {
    out.push({ collection, field: '*', mode: 'read', via: 'rest' })
  }
  for (const f of fields) add(f)
  // An aggregate read sorts by its figures (`-sum.amount`, `countAll`), not fields.
  if (defaultAll) for (const s of splitList(params.get('sort'))) add(s.replace(/^-/, ''))
  const filter = safeJson(params.get('filter'))
  for (const p of filterPaths(filter)) add(p)
  const conditions = safeJson(params.get('conditions'))
  const condWalk = (c: unknown) => {
    if (Array.isArray(c)) return c.forEach(condWalk)
    if (!c || typeof c !== 'object') return
    const o = c as { path?: unknown; or?: unknown }
    if (Array.isArray(o.path)) add(o.path.map(String).join('.'))
    if (o.or) condWalk(o.or)
  }
  condWalk(conditions)
  for (const key of ['groupBy', 'sum', 'avg', 'min', 'max', 'count', 'countDistinct', 'field']) {
    for (const f of splitList(params.get(key))) add(f)
  }
  for (const f of splitList(params.get('paths'))) add(f)
  return out
}

export interface RestUsage {
  collection: string | null
  usages: FieldUsage[]
}

/** One REST request → the collection it addresses and the fields it uses. */
export function restUsage(
  rel: RelationIndex,
  method: string,
  path: string,
  query: string | null,
  body: string | null
): RestUsage {
  const norm = normalizeEndpoint(path)
  const segs = norm.split('/').filter(Boolean) // ['api','items',c,…]
  if (segs[1] !== 'items' || !segs[2]) return { collection: null, usages: [] }
  const collection = segs[2]
  const rest = segs.slice(3)
  const m = method.toUpperCase()
  const parsed = safeJson(body)
  const usages: FieldUsage[] = []
  if (rest.length === 0) {
    if (m === 'GET') usages.push(...queryReads(rel, collection, query, true))
    else if (m === 'POST' || m === 'PATCH' || m === 'PUT')
      usages.push(...bodyWrites(rel, collection, parsed, 'rest'))
  } else if (ITEM_ACTIONS.has(rest[0])) {
    if (rest[0] === 'bulk' && m === 'POST') {
      const rows = Array.isArray(parsed)
        ? parsed
        : ((parsed as { rows?: unknown } | undefined)?.rows ?? [])
      usages.push(...bodyWrites(rel, collection, rows, 'rest'))
    } else if (rest[0] === 'batch' && m === 'POST') {
      const b = (parsed ?? {}) as { create?: unknown; update?: unknown }
      usages.push(...bodyWrites(rel, collection, b.create, 'rest'))
      usages.push(...bodyWrites(rel, collection, b.update, 'rest'))
    } else if (m === 'GET') {
      usages.push(...queryReads(rel, collection, query, false))
    }
  } else if (rest.length === 1) {
    if (m === 'GET') usages.push(...queryReads(rel, collection, query, true))
    else if (m === 'PATCH' || m === 'PUT')
      usages.push(...bodyWrites(rel, collection, parsed, 'rest'))
  }
  return { collection, usages }
}

// ─── GraphQL ────────────────────────────────────────────────────────────────

export interface GraphQLUsage {
  operation: string | null
  kind: string | null
  rootFields: string[]
  usages: FieldUsage[]
  /** Collections a root field addresses (read or write). */
  collections: Array<{ collection: string; mode: UsageMode }>
  /** `Type` → fields selected on it (for the SDL subset). */
  typeFields: Map<string, Set<string>>
  /** `Type.field` → argument names passed. */
  args: Map<string, Set<string>>
  /** Input type → input fields supplied (literals and variables). */
  inputFields: Map<string, Set<string>>
}

const MUTATION_NAME = /^(create|update|delete|upsert)_(.+?)(_items?|_batch|_dry_run)?$/

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>()
  set.add(value)
  map.set(key, set)
}

function recordInputValue(
  type: GraphQLInputType,
  value: unknown,
  into: Map<string, Set<string>>,
  depth = 0
): void {
  if (depth > 12 || value == null) return
  let t: GraphQLInputType = type
  if (isNonNullType(t)) t = t.ofType
  if (isListType(t)) {
    if (Array.isArray(value)) for (const v of value) recordInputValue(t.ofType, v, into, depth + 1)
    return
  }
  if (!isInputObjectType(t) || typeof value !== 'object' || Array.isArray(value)) return
  const fields = t.getFields()
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    addTo(into, t.name, k)
    const f = fields[k]
    if (f) recordInputValue(f.type, v, into, depth + 1)
  }
}

/** Read the request body of a GraphQL call; `persisted` resolves an
 *  `{id}` / APQ-hash body to its stored document. */
export function graphqlDocumentOf(
  body: string | null,
  persisted?: (key: { id?: unknown; hash?: string }) => string | null
): { query: string; variables: Record<string, unknown>; operationName?: string } | null {
  const parsed = safeJson(body) as
    | {
        query?: unknown
        variables?: unknown
        operationName?: unknown
        id?: unknown
        extensions?: { persistedQuery?: { sha256Hash?: string } }
      }
    | undefined
  if (!parsed || typeof parsed !== 'object') return null
  let query = typeof parsed.query === 'string' ? parsed.query : null
  if (!query && persisted) {
    const hash = parsed.extensions?.persistedQuery?.sha256Hash
    query = persisted(hash ? { hash } : { id: parsed.id })
  }
  if (!query) return null
  const variables =
    parsed.variables && typeof parsed.variables === 'object'
      ? (parsed.variables as Record<string, unknown>)
      : {}
  return {
    query,
    variables,
    operationName: typeof parsed.operationName === 'string' ? parsed.operationName : undefined
  }
}

/**
 * Walk a document against the schema. Every selected field is recorded on
 * its parent type (even one the schema no longer has — that is exactly the
 * break the check looks for), mapped to a collection when the parent type is
 * a collection type or an M2M row type.
 */
export function graphqlUsage(
  schema: GraphQLSchema,
  rel: RelationIndex,
  collections: Set<string>,
  source: { query: string; variables: Record<string, unknown>; operationName?: string }
): GraphQLUsage | null {
  let document: DocumentNode
  try {
    document = parse(source.query)
  } catch {
    return null
  }
  const ops = document.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION)
  const op =
    (source.operationName &&
      ops.find(
        (o) => o.kind === Kind.OPERATION_DEFINITION && o.name?.value === source.operationName
      )) ||
    ops[0]
  if (!op || op.kind !== Kind.OPERATION_DEFINITION) return null
  const allRoots = op.selectionSet.selections
    .filter((s) => s.kind === Kind.FIELD)
    .map((s) => (s.kind === Kind.FIELD ? s.name.value : ''))
  const rootFields = allRoots.filter((n) => n && !n.startsWith('__'))
  const usage: GraphQLUsage = {
    // Same identity as the log's graphql_operation (plugins/graphql.ts).
    operation: (op.name?.value ?? allRoots[0] ?? null)?.slice(0, 200) ?? null,
    kind: op.operation,
    rootFields,
    usages: [],
    collections: [],
    typeFields: new Map(),
    args: new Map(),
    inputFields: new Map()
  }
  const rootNames = new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter(Boolean)
      .map((t) => (t as GraphQLNamedType).name)
  )
  const collectionOfType = (name: string | undefined): string | null =>
    name && collections.has(name) ? name : null

  const mapField = (parentName: string, field: string): FieldUsage | null => {
    if (field.startsWith('__')) return null
    if (collections.has(parentName)) {
      return { collection: parentName, field, mode: 'read', via: 'graphql', gqlType: parentName }
    }
    const m2m = rel.m2mTypes.get(parentName)
    if (m2m) {
      if (field === 'id' || field === m2m.fkToOther) return null
      return { collection: m2m.target, field, mode: 'read', via: 'graphql', gqlType: parentName }
    }
    return null
  }

  const typeInfo = new TypeInfo(schema)
  try {
    visit(
      document,
      visitWithTypeInfo(typeInfo, {
        OperationDefinition(node) {
          // Only the operation that runs; other operations in the document are skipped.
          if (node !== op) return false
          return undefined
        },
        Field(node) {
          const parent = typeInfo.getParentType()
          const name = node.name.value
          // Introspection (`__schema`, `__type`, `__typename`) is not the caller's data.
          if (!parent || name.startsWith('__') || parent.name.startsWith('__')) return
          addTo(usage.typeFields, parent.name, name)
          for (const a of node.arguments ?? [])
            addTo(usage.args, `${parent.name}.${name}`, a.name.value)
          const mapped = mapField(parent.name, name)
          if (mapped) usage.usages.push(mapped)
          const def = typeInfo.getFieldDef()
          const named = def ? getNamedType(def.type) : null
          let target = collectionOfType(named?.name)
          const isRoot = rootNames.has(parent.name)
          if (isRoot) {
            const isMutation = parent.name === schema.getMutationType()?.name
            if (!target) {
              const m = name.match(MUTATION_NAME)
              if (m && collections.has(m[2])) target = m[2]
              else if (collections.has(name.replace(/_(by_id|metadata|aggregated)$/, '')))
                target = name.replace(/_(by_id|metadata|aggregated)$/, '')
            }
            if (target) {
              usage.collections.push({
                collection: target,
                mode: isMutation && !name.startsWith('delete_') ? 'write' : 'read'
              })
            }
            if (isMutation && target) {
              const data = node.arguments?.find((a) => a.name.value === 'data')
              if (data) {
                const value = valueFromASTUntyped(data.value as ValueNode, source.variables)
                usage.usages.push(...bodyWrites(rel, target, value, 'graphql'))
              }
            }
          } else if (!target && named && isObjectType(named)) {
            const m2m = rel.m2mTypes.get(named.name)
            if (m2m) target = m2m.target
          }
          if (target) {
            const filterArg = node.arguments?.find((a) => a.name.value === 'filter')
            if (filterArg) {
              const value = valueFromASTUntyped(filterArg.value as ValueNode, source.variables)
              for (const p of filterPaths(value))
                usage.usages.push(...resolveDotted(rel, target, p, 'read', 'graphql'))
            }
            const sortArg = node.arguments?.find((a) => a.name.value === 'sort')
            if (sortArg && !name.endsWith('_aggregated')) {
              const value = valueFromASTUntyped(sortArg.value as ValueNode, source.variables)
              const list = Array.isArray(value) ? value : [value]
              for (const s of list) {
                if (typeof s === 'string' && s)
                  usage.usages.push(
                    ...resolveDotted(rel, target, s.replace(/^-/, ''), 'read', 'graphql')
                  )
              }
            }
          }
        },
        ObjectField(node) {
          const parent = typeInfo.getParentInputType()
          const named = parent ? getNamedType(parent) : null
          if (named) addTo(usage.inputFields, named.name, node.name.value)
        },
        VariableDefinition(node) {
          const t = typeInfo.getInputType()
          const v = source.variables[node.variable.name.value]
          if (t && v !== undefined) recordInputValue(t, v, usage.inputFields)
        }
      })
    )
  } catch {
    // A document the walker cannot read keeps whatever it gathered.
  }
  return usage
}
