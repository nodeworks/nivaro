/**
 * Typed GraphQL client generation (#1282) — `nivaro types --graphql`.
 *
 * Input: the `__schema` of a standard introspection result, read from the
 * live instance AS THE TOKEN'S USER (so only the collections that user may
 * see). Output: one standalone TypeScript file — types for every object,
 * input, enum and union in the schema, a `Selection<T>` / `Selected<T, S>`
 * pair that types a query's result from the fields it asks for, and
 * `createGraphQLClient()` with list / byId / create / update / delete /
 * aggregated / metadata helpers per collection plus a `graphql(doc, vars)`
 * escape hatch. The file needs no dependency and no DOM lib: it carries its
 * own fetch type.
 *
 * Plain ESM (no build step): the CLI imports it directly, the unit tests run
 * it under `node --test`.
 */

/** The introspection document the CLI posts. Seven `ofType` levels cover
 *  `[[T!]!]!`, the deepest wrapping the core emits. */
export const INTROSPECTION_QUERY = `query NivaroIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: true) {
        name description isDeprecated deprecationReason
        args { name type { ...TypeRef } defaultValue }
        type { ...TypeRef }
      }
      inputFields { name type { ...TypeRef } defaultValue }
      enumValues(includeDeprecated: true) { name }
      possibleTypes { name }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name
    ofType { kind name ofType { kind name ofType { kind name } } } } } } }
}`

const BUILTIN_SCALARS = {
  ID: 'string',
  String: 'string',
  Int: 'number',
  Float: 'number',
  Boolean: 'boolean'
}

/** Custom scalars whose wire form is known; anything else is `unknown`. */
const KNOWN_SCALARS = {
  Date: 'string',
  DateTime: 'string',
  Timestamp: 'string',
  Time: 'string',
  BigInt: 'string',
  UUID: 'string'
}

/** Names a generated type may not take: TS keywords, the globals the file
 *  uses, and the file's own helpers. A schema type with one of them gets a
 *  trailing underscore. */
const RESERVED = new Set([
  'any',
  'as',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'module',
  'namespace',
  'never',
  'new',
  'null',
  'number',
  'object',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'return',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unique',
  'unknown',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'Array',
  'Boolean',
  'Date',
  'Error',
  'Function',
  'JSON',
  'Map',
  'NonNullable',
  'Number',
  'Object',
  'Omit',
  'Partial',
  'Pick',
  'Promise',
  'ReadonlyArray',
  'Record',
  'Set',
  'String',
  'Symbol',
  'Selection',
  'Selected',
  'GqlBase',
  'GqlSelField',
  'GqlPick',
  'GqlUnionValue',
  'GqlWriteData',
  'GqlFetch',
  'GqlResponse',
  'GraphQLClientOptions',
  'GraphQLRequestError',
  'GraphQLClient',
  'createGraphQLClient',
  'DEFAULT_SELECTIONS'
])

/** The TS name a GraphQL type is emitted under. */
export function tsTypeName(name) {
  return RESERVED.has(name) ? `${name}_` : name
}

function named(ref) {
  let r = ref
  while (r && (r.kind === 'NON_NULL' || r.kind === 'LIST')) r = r.ofType
  return r ?? null
}

/** GraphQL type-reference string for a variable declaration: `[String!]!`. */
export function gqlTypeRef(ref) {
  if (ref.kind === 'NON_NULL') return `${gqlTypeRef(ref.ofType)}!`
  if (ref.kind === 'LIST') return `[${gqlTypeRef(ref.ofType)}]`
  return ref.name
}

