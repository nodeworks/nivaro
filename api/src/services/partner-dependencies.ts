/**
 * Partner dependency map + break check (#608).
 *
 * Which parts of the API each non-session caller actually uses — REST
 * endpoints, GraphQL operations, and the collections and fields behind them —
 * harvested from the request log (nivaro_api_logs: path, logged query string,
 * the stored JSON body of token / API-key writes and GraphQL calls, the
 * graphql_* columns) plus nivaro_persisted_queries for documents sent by id or
 * hash. A caller = an API key, or a static-token account (`key:<id>` /
 * `user:<UUID>`, the same identity the inbound callers view uses).
 *
 * The map answers "what would this change break for whom": the break check
 * compares every partner's used set with the current schema, the readiness
 * scorecard warns on the same findings, and the field-removal impact scan
 * names the callers of a field. Evidence only goes as far back as the log
 * (14-day retention) and only as deep as what was logged — a GET's fields
 * come from its query string, a write's from its stored body (capped at
 * 64 KB; bodies of session callers are never stored).
 */
import type { GraphQLSchema } from 'graphql'
import {
  type GraphQLNamedType,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isObjectType,
  isScalarType,
  isUnionType
} from 'graphql'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { CMSField } from '../types.js'
import { getRelations, listCollections } from './collections.js'
import { selectInChunks } from './db-batch.js'
import { accountKindOf } from './machine-accounts.js'
import {
  buildRelationIndex,
  type FieldUsage,
  graphqlDocumentOf,
  graphqlUsage,
  normalizeEndpoint,
  type RelationIndex,
  restUsage,
  type UsageMode,
  type UsageVia
} from './partner-usage.js'

export interface FieldUse {
  field: string
  calls: number
  last_seen: string
  via: UsageVia[]
  /** GraphQL types the field was selected on (for the break check). */
  gql_types?: string[]
}

export interface CollectionUse {
  collection: string
  calls: number
  last_seen: string
  /** A read with no field list (REST) — every field is in play. */
  read_all: boolean
  writes: boolean
  read: FieldUse[]
  written: FieldUse[]
}

export interface EndpointUse {
  method: string
  path: string
  calls: number
  errors: number
  last_seen: string
}

export interface OperationUse {
  name: string
  kind: string
  calls: number
  errors: number
  last_seen: string
  root_fields: string[]
  persisted: boolean
}

export interface CallerDependencies {
  key: string
  kind: 'api_key' | 'token'
  label: string
  email: string | null
  user: string | null
  api_key_id: number | null
  /** Machine account kind (integration, bot, …); null for a person. */
  account_kind: string | null
  /** API keys and machine accounts — the callers the break check judges. */
  partner: boolean
  calls: number
  first_seen: string
  last_seen: string
  endpoints: EndpointUse[]
  operations: OperationUse[]
  collections: CollectionUse[]
  /** For the GraphQL SDL subset: type → fields selected, `Type.field` → args,
   *  input type → input fields supplied. */
  graphql: {
    type_fields: Record<string, string[]>
    args: Record<string, string[]>
    input_fields: Record<string, string[]>
  }
  /** How much evidence the map rests on. */
  evidence: {
    rows: number
    bodies_read: number
    documents_unreadable: number
    writes_without_body: number
  }
}

export interface DependencyMap {
  days: number
  generated_at: string
  callers: CallerDependencies[]
  truncated: boolean
}

// ─── Schema source ──────────────────────────────────────────────────────────

let schemaProvider: (() => Promise<GraphQLSchema>) | null = null

/** Scripts pass `buildGraphQLSchema`; inside the API the plugin's cached
 *  schema is used (no second 10-second build). */
export function setDependencySchemaProvider(fn: () => Promise<GraphQLSchema>): void {
  schemaProvider = fn
  cache.clear()
}

async function currentSchema(): Promise<GraphQLSchema | null> {
  try {
    if (schemaProvider) return await schemaProvider()
    const { getGraphQLSchema } = await import('../plugins/graphql.js')
    return await getGraphQLSchema()
  } catch {
    return null
  }
}

// ─── Harvest ────────────────────────────────────────────────────────────────

const BODY_ROW_CAP = 5_000
const GROUP_ROW_CAP = 50_000
const CACHE_TTL = 3 * 60_000
const cache = new Map<number, { at: number; map: Promise<DependencyMap> }>()

export function clearDependencyCache(): void {
  cache.clear()
}

