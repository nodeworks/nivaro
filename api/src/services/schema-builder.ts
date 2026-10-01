import {
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLFieldConfig,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  Kind,
  type SelectionNode
} from 'graphql'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import {
  domainMutationFields,
  domainQueryFields,
  domainSubscriptionFields
} from '../graphql/resolvers.js'
import { GraphQLJSON } from '../graphql/scalars.js'
import { ALL_DOMAIN_TYPES, UserType } from '../graphql/types.js'
import { describeDbRefusal, reasonWithoutSql } from '../lib/db-refusal.js'
import type { User } from '../types.js'
import { getFields, getRelations, listCollections } from './collections.js'
import { applyNestedGate, narrowNestedRow, nestedGate } from './graphql-nested-access.js'
import {
  AGGREGATE_FUNCTIONS,
  type AggregateFunction,
  type AggregateSpec
} from './item-aggregates.js'
import {
  aggregateItems,
  applyFilterToQuery,
  CollectionNotFoundError,
  createOne,
  deleteOne,
  ForbiddenError,
  readItems,
  readOne,
  rehearseCreate,
  updateOne,
  upsertInfoOf
} from './items.js'
import { timedGate, timedResolver } from './traffic-taps/graphql-resolvers.js'
import { runUnit } from './unit-of-work.js'
import { RECORD_ORIGINS, translateVirtualKeys } from './virtual-filters.js'
import {
  executeWorkflowTransition,
  startWorkflowInstance,
  WorkflowMutationError
} from './workflow-mutations.js'

// ─── CMS field type → GraphQL scalar mapping ──────────────────────────────────

const TYPE_MAP: Record<string, GraphQLOutputType> = {
  string: GraphQLString,
  text: GraphQLString,
  uuid: GraphQLString,
  hash: GraphQLString,
  integer: GraphQLInt,
  bigInteger: GraphQLInt,
  float: GraphQLFloat,
  decimal: GraphQLFloat,
  boolean: GraphQLBoolean,
  datetime: GraphQLString,
  date: GraphQLString,
  time: GraphQLString,
  json: GraphQLJSON,
  csv: GraphQLString
}

function fieldType(fieldName: string, cmsType: string): GraphQLOutputType {
  if (fieldName === 'id') return GraphQLID
  return TYPE_MAP[cmsType] ?? GraphQLString
}

// ─── Shared filter operator input types ──────────────────────────────────────

// Filters that are not columns. GraphQL names cannot start with `$`, so the
// inputs spell them `_state`, `_origin`, … and the resolvers rename them to
// the keys both REST surfaces use (services/virtual-filters.ts).
const RecordOriginEnum = new GraphQLEnumType({
  name: 'RecordOrigin',
  description: 'Who made a write.',
  values: Object.fromEntries(RECORD_ORIGINS.map((o) => [o, { value: o }]))
})

const StateVirtualFilter = new GraphQLInputObjectType({
  name: 'PipelineStateFilter',
  description:
    "The record's pipeline state, by state key. `__none__` names records that run no pipeline.",
  fields: {
    _eq: { type: GraphQLString },
    _neq: { type: GraphQLString },
    _in: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    _nin: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) }
  }
})

const OriginVirtualFilter = new GraphQLInputObjectType({
  name: 'RecordOriginFilter',
  description:
    'Who wrote to the record. `_in` = a write of these origins exists, `_nin` = none exists; the other keys narrow which writes count.',
  fields: {
    _eq: { type: RecordOriginEnum },
    _neq: { type: RecordOriginEnum },
    _in: { type: new GraphQLList(new GraphQLNonNull(RecordOriginEnum)) },
    _nin: { type: new GraphQLList(new GraphQLNonNull(RecordOriginEnum)) },
    days: { type: GraphQLInt, description: 'Only writes of the last N days.' },
    since: { type: GraphQLString, description: 'Only writes at or after this ISO time.' },
    until: { type: GraphQLString, description: 'Only writes at or before this ISO time.' },
    by: { type: GraphQLID, description: 'Only writes by this account.' },
    action: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
      description: 'Only these kinds of write: create, update, delete.'
    }
  }
})

const AddendumPresenceEnum = new GraphQLEnumType({
  name: 'AddendumPresence',
  values: {
    active: { value: 'active', description: 'An addendum is in flight.' },
    none: { value: 'none', description: 'No addendum is in flight.' },
    any: { value: 'any', description: 'The record has had an addendum.' }
  }
})

const IntegrationStandingEnum = new GraphQLEnumType({
  name: 'IntegrationStanding',
  values: {
    danger: { value: 'danger', description: 'A partner was not told: overdue, failed or missing.' },
    warning: { value: 'warning', description: 'A message is pending or was skipped.' },
    positive: { value: 'positive', description: 'A partner was told.' },
    none: { value: 'none', description: 'Nothing is owed to any partner.' }
  }
})

const VIRTUAL_FILTER_FIELDS: Record<string, { type: GraphQLInputType; description: string }> = {
  _state: { type: StateVirtualFilter, description: 'Pipeline state of the record.' },
  _origin: { type: OriginVirtualFilter, description: 'Who wrote to the record.' },
  _addendums: { type: AddendumPresenceEnum, description: 'Addendums on the record.' },
  _at_risk: {
    type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
    description: 'Highlight rule ids the record matches, or "any".'
  },
  _integrations: {
    type: IntegrationStandingEnum,
    description: 'How the record stands with its integration partners.'
  }
}

const StringFilterOps = new GraphQLInputObjectType({
  name: 'StringFilter',
  fields: {
    _eq: { type: GraphQLString },
    _neq: { type: GraphQLString },
    _contains: { type: GraphQLString },
    _ncontains: { type: GraphQLString },
    _starts_with: { type: GraphQLString },
    _ends_with: { type: GraphQLString },
    _icontains: { type: GraphQLString },
    _nstarts_with: { type: GraphQLString },
    _nends_with: { type: GraphQLString },
    _empty: { type: GraphQLBoolean },
    _nempty: { type: GraphQLBoolean },
    _in: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    _nin: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    _null: { type: GraphQLBoolean },
    _nnull: { type: GraphQLBoolean }
  }
})

const IntFilterOps = new GraphQLInputObjectType({
  name: 'IntFilter',
  fields: {
    _eq: { type: GraphQLInt },
    _neq: { type: GraphQLInt },
    _gt: { type: GraphQLInt },
    _gte: { type: GraphQLInt },
    _lt: { type: GraphQLInt },
    _lte: { type: GraphQLInt },
    _between: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) },
    _nbetween: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) },
    _in: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) },
    _nin: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) },
    _null: { type: GraphQLBoolean },
    _nnull: { type: GraphQLBoolean }
  }
})

const FloatFilterOps = new GraphQLInputObjectType({
  name: 'FloatFilter',
  fields: {
    _eq: { type: GraphQLFloat },
    _neq: { type: GraphQLFloat },
    _gt: { type: GraphQLFloat },
    _gte: { type: GraphQLFloat },
    _lt: { type: GraphQLFloat },
    _lte: { type: GraphQLFloat },
    _between: { type: new GraphQLList(new GraphQLNonNull(GraphQLFloat)) },
    _nbetween: { type: new GraphQLList(new GraphQLNonNull(GraphQLFloat)) },
    _in: { type: new GraphQLList(new GraphQLNonNull(GraphQLFloat)) },
    _nin: { type: new GraphQLList(new GraphQLNonNull(GraphQLFloat)) },
    _null: { type: GraphQLBoolean },
    _nnull: { type: GraphQLBoolean }
  }
})

const BoolFilterOps = new GraphQLInputObjectType({
  name: 'BoolFilter',
  fields: {
    _eq: { type: GraphQLBoolean },
    _neq: { type: GraphQLBoolean },
    _null: { type: GraphQLBoolean },
    _nnull: { type: GraphQLBoolean }
  }
})

// Dates stored as strings; supports all comparison operators
const DateFilterOps = new GraphQLInputObjectType({
  name: 'DateFilter',
  fields: {
    _eq: { type: GraphQLString },
    _neq: { type: GraphQLString },
    _gt: { type: GraphQLString },
    _gte: { type: GraphQLString },
    _lt: { type: GraphQLString },
    _lte: { type: GraphQLString },
    _between: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    _nbetween: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    _null: { type: GraphQLBoolean },
    _nnull: { type: GraphQLBoolean }
  }
})

const IDFilterOps = new GraphQLInputObjectType({
  name: 'IDFilter',
  fields: {
    _eq: { type: GraphQLID },
    _neq: { type: GraphQLID },
    // Keys are ordered: a reader walking a collection asks for ids after the last one.
    _gt: { type: GraphQLID },
    _gte: { type: GraphQLID },
    _lt: { type: GraphQLID },
    _lte: { type: GraphQLID },
    _in: { type: new GraphQLList(new GraphQLNonNull(GraphQLID)) },
    _nin: { type: new GraphQLList(new GraphQLNonNull(GraphQLID)) },
    _null: { type: GraphQLBoolean },
    _nnull: { type: GraphQLBoolean }
  }
})

