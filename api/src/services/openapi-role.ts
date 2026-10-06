import { db } from '../db/index.js'
import type { Policy, Role } from '../types.js'
import { type Action, parsePolicyFields, parseRowFilter, type RowCondition } from './permissions.js'
import { describeHops, listScopeDimensions, scopeHopsFor } from './user-scopes.js'

/**
 * OpenAPI per role (#1283) — the generated items-API contract narrowed to what
 * ONE role can actually read and write, so a team building against that role
 * gets the spec it will really hit.
 *
 * The access decision mirrors permissions.ts exactly — can() (an exact or `*`
 * policy for the action), getAllowedFields() (the policy's `fields`, null =
 * every field) and getRowFilter() (an exact-collection policy beats `*`) —
 * evaluated from ONE read of the role's policies instead of two queries per
 * (collection, action): a 200-collection instance would otherwise cost
 * thousands of round trips for a single download. The parsers are the shared
 * ones, so a `*` fields value or a bad row_filter reads the same here as on
 * the request path.
 *
 * `narrowOpenApiForRole` is pure: it takes the full spec generateOpenApi()
 * built and the access map, and returns the narrowed copy.
 */

export interface CollectionAccess {
  /** Field allow-list per action: null = every field, false = no policy. */
  read: string[] | null | false
  create: string[] | null | false
  update: string[] | null | false
  delete: boolean
  rowFilters: Partial<Record<Action, RowCondition[]>>
  /** Plain sentences about User Scope dimensions that reach this collection. */
  scopeNotes: string[]
}

export interface RoleAccess {
  role: { id: string; name: string; admin_access: boolean }
  access: Map<string, CollectionAccess>
}

const ACTIONS: Action[] = ['read', 'create', 'update', 'delete']

/** Pick the policy that decides (role, action, collection): exact beats `*`. */
export function pickPolicy<P extends { collection: string; action: string }>(
  policies: P[],
  action: Action,
  collection: string
): P | null {
  return (
    policies.find((p) => p.action === action && p.collection === collection) ??
    policies.find((p) => p.action === action && p.collection === '*') ??
    null
  )
}

export async function roleAccessFor(
  roleId: string,
  collections: string[]
): Promise<RoleAccess | null> {
  const role = (await db<Role>('nivaro_roles').where({ id: roleId }).first()) as Role | undefined
  if (!role) return null
  const admin = !!role.admin_access
  const policies = admin
    ? []
    : ((await db('nivaro_policies').where({ role: roleId })) as Array<
        Policy & { row_filter?: string | null; fields: unknown }
      >)

  // Scope dimensions — which per-user restrictions can narrow each collection.
  // Admins bypass User Scopes on the request path, so they get no notes.
  const dims = admin ? [] : await listScopeDimensions().catch(() => [])
  const targets = new Set(dims.map((d) => d.target_collection))

  const access = new Map<string, CollectionAccess>()
  for (const collection of collections) {
    const entry: CollectionAccess = {
      read: admin ? null : false,
      create: admin ? null : false,
      update: admin ? null : false,
      delete: admin,
      rowFilters: {},
      scopeNotes: []
    }
    if (!admin) {
      for (const action of ACTIONS) {
        const p = pickPolicy(policies, action, collection)
        if (!p) continue
        if (action === 'delete') entry.delete = true
        else entry[action] = parsePolicyFields(p.fields)
        const rf = parseRowFilter(p.row_filter)
        if (rf) entry.rowFilters[action] = rf
      }
      const reachable = entry.read !== false || entry.update !== false || entry.delete
      if (reachable) {
        for (const dim of dims) {
          // A dimension target table is filtered only by its own dimension.
          if (targets.has(collection) && dim.target_collection !== collection) continue
          const hops = await scopeHopsFor(dim, collection).catch(() => null)
          if (hops == null) {
            if (dim.strict)
              entry.scopeNotes.push(
                `${dim.label}: no route from this collection — a caller restricted on ${dim.label} sees no rows (strict dimension).`
              )
            continue
          }
          entry.scopeNotes.push(
            hops.length === 0
              ? `${dim.label}: a caller restricted on ${dim.label} sees only the ${dim.label} rows they are allowed.`
              : `${dim.label}: a caller restricted on ${dim.label} sees only rows linked to their allowed values (${describeHops(hops)}).`
          )
        }
      }
    }
    access.set(collection, entry)
  }
  return {
    role: { id: String(role.id), name: role.name, admin_access: admin },
    access
  }
}

// ─── Pure narrowing ──────────────────────────────────────────────────────────

type Json = Record<string, unknown>

const OP_WORDS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  contains: 'contains',
  in: 'is one of',
  null: 'is empty',
  nnull: 'is not empty'
}

export function describeRowFilter(conds: RowCondition[]): string {
  return conds
    .map((c) => {
      const word = OP_WORDS[c.op] ?? c.op
      if (c.op === 'null' || c.op === 'nnull') return `${c.field} ${word}`
      const v =
        c.value === '$CURRENT_USER'
          ? 'the calling user'
          : c.value === '$CURRENT_ROLE'
            ? 'the caller’s role'
            : Array.isArray(c.value)
              ? c.value.join(', ')
              : String(c.value ?? '')
      return `${c.field} ${word} ${v}`
    })
    .join(' and ')
}