interface Acc {
  key: string
  auth: string
  user: string | null
  api_key_id: number | null
  calls: number
  first: number
  last: number
  endpoints: Map<string, EndpointUse>
  operations: Map<string, OperationUse>
  collections: Map<
    string,
    {
      calls: number
      last: number
      read_all: boolean
      writes: boolean
      read: Map<string, { calls: number; last: number; via: Set<UsageVia>; gql: Set<string> }>
      written: Map<string, { calls: number; last: number; via: Set<UsageVia>; gql: Set<string> }>
    }
  >
  typeFields: Map<string, Set<string>>
  args: Map<string, Set<string>>
  inputFields: Map<string, Set<string>>
  evidence: CallerDependencies['evidence']
}

const iso = (ms: number) => new Date(ms).toISOString()
const ms = (v: unknown) => new Date(v as string).getTime()

function callerKey(r: Record<string, unknown>): string {
  return r.auth === 'api_key' ? `key:${r.api_key_id}` : `user:${String(r.user ?? '').toUpperCase()}`
}

function mergeSet(into: Map<string, Set<string>>, from: Map<string, Set<string>>): void {
  for (const [k, vs] of from) {
    const set = into.get(k) ?? new Set<string>()
    for (const v of vs) set.add(v)
    into.set(k, set)
  }
}

function touchCollection(
  acc: Acc,
  collection: string,
  calls: number,
  at: number,
  mode: UsageMode | 'none'
) {
  let c = acc.collections.get(collection)
  if (!c) {
    c = {
      calls: 0,
      last: 0,
      read_all: false,
      writes: false,
      read: new Map(),
      written: new Map()
    }
    acc.collections.set(collection, c)
  }
  c.calls += calls
  c.last = Math.max(c.last, at)
  if (mode === 'write') c.writes = true
  return c
}

function recordUsages(acc: Acc, usages: FieldUsage[], calls: number, at: number): void {
  // One request that names a field twice counts once for it.
  const seen = new Set<string>()
  for (const u of usages) {
    const id = `${u.collection}|${u.field}|${u.mode}|${u.gqlType ?? ''}`
    if (seen.has(id)) continue
    seen.add(id)
    const c = touchCollection(acc, u.collection, 0, at, u.mode)
    if (u.field === '*') {
      c.read_all = true
      continue
    }
    const bucket = u.mode === 'write' ? c.written : c.read
    const f = bucket.get(u.field) ?? { calls: 0, last: 0, via: new Set(), gql: new Set() }
    f.calls += calls
    f.last = Math.max(f.last, at)
    f.via.add(u.via)
    if (u.gqlType) f.gql.add(u.gqlType)
    bucket.set(u.field, f)
  }
}

const isGraphQLPath = (p: string) => /^\/(api\/)?graphql\/?$/.test(p)