function filterOpsForField(fieldName: string, cmsType: string): GraphQLInputObjectType {
  if (fieldName === 'id') return IDFilterOps
  switch (cmsType) {
    case 'uuid':
      return IDFilterOps
    case 'integer':
    case 'bigInteger':
      return IntFilterOps
    case 'float':
    case 'decimal':
      return FloatFilterOps
    case 'boolean':
      return BoolFilterOps
    case 'datetime':
    case 'date':
    case 'time':
      return DateFilterOps
    default:
      return StringFilterOps
  }
}

const ALL_FILTER_TYPES = [
  StringFilterOps,
  IntFilterOps,
  FloatFilterOps,
  BoolFilterOps,
  DateFilterOps,
  IDFilterOps
]

// ─── Shared delete response ───────────────────────────────────────────────────

const DeleteResponseType = new GraphQLObjectType({
  name: 'DeleteResponse',
  fields: { id: { type: GraphQLID } }
})

const DeleteManyResponseType = new GraphQLObjectType({
  name: 'DeleteManyResponse',
  fields: { ids: { type: new GraphQLList(GraphQLID) } }
})

// ─── Error conversion ─────────────────────────────────────────────────────────

const STATUS_CODES_GQL: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  423: 'LOCKED',
  429: 'RATE_LIMITED'
}

/**
 * A refusal from the items service becomes a GraphQL error a client can
 * branch on: `extensions.code` is the service's own machine code
 * (CHANGE_REASON_REQUIRED, VALIDATION_RULE_FAILED, …) or one derived from the
 * status, `extensions.status` the HTTP status the REST API would have
 * answered, and the structured detail (violations, conflicts, the nested row
 * that failed) rides along. A server fault keeps its reason but never the
 * statement that raised it.
 */
function wrapError(err: unknown): never {
  if (err instanceof ForbiddenError)
    throw Object.assign(new Error('Forbidden'), {
      extensions: { code: 'FORBIDDEN', status: 403 }
    })
  if (err instanceof CollectionNotFoundError)
    throw Object.assign(new Error(err.message), {
      extensions: { code: 'NOT_FOUND', status: 404 }
    })
  const e = err as {
    message?: string
    statusCode?: number
    code?: unknown
    violations?: unknown
    conflicts?: unknown
    latest_revision?: unknown
    nested?: unknown
    fields?: unknown
    first?: unknown
  }
  const refusal = typeof e?.statusCode === 'number' ? null : describeDbRefusal(err)
  if (refusal)
    throw Object.assign(new Error(refusal.message), {
      extensions: { code: refusal.code, status: refusal.status }
    })
  const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
  if (status >= 400 && status < 500) {
    const own = typeof e.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code) ? e.code : null
    throw Object.assign(new Error(e.message ?? 'Request refused'), {
      extensions: {
        code: own ?? STATUS_CODES_GQL[status] ?? 'BAD_REQUEST',
        status,
        ...(e.violations !== undefined ? { violations: e.violations } : {}),
        ...(e.conflicts !== undefined ? { conflicts: e.conflicts } : {}),
        ...(e.latest_revision !== undefined ? { latest_revision: e.latest_revision } : {}),
        ...(e.nested !== undefined ? { nested: e.nested } : {}),
        ...(e.fields !== undefined ? { fields: e.fields } : {}),
        ...(e.first !== undefined ? { first: e.first } : {})
      }
    })
  }
  // A driver error's message leads with the statement it ran.
  const message = reasonWithoutSql(String(e?.message ?? 'Internal error'))
  throw Object.assign(new Error(message), {
    extensions: { code: 'INTERNAL_SERVER_ERROR', status: 500 },
    originalError: err
  })
}

// WorkflowMutationError carries an HTTP-ish status from the shared workflow
// mutation service — map it onto GraphQL error extensions so callers can
// branch the same way REST callers branch on status codes.
const WORKFLOW_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE'
}

function wrapWorkflowError(err: unknown): never {
  if (err instanceof WorkflowMutationError) {
    throw Object.assign(new Error(err.message), {
      extensions: {
        code: WORKFLOW_ERROR_CODES[err.statusCode] ?? 'BAD_REQUEST',
        status: err.statusCode,
        ...(err.extras ?? {})
      }
    })
  }
  throw err
}

// ─── Schema builder ───────────────────────────────────────────────────────────

interface GQLContext {
  user?: User
  isAdmin?: boolean
  /** The HTTP request behind a query or mutation; absent on subscriptions.
   *  Writes hand it to the items service so hooks, activity rows and the
   *  admin check see the same request a REST write gives them. */
  req?: import('fastify').FastifyRequest
  /** Creates the natural key routed to an update, reported in `extensions`. */
  upserts?: Array<{ collection: string; matched_id: string | number; keys: string[] }>
}

/** Directus-style arguments on a nested to-many field
 *  (`forecasts(limit: 1, sort: ["-year.id", "-id"], filter: {...})`). */
const NESTED_LIST_ARGS = {
  sort: {
    type: new GraphQLList(GraphQLString),
    description: 'Sort fields. Prefix - for desc; dotted paths follow an M2O.'
  },
  limit: { type: GraphQLInt, description: '-1 = all' },
  offset: { type: GraphQLInt }
}

/** Apply nested-list args to a raw knex query over `collection`. A dotted
 *  sort whose leaf is `id` orders by the FK column itself (`year.id` = the
 *  year column); any other dotted sort left-joins the target once. */
async function applyNestedListArgs(
  q: Knex.QueryBuilder,
  collection: string,
  args: { filter?: Record<string, unknown>; sort?: string[]; limit?: number; offset?: number },
  m2oOf: (field: string) => string | undefined
): Promise<void> {
  if (args.filter && Object.keys(args.filter).length)
    await applyFilterToQuery(
      q,
      translateVirtualKeys(args.filter) as Record<string, unknown>,
      collection
    )
  const joined = new Set<string>()
  for (const raw of args.sort ?? []) {
    const desc = raw.startsWith('-')
    const path = desc ? raw.slice(1) : raw
    const dir = desc ? 'desc' : 'asc'
    const segs = path.split('.')
    if (segs.length === 1) {
      q.orderBy(`${collection}.${segs[0]}`, dir)
      continue
    }
    const [fk, leaf] = segs
    const target = m2oOf(fk)
    if (!target || segs.length > 2) continue
    if (leaf === 'id') {
      q.orderBy(`${collection}.${fk}`, dir)
      continue
    }
    const alias = `_s_${fk}`
    if (!joined.has(alias)) {
      q.leftJoin(`${target} as ${alias}`, `${alias}.id`, `${collection}.${fk}`)
      joined.add(alias)
    }
    q.orderBy(`${alias}.${leaf}`, dir)
  }
  if (args.limit != null && args.limit >= 0) q.limit(args.limit)
  if (args.offset != null && args.offset > 0) {
    if (!(args.sort ?? []).length) q.orderBy(`${collection}.id`, 'asc')
    q.offset(args.offset)
  }
}