function isRequired(ref) {
  return ref.kind === 'NON_NULL'
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
function prop(name) {
  return IDENT.test(name) ? name : JSON.stringify(name)
}

function comment(text, indent = '') {
  if (!text) return ''
  const clean = String(text).replace(/\*\//g, '* /').trim()
  if (!clean) return ''
  const lines = clean.split('\n')
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`
}

/**
 * Builds the generator's view of the schema: types by name, the root type
 * names, and every collection with the operations the core gives it.
 */
/** Which policy action a helper needs. */
const OP_ACTION = {
  list: 'read',
  byId: 'read',
  metadata: 'read',
  aggregated: 'read',
  create: 'create',
  update: 'update',
  delete: 'delete'
}

/**
 * The caller's access, from GET /api/security/my/permissions, as the
 * generator reads it: admins keep everything; anyone else keeps only the
 * helpers their role's policies allow (`*` = every collection).
 * @param {{ is_admin?: boolean, collections?: Array<{ collection: string, actions: string[] }> } | null} perms
 */
export function accessFromPermissions(perms) {
  if (!perms || perms.is_admin) return null
  const map = new Map()
  for (const c of perms.collections ?? []) {
    const set = map.get(c.collection) ?? new Set()
    for (const a of c.actions ?? []) set.add(a)
    map.set(c.collection, set)
  }
  return map
}

function allowed(access, collection, method) {
  if (!access) return true
  const action = OP_ACTION[method]
  const own = access.get(collection)
  const any = access.get('*')
  return !!(own?.has(action) || own?.has('*') || any?.has(action) || any?.has('*'))
}

export function analyzeSchema(schema, access = null) {
  const types = new Map()
  for (const t of schema.types ?? []) if (t.name && !t.name.startsWith('__')) types.set(t.name, t)
  const queryName = schema.queryType?.name ?? 'Query'
  const mutationName = schema.mutationType?.name ?? null
  const query = types.get(queryName)
  const mutation = mutationName ? types.get(mutationName) : null
  const qf = new Map((query?.fields ?? []).map((f) => [f.name, f]))
  const mf = new Map((mutation?.fields ?? []).map((f) => [f.name, f]))
  const collections = []
  for (const f of query?.fields ?? []) {
    const byId = qf.get(`${f.name}_by_id`)
    if (!byId) continue
    const item = named(byId.type)
    if (!item || types.get(item.name)?.kind !== 'OBJECT') continue
    const ops = [
      ['list', 'query', f],
      ['byId', 'query', byId],
      ['metadata', 'query', qf.get(`${f.name}_metadata`)],
      ['aggregated', 'query', qf.get(`${f.name}_aggregated`)],
      ['create', 'mutation', mf.get(`create_${f.name}`)],
      ['update', 'mutation', mf.get(`update_${f.name}_item`)],
      ['delete', 'mutation', mf.get(`delete_${f.name}_item`)]
    ]
      .filter(([method, , field]) => field && allowed(access, f.name, method))
      .map(([method, kind, field]) => ({ method, kind, field }))
    if (ops.length === 0) continue
    collections.push({ name: f.name, itemType: item.name, ops })
  }
  collections.sort((a, b) => a.name.localeCompare(b.name))
  return { types, queryName, mutationName, collections }
}

function scalarTs(name) {
  return BUILTIN_SCALARS[name] ?? KNOWN_SCALARS[name] ?? 'unknown'
}

/** TS type of an OUTPUT reference (object fields, operation results). */
function outTs(ref, types, nullable = true) {
  if (ref.kind === 'NON_NULL') return outTs(ref.ofType, types, false)
  const inner =
    ref.kind === 'LIST'
      ? `Array<${outTs(ref.ofType, types)}>`
      : types.get(ref.name)?.kind === 'SCALAR' || BUILTIN_SCALARS[ref.name]
        ? scalarTs(ref.name)
        : tsTypeName(ref.name)
  return nullable ? `${inner} | null` : inner
}

/** TS type of an INPUT reference (arguments, input-object fields). */
function inTs(ref, types) {
  if (ref.kind === 'NON_NULL') return inTs(ref.ofType, types)
  if (ref.kind === 'LIST') return `Array<${inTs(ref.ofType, types)}${nullableIn(ref.ofType)}>`
  return types.get(ref.name)?.kind === 'SCALAR' || BUILTIN_SCALARS[ref.name]
    ? scalarTs(ref.name)
    : tsTypeName(ref.name)
}
function nullableIn(ref) {
  return ref.kind === 'NON_NULL' ? '' : ' | null'
}

/** Fields a default selection takes: leaf fields with no required argument. */
function leafFields(type, types) {
  const out = []
  for (const f of type.fields ?? []) {
    if ((f.args ?? []).some((a) => isRequired(a.type) && a.defaultValue == null)) continue
    const n = named(f.type)
    const kind = types.get(n.name)?.kind ?? (BUILTIN_SCALARS[n.name] ? 'SCALAR' : null)
    if (kind === 'SCALAR' || kind === 'ENUM') out.push(f.name)
  }
  return out
}

const HELPERS = `// ─── Selection typing ───────────────────────────────────────────────────────

/** A union-typed field's value. Select it with a raw string of inline
 *  fragments: \`{ item: '... on vendors { id name }' }\`. */
export type GqlUnionValue = { __typename: string } & { [key: string]: unknown }

type GqlBase<V> = NonNullable<V> extends ReadonlyArray<infer U> ? NonNullable<U> : NonNullable<V>
type GqlSelField<V> = GqlBase<V> extends GqlUnionValue
  ? string
  : GqlBase<V> extends object
    ? Selection<GqlBase<V>> | string
    : true

/** The fields to fetch: \`true\` for a leaf, a nested Selection (or a raw
 *  GraphQL sub-selection string) for an object. */
export type Selection<T> = { [K in keyof T]?: GqlSelField<T[K]> }

type GqlPick<V, S> = V extends null | undefined
  ? V
  : V extends ReadonlyArray<infer U>
    ? Array<GqlPick<U, S>>
    : S extends string
      ? V
      : V extends object
        ? Selected<V, S>
        : V

/** The shape a query returns for the selection \`S\` over the type \`T\`. */
export type Selected<T, S> = { [K in keyof S & keyof T]: GqlPick<T[K], S[K]> }

/** A create / update payload: the item's own field names, plus anything the
 *  server accepts besides (nested rows, \`_change_reason\`). */
export type GqlWriteData<T> = { [K in keyof T]?: unknown } & {
  _change_reason?: string
  [key: string]: unknown
}

// ─── Transport ───────────────────────────────────────────────────────────────

type GqlResponse = {
  ok: boolean
  status: number
  text(): Promise<string>
}
export type GqlFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<GqlResponse>

export interface GraphQLClientOptions {
  /** API origin, e.g. https://cms.example.com — the client posts to /api/graphql. */
  url: string
  /** A static token or an API key, sent as a Bearer token. */
  token?: string
  headers?: Record<string, string>
  /** Defaults to the global fetch. */
  fetch?: GqlFetch
}

/** A GraphQL answer that carried \`errors\`, or a request that failed. */
export class GraphQLRequestError extends Error {
  readonly status: number
  readonly errors: Array<{ message: string; extensions?: Record<string, unknown> }>
  constructor(
    message: string,
    status: number,
    errors: Array<{ message: string; extensions?: Record<string, unknown> }>
  ) {
    super(message)
    this.name = 'GraphQLRequestError'
    this.status = status
    this.errors = errors
  }
}

function gqlRender(sel: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(sel)) {
    if (!value) continue
    if (value === true) parts.push(key)
    else if (typeof value === 'string') parts.push(\`\${key} { \${value} }\`)
    else parts.push(\`\${key} { \${gqlRender(value as Record<string, unknown>)} }\`)
  }
  if (parts.length === 0) throw new Error('A selection must name at least one field')
  return parts.join(' ')
}

function gqlDocument(
  kind: 'query' | 'mutation',
  field: string,
  varTypes: Record<string, string>,
  vars: Record<string, unknown>,
  selection: Record<string, unknown> | null
): { query: string; variables: Record<string, unknown> } {
  const used = Object.keys(varTypes).filter((k) => vars[k] !== undefined)
  const defs = used.map((k) => \`$\${k}: \${varTypes[k]}\`).join(', ')
  const args = used.map((k) => \`\${k}: $\${k}\`).join(', ')
  const head = defs ? \`\${kind}(\${defs})\` : kind
  const call = args ? \`\${field}(\${args})\` : field
  const body = selection ? \` { \${gqlRender(selection)} }\` : ''
  const variables: Record<string, unknown> = {}
  for (const k of used) variables[k] = vars[k]
  return { query: \`\${head} { \${call}\${body} }\`, variables }
}
`

/**
 * Generates the client file from an introspection `__schema`.
 * @param {object} schema  `data.__schema` of the introspection answer
 * @param {{ source?: string, access?: Map<string, Set<string>> | null }} [opts]
 *   `source` is shown in the header; `access` (accessFromPermissions) keeps
 *   only the helpers the caller may use
 * @returns {string}
 */
export function generateGraphQLClient(schema, opts = {}) {
  const { types, queryName, mutationName, collections } = analyzeSchema(schema, opts.access ?? null)
  const out = []
  out.push(
    '/* eslint-disable */\n' +
      '// biome-ignore-all lint: generated file\n' +
      '/**\n' +
      ' * Typed GraphQL client — generated by `nivaro types --graphql`.\n' +
      ` * Source: ${opts.source ?? 'a Nivaro instance'}. Do not edit by hand; re-run the command.\n` +
      ' *\n' +
      ' *   const cms = createGraphQLClient({ url: process.env.NIVARO_URL!, token })\n' +
      ' *   const rows = await cms.<collection>.list({ limit: 10 }, { id: true })\n' +
      ' */\n'
  )

  // ── schema types ──
  const roots = new Set([queryName, mutationName, 'Subscription'].filter(Boolean))
  const sorted = [...types.values()].sort((a, b) => a.name.localeCompare(b.name))
  out.push('// ─── Schema types ───────────────────────────────────────────────────────────\n')
  for (const t of sorted) {
    if (roots.has(t.name)) continue
    const tn = tsTypeName(t.name)
    if (t.kind === 'ENUM') {
      const vals = (t.enumValues ?? []).map((v) => JSON.stringify(v.name))
      out.push(`${comment(t.description)}export type ${tn} = ${vals.join(' | ') || 'never'}\n`)
    } else if (t.kind === 'UNION') {
      const members = (t.possibleTypes ?? []).map((p) => p.name).join(', ')
      out.push(`/** Union of ${members}. */\nexport type ${tn} = GqlUnionValue\n`)
    } else if (t.kind === 'INPUT_OBJECT') {
      const lines = (t.inputFields ?? []).map((f) => {
        const req = isRequired(f.type) && f.defaultValue == null
        return `  ${prop(f.name)}${req ? '' : '?'}: ${inTs(f.type, types)}${req ? '' : ' | null'}`
      })
      out.push(
        `${comment(t.description)}export interface ${tn} {\n${lines.join('\n')}${lines.length ? '\n' : ''}}\n`
      )
    } else if (t.kind === 'OBJECT' || t.kind === 'INTERFACE') {
      const lines = (t.fields ?? []).map((f) => {
        const deprecated = f.isDeprecated
          ? `  /** @deprecated ${String(f.deprecationReason ?? '').replace(/\*\//g, '* /')} */\n`
          : comment(f.description, '  ')
        return `${deprecated}  ${prop(f.name)}: ${outTs(f.type, types)}`
      })
      out.push(
        `${comment(t.description)}export interface ${tn} {\n${lines.join('\n')}${lines.length ? '\n' : ''}}\n`
      )
    }
  }

  out.push(HELPERS)

  // ── default selections ──
  const defaultsFor = new Set()
  for (const c of collections)
    for (const op of c.ops) {
      const n = named(op.field.type)
      const kind = types.get(n.name)?.kind
      if (kind === 'OBJECT' || kind === 'INTERFACE') defaultsFor.add(n.name)
    }
  out.push(
    '// ─── Default selections (every leaf field) ──────────────────────────────────\n\n' +
      'export const DEFAULT_SELECTIONS = {\n'
  )
  for (const name of [...defaultsFor].sort()) {
    const leaves = leafFields(types.get(name), types)
    const body = leaves.map((l) => `${prop(l)}: true`).join(', ')
    out.push(`  ${prop(name)}: {${body ? ` ${body} ` : ''}},\n`)
  }
  out.push('} as const\n\n')

  // ── client ──
  out.push(
    '// ─── Client ─────────────────────────────────────────────────────────────────\n\n' +
      'export function createGraphQLClient(opts: GraphQLClientOptions) {\n' +
      "  const endpoint = `${opts.url.replace(/\\/+$/, '')}/api/graphql`\n" +
      '  const doFetch: GqlFetch | undefined =\n' +
      '    opts.fetch ?? (globalThis as unknown as { fetch?: GqlFetch }).fetch\n\n' +
      '  /** Runs any document: the escape hatch for what the helpers do not cover. */\n' +
      '  async function graphql<T = unknown>(\n' +
      '    query: string,\n' +
      '    variables?: Record<string, unknown>\n' +
      '  ): Promise<T> {\n' +
      "    if (!doFetch) throw new Error('No fetch available — pass opts.fetch')\n" +
      "    const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers }\n" +
      '    if (opts.token) headers.authorization = `Bearer ${opts.token}`\n' +
      '    const res = await doFetch(endpoint, {\n' +
      "      method: 'POST',\n" +
      '      headers,\n' +
      '      body: JSON.stringify({ query, variables: variables ?? {} })\n' +
      '    })\n' +
      '    const text = await res.text()\n' +
      '    let json: { data?: unknown; errors?: Array<{ message: string }> } | null = null\n' +
      '    try {\n' +
      '      json = JSON.parse(text)\n' +
      '    } catch {\n' +
      '      json = null\n' +
      '    }\n' +
      '    if (json?.errors?.length)\n' +
      '      throw new GraphQLRequestError(json.errors[0].message, res.status, json.errors)\n' +
      '    if (!res.ok || !json)\n' +
      '      throw new GraphQLRequestError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, [])\n' +
      '    return json.data as T\n' +
      '  }\n\n' +
      '  async function run<T>(\n' +
      "    kind: 'query' | 'mutation',\n" +
      '    field: string,\n' +
      '    varTypes: Record<string, string>,\n' +
      '    vars: Record<string, unknown>,\n' +
      '    selection: Record<string, unknown> | null\n' +
      '  ): Promise<T> {\n' +
      '    const doc = gqlDocument(kind, field, varTypes, vars, selection)\n' +
      '    const data = await graphql<Record<string, T>>(doc.query, doc.variables)\n' +
      '    return data[field]\n' +
      '  }\n\n' +
      '  return {\n' +
      '    graphql,\n'
  )
  const usedKeys = new Set(['graphql'])
  for (const c of collections) {
    let key = c.name
    while (usedKeys.has(key)) key = `${key}_`
    usedKeys.add(key)
    const itemTs = tsTypeName(c.itemType)
    out.push(`    ${prop(key)}: {\n`)
    for (const op of c.ops) out.push(renderOp(op, c, itemTs, types))
    out.push('    },\n')
  }
  out.push(
    '  }\n}\n\n/** The client `createGraphQLClient` returns. */\nexport type GraphQLClient = ReturnType<typeof createGraphQLClient>\n'
  )
  return out.join('\n')
}

function renderOp(op, c, itemTs, types) {
  const { field, kind, method } = op
  const args = field.args ?? []
  const varTypes = Object.fromEntries(args.map((a) => [a.name, gqlTypeRef(a.type)]))
  const n = named(field.type)
  const retKind = types.get(n.name)?.kind
  const selectable = retKind === 'OBJECT' || retKind === 'INTERFACE'
  const retName = tsTypeName(n.name)
  const writeData = method === 'create' || method === 'update'

  const argTs = (a) => {
    if (writeData && a.name === 'data') return `GqlWriteData<${itemTs}>`
    return inTs(a.type, types) + (isRequired(a.type) ? '' : ' | null')
  }
  const names = args.map((a) => a.name).sort()
  const shape = names.join(',')
  const positional = shape === 'id' || shape === 'data' || shape === 'data,id'

  // the result type, wrapped the way the field's own type is wrapped
  const resultOf = (inner) => {
    const wrap = (ref, nullable = true) => {
      if (ref.kind === 'NON_NULL') return wrap(ref.ofType, false)
      const body = ref.kind === 'LIST' ? `Array<${wrap(ref.ofType)}>` : inner
      return nullable ? `${body} | null` : body
    }
    return wrap(field.type)
  }

  const params = []
  let varsExpr
  if (positional) {
    const order = shape === 'data,id' ? ['id', 'data'] : names
    for (const nm of order) {
      const a = args.find((x) => x.name === nm)
      params.push(`${nm}: ${argTs(a)}`)
    }
    varsExpr = `{ ${order.join(', ')} }`
  } else if (args.length) {
    const allOptional = args.every((a) => !isRequired(a.type) || a.defaultValue != null)
    const fields = args
      .map((a) => {
        const req = isRequired(a.type) && a.defaultValue == null
        return `${prop(a.name)}${req ? '' : '?'}: ${argTs(a)}`
      })
      .join('; ')
    params.push(`args: { ${fields} }${allOptional ? ' = {}' : ''}`)
    varsExpr = 'args as Record<string, unknown>'
  } else {
    varsExpr = '{}'
  }

  const doc = comment(field.description, '      ')
  const vt = JSON.stringify(varTypes)
  if (!selectable) {
    const ret = resultOf(scalarTs(n.name) === 'unknown' ? 'unknown' : scalarTs(n.name))
    return `${doc}      ${method}(${params.join(', ')}): Promise<${ret}> {\n        return run<${ret}>('${kind}', '${field.name}', ${vt}, ${varsExpr}, null)\n      },\n`
  }
  const defaultType = `(typeof DEFAULT_SELECTIONS)[${JSON.stringify(n.name)}]`
  params.push(`select?: S`)
  const ret = resultOf(`Selected<${retName}, S>`)
  return (
    `${doc}      ${method}<S extends Selection<${retName}> = ${defaultType}>(${params.join(', ')}): Promise<${ret}> {\n` +
    `        return run<${ret}>('${kind}', '${field.name}', ${vt}, ${varsExpr}, (select ?? DEFAULT_SELECTIONS[${JSON.stringify(n.name)}]) as Record<string, unknown>)\n` +
    '      },\n'
  )
}