async function buildMap(days: number): Promise<DependencyMap> {
  const from = new Date(Date.now() - days * 86_400_000)
  const [hasQuery, hasGql, relations, collectionRows, schema] = await Promise.all([
    hasColumn('nivaro_api_logs', 'query'),
    hasColumn('nivaro_api_logs', 'graphql_operation'),
    getRelations(),
    listCollections(),
    currentSchema()
  ])
  const rel: RelationIndex = buildRelationIndex(relations)
  const collections = new Set(collectionRows.map((c) => c.collection))

  const base = () =>
    db('nivaro_api_logs as l')
      .where('l.created_at', '>=', from)
      .whereIn('l.auth', ['token', 'api_key'])
      .where((w) => w.whereNotNull('l.user').orWhereNotNull('l.api_key_id'))

  const groupCols = ['l.auth', 'l.user', 'l.api_key_id', 'l.method', 'l.path']
  if (hasQuery) groupCols.push('l.query')
  if (hasGql) groupCols.push('l.graphql_operation', 'l.graphql_kind')

  const [groups, bodies, persistedRows] = await Promise.all([
    base()
      .select(groupCols)
      .count('* as calls')
      .sum({ errors: db.raw('CASE WHEN l.status >= 400 THEN 1 ELSE 0 END') })
      .sum({ bodied: db.raw('CASE WHEN l.request_body IS NULL THEN 0 ELSE 1 END') })
      .min({ first_at: 'l.created_at' })
      .max({ last_at: 'l.created_at' })
      .groupBy(groupCols)
      .limit(GROUP_ROW_CAP) as Promise<Array<Record<string, unknown>>>,
    // One row per distinct body (CHECKSUM) per caller + endpoint: a partner
    // repeating the same write or document is read once, not N times — the
    // raw bodies of two weeks run to tens of megabytes.
    base()
      .whereNotNull('l.request_body')
      .where((w) =>
        w
          .where('l.path', 'like', '/api/items/%')
          .orWhere('l.path', 'like', '/items/%')
          .orWhere('l.path', 'like', '%graphql')
      )
      .select('l.auth', 'l.user', 'l.api_key_id', 'l.method', 'l.path')
      .count('* as calls')
      .sum({ errors: db.raw('CASE WHEN l.status >= 400 THEN 1 ELSE 0 END') })
      .min({ id: 'l.id' })
      .max({ last_at: 'l.created_at' })
      .groupBy(
        'l.auth',
        'l.user',
        'l.api_key_id',
        'l.method',
        'l.path',
        db.raw('CHECKSUM(l.request_body)')
      )
      .orderBy('last_at', 'desc')
      .limit(BODY_ROW_CAP) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_persisted_queries')
      .select('id', 'hash', 'query')
      .catch(() => [] as Array<Record<string, unknown>>) as Promise<Array<Record<string, unknown>>>
  ])

  const bodyText = new Map<number, string>(
    (
      await selectInChunks(
        bodies.map((b) => Number(b.id)),
        500,
        (ids) =>
          db('nivaro_api_logs').whereIn('id', ids).select('id', 'request_body') as Promise<
            Array<{ id: number | string; request_body: string | null }>
          >
      )
    ).map((r) => [Number(r.id), String(r.request_body ?? '')])
  )

  const pqById = new Map(persistedRows.map((r) => [String(r.id), String(r.query)]))
  const pqByHash = new Map(persistedRows.map((r) => [String(r.hash), String(r.query)]))
  const persisted = (k: { id?: unknown; hash?: string }) =>
    (k.hash ? pqByHash.get(k.hash) : pqById.get(String(k.id))) ?? null

  const accs = new Map<string, Acc>()
  const accOf = (r: Record<string, unknown>): Acc => {
    const key = callerKey(r)
    let a = accs.get(key)
    if (!a) {
      a = {
        key,
        auth: String(r.auth),
        user: r.user ? String(r.user) : null,
        api_key_id: r.api_key_id == null ? null : Number(r.api_key_id),
        calls: 0,
        first: Number.POSITIVE_INFINITY,
        last: 0,
        endpoints: new Map(),
        operations: new Map(),
        collections: new Map(),
        typeFields: new Map(),
        args: new Map(),
        inputFields: new Map(),
        evidence: { rows: 0, bodies_read: 0, documents_unreadable: 0, writes_without_body: 0 }
      }
      accs.set(key, a)
    }
    if (a.user == null && r.user) a.user = String(r.user)
    return a
  }

  // 1 — grouped rows: endpoints, operations, REST reads from the query string.
  for (const g of groups) {
    const a = accOf(g)
    const calls = Number(g.calls ?? 0)
    const errors = Number(g.errors ?? 0)
    const first = ms(g.first_at)
    const last = ms(g.last_at)
    const method = String(g.method).toUpperCase()
    const path = String(g.path)
    a.calls += calls
    a.first = Math.min(a.first, first)
    a.last = Math.max(a.last, last)
    a.evidence.rows += calls
    const ep = normalizeEndpoint(path)
    const eKey = `${method} ${ep}`
    const e = a.endpoints.get(eKey) ?? { method, path: ep, calls: 0, errors: 0, last_seen: iso(0) }
    e.calls += calls
    e.errors += errors
    if (last > ms(e.last_seen)) e.last_seen = iso(last)
    a.endpoints.set(eKey, e)

    if (isGraphQLPath(path)) {
      const name = g.graphql_operation ? String(g.graphql_operation) : null
      if (name) {
        const o = a.operations.get(name) ?? {
          name,
          kind: String(g.graphql_kind ?? 'query'),
          calls: 0,
          errors: 0,
          last_seen: iso(0),
          root_fields: [],
          persisted: false
        }
        o.calls += calls
        o.errors += errors
        if (last > ms(o.last_seen)) o.last_seen = iso(last)
        a.operations.set(name, o)
      }
      continue
    }
    const r = restUsage(rel, method, path, hasQuery ? ((g.query as string) ?? null) : null, null)
    if (!r.collection) continue
    touchCollection(a, r.collection, calls, last, method === 'GET' ? 'read' : 'write')
    if (method === 'GET') recordUsages(a, r.usages, calls, last)
    else if (method !== 'DELETE' && Number(g.bodied ?? 0) < calls)
      a.evidence.writes_without_body += calls - Number(g.bodied ?? 0)
  }

  // 2 — stored bodies: REST write fields and GraphQL documents. Identical
  // bodies parse once.
  const parsedDocs = new Map<string, ReturnType<typeof graphqlUsage>>()
  // Operations the grouped rows already counted (graphql_operation column);
  // the rest are counted here, one per stored body.
  const countedOps = new Set(
    [...accs.values()].flatMap((a) => [...a.operations.keys()].map((n) => `${a.key}|${n}`))
  )
  for (const b of bodies) {
    const a = accOf(b)
    const at = ms(b.last_at)
    const n = Number(b.calls ?? 1)
    const method = String(b.method).toUpperCase()
    const path = String(b.path)
    const body = bodyText.get(Number(b.id)) ?? ''
    a.evidence.bodies_read += n
    if (isGraphQLPath(path)) {
      if (!schema) continue
      let usage = parsedDocs.get(body)
      if (usage === undefined) {
        const doc = graphqlDocumentOf(body, persisted)
        usage = doc ? graphqlUsage(schema, rel, collections, doc) : null
        parsedDocs.set(body, usage)
      }
      if (!usage) {
        a.evidence.documents_unreadable += n
        continue
      }
      const wasPersisted = !/"query"\s*:/.test(body)
      recordUsages(a, usage.usages, n, at)
      for (const c of usage.collections) touchCollection(a, c.collection, n, at, c.mode)
      mergeSet(a.typeFields, usage.typeFields)
      mergeSet(a.args, usage.args)
      mergeSet(a.inputFields, usage.inputFields)
      const name = usage.operation ?? '(anonymous)'
      const o = a.operations.get(name) ?? {
        name,
        kind: usage.kind ?? 'query',
        calls: 0,
        errors: 0,
        last_seen: iso(at),
        root_fields: [],
        persisted: false
      }
      if (!countedOps.has(`${a.key}|${name}`)) {
        // Only in the body scan (the rows predate the operation column).
        o.calls += n
        o.errors += Number(b.errors ?? 0)
        if (at > ms(o.last_seen)) o.last_seen = iso(at)
      }
      o.root_fields = [...new Set([...o.root_fields, ...usage.rootFields])]
      if (wasPersisted) o.persisted = true
      a.operations.set(name, o)
      continue
    }
    const r = restUsage(rel, method, path, null, body)
    if (r.collection && method !== 'GET') recordUsages(a, r.usages, n, at)
  }

  // 3 — labels.
  const userIds = [
    ...new Set([...accs.values()].filter((a) => a.user).map((a) => a.user as string))
  ]
  const keyIds = [
    ...new Set(
      [...accs.values()].filter((a) => a.api_key_id != null).map((a) => a.api_key_id as number)
    )
  ]
  const [users, keys] = await Promise.all([
    userIds.length
      ? (db('nivaro_users')
          .whereIn('id', userIds)
          .select('id', 'first_name', 'last_name', 'email', 'account_kind')
          .catch(() =>
            db('nivaro_users')
              .whereIn('id', userIds)
              .select('id', 'first_name', 'last_name', 'email')
          ) as Promise<Array<Record<string, unknown>>>)
      : Promise.resolve([] as Array<Record<string, unknown>>),
    keyIds.length
      ? (db('nivaro_api_keys').whereIn('id', keyIds).select('id', 'name') as Promise<
          Array<Record<string, unknown>>
        >)
      : Promise.resolve([] as Array<Record<string, unknown>>)
  ])
  const userById = new Map(users.map((u) => [String(u.id).toUpperCase(), u]))
  const keyById = new Map(keys.map((k) => [Number(k.id), k]))

  const fieldList = (
    m: Map<string, { calls: number; last: number; via: Set<UsageVia>; gql: Set<string> }>
  ): FieldUse[] =>
    [...m.entries()]
      .map(([field, f]) => ({
        field,
        calls: f.calls,
        last_seen: iso(f.last),
        via: [...f.via].sort(),
        ...(f.gql.size ? { gql_types: [...f.gql].sort() } : {})
      }))
      .sort((x, y) => x.field.localeCompare(y.field))
  const record = (m: Map<string, Set<string>>) =>
    Object.fromEntries([...m.entries()].map(([k, v]) => [k, [...v].sort()]))

  const callers: CallerDependencies[] = [...accs.values()].map((a) => {
    const isKey = a.auth === 'api_key'
    const u = a.user ? userById.get(a.user.toUpperCase()) : undefined
    const k = a.api_key_id != null ? keyById.get(a.api_key_id) : undefined
    const kind = accountKindOf(
      u ? { account_kind: u.account_kind as string | null, email: u.email as string | null } : null
    )
    const label = isKey
      ? String(k?.name ?? `API key #${a.api_key_id} (deleted)`)
      : u
        ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? a.user)
        : String(a.user ?? 'unknown')
    return {
      key: a.key,
      kind: isKey ? 'api_key' : 'token',
      label,
      email: (u?.email as string | null) ?? null,
      user: isKey ? null : a.user,
      api_key_id: isKey ? a.api_key_id : null,
      account_kind: isKey ? null : kind,
      partner: isKey || kind != null,
      calls: a.calls,
      first_seen: iso(Number.isFinite(a.first) ? a.first : a.last),
      last_seen: iso(a.last),
      endpoints: [...a.endpoints.values()].sort((x, y) => y.calls - x.calls),
      operations: [...a.operations.values()].sort((x, y) => y.calls - x.calls),
      collections: [...a.collections.entries()]
        .map(([collection, c]) => ({
          collection,
          calls: c.calls,
          last_seen: iso(c.last),
          read_all: c.read_all,
          writes: c.writes,
          read: fieldList(c.read),
          written: fieldList(c.written)
        }))
        .sort((x, y) => y.calls - x.calls || x.collection.localeCompare(y.collection)),
      graphql: {
        type_fields: record(a.typeFields),
        args: record(a.args),
        input_fields: record(a.inputFields)
      },
      evidence: a.evidence
    }
  })
  callers.sort((x, y) => Number(y.partner) - Number(x.partner) || y.calls - x.calls)

  return {
    days,
    generated_at: new Date().toISOString(),
    callers,
    truncated: groups.length >= GROUP_ROW_CAP || bodies.length >= BODY_ROW_CAP
  }
}