export async function buildGraphQLSchema(): Promise<GraphQLSchema> {
  const collections = await listCollections()
  // `hidden` on a collection is a UI flag (keep it out of the nav), not an API
  // exclusion — REST /items serves hidden collections, and Directus exposed
  // them in GraphQL too. Junction tables are routinely hidden, and legacy
  // integrations mutate them directly (delete_workflows_files_items), so
  // filtering them out silently removed mutations third parties depend on.
  const visible = collections

  // Pre-load all fields per collection
  const allFields = new Map<string, Awaited<ReturnType<typeof getFields>>>()
  // Every registered field, hidden ones included: a junction's own columns are
  // routinely hidden, and `_link` filters exactly those.
  const rawFields = new Map<string, Awaited<ReturnType<typeof getFields>>>()
  for (const col of visible) {
    const fields = await getFields(col.collection)
    rawFields.set(col.collection, fields)
    // `hidden` is a UI flag — it means "do not put this on the form", not "do
    // not expose it". The primary key is routinely flagged hidden (the legacy
    // import did it to every table), which made `{ id }` — the one selection
    // every GraphQL client makes — unqueryable, and left mutations unable to
    // return the id of the row they just created. REST never filtered on
    // hidden, so this also brings the two APIs into agreement.
    allFields.set(
      col.collection,
      fields.filter((f) => !f.hidden || f.field === 'id')
    )
  }

  // ── Relation maps ──────────────────────────────────────────────────────────
  const allRelations = await getRelations()

  // M2O:  "collection.field" → target one_collection
  const m2oMap = new Map<string, string>()

  // O2M:  "one_collection.one_field" → { manyCollection, manyField }
  const o2mMap = new Map<string, { manyCollection: string; manyField: string }>()

  // M2M:  "one_collection.one_field" → { junction, fkToParent, fkToOther, otherCollection }
  const m2mMap = new Map<
    string,
    { junction: string; fkToParent: string; fkToOther: string; otherCollection: string }
  >()

  // M2A (#821): "one_collection.one_field" → a junction whose item column may
  // point at any of several collections, named per row by a discriminator.
  interface M2AInfo {
    junction: string
    fkToParent: string
    itemField: string
    discriminator: string
    allowed: string[]
  }
  const m2aMap = new Map<string, M2AInfo>()

  for (const rel of allRelations) {
    if (!rel.one_collection) continue

    if (!rel.junction_field) {
      // Simple FK on many_collection → M2O from many side, O2M from one side
      m2oMap.set(`${rel.many_collection}.${rel.many_field}`, rel.one_collection)
      if (rel.one_field) {
        o2mMap.set(`${rel.one_collection}.${rel.one_field}`, {
          manyCollection: rel.many_collection,
          manyField: rel.many_field
        })
      }
    } else {
      // junction_field present → M2M
      if (rel.one_field) {
        const otherRel = allRelations.find(
          (r) => r.many_collection === rel.many_collection && r.many_field === rel.junction_field
        )
        if (otherRel?.one_collection) {
          m2mMap.set(`${rel.one_collection}.${rel.one_field}`, {
            junction: rel.many_collection,
            fkToParent: rel.many_field,
            fkToOther: rel.junction_field,
            otherCollection: otherRel.one_collection
          })
        } else if (otherRel) {
          const allowedRaw = (otherRel as { one_allowed_collections?: unknown })
            .one_allowed_collections
          const allowed = Array.isArray(allowedRaw)
            ? allowedRaw.map(String)
            : typeof allowedRaw === 'string'
              ? allowedRaw
                  .replace(/^\[|\]$/g, '')
                  .split(',')
                  .map((c) => c.trim().replace(/^"|"$/g, ''))
                  .filter(Boolean)
              : []
          if (allowed.length > 0) {
            m2aMap.set(`${rel.one_collection}.${rel.one_field}`, {
              junction: rel.many_collection,
              fkToParent: rel.many_field,
              itemField: rel.junction_field,
              discriminator:
                (otherRel as { one_collection_field?: string | null }).one_collection_field ||
                'collection',
              allowed
            })
          }
        }
      }
    }
  }

  // ── Type registry (build ALL types first so thunks can cross-reference) ────
  const typeRegistry = new Map<string, GraphQLObjectType>()

  // nivaro_files is a system table (never in nivaro_collections), but business
  // M2M aliases point at it (a record's attached files). Give it a fixed,
  // safe read type so `files { id filename_download }` resolves.
  if ([...m2mMap.values()].some((m) => m.otherCollection === 'nivaro_files')) {
    typeRegistry.set(
      'nivaro_files',
      new GraphQLObjectType({
        name: 'nivaro_files',
        fields: {
          id: { type: GraphQLID },
          title: { type: GraphQLString },
          filename_download: { type: GraphQLString },
          filename_disk: { type: GraphQLString },
          type: { type: GraphQLString },
          filesize: { type: GraphQLInt },
          width: { type: GraphQLInt },
          height: { type: GraphQLInt },
          description: { type: GraphQLString },
          uploaded_on: { type: GraphQLString },
          modified_on: { type: GraphQLString }
        }
      })
    )
  }
  // One object type per M2M alias, shaped like the Directus junction row the
  // legacy API returned: `id` = the JUNCTION row id (integrations delete
  // junction rows by it), the junction's FK to the target as an object
  // (`purchase_orders { purchase_order { number } }`), and every target field
  // flattened on top (`purchase_orders { number }`) for the nivaro-native shape.
  const m2mRowTypes = new Map<string, GraphQLObjectType>()
  const m2mRowType = (
    parentCol: string,
    field: string,
    info: { junction: string; fkToParent: string; fkToOther: string; otherCollection: string },
    otherType: GraphQLObjectType
  ): GraphQLObjectType => {
    const name = `${parentCol}_${field}_m2m`
    const have = m2mRowTypes.get(name)
    if (have) return have
    const t = new GraphQLObjectType({
      name,
      description: `${info.junction} rows linking ${parentCol} to ${info.otherCollection}`,
      fields: () => {
        const out: Record<string, GraphQLFieldConfig<unknown, GQLContext>> = {}
        for (const [k, fld] of Object.entries(otherType.getFields())) {
          if (k === 'id' || k === info.fkToOther) continue
          out[k] = {
            type: fld.type,
            description: fld.description ?? undefined,
            args: Object.fromEntries(
              fld.args.map((a) => [
                a.name,
                { type: a.type, description: a.description ?? undefined }
              ])
            ),
            resolve: fld.resolve
              ? (src, args, ctx, inf) =>
                  (fld.resolve as NonNullable<typeof fld.resolve>)(
                    (src as { __target: unknown }).__target,
                    args,
                    ctx,
                    inf
                  )
              : (src) => ((src as { __target: Record<string, unknown> }).__target ?? {})[k]
          }
        }
        out.id = {
          type: GraphQLID,
          description: 'Junction row id',
          resolve: (src) => (src as { __junction_id: unknown }).__junction_id
        }
        out[info.fkToOther] = {
          type: otherType,
          description: `The ${info.otherCollection} row`,
          resolve: (src) => (src as { __target: unknown }).__target
        }
        return out
      }
    })
    m2mRowTypes.set(name, t)
    return t
  }

  // One object type per M2A alias (#821): the junction row id, the stored
  // discriminator, and `item` as a union of the allowed collections' types
  // (`directus_users` reads as the User type). An allowed collection nobody
  // registered contributes nothing; a link into one resolves `item: null`.
  const m2aRowTypes = new Map<string, GraphQLObjectType>()
  const userTypeFor = (c: string) => c === 'directus_users' || c === 'nivaro_users'
  const m2aMemberTypes = (info: M2AInfo): Map<string, GraphQLObjectType> => {
    const out = new Map<string, GraphQLObjectType>()
    for (const c of info.allowed) {
      const t = userTypeFor(c) ? UserType : typeRegistry.get(c)
      if (t) out.set(c, t)
    }
    return out
  }
  const m2aRowType = (parentCol: string, field: string, info: M2AInfo): GraphQLObjectType => {
    const name = `${parentCol}_${field}_m2a`
    const have = m2aRowTypes.get(name)
    if (have) return have
    const members = m2aMemberTypes(info)
    const memberTypes = [...new Set(members.values())]
    const itemType: GraphQLOutputType =
      memberTypes.length === 0
        ? GraphQLJSON
        : new GraphQLUnionType({
            name: `${name}_item`,
            description: `One of ${[...members.keys()].join(', ')}`,
            types: memberTypes,
            resolveType: (v) => (v as { __typename?: string }).__typename ?? memberTypes[0].name
          })
    const t = new GraphQLObjectType({
      name,
      description: `${info.junction} rows linking ${parentCol} to ${info.allowed.join(' | ')}`,
      fields: {
        id: {
          type: GraphQLID,
          description: 'Junction row id',
          resolve: (src) => (src as { __junction_id: unknown }).__junction_id
        },
        [info.discriminator]: {
          type: GraphQLString,
          description: 'Which collection the linked record belongs to, as stored'
        },
        item: {
          type: itemType,
          description: 'The linked record; null when its collection is unknown or unreadable'
        },
        item_id: {
          type: GraphQLID,
          description: 'The linked record id, as stored on the junction row'
        }
      }
    })
    m2aRowTypes.set(name, t)
    return t
  }

  // Tasks on a record (#1013): every collection type carries `tasks`, the
  // open (or all) tasks on that record. The parent row was read as the viewer,
  // so the record gate already held; support tickets stay private to their
  // own people.
  const RecordTaskType = new GraphQLObjectType({
    name: 'RecordTask',
    fields: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
      title: { type: GraphQLString },
      description: { type: GraphQLString },
      status: { type: GraphQLString },
      priority: { type: GraphQLString },
      due_date: { type: GraphQLString },
      assignee: { type: GraphQLID },
      assignee_name: { type: GraphQLString },
      team_id: { type: GraphQLInt },
      created_by: { type: GraphQLID },
      created_by_name: { type: GraphQLString },
      completed_at: { type: GraphQLString },
      created_at: { type: GraphQLString }
    }
  })
  const tasksField = (colName: string): GraphQLFieldConfig<unknown, GQLContext> => ({
    type: new GraphQLList(new GraphQLNonNull(RecordTaskType)),
    description: 'Tasks on this record (open ones unless status says otherwise).',
    args: {
      status: {
        type: GraphQLString,
        description: "'active' (default: open + in progress), 'done', 'cancelled' or 'all'"
      }
    },
    resolve: async (parent, args: { status?: string }, ctx) => {
      const id = (parent as { id?: unknown } | null)?.id
      if (!ctx.user || id == null) return []
      const q = db('nivaro_tasks as t')
        .leftJoin('nivaro_users as a', 'a.id', 't.assignee')
        .leftJoin('nivaro_users as c', 'c.id', 't.created_by')
        .where('t.collection', colName)
        .where('t.item', String(id))
        .orderBy('t.created_at', 'desc')
        .limit(200)
        .select(
          't.*',
          'a.first_name as af',
          'a.last_name as al',
          'c.first_name as cf',
          'c.last_name as cl'
        )
      const status = args.status ?? 'active'
      if (status === 'active') q.whereIn('t.status', ['open', 'in_progress'])
      else if (status !== 'all') q.where('t.status', status)
      if (!ctx.isAdmin) {
        const me = ctx.user.id
        q.where((w) =>
          w
            .whereNull('t.kind')
            .orWhereNot('t.kind', 'support')
            .orWhere('t.created_by', me)
            .orWhere('t.assignee', me)
        )
      }
      const rows = (await q) as Array<Record<string, unknown>>
      const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)
      const nm = (f: unknown, l: unknown) => [f, l].filter(Boolean).join(' ') || null
      return rows.map((r) => ({
        ...r,
        due_date: r.due_date ? new Date(r.due_date as string).toISOString().slice(0, 10) : null,
        completed_at: iso(r.completed_at),
        created_at: iso(r.created_at),
        assignee_name: nm(r.af, r.al),
        created_by_name: nm(r.cf, r.cl)
      }))
    }
  })

  for (const col of visible) {
    const colName = col.collection
    const fields = allFields.get(colName) ?? []

    typeRegistry.set(
      colName,
      new GraphQLObjectType({
        name: colName,
        description: col.display_name ?? colName,
        fields: () => {
          const gqlFields: Record<string, GraphQLFieldConfig<unknown, GQLContext>> = {}

          for (const f of fields) {
            const fkey = `${colName}.${f.field}`

            // ── M2O: FK field → resolve to related item ──────────────────────
            const m2oTarget = m2oMap.get(fkey)
            if (m2oTarget) {
              const relType = typeRegistry.get(m2oTarget)
              if (relType) {
                const target = m2oTarget
                const col = f.field
                gqlFields[f.field] = {
                  type: relType,
                  description: f.note ?? undefined,
                  // The legacy API accepted list arguments on every relation,
                  // to-one included (`core_category(limit: -1) { id }`), and
                  // integrations send them. A to-one has nothing to page, so
                  // they are accepted and ignored rather than rejected.
                  args: NESTED_LIST_ARGS,
                  resolve: timedResolver(
                    'm2o',
                    async (source: unknown, _args: Record<string, unknown>, ctx: GQLContext) => {
                      const parent = source as Record<string, unknown>
                      const fkVal = parent[col]
                      if (fkVal == null) return null
                      const gate = await timedGate(ctx, target, () => nestedGate(ctx, target))
                      const q = db(target).where(`${target}.id`, fkVal as string | number)
                      if (!applyNestedGate(q, target, gate, ctx.user as User)) return null
                      const row = (await q.first(`${target}.*`)) as
                        | Record<string, unknown>
                        | undefined
                      return row ? narrowNestedRow(row, gate) : null
                    }
                  )
                }
                continue
              }
              // Target not registered → fall through to scalar (returns FK string)
            }

            // ── M2A: junction rows naming their target's collection ──────────
            const m2aInfo = m2aMap.get(fkey)
            if (m2aInfo) {
              const info = { ...m2aInfo }
              const members = m2aMemberTypes(info)
              gqlFields[f.field] = {
                type: new GraphQLList(new GraphQLNonNull(m2aRowType(colName, f.field, info))),
                description: f.note ?? undefined,
                args: {
                  collection: {
                    type: new GraphQLList(GraphQLString),
                    description:
                      'Only links into these collections (as stored on the junction row).'
                  },
                  limit: { type: GraphQLInt },
                  offset: { type: GraphQLInt }
                },
                resolve: timedResolver(
                  'm2a',
                  async (
                    source: unknown,
                    args: { collection?: string[]; limit?: number; offset?: number },
                    ctx: GQLContext
                  ) => {
                    const parentId = (source as Record<string, unknown>)['id']
                    if (parentId == null) return []
                    const q = db(info.junction)
                      .where(info.fkToParent, parentId as string | number)
                      .orderBy('id', 'asc')
                      .select('id', info.itemField, info.discriminator)
                    if (Array.isArray(args.collection) && args.collection.length > 0)
                      q.whereIn(info.discriminator, args.collection.map(String))
                    if (typeof args.limit === 'number' && args.limit > 0) q.limit(args.limit)
                    if (typeof args.offset === 'number' && args.offset > 0) q.offset(args.offset)
                    const links = (await q) as Array<Record<string, unknown>>
                    // One read per collection the links name, each gated as the caller.
                    const byCollection = new Map<string, Set<string>>()
                    for (const l of links) {
                      const c = String(l[info.discriminator] ?? '')
                      const id = l[info.itemField]
                      if (!c || id == null) continue
                      byCollection.set(c, (byCollection.get(c) ?? new Set()).add(String(id)))
                    }
                    const found = new Map<string, Map<string, Record<string, unknown>>>()
                    for (const [c, ids] of byCollection) {
                      const type = members.get(c)
                      if (!type) continue
                      const rows = new Map<string, Record<string, unknown>>()
                      if (userTypeFor(c)) {
                        // People hang off a record the caller already read; the
                        // User type carries only what a directory shows.
                        const users = (await db('nivaro_users')
                          .whereIn('id', [...ids])
                          .where({ is_redacted: false })
                          .select(
                            'id',
                            'email',
                            'first_name',
                            'last_name',
                            'status',
                            'last_access',
                            'created_at',
                            'updated_at'
                          )
                          .catch(() => [])) as Array<Record<string, unknown>>
                        for (const u of users) {
                          rows.set(String(u.id).toUpperCase(), {
                            id: u.id,
                            email: u.email,
                            firstName: u.first_name,
                            lastName: u.last_name,
                            status: u.status,
                            lastAccess: u.last_access,
                            createdAt: u.created_at,
                            updatedAt: u.updated_at,
                            __typename: type.name
                          })
                        }
                      } else {
                        const gate = await timedGate(ctx, c, () => nestedGate(ctx, c))
                        const rq = db(c).whereIn(`${c}.id`, [...ids])
                        if (!applyNestedGate(rq, c, gate, ctx.user as User)) continue
                        const rs = (await rq.select(`${c}.*`).catch(() => [])) as Array<
                          Record<string, unknown>
                        >
                        for (const r of rs) {
                          rows.set(String(r.id).toUpperCase(), {
                            ...narrowNestedRow(r, gate),
                            __typename: type.name
                          })
                        }
                      }
                      found.set(c, rows)
                    }
                    return links.map((l) => {
                      const c = String(l[info.discriminator] ?? '')
                      const id = l[info.itemField]
                      return {
                        __junction_id: l.id,
                        [info.discriminator]: c || null,
                        item_id: id ?? null,
                        item:
                          id == null ? null : (found.get(c)?.get(String(id).toUpperCase()) ?? null)
                      }
                    })
                  }
                )
              }
              continue
            }

            // ── M2M: virtual field → join through junction ────────────────────
            const m2mInfo = m2mMap.get(fkey)
            if (m2mInfo) {
              const otherType = typeRegistry.get(m2mInfo.otherCollection)
              if (otherType) {
                const info = { ...m2mInfo }
                const otherCol = info.otherCollection
                gqlFields[f.field] = {
                  type: new GraphQLList(
                    new GraphQLNonNull(m2mRowType(colName, f.field, info, otherType))
                  ),
                  description: f.note ?? undefined,
                  args: {
                    ...NESTED_LIST_ARGS,
                    filter: {
                      type: (filterRegistry.get(otherCol) ?? GraphQLJSON) as GraphQLInputType
                    }
                  },
                  resolve: timedResolver(
                    'm2m',
                    async (source: unknown, args: Record<string, unknown>, ctx: GQLContext) => {
                      const parentId = (source as Record<string, unknown>)['id']
                      if (parentId == null) return []
                      const gate = await timedGate(ctx, otherCol, () => nestedGate(ctx, otherCol))
                      const q = db(`${info.junction} as _j`)
                        .join(otherCol, `${otherCol}.id`, `_j.${info.fkToOther}`)
                        .where(`_j.${info.fkToParent}`, parentId as string | number)
                        .select(`${otherCol}.*`, '_j.id as __junction_id')
                      if (!applyNestedGate(q, otherCol, gate, ctx.user as User)) return []
                      await applyNestedListArgs(q, otherCol, args as never, (fk) =>
                        m2oMap.get(`${otherCol}.${fk}`)
                      )
                      const rows = (await q) as Array<Record<string, unknown>>
                      return rows.map(({ __junction_id, ...target }) => ({
                        __junction_id,
                        __target: narrowNestedRow(target, gate)
                      }))
                    }
                  )
                }
                continue
              }
            }

            // ── O2M: virtual field → fetch many side ──────────────────────────
            const o2mInfo = o2mMap.get(fkey)
            if (o2mInfo) {
              const manyType = typeRegistry.get(o2mInfo.manyCollection)
              if (manyType) {
                const info = { ...o2mInfo }
                const manyCol = info.manyCollection
                gqlFields[f.field] = {
                  type: new GraphQLList(new GraphQLNonNull(manyType)),
                  description: f.note ?? undefined,
                  args: {
                    ...NESTED_LIST_ARGS,
                    filter: {
                      type: (filterRegistry.get(manyCol) ?? GraphQLJSON) as GraphQLInputType
                    }
                  },
                  resolve: timedResolver(
                    'o2m',
                    async (source: unknown, args: Record<string, unknown>, ctx: GQLContext) => {
                      const parentId = (source as Record<string, unknown>)['id']
                      if (parentId == null) return []
                      const gate = await timedGate(ctx, manyCol, () => nestedGate(ctx, manyCol))
                      const q = db(manyCol)
                        .where(`${manyCol}.${info.manyField}`, parentId as string | number)
                        .select(`${manyCol}.*`)
                      if (!applyNestedGate(q, manyCol, gate, ctx.user as User)) return []
                      await applyNestedListArgs(q, manyCol, args as never, (fk) =>
                        m2oMap.get(`${manyCol}.${fk}`)
                      )
                      const rows = (await q) as Array<Record<string, unknown>>
                      return gate.fields ? rows.map((r) => narrowNestedRow(r, gate)) : rows
                    }
                  )
                }
                continue
              }
            }

            // ── Scalar fallback ───────────────────────────────────────────────
            gqlFields[f.field] = {
              type: fieldType(f.field, f.type),
              description: f.note ?? undefined
            }
          }

          // Deprecation policy (#613): a retiring field says so in the
          // schema from the day it was marked, whatever kind of field it is.
          for (const f of fields) {
            if (!f.deprecated_at || !gqlFields[f.field]) continue
            const since = new Date(f.deprecated_at)
            const day = Number.isNaN(since.getTime())
              ? ''
              : ` since ${since.toISOString().slice(0, 10)}`
            gqlFields[f.field].deprecationReason =
              (f.deprecation_note?.trim() || 'Being removed from the API') + day
          }

          if (!gqlFields.tasks && !colName.startsWith('nivaro_'))
            gqlFields.tasks = tasksField(colName)

          return gqlFields
        }
      })
    )
  }

  // ── Per-collection filter input types (thunks allow self-ref _and/_or) ───
  const filterRegistry = new Map<string, GraphQLInputObjectType>()

  // Wrapper input types for O2M and M2M relations: `_some` / `_none`, PLUS the
  // related collection's own filter fields — the Directus shape
  // (`purchase_orders: {number: {_in: [...]}}`), which items.ts reads as an
  // implicit `_some`. Built alongside filterRegistry so thunks can reference them.
  const relationWrapperTypes: GraphQLInputObjectType[] = []
  const innerFieldsOf = (
    inner: GraphQLInputObjectType
  ): Record<string, { type: GraphQLInputType }> =>
    Object.fromEntries(Object.entries(inner.getFields()).map(([k, v]) => [k, { type: v.type }]))

  // `_link`: the junction row's own columns. One input type per junction,
  // built from its scalar fields; a junction nobody registered takes JSON.
  const linkTypes = new Map<string, GraphQLInputType>()
  const linkFilterFor = (junction: string): GraphQLInputType => {
    const hit = linkTypes.get(junction)
    if (hit) return hit
    const scalars = (rawFields.get(junction) ?? []).filter(
      (f) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(f.field) &&
        !m2mMap.has(`${junction}.${f.field}`) &&
        !o2mMap.has(`${junction}.${f.field}`)
    )
    if (scalars.length === 0) {
      linkTypes.set(junction, GraphQLJSON)
      return GraphQLJSON
    }
    const t: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: `${junction}_link_filter`,
      description: `Columns of a ${junction} row.`,
      fields: (): Record<string, { type: GraphQLInputType }> => ({
        ...Object.fromEntries(
          scalars.map((f) => [f.field, { type: filterOpsForField(f.field, f.type) }])
        ),
        _and: { type: new GraphQLList(new GraphQLNonNull(t)) },
        _or: { type: new GraphQLList(new GraphQLNonNull(t)) }
      })
    })
    relationWrapperTypes.push(t)
    linkTypes.set(junction, t)
    return t
  }

  for (const col of visible) {
    const colName = col.collection
    const fields = allFields.get(colName) ?? []

    filterRegistry.set(
      colName,
      new GraphQLInputObjectType({
        name: `${colName}_filter`,
        fields: (): Record<string, { type: GraphQLInputType }> => {
          const f: Record<string, { type: GraphQLInputType }> = {}

          for (const field of fields) {
            const fkey = `${colName}.${field.field}`

            // ── M2M virtual field ────────────────────────────────────────────
            const m2mInfo = m2mMap.get(fkey)
            if (m2mInfo) {
              const m2mOtherCollection = m2mInfo.otherCollection
              // Only create wrapper when other collection is visible (will be in filterRegistry)
              if (visible.some((c) => c.collection === m2mOtherCollection)) {
                const wrapperType = new GraphQLInputObjectType({
                  name: `${colName}_${field.field}_m2m_filter`,
                  fields: (): Record<string, { type: GraphQLInputType }> => {
                    const inner = filterRegistry.get(m2mOtherCollection)
                    if (!inner) return { _exists: { type: GraphQLBoolean } }
                    const own = innerFieldsOf(inner)
                    // Legacy junction shape: `{<junction fk>: {…target filter…}}`.
                    // Offered only when the related collection has no field of
                    // that name, which would otherwise change meaning.
                    const leg = m2mInfo.fkToOther
                    // `_link` filters the JUNCTION row of the same link the
                    // other keys filter the related record of.
                    const link = linkFilterFor(m2mInfo.junction)
                    const some = new GraphQLInputObjectType({
                      name: `${colName}_${field.field}_m2m_some`,
                      fields: () => ({ ...own, _link: { type: link } })
                    })
                    relationWrapperTypes.push(some)
                    return {
                      _some: { type: some },
                      _none: { type: some },
                      ...own,
                      _link: { type: link },
                      ...(leg && !(leg in own) ? { [leg]: { type: inner } } : {})
                    }
                  }
                })
                relationWrapperTypes.push(wrapperType)
                f[field.field] = { type: wrapperType }
              }
              continue
            }

            // ── O2M virtual field ────────────────────────────────────────────
            const o2mInfo = o2mMap.get(fkey)
            if (o2mInfo) {
              const o2mManyCollection = o2mInfo.manyCollection
              // Only create wrapper when many collection is visible
              if (visible.some((c) => c.collection === o2mManyCollection)) {
                const wrapperType = new GraphQLInputObjectType({
                  name: `${colName}_${field.field}_relation_filter`,
                  fields: (): Record<string, { type: GraphQLInputType }> => {
                    const inner = filterRegistry.get(o2mManyCollection)
                    if (!inner) return { _exists: { type: GraphQLBoolean } }
                    return {
                      _some: { type: inner },
                      _none: { type: inner },
                      ...innerFieldsOf(inner)
                    }
                  }
                })
                relationWrapperTypes.push(wrapperType)
                f[field.field] = { type: wrapperType }
              }
              continue
            }

            // ── M2O FK field ─────────────────────────────────────────────────
            const m2oTarget = m2oMap.get(fkey)
            if (m2oTarget) {
              // One key, both shapes: operators compare the FK value
              // (`author: {_eq: "uuid"}`) and the related record's own fields
              // filter through the relation (`author: {first_name: {_eq: …}}`
              // — the legacy API's shape, which items.ts already compiles).
              const opsType = filterOpsForField(field.field, field.type)
              const relFilter = filterRegistry.get(m2oTarget)
              if (relFilter) {
                const m2oWrapper = new GraphQLInputObjectType({
                  name: `${colName}_${field.field}_m2o_filter`,
                  fields: (): Record<string, { type: GraphQLInputType }> => ({
                    ...innerFieldsOf(relFilter),
                    ...innerFieldsOf(opsType)
                  })
                })
                relationWrapperTypes.push(m2oWrapper)
                f[field.field] = { type: m2oWrapper }
              } else {
                f[field.field] = { type: opsType }
              }
              // Alias kept for callers written against it.
              if (relFilter) {
                const alias = field.field.endsWith('_id')
                  ? field.field.slice(0, -3)
                  : `${field.field}_rel`
                f[alias] = { type: relFilter }
              }
              continue
            }

            // ── Scalar field ─────────────────────────────────────────────────
            f[field.field] = { type: filterOpsForField(field.field, field.type) }
          }

          // Filters that are not columns — never over a real field's name.
          for (const [k, def] of Object.entries(VIRTUAL_FILTER_FIELDS)) if (!(k in f)) f[k] = def

          // Logical combinators
          const selfType = filterRegistry.get(colName)
          if (selfType) {
            f['_and'] = { type: new GraphQLList(new GraphQLNonNull(selfType)) }
            f['_or'] = { type: new GraphQLList(new GraphQLNonNull(selfType)) }
          }

          return f
        }
      })
    )
  }

  // ── Queries and mutations ──────────────────────────────────────────────────
  const queryFields: Record<string, GraphQLFieldConfig<unknown, GQLContext>> = {}
  const mutationFields: Record<string, GraphQLFieldConfig<unknown, GQLContext>> = {}

  for (const col of visible) {
    const name = col.collection
    const itemType = typeRegistry.get(name)
    if (!itemType) continue

    const fields = allFields.get(name) ?? []
    if (fields.length === 0) continue

    // The list query returns the ITEMS directly (the shape every GraphQL client
    // written against a Directus-style API already expects — no `data`
    // wrapper), and `<name>_metadata` answers the same filter/search with the
    // page facts the wrapper used to carry. A GraphQL field is either a list
    // or an object, so the two cannot share one field.
    const listArgs = {
      filter: {
        type: (filterRegistry.get(name) ?? GraphQLJSON) as GraphQLInputType,
        description: 'Filter by field values.'
      },
      sort: {
        type: new GraphQLList(GraphQLString),
        description: 'Sort fields. Prefix - for desc.'
      },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      search: { type: GraphQLString },
      after: {
        type: GraphQLString,
        description:
          'Keyset paging: "start" for the first page, then next_cursor of the page before (read it from <collection>_metadata with the same arguments). Replaces offset.'
      }
    }
    const listRead = (args: Record<string, unknown>, ctx: GQLContext, fields?: string[]) => {
      if (!ctx.user)
        throw Object.assign(new Error('Unauthorized'), {
          extensions: { code: 'UNAUTHENTICATED' }
        })
      return readItems(ctx.user, name, {
        filter: translateVirtualKeys(args.filter) as Record<string, unknown> | undefined,
        sort: args.sort as string[] | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
        search: args.search as string | undefined,
        ...(typeof args.after === 'string' ? { after: args.after } : {}),
        ...(fields ? { fields } : {})
      })
    }

    const metadataType = new GraphQLObjectType({
      name: `${name}_metadata`,
      fields: {
        total: { type: new GraphQLNonNull(GraphQLInt) },
        limit: { type: new GraphQLNonNull(GraphQLInt) },
        offset: { type: new GraphQLNonNull(GraphQLInt) },
        next_cursor: {
          type: GraphQLString,
          description: 'With `after`: the cursor of the next page, null on the last one.'
        }
      }
    })

    queryFields[name] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(itemType))),
      description: `List ${col.display_name ?? name} items.`,
      args: listArgs,
      resolve: async (_root, args: Record<string, unknown>, ctx: GQLContext) => {
        try {
          return (await listRead(args, ctx)).data
        } catch (e) {
          wrapError(e)
        }
      }
    }

    queryFields[`${name}_metadata`] = {
      type: new GraphQLNonNull(metadataType),
      description: `Page facts (total / limit / offset) for the same ${col.display_name ?? name} list arguments.`,
      args: listArgs,
      resolve: async (_root, args: Record<string, unknown>, ctx: GQLContext) => {
        try {
          const page = await listRead(args, ctx, ['id'])
          return {
            total: page.total ?? 0,
            limit: page.limit,
            offset: page.offset,
            next_cursor: (page as { next_cursor?: string | null }).next_cursor ?? null
          }
        } catch (e) {
          wrapError(e)
        }
      }
    }

    // ── Aggregates: `<name>_aggregated(filter, groupBy) { countAll sum { amount } }`
    // Which figures to compute is read off the selection, so a query pays for
    // what it asks.
    {
      const linked = (f: string) => o2mMap.has(`${name}.${f}`) || m2mMap.has(`${name}.${f}`)
      const stored = fields.filter((f) => !linked(f.field) && f.type !== 'alias')
      const numeric = stored.filter(
        (f) => f.field !== 'id' && ['integer', 'bigInteger', 'float', 'decimal'].includes(f.type)
      )
      const ordered = stored.filter((f) =>
        [
          'integer',
          'bigInteger',
          'float',
          'decimal',
          'datetime',
          'date',
          'time',
          'string'
        ].includes(f.type)
      )
      const bag = (
        suffix: string,
        list: typeof stored,
        type: (f: (typeof stored)[number]) => GraphQLOutputType
      ) =>
        list.length === 0
          ? null
          : new GraphQLObjectType({
              name: `${name}_aggregated_${suffix}`,
              fields: Object.fromEntries(list.map((f) => [f.field, { type: type(f) }]))
            })
      const countBag = bag('count', stored, () => GraphQLInt)
      const numberBag = bag('number', numeric, () => GraphQLFloat)
      const fieldBag = bag('fields', ordered, (f) =>
        f.field === 'id' ? GraphQLString : fieldType(f.field, f.type)
      )
      const aggregatedType = new GraphQLObjectType({
        name: `${name}_aggregated`,
        fields: {
          group: { type: GraphQLJSON, description: 'The group-by values of this row.' },
          countAll: { type: GraphQLInt, description: 'Rows in the group.' },
          ...(countBag
            ? {
                count: { type: countBag, description: 'Rows that hold a value, per field.' },
                countDistinct: { type: countBag, description: 'Different values, per field.' }
              }
            : {}),
          ...(numberBag ? { sum: { type: numberBag }, avg: { type: numberBag } } : {}),
          ...(fieldBag ? { min: { type: fieldBag }, max: { type: fieldBag } } : {})
        }
      })
      queryFields[`${name}_aggregated`] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(aggregatedType))),
        description: `Counts, sums and averages over ${col.display_name ?? name}, optionally grouped. The rows counted are the rows the same filter would list for the caller.`,
        args: {
          filter: { type: (filterRegistry.get(name) ?? GraphQLJSON) as GraphQLInputType },
          search: { type: GraphQLString },
          groupBy: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
          sort: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
            description: 'Group fields, countAll, or "<function>.<field>". Prefix - for desc.'
          },
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt }
        },
        resolve: async (_root, args: Record<string, unknown>, ctx: GQLContext, info) => {
          if (!ctx.user)
            throw Object.assign(new Error('Unauthorized'), {
              extensions: { code: 'UNAUTHENTICATED' }
            })
          const spec: AggregateSpec = {
            groupBy: (args.groupBy as string[] | undefined) ?? [],
            sort: args.sort as string[] | undefined,
            limit: args.limit as number | undefined,
            offset: args.offset as number | undefined
          }
          const visit = (
            selections: readonly SelectionNode[] | undefined,
            inside: string | null
          ) => {
            for (const sel of selections ?? []) {
              if (sel.kind === Kind.FIELD) {
                const n = sel.name.value
                if (inside === null) {
                  if (n === 'countAll') spec.countAll = true
                  else if ((AGGREGATE_FUNCTIONS as readonly string[]).includes(n))
                    visit(sel.selectionSet?.selections, n)
                } else if (!n.startsWith('__')) {
                  const key = inside as AggregateFunction
                  spec[key] = [...(spec[key] ?? []), n]
                }
              } else if (sel.kind === Kind.INLINE_FRAGMENT) {
                visit(sel.selectionSet.selections, inside)
              } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
                visit(info.fragments[sel.name.value]?.selectionSet.selections, inside)
              }
            }
          }
          for (const node of info.fieldNodes) visit(node.selectionSet?.selections, null)
          try {
            const res = await aggregateItems(ctx.user, name, {
              filter: translateVirtualKeys(args.filter) as Record<string, unknown> | undefined,
              search: args.search as string | undefined,
              aggregate: spec
            })
            return res.data
          } catch (e) {
            wrapError(e)
          }
        }
      }
    }

    queryFields[`${name}_by_id`] = {
      type: itemType,
      description: `Get a single ${col.display_name ?? name} item by ID.`,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_root, { id }: { id: string }, ctx: GQLContext) => {
        if (!ctx.user)
          throw Object.assign(new Error('Unauthorized'), {
            extensions: { code: 'UNAUTHENTICATED' }
          })
        try {
          return await readOne(ctx.user, name, id)
        } catch (e) {
          wrapError(e)
        }
      }
    }

    mutationFields[`create_${name}`] = {
      type: itemType,
      args: { data: { type: new GraphQLNonNull(GraphQLJSON) } },
      resolve: async (_root, { data }: { data: Record<string, unknown> }, ctx: GQLContext) => {
        if (!ctx.user)
          throw Object.assign(new Error('Unauthorized'), {
            extensions: { code: 'UNAUTHENTICATED' }
          })
        try {
          const item = await createOne(ctx.user, name, data, ctx.req)
          const upsert = upsertInfoOf(item)
          if (upsert) ctx.upserts?.push({ collection: name, ...upsert })
          return item
        } catch (e) {
          wrapError(e)
        }
      }
    }

    // Directus named this `create_<collection>_item`; ours is `create_<collection>`.
    // Both point at the same resolver so an integration written against the old
    // schema keeps working — it costs one extra field in the schema and saves a
    // coordinated release with every third party that posts to us.
    mutationFields[`create_${name}_item`] = mutationFields[`create_${name}`]

    // A rehearsal of the create: everything a create runs, nothing stored.
    mutationFields[`create_${name}_dry_run`] = {
      type: GraphQLJSON,
      description: `What creating a ${col.singular ?? name} record with this data would do: the record as it would be stored, what the server would fill, and the refusal if there is one. Nothing is stored and no number is taken.`,
      args: { data: { type: new GraphQLNonNull(GraphQLJSON) } },
      resolve: async (_root, { data }: { data: Record<string, unknown> }, ctx: GQLContext) => {
        if (!ctx.user)
          throw Object.assign(new Error('Unauthorized'), {
            extensions: { code: 'UNAUTHENTICATED' }
          })
        try {
          return await rehearseCreate(ctx.user, name, data, ctx.req)
        } catch (e) {
          wrapError(e)
        }
      }
    }

    mutationFields[`update_${name}_item`] = {
      type: itemType,
      args: {
        id: { type: new GraphQLNonNull(GraphQLID) },
        data: { type: new GraphQLNonNull(GraphQLJSON) }
      },
      resolve: async (
        _root,
        { id, data }: { id: string; data: Record<string, unknown> },
        ctx: GQLContext
      ) => {
        if (!ctx.user)
          throw Object.assign(new Error('Unauthorized'), {
            extensions: { code: 'UNAUTHENTICATED' }
          })
        try {
          return await updateOne(ctx.user, name, id, data, ctx.req)
        } catch (e) {
          wrapError(e)
        }
      }
    }

    mutationFields[`delete_${name}_item`] = {
      type: DeleteResponseType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_root, { id }: { id: string }, ctx: GQLContext) => {
        if (!ctx.user)
          throw Object.assign(new Error('Unauthorized'), {
            extensions: { code: 'UNAUTHENTICATED' }
          })
        try {
          await deleteOne(ctx.user, name, id, ctx.req)
          return { id }
        } catch (e) {
          wrapError(e)
        }
      }
    }

    // Directus batch forms — `create_<name>_items(data: [...])` and
    // `delete_<name>_items(ids: [...])`. Legacy Directus-era integrations
    // send these verbatim; each row still goes through createOne/deleteOne
    // so hooks, rules, rollups and activity apply per record. Sequential on
    // purpose: line rows read earlier rows (line numbering, rollups).
    mutationFields[`create_${name}_items`] = {
      type: new GraphQLList(itemType),
      args: { data: { type: new GraphQLNonNull(GraphQLJSON) } },
      resolve: async (_root, { data }: { data: unknown }, ctx: GQLContext) => {
        if (!ctx.user)
          throw Object.assign(new Error('Unauthorized'), {
            extensions: { code: 'UNAUTHENTICATED' }
          })
        const rows = Array.isArray(data) ? data : [data]
        const user = ctx.user
        return runUnit(`batch-create:${name}`, async (unit) => {
          const results: unknown[] = []
          try {
            for (const row of rows) {
              const item = await createOne(user, name, row as Record<string, unknown>, ctx.req)
              const upsert = upsertInfoOf(item)
              if (upsert) ctx.upserts?.push({ collection: name, ...upsert })
              results.push(item)
            }
            return results
          } catch (e) {
            // All or nothing, as the legacy batch was: a caller that gets an
            // error retries the WHOLE batch, so rows that landed before the
            // failure would come back as duplicates. Undone through deleteOne so
            // rollups and activity follow; a row that cannot be undone is named.
            unit.discard()
            const stuck: unknown[] = []
            for (const made of [...results].reverse()) {
              const id = (made as { id?: unknown } | null)?.id
              if (id == null) continue
              // A row the natural key matched existed before this call — the
              // undo must never delete it.
              if (upsertInfoOf(made)) continue
              try {
                await deleteOne(user, name, String(id), ctx.req)
              } catch {
                stuck.push(id)
              }
            }
            if (stuck.length > 0 && e instanceof Error)
              e.message += ` — and ${stuck.length} row(s) created before the failure could not be removed: ${stuck.join(', ')}`
            wrapError(e)
          }
        })
      }
    }

    // Batch updates, under the legacy names:
    //   update_<c>_items(ids, data)      the same change to several records
    //   update_<c>_batch(data: [{id, …}]) a different change per record
    // Sequential updateOne as the caller. All or nothing: when one is
    // refused, the records already changed get their prior values back
    // (only the fields this call wrote), newest first.
    const runUpdates = async (
      ctx: GQLContext,
      changes: Array<{ id: string; data: Record<string, unknown> }>
    ): Promise<unknown[]> => {
      if (!ctx.user)
        throw Object.assign(new Error('Unauthorized'), {
          extensions: { code: 'UNAUTHENTICATED' }
        })
      if (changes.length > 500)
        throw Object.assign(new Error('At most 500 records per call'), {
          extensions: { code: 'BATCH_LIMIT', status: 422 }
        })
      const results: unknown[] = []
      const done: Array<{ id: string; prior: Record<string, unknown> }> = []
      const user = ctx.user
      try {
        for (const [index, change] of changes.entries()) {
          if (!change.id)
            throw Object.assign(new Error(`Row ${index + 1} has no id`), { statusCode: 400 })
          const before = (await readOne(user, name, change.id)) as Record<string, unknown> | null
          if (!before)
            throw Object.assign(new Error(`Row ${index + 1}: no record ${change.id}`), {
              statusCode: 404
            })
          const prior: Record<string, unknown> = {}
          for (const k of Object.keys(change.data))
            if (!k.startsWith('_') && k in before) prior[k] = before[k]
          results.push(await updateOne(user, name, change.id, { ...change.data }, ctx.req))
          done.push({ id: change.id, prior })
        }
        return results
      } catch (e) {
        const stuck: string[] = []
        for (const d of [...done].reverse()) {
          if (Object.keys(d.prior).length === 0) continue
          try {
            await updateOne(
              user,
              name,
              d.id,
              { ...d.prior, _change_reason: 'Batch update undone: a later record was refused' },
              ctx.req
            )
          } catch {
            stuck.push(d.id)
          }
        }
        if (e instanceof Error) {
          e.message += done.length
            ? stuck.length
              ? ` — ${done.length - stuck.length} earlier record(s) restored; could not restore: ${stuck.join(', ')}`
              : ` — nothing was changed (${done.length} earlier record(s) restored)`
            : ' — nothing was changed'
        }
        wrapError(e)
      }
    }

    mutationFields[`update_${name}_items`] = {
      type: new GraphQLList(new GraphQLNonNull(itemType)),
      description: 'The same change applied to several records. All or nothing.',
      args: {
        ids: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))) },
        data: { type: new GraphQLNonNull(GraphQLJSON) }
      },
      resolve: (
        _root,
        { ids, data }: { ids: string[]; data: Record<string, unknown> },
        ctx: GQLContext
      ) =>
        runUpdates(
          ctx,
          ids.map((id) => ({ id: String(id), data }))
        )
    }

    mutationFields[`update_${name}_batch`] = {
      type: new GraphQLList(new GraphQLNonNull(itemType)),
      description: 'A list of {id, …fields}: each record gets its own change. All or nothing.',
      args: { data: { type: new GraphQLNonNull(GraphQLJSON) } },
      resolve: (_root, { data }: { data: unknown }, ctx: GQLContext) => {
        const rows = Array.isArray(data) ? data : [data]
        return runUpdates(
          ctx,
          rows.map((r) => {
            const { id, ...rest } = (r ?? {}) as Record<string, unknown>
            return { id: id == null ? '' : String(id), data: rest }
          })
        )
      }
    }

    mutationFields[`delete_${name}_items`] = {
      type: DeleteManyResponseType,
      args: { ids: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))) } },
      resolve: async (_root, { ids }: { ids: string[] }, ctx: GQLContext) => {
        if (!ctx.user)
          throw Object.assign(new Error('Unauthorized'), {
            extensions: { code: 'UNAUTHENTICATED' }
          })
        try {
          for (const id of ids) await deleteOne(ctx.user, name, id, ctx.req)
          return { ids }
        } catch (e) {
          wrapError(e)
        }
      }
    }
  }

  // Merge domain fields (workflow, pipeline, users, activity, files, settings)
  Object.assign(queryFields, domainQueryFields)
  Object.assign(mutationFields, domainMutationFields)

  // ── Workflow mutations (#601) ──────────────────────────────────────────────
  // Same service layer as POST /pipelines/instance/:c/:i/start|transition —
  // every REST precondition (from-state validity, auto-transition refusal,
  // role gate, requirements, condition-rule revalidation) applies identically.
  mutationFields['workflow_start'] = {
    type: GraphQLJSON,
    description:
      'Start the bound workflow/pipeline instance for a record. Returns the instance as JSON.',
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLString) }
    },
    resolve: async (
      _root,
      { collection, item }: { collection: string; item: string },
      ctx: GQLContext
    ) => {
      if (!ctx.user)
        throw Object.assign(new Error('Unauthorized'), {
          extensions: { code: 'UNAUTHENTICATED' }
        })
      try {
        const instance = await startWorkflowInstance({
          collection,
          item,
          actor: { id: ctx.user.id, role: ctx.user.role, isAdmin: ctx.isAdmin ?? false }
        })
        return instance ?? null
      } catch (e) {
        wrapWorkflowError(e)
      }
    }
  }

  mutationFields['workflow_transition'] = {
    type: GraphQLJSON,
    description:
      'Execute a workflow transition on a record (same gates as the REST endpoint). Returns the updated instance as JSON.',
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLString) },
      transition_id: { type: new GraphQLNonNull(GraphQLString) },
      comment: { type: GraphQLString }
    },
    resolve: async (
      _root,
      args: { collection: string; item: string; transition_id: string; comment?: string },
      ctx: GQLContext
    ) => {
      if (!ctx.user)
        throw Object.assign(new Error('Unauthorized'), {
          extensions: { code: 'UNAUTHENTICATED' }
        })
      try {
        const result = await executeWorkflowTransition({
          collection: args.collection,
          item: args.item,
          transitionId: args.transition_id,
          comment: args.comment ?? null,
          actor: { id: ctx.user.id, role: ctx.user.role, isAdmin: ctx.isAdmin ?? false }
        })
        return result.instance ?? null
      } catch (e) {
        wrapWorkflowError(e)
      }
    }
  }

  if (Object.keys(queryFields).length === 0) {
    queryFields._empty = { type: GraphQLBoolean, resolve: () => null }
  }
  if (Object.keys(mutationFields).length === 0) {
    mutationFields._empty = { type: GraphQLBoolean, resolve: () => null }
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    mutation: new GraphQLObjectType({ name: 'Mutation', fields: mutationFields }),
    subscription: new GraphQLObjectType({ name: 'Subscription', fields: domainSubscriptionFields }),
    types: [
      GraphQLJSON,
      DeleteResponseType,
      ...ALL_DOMAIN_TYPES,
      ...ALL_FILTER_TYPES,
      ...[...filterRegistry.values()],
      ...relationWrapperTypes
    ]
  })
}