function allows(list: string[] | null | false, field: string): boolean {
  if (list === false) return false
  if (list === null) return true
  return field === 'id' || list.includes(field)
}

function refName(op: unknown): string | null {
  const s = JSON.stringify(op ?? {})
  const m = s.match(/#\/components\/schemas\/([A-Za-z0-9_]+)/)
  return m ? m[1] : null
}

function withNote(op: Json, notes: string[]): Json {
  if (!notes.length) return op
  const prev = typeof op.description === 'string' ? `${op.description}\n\n` : ''
  return { ...op, description: `${prev}${notes.join('\n\n')}` }
}

/** Narrow a generateOpenApi() document to one role's access. */
export function narrowOpenApiForRole(spec: Json, roleAccess: RoleAccess): Json {
  const out = structuredClone(spec) as Json
  const paths = (out.paths ?? {}) as Record<string, Json>
  const components = (out.components ?? {}) as Json
  const schemas = (components.schemas ?? {}) as Record<string, Json>
  const keptSchemas: Record<string, Json> = {}
  const nextPaths: Record<string, Json> = {}

  for (const [collection, a] of roleAccess.access) {
    const listPath = `/items/${collection}`
    const itemPath = `/items/${collection}/{id}`
    const list = paths[listPath]
    const item = paths[itemPath]
    if (!list && !item) continue
    const name = refName(list?.get ?? list?.post ?? item?.get)
    const base = name ? schemas[name] : undefined
    if (!name || !base) continue

    const props = (base.properties ?? {}) as Record<string, Json>
    const writable = (f: string) => allows(a.create, f) || allows(a.update, f)

    const readProps: Record<string, Json> = {}
    for (const [f, s] of Object.entries(props)) {
      if (!allows(a.read, f)) continue
      readProps[f] = writable(f) ? s : { ...s, readOnly: true }
    }
    const writeSchema = (allowed: string[] | null | false, required: boolean): Json => {
      const p: Record<string, Json> = {}
      for (const [f, s] of Object.entries(props)) {
        if (f === 'id' || !allows(allowed, f)) continue
        p[f] = allows(a.read, f) ? s : { ...s, writeOnly: true }
      }
      const req = required
        ? ((base.required as string[] | undefined) ?? []).filter((f) => f in p)
        : []
      return {
        type: 'object',
        properties: p,
        ...(req.length ? { required: req } : {})
      }
    }

    const scopeNote = a.scopeNotes.length
      ? `User Scopes (per caller, on top of this role): ${a.scopeNotes.join(' ')}`
      : ''
    const notesFor = (action: Action): string[] => {
      const out: string[] = []
      const rf = a.rowFilters[action]
      if (rf?.length)
        out.push(`Row filter for this role: only rows where ${describeRowFilter(rf)}.`)
      if (scopeNote && action !== 'create') out.push(scopeNote)
      return out
    }

    const nl: Json = {}
    const ni: Json = {}
    if (a.read !== false) {
      keptSchemas[name] = {
        ...base,
        properties: readProps,
        required: ((base.required as string[] | undefined) ?? []).filter((f) => f in readProps)
      }
      if (list?.get) nl.get = withNote(list.get as Json, notesFor('read'))
      if (item?.get) ni.get = withNote(item.get as Json, notesFor('read'))
    }
    const responseRef = a.read !== false ? null : { type: 'object' }
    const stripResponse = (op: Json): Json => {
      if (!responseRef) return op
      // The role cannot read: a write answers, but the body is not readable data.
      const responses = { ...((op.responses ?? {}) as Json) }
      for (const code of Object.keys(responses)) {
        const r = responses[code] as Json
        if (r?.content) responses[code] = { description: r.description }
      }
      return { ...op, responses }
    }
    if (a.create !== false && list?.post) {
      keptSchemas[`${name}Create`] = writeSchema(a.create, true)
      const op = list.post as Json
      nl.post = withNote(
        stripResponse({
          ...op,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${name}Create` } }
            }
          }
        }),
        notesFor('create')
      )
    }
    if (a.update !== false && item?.patch) {
      keptSchemas[`${name}Update`] = writeSchema(a.update, false)
      const op = item.patch as Json
      ni.patch = withNote(
        stripResponse({
          ...op,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${name}Update` } }
            }
          }
        }),
        notesFor('update')
      )
    }
    if (a.delete && item?.delete) ni.delete = withNote(item.delete as Json, notesFor('delete'))

    if (Object.keys(nl).length) nextPaths[listPath] = nl
    if (Object.keys(ni).length) nextPaths[itemPath] = ni
  }

  out.paths = nextPaths
  out.components = { ...components, schemas: keptSchemas }
  const info = { ...((out.info ?? {}) as Json) }
  const r = roleAccess.role
  info.title = `${String(info.title ?? 'API')} — role ${r.name}`
  info.description = r.admin_access
    ? `Narrowed for the role "${r.name}". This role has admin access, so every collection and field is open and no row filter or User Scope applies.`
    : `Narrowed for the role "${r.name}": only the collections, operations and fields this role's policies allow. Response schemas list readable fields (readOnly = readable but never writable); Create/Update request schemas list writable fields (writeOnly = writable but not readable back). Row filters and User Scope notes on each operation say which rows a caller will actually reach.`
  out.info = info
  return out
}