/** The dependency map over the last `days` of the request log (cached 3 min). */
export async function dependencyMap(
  days = 14,
  opts: { fresh?: boolean } = {}
): Promise<DependencyMap> {
  const d = Math.max(1, Math.min(30, Math.floor(days) || 14))
  const hit = cache.get(d)
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL) return hit.map
  const map = buildMap(d)
  cache.set(d, { at: Date.now(), map })
  map.catch(() => cache.delete(d))
  return map
}

export async function callerDependencies(
  key: string,
  days = 14
): Promise<CallerDependencies | null> {
  const map = await dependencyMap(days)
  return map.callers.find((c) => c.key.toUpperCase() === key.toUpperCase()) ?? null
}

/** Callers that read or write `collection.field` (or read the whole collection). */
export async function callersUsingField(
  collection: string,
  field: string,
  days = 14
): Promise<
  Array<{
    key: string
    label: string
    partner: boolean
    modes: UsageMode[]
    calls: number
    last_seen: string
    whole_collection: boolean
  }>
> {
  const map = await dependencyMap(days)
  const out = []
  for (const c of map.callers) {
    const col = c.collections.find((x) => x.collection === collection)
    if (!col) continue
    const r = col.read.find((f) => f.field === field)
    const w = col.written.find((f) => f.field === field)
    if (!r && !w && !col.read_all) continue
    const modes: UsageMode[] = []
    if (r || col.read_all) modes.push('read')
    if (w) modes.push('write')
    const hits = [r, w].filter(Boolean) as FieldUse[]
    out.push({
      key: c.key,
      label: c.label,
      partner: c.partner,
      modes,
      calls: hits.reduce((s, h) => s + h.calls, 0) || col.calls,
      last_seen:
        hits
          .map((h) => h.last_seen)
          .sort()
          .pop() ?? col.last_seen,
      whole_collection: !r && !w && col.read_all
    })
  }
  return out.sort((x, y) => Number(y.partner) - Number(x.partner) || y.calls - x.calls)
}