// ─── OpenAPI 3.1 spec generator ───────────────────────────────────────────────

const OA_TYPE_MAP: Record<string, { type: string; format?: string }> = {
  string: { type: 'string' },
  text: { type: 'string' },
  uuid: { type: 'string', format: 'uuid' },
  hash: { type: 'string' },
  integer: { type: 'integer' },
  bigInteger: { type: 'integer', format: 'int64' },
  float: { type: 'number', format: 'float' },
  decimal: { type: 'number', format: 'double' },
  boolean: { type: 'boolean' },
  datetime: { type: 'string', format: 'date-time' },
  date: { type: 'string', format: 'date' },
  time: { type: 'string', format: 'time' },
  json: { type: 'object' },
  csv: { type: 'string' }
}

export async function buildOpenAPISpec(baseUrl: string): Promise<Record<string, unknown>> {
  const collections = await listCollections()
  const components: Record<string, unknown> = {}
  const paths: Record<string, unknown> = {}

  // ── Filter DSL schema (shared) ────────────────────────────────────────────
  components['FilterDSL'] = {
    type: 'object',
    description: 'Nivaro filter object. Keys are field names, values are operator objects.',
    example: { status: { _eq: 'active' }, amount: { _gt: 1000 } },
    additionalProperties: {
      type: 'object',
      additionalProperties: true
    }
  }

  components['ListMeta'] = {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      limit: { type: 'integer' },
      offset: { type: 'integer' }
    },
    required: ['total', 'limit', 'offset']
  }

  for (const col of collections.filter((c) => !c.hidden)) {
    const name = col.collection
    const fields = await getFields(name)
    const visibleFields = fields.filter((f) => !f.hidden || f.field === 'id')

    // ── Schema component ──────────────────────────────────────────────────────
    const schemaName = name.replace(/[^a-zA-Z0-9_]/g, '_')
    const properties: Record<string, unknown> = {}
    for (const f of visibleFields) {
      const oaType = OA_TYPE_MAP[f.type] ?? { type: 'string' }
      properties[f.field] = {
        ...oaType,
        ...(f.note ? { description: f.note } : {}),
        nullable: true
      }
    }
    components[schemaName] = {
      type: 'object',
      description: col.display_name ?? name,
      properties
    }

    // ── List response component ───────────────────────────────────────────────
    components[`${schemaName}_list`] = {
      allOf: [
        { $ref: '#/components/schemas/ListMeta' },
        {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: `#/components/schemas/${schemaName}` } }
          },
          required: ['data']
        }
      ]
    }

    // ── Paths ─────────────────────────────────────────────────────────────────
    const tag = col.display_name ?? name
    const listPath = `/items/${name}`
    const itemPath = `/items/${name}/{id}`

    paths[listPath] = {
      get: {
        tags: [tag],
        summary: `List ${tag}`,
        operationId: `list_${name}`,
        parameters: [
          {
            name: 'filter',
            in: 'query',
            description: 'Filter DSL JSON string',
            schema: { type: 'string' }
          },
          {
            name: 'sort',
            in: 'query',
            description: 'Comma-separated sort fields. Prefix with - for descending.',
            schema: { type: 'string' }
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          {
            name: 'search',
            in: 'query',
            description: 'Fulltext search',
            schema: { type: 'string' }
          },
          {
            name: 'fields',
            in: 'query',
            description: 'Comma-separated field list',
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${schemaName}_list` } }
            }
          },
          401: { description: 'Unauthorized' },
          403: { description: 'Forbidden' }
        },
        security: [{ bearerToken: [] }, { sessionCookie: [] }]
      },
      post: col.singleton
        ? undefined
        : {
            tags: [tag],
            summary: `Create ${tag} item`,
            operationId: `create_${name}`,
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } }
              }
            },
            responses: {
              201: {
                description: 'Created',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { data: { $ref: `#/components/schemas/${schemaName}` } }
                    }
                  }
                }
              },
              401: { description: 'Unauthorized' },
              403: { description: 'Forbidden' }
            },
            security: [{ bearerToken: [] }, { sessionCookie: [] }]
          }
    }

    if (!col.singleton) {
      paths[itemPath] = {
        get: {
          tags: [tag],
          summary: `Get ${tag} by ID`,
          operationId: `read_${name}_item`,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { $ref: `#/components/schemas/${schemaName}` } }
                  }
                }
              }
            },
            404: { description: 'Not found' }
          },
          security: [{ bearerToken: [] }, { sessionCookie: [] }]
        },
        patch: {
          tags: [tag],
          summary: `Update ${tag} item`,
          operationId: `update_${name}_item`,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } }
            }
          },
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { $ref: `#/components/schemas/${schemaName}` } }
                  }
                }
              }
            }
          },
          security: [{ bearerToken: [] }, { sessionCookie: [] }]
        },
        delete: {
          tags: [tag],
          summary: `Delete ${tag} item`,
          operationId: `delete_${name}_item`,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 204: { description: 'Deleted' } },
          security: [{ bearerToken: [] }, { sessionCookie: [] }]
        }
      }
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Nivaro API',
      version: '1.0.0',
      description:
        'Auto-generated REST API for all collections registered in the Nivaro CMS metadata registry. Authenticate with a static token (Authorization: Bearer <token>) or a session cookie.'
    },
    servers: [{ url: `${baseUrl}/api`, description: 'Nivaro API' }],
    components: {
      schemas: components,
      securitySchemes: {
        bearerToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'Static token from POST /users/me/token'
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sessionId',
          description: 'Browser session cookie (OIDC login)'
        }
      }
    },
    paths
  }
}
