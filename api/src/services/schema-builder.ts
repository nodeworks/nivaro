import {
  GraphQLBoolean,
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
  GraphQLString
} from 'graphql'
import { db } from '../db/index.js'
import {
  domainMutationFields,
  domainQueryFields,
  domainSubscriptionFields
} from '../graphql/resolvers.js'
import { GraphQLJSON } from '../graphql/scalars.js'
import { ALL_DOMAIN_TYPES } from '../graphql/types.js'
import type { User } from '../types.js'
import { getFields, getRelations, listCollections } from './collections.js'
import {
  CollectionNotFoundError,
  createOne,
  deleteOne,
  ForbiddenError,
  readItems,
  readOne,
  updateOne
} from './items.js'

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

const StringFilterOps = new GraphQLInputObjectType({
  name: 'StringFilter',
  fields: {
    _eq: { type: GraphQLString },
    _neq: { type: GraphQLString },
    _contains: { type: GraphQLString },
    _ncontains: { type: GraphQLString },
    _starts_with: { type: GraphQLString },
    _ends_with: { type: GraphQLString },
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
    _null: { type: GraphQLBoolean },
    _nnull: { type: GraphQLBoolean }
  }
})

const IDFilterOps = new GraphQLInputObjectType({
  name: 'IDFilter',
  fields: {
    _eq: { type: GraphQLID },
    _neq: { type: GraphQLID },
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

// ─── Error conversion ─────────────────────────────────────────────────────────

function wrapError(err: unknown): never {
  if (err instanceof ForbiddenError)
    throw Object.assign(new Error('Forbidden'), { extensions: { code: 'FORBIDDEN' } })
  if (err instanceof CollectionNotFoundError)
    throw Object.assign(new Error(err.message), { extensions: { code: 'NOT_FOUND' } })
  throw err
}

// ─── Schema builder ───────────────────────────────────────────────────────────

interface GQLContext {
  user?: User
  isAdmin?: boolean
}

export async function buildGraphQLSchema(): Promise<GraphQLSchema> {
  const collections = await listCollections()
  const visible = collections.filter((c) => !c.hidden)

  // Pre-load all fields per collection
  const allFields = new Map<string, Awaited<ReturnType<typeof getFields>>>()
  for (const col of visible) {
    const fields = await getFields(col.collection)
    allFields.set(
      col.collection,
      fields.filter((f) => !f.hidden)
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
        }
      }
    }
  }

  // ── Type registry (build ALL types first so thunks can cross-reference) ────
  const typeRegistry = new Map<string, GraphQLObjectType>()

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
                  resolve: async (source: unknown) => {
                    const parent = source as Record<string, unknown>
                    const fkVal = parent[col]
                    if (fkVal == null) return null
                    return (await db(target).where({ id: fkVal }).first()) ?? null
                  }
                }
                continue
              }
              // Target not registered → fall through to scalar (returns FK string)
            }

            // ── M2M: virtual field → join through junction ────────────────────
            const m2mInfo = m2mMap.get(fkey)
            if (m2mInfo) {
              const otherType = typeRegistry.get(m2mInfo.otherCollection)
              if (otherType) {
                const info = { ...m2mInfo }
                gqlFields[f.field] = {
                  type: new GraphQLList(new GraphQLNonNull(otherType)),
                  description: f.note ?? undefined,
                  resolve: async (source: unknown) => {
                    const parentId = (source as Record<string, unknown>)['id']
                    if (parentId == null) return []
                    return db(`${info.junction} as _j`)
                      .where({ [`_j.${info.fkToParent}`]: parentId })
                      .join(`${info.otherCollection} as _rel`, '_rel.id', `_j.${info.fkToOther}`)
                      .select('_rel.*')
                  }
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
                gqlFields[f.field] = {
                  type: new GraphQLList(new GraphQLNonNull(manyType)),
                  description: f.note ?? undefined,
                  resolve: async (source: unknown) => {
                    const parentId = (source as Record<string, unknown>)['id']
                    if (parentId == null) return []
                    return db(info.manyCollection).where({ [info.manyField]: parentId })
                  }
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

          return gqlFields
        }
      })
    )
  }

  // ── Per-collection filter input types (thunks allow self-ref _and/_or) ───
  const filterRegistry = new Map<string, GraphQLInputObjectType>()

  // Wrapper input types for O2M and M2M relations (_some / _none)
  // Built alongside filterRegistry so thunks can reference them.
  const relationWrapperTypes: GraphQLInputObjectType[] = []

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
                    return { _some: { type: inner }, _none: { type: inner } }
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
                    return { _some: { type: inner }, _none: { type: inner } }
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
              // Primary: filter by FK value (e.g. author_id: { _eq: "uuid" })
              f[field.field] = { type: filterOpsForField(field.field, field.type) }
              // Alias: nested relation filter (e.g. author: { first_name: { _eq: ... } })
              const relFilter = filterRegistry.get(m2oTarget)
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

    const listType = new GraphQLObjectType({
      name: `${name}_list`,
      fields: {
        data: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(itemType))) },
        total: { type: new GraphQLNonNull(GraphQLInt) },
        limit: { type: new GraphQLNonNull(GraphQLInt) },
        offset: { type: new GraphQLNonNull(GraphQLInt) }
      }
    })

    queryFields[name] = {
      type: new GraphQLNonNull(listType),
      description: `List ${col.display_name ?? name} items.`,
      args: {
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
        search: { type: GraphQLString }
      },
      resolve: async (_root, args: Record<string, unknown>, ctx: GQLContext) => {
        if (!ctx.user)
          throw Object.assign(new Error('Unauthorized'), {
            extensions: { code: 'UNAUTHENTICATED' }
          })
        try {
          return await readItems(ctx.user, name, {
            filter: args.filter as Record<string, unknown> | undefined,
            sort: args.sort as string[] | undefined,
            limit: args.limit as number | undefined,
            offset: args.offset as number | undefined,
            search: args.search as string | undefined
          })
        } catch (e) {
          wrapError(e)
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
          return await createOne(ctx.user, name, data)
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
          return await updateOne(ctx.user, name, id, data)
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
          await deleteOne(ctx.user, name, id)
          return { id }
        } catch (e) {
          wrapError(e)
        }
      }
    }
  }

  // Merge domain fields (workflow, pipeline, users, activity, files, settings)
  Object.assign(queryFields, domainQueryFields)
  Object.assign(mutationFields, domainMutationFields)

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
    const visibleFields = fields.filter((f) => !f.hidden)

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