// ─── Break check ────────────────────────────────────────────────────────────

export interface DependencyFinding {
  severity: 'break' | 'deprecated'
  caller: string
  caller_key: string
  collection: string
  field: string | null
  mode: UsageMode | null
  via: UsageVia[]
  message: string
  last_seen: string
}

interface CurrentSchema {
  collections: Set<string>
  tables: Set<string>
  fields: Map<string, Map<string, { deprecated_at: string | null; note: string | null }>>
  columns: Map<string, Set<string>>
  aliases: Map<string, Set<string>>
  gql: GraphQLSchema | null
}

async function loadCurrentSchema(): Promise<CurrentSchema> {
  const hasDep = await hasColumn('nivaro_fields', 'deprecated_at')
  const [collectionRows, fieldRows, columnRows, relations, gql] = await Promise.all([
    db('nivaro_collections').select('collection') as Promise<Array<{ collection: string }>>,
    db('nivaro_fields').select(
      hasDep
        ? ['collection', 'field', 'deprecated_at', 'deprecation_note']
        : ['collection', 'field']
    ) as Promise<Array<Record<string, unknown>>>,
    db('information_schema.columns').select('table_name', 'column_name') as Promise<
      Array<{ table_name: string; column_name: string }>
    >,
    getRelations(),
    currentSchema()
  ])
  const fields = new Map<
    string,
    Map<string, { deprecated_at: string | null; note: string | null }>
  >()
  for (const f of fieldRows) {
    const c = String(f.collection)
    const m = fields.get(c) ?? new Map()
    m.set(String(f.field), {
      deprecated_at: f.deprecated_at ? new Date(f.deprecated_at as string).toISOString() : null,
      note: (f.deprecation_note as string | null) ?? null
    })
    fields.set(c, m)
  }
  const columns = new Map<string, Set<string>>()
  for (const r of columnRows) {
    const s = columns.get(r.table_name) ?? new Set<string>()
    s.add(r.column_name)
    columns.set(r.table_name, s)
  }
  const aliases = new Map<string, Set<string>>()
  for (const r of relations) {
    if (!r.one_collection || !r.one_field) continue
    const s = aliases.get(r.one_collection) ?? new Set<string>()
    s.add(r.one_field)
    aliases.set(r.one_collection, s)
  }
  return {
    collections: new Set(collectionRows.map((c) => c.collection)),
    tables: new Set(columns.keys()),
    fields,
    columns,
    aliases,
    gql
  }
}

function fieldExists(
  s: CurrentSchema,
  collection: string,
  f: FieldUse
): { ok: boolean; missingVia: UsageVia[] } {
  const missing: UsageVia[] = []
  if (f.via.includes('rest')) {
    const ok =
      f.field === 'id' ||
      s.fields.get(collection)?.has(f.field) ||
      s.columns.get(collection)?.has(f.field) ||
      s.aliases.get(collection)?.has(f.field)
    if (!ok) missing.push('rest')
  }
  if (f.via.includes('graphql')) {
    let ok = false
    if (s.gql && f.gql_types?.length) {
      for (const t of f.gql_types) {
        const type = s.gql.getType(t)
        if (type && isObjectType(type) && type.getFields()[f.field]) ok = true
      }
    } else {
      ok = !!(f.field === 'id' || s.fields.get(collection)?.has(f.field))
    }
    if (!ok) missing.push('graphql')
  }
  return { ok: missing.length === 0, missingVia: missing }
}

/**
 * Compare every caller's used set with the current schema. A break = a used
 * collection or field that no longer exists (or a GraphQL root field the
 * schema dropped); a deprecation = a used field that carries deprecated_at.
 * Only partners (API keys, machine accounts) unless `includePeople`.
 */
export async function checkDependencies(
  opts: { days?: number; includePeople?: boolean; fresh?: boolean } = {}
): Promise<{ findings: DependencyFinding[]; callers: number; fields: number; days: number }> {
  const [map, s] = await Promise.all([
    dependencyMap(opts.days ?? 14, { fresh: opts.fresh }),
    loadCurrentSchema()
  ])
  const findings: DependencyFinding[] = []
  let fieldCount = 0
  const judged = map.callers.filter((c) => c.partner || opts.includePeople)
  for (const c of judged) {
    for (const col of c.collections) {
      const gone = !s.collections.has(col.collection) && !s.tables.has(col.collection)
      if (gone) {
        findings.push({
          severity: 'break',
          caller: c.label,
          caller_key: c.key,
          collection: col.collection,
          field: null,
          mode: col.writes ? 'write' : 'read',
          via: [...new Set([...col.read, ...col.written].flatMap((f) => f.via))] as UsageVia[],
          message: `${c.label} uses ${col.collection}, which no longer exists`,
          last_seen: col.last_seen
        })
        continue
      }
      for (const [mode, list] of [
        ['read', col.read],
        ['write', col.written]
      ] as const) {
        for (const f of list) {
          fieldCount++
          const verdict = fieldExists(s, col.collection, f)
          if (!verdict.ok) {
            findings.push({
              severity: 'break',
              caller: c.label,
              caller_key: c.key,
              collection: col.collection,
              field: f.field,
              mode,
              via: verdict.missingVia,
              message: `${c.label} ${mode === 'write' ? 'writes' : 'reads'} ${col.collection}.${f.field}, ${
                verdict.missingVia.length === 1 && verdict.missingVia[0] === 'graphql'
                  ? 'which the GraphQL schema no longer serves'
                  : 'which no longer exists'
              }`,
              last_seen: f.last_seen
            })
            continue
          }
          const meta = s.fields.get(col.collection)?.get(f.field)
          if (meta?.deprecated_at) {
            findings.push({
              severity: 'deprecated',
              caller: c.label,
              caller_key: c.key,
              collection: col.collection,
              field: f.field,
              mode,
              via: f.via,
              message: `${c.label} ${mode === 'write' ? 'writes' : 'reads'} ${col.collection}.${f.field}, deprecated since ${meta.deprecated_at.slice(0, 10)}${meta.note ? ` (${meta.note})` : ''}`,
              last_seen: f.last_seen
            })
          }
        }
      }
    }
    if (s.gql) {
      const q = s.gql.getQueryType()?.getFields() ?? {}
      const m = s.gql.getMutationType()?.getFields() ?? {}
      const sub = s.gql.getSubscriptionType()?.getFields() ?? {}
      for (const op of c.operations) {
        const roots = op.kind === 'mutation' ? m : op.kind === 'subscription' ? sub : q
        for (const rf of op.root_fields) {
          if (rf.startsWith('__') || roots[rf]) continue
          findings.push({
            severity: 'break',
            caller: c.label,
            caller_key: c.key,
            collection: '(graphql)',
            field: rf,
            mode: op.kind === 'mutation' ? 'write' : 'read',
            via: ['graphql'],
            message: `${c.label}'s operation ${op.name} calls ${op.kind} field ${rf}, which the schema no longer has`,
            last_seen: op.last_seen
          })
        }
      }
    }
  }
  // One line per (caller, collection, field, severity).
  const seen = new Set<string>()
  const unique = findings.filter((f) => {
    const id = `${f.caller_key}|${f.collection}|${f.field}|${f.severity}|${f.mode}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  unique.sort(
    (a, b) =>
      Number(b.severity === 'break') - Number(a.severity === 'break') ||
      a.caller.localeCompare(b.caller) ||
      a.collection.localeCompare(b.collection)
  )
  return { findings: unique, callers: judged.length, fields: fieldCount, days: map.days }
}

// ─── Exports ────────────────────────────────────────────────────────────────

/** The generated OpenAPI document narrowed to what this caller calls. */
export async function openApiSubset(dep: CallerDependencies): Promise<Record<string, unknown>> {
  const { generateOpenApi, loadSchema } = await import('../routes/dev-tools.js')
  const { collections, fieldsByCollection, projectName } = await loadSchema()
  const restCollections = new Map<string, CollectionUse>()
  const usedPaths = new Map<string, Set<string>>()
  for (const e of dep.endpoints) {
    if (/^\/api\/graphql\/?$/.test(e.path)) continue
    const rel = e.path.replace(/^\/api/, '') || '/'
    const set = usedPaths.get(rel) ?? new Set<string>()
    set.add(e.method.toLowerCase())
    usedPaths.set(rel, set)
    const m = rel.match(/^\/items\/([^/]+)/)
    if (m) {
      const use = dep.collections.find((c) => c.collection === m[1])
      if (use) restCollections.set(m[1], use)
    }
  }
  const subsetCollections = collections.filter((c) => restCollections.has(c.collection))
  const subsetFields = new Map<string, CMSField[]>()
  for (const c of subsetCollections) {
    const use = restCollections.get(c.collection) as CollectionUse
    const wanted = new Set([
      'id',
      ...use.read.map((f) => f.field),
      ...use.written.map((f) => f.field)
    ])
    const all = fieldsByCollection.get(c.collection) ?? []
    subsetFields.set(c.collection, use.read_all ? all : all.filter((f) => wanted.has(f.field)))
  }
  const spec = generateOpenApi(subsetCollections, subsetFields, projectName) as {
    info: Record<string, unknown>
    paths: Record<string, Record<string, unknown>>
    [k: string]: unknown
  }
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [path, methods] of usedPaths) {
    // The generated spec names the record id {id}; our normalizer does too.
    const generated = spec.paths[path]
    const ops: Record<string, unknown> = {}
    const idParams = [...path.matchAll(/\{(\w+)\}/g)]
    let n = 0
    const renamed = path.replace(/\{id\}/g, () => (n++ === 0 ? '{id}' : `{id${n}}`))
    for (const method of methods) {
      if (generated?.[method]) {
        ops[method] = generated[method]
        continue
      }
      ops[method] = {
        summary: `Called by ${dep.label}`,
        description: 'Not described by the generated items spec — see the API reference.',
        ...(idParams.length
          ? {
              parameters: [...renamed.matchAll(/\{(\w+)\}/g)].map((p) => ({
                name: p[1],
                in: 'path',
                required: true,
                schema: { type: 'string' }
              }))
            }
          : {}),
        responses: { default: { description: 'See the API reference' } }
      }
    }
    paths[renamed] = ops
  }
  return {
    ...spec,
    info: {
      ...spec.info,
      title: `${projectName} API — used by ${dep.label}`,
      description: `The endpoints and fields ${dep.label} called in the last logged window, generated from the schema registry.`
    },
    paths,
    'x-nivaro-caller': dep.key,
    'x-nivaro-generated-at': new Date().toISOString()
  }
}

function sdlString(s: string): string {
  return JSON.stringify(s)
}

/** The live GraphQL schema narrowed to the types, fields, arguments and
 *  input fields this caller uses, printed as SDL. */
export async function graphqlSdlSubset(dep: CallerDependencies): Promise<string> {
  const schema = await currentSchema()
  if (!schema) return '# GraphQL schema unavailable\n'
  const typeFields = dep.graphql.type_fields
  if (Object.keys(typeFields).length === 0) {
    return `# ${dep.label} made no GraphQL calls in the logged window.\n`
  }
  const argsUsed = dep.graphql.args
  const inputUsed = dep.graphql.input_fields
  const out: string[] = [
    `# GraphQL used by ${dep.label} (${dep.key})`,
    `# Generated ${new Date().toISOString()} from the live schema and the request log.`,
    ''
  ]
  const referenced = new Set<string>()
  const printed = new Set<string>()
  const refOf = (t: unknown) => getNamedType(t as Parameters<typeof getNamedType>[0])?.name
  const deprecated = (reason?: string | null) =>
    reason ? ` @deprecated(reason: ${sdlString(reason)})` : ''

  const orderedTypes = Object.keys(typeFields).sort((a, b) => {
    const rank = (n: string) =>
      n === schema.getQueryType()?.name ? 0 : n === schema.getMutationType()?.name ? 1 : 2
    return rank(a) - rank(b) || a.localeCompare(b)
  })
  for (const typeName of orderedTypes) {
    const type = schema.getType(typeName)
    if (!type || !isObjectType(type)) continue
    const fields = type.getFields()
    const lines: string[] = []
    for (const fname of typeFields[typeName]) {
      const f = fields[fname]
      if (!f) {
        lines.push(`  # ${fname}: no longer in the schema`)
        continue
      }
      const used = new Set(argsUsed[`${typeName}.${fname}`] ?? [])
      const args = f.args.filter((a) => used.has(a.name))
      for (const a of args) referenced.add(refOf(a.type) as string)
      referenced.add(refOf(f.type) as string)
      const argText = args.length
        ? `(${args.map((a) => `${a.name}: ${String(a.type)}`).join(', ')})`
        : ''
      lines.push(`  ${fname}${argText}: ${String(f.type)}${deprecated(f.deprecationReason)}`)
    }
    if (type.description) out.push(`"""${type.description.replace(/"""/g, '\\"""')}"""`)
    out.push(`type ${typeName} {`, ...lines, '}', '')
    printed.add(typeName)
  }
  // Input types reachable from used arguments, narrowed to supplied fields.
  const queue = [...referenced]
  while (queue.length) {
    const name = queue.shift() as string
    if (!name || printed.has(name)) continue
    const type = schema.getType(name) as GraphQLNamedType | undefined
    if (!type) continue
    if (isInputObjectType(type)) {
      const supplied = new Set(inputUsed[name] ?? [])
      const fields = Object.values(type.getFields()).filter((f) => supplied.has(f.name))
      if (fields.length === 0) {
        out.push(`input ${name}`, '')
      } else {
        out.push(`input ${name} {`)
        for (const f of fields) {
          out.push(`  ${f.name}: ${String(f.type)}`)
          const inner = refOf(f.type)
          if (inner && !printed.has(inner)) queue.push(inner)
        }
        out.push('}', '')
      }
      printed.add(name)
    } else if (isEnumType(type)) {
      out.push(`enum ${name} {`, ...type.getValues().map((v) => `  ${v.name}`), '}', '')
      printed.add(name)
    } else if (isScalarType(type)) {
      if (!['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name))
        out.push(`scalar ${name}`, '')
      printed.add(name)
    } else if (isUnionType(type)) {
      const members = type.getTypes().filter((t) => printed.has(t.name))
      if (members.length) out.push(`union ${name} = ${members.map((t) => t.name).join(' | ')}`, '')
      printed.add(name)
    }
  }
  return `${out.join('\n').trimEnd()}\n`
}
