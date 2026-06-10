import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { getRelations, listCollections } from '../services/collections.js'
import type { CMSCollection, CMSField, CMSRelation } from '../types.js'

/**
 * Developer tooling endpoints (admin only) — prefix /api/dev-tools
 *
 * GET /types.ts      TypeScript interfaces generated from the schema registry
 * GET /openapi.json  OpenAPI 3.1 document for the generic items API
 * GET /postman.json  Postman v2.1 collection ({{baseUrl}} / {{token}} vars)
 * GET /bruno.json    Bruno collection JSON
 */

// ─── Shared helpers ──────────────────────────────────────────────────────────

function pascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

const TS_TYPE_MAP: Record<string, string> = {
  string: 'string',
  text: 'string',
  uuid: 'string',
  hash: 'string',
  csv: 'string',
  integer: 'number',
  bigInteger: 'number',
  float: 'number',
  decimal: 'number',
  boolean: 'boolean',
  datetime: 'string',
  date: 'string',
  time: 'string',
  json: 'unknown'
}

function tsType(cmsType: string): string {
  return TS_TYPE_MAP[cmsType] ?? 'string'
}

const OPENAPI_TYPE_MAP: Record<string, { type: string; format?: string }> = {
  string: { type: 'string' },
  text: { type: 'string' },
  uuid: { type: 'string', format: 'uuid' },
  hash: { type: 'string' },
  csv: { type: 'string' },
  integer: { type: 'integer' },
  bigInteger: { type: 'integer', format: 'int64' },
  float: { type: 'number' },
  decimal: { type: 'number' },
  boolean: { type: 'boolean' },
  datetime: { type: 'string', format: 'date-time' },
  date: { type: 'string', format: 'date' },
  time: { type: 'string' },
  json: {} as { type: string } // any
}

export async function loadSchema(): Promise<{
  collections: CMSCollection[]
  fieldsByCollection: Map<string, CMSField[]>
  relations: CMSRelation[]
  projectName: string
}> {
  const collections = (await listCollections()).filter((c) => !c.collection.startsWith('nivaro_'))
  const allFields = (await db<CMSField>('nivaro_fields').orderBy('sort', 'asc')) as CMSField[]
  const fieldsByCollection = new Map<string, CMSField[]>()
  for (const f of allFields) {
    const list = fieldsByCollection.get(f.collection) ?? []
    list.push(f)
    fieldsByCollection.set(f.collection, list)
  }
  const relations = await getRelations()

  let projectName = 'Nivaro CMS'
  try {
    const settings = (await db('nivaro_settings').orderBy('id', 'asc').first()) as
      | { project_name?: string | null }
      | undefined
    if (settings?.project_name) projectName = settings.project_name
  } catch {
    // settings table unavailable — keep default
  }

  return { collections, fieldsByCollection, relations, projectName }
}

// ─── TypeScript interface generation ─────────────────────────────────────────

function generateTypes(
  collections: CMSCollection[],
  fieldsByCollection: Map<string, CMSField[]>,
  relations: CMSRelation[],
  projectName: string
): string {
  const known = new Set(collections.map((c) => c.collection))
  const lines: string[] = [
    '/**',
    ` * ${projectName} — generated TypeScript definitions`,
    ` * Generated: ${new Date().toISOString()}`,
    ' * Source: GET /api/dev-tools/types.ts',
    ' */',
    ''
  ]

  for (const col of collections) {
    const fields = fieldsByCollection.get(col.collection) ?? []
    const ifaceName = pascalCase(col.singular ?? col.collection)

    // M2O relations on this collection: field → related interface
    const m2o = new Map<string, string>()
    for (const r of relations) {
      if (r.many_collection === col.collection && r.one_collection && known.has(r.one_collection)) {
        m2o.set(r.many_field, pascalCase(r.one_collection))
      }
    }
    // O2M: another collection points back at this one via one_field alias
    const o2m: Array<{ field: string; related: string }> = []
    for (const r of relations) {
      if (
        r.one_collection === col.collection &&
        r.one_field &&
        known.has(r.many_collection) &&
        !r.junction_field
      ) {
        o2m.push({ field: r.one_field, related: pascalCase(r.many_collection) })
      }
    }

    if (col.note) lines.push(`/** ${col.note} */`)
    lines.push(`export interface ${ifaceName} {`)

    const declared = new Set<string>()
    for (const f of fields) {
      if (declared.has(f.field)) continue
      declared.add(f.field)
      const optional = f.required ? '' : '?'
      const rel = m2o.get(f.field)
      if (rel) {
        lines.push(`  /** M2O relation → ${rel} */`)
        lines.push(`  ${f.field}${optional}: ${tsType(f.type)} | ${rel} | null;`)
      } else {
        const nullable = f.required ? '' : ' | null'
        lines.push(`  ${f.field}${optional}: ${tsType(f.type)}${nullable};`)
      }
    }
    for (const { field, related } of o2m) {
      if (declared.has(field)) continue
      declared.add(field)
      lines.push(`  /** O2M relation → ${related}[] */`)
      lines.push(`  ${field}?: ${related}[];`)
    }

    lines.push('}', '')
  }

  // Collection name → type map for typed SDK usage
  lines.push('export interface Collections {')
  for (const col of collections) {
    lines.push(`  ${col.collection}: ${pascalCase(col.singular ?? col.collection)};`)
  }
  lines.push('}', '')

  return lines.join('\n')
}

// ─── OpenAPI 3.1 generation ──────────────────────────────────────────────────

function fieldToOpenApiSchema(f: CMSField): Record<string, unknown> {
  const base = OPENAPI_TYPE_MAP[f.type] ?? { type: 'string' }
  const schema: Record<string, unknown> = { ...base }
  if (f.note) schema.description = f.note
  return schema
}

export function generateOpenApi(
  collections: CMSCollection[],
  fieldsByCollection: Map<string, CMSField[]>,
  projectName: string
): Record<string, unknown> {
  const paths: Record<string, unknown> = {}
  const schemas: Record<string, unknown> = {}

  for (const col of collections) {
    const fields = fieldsByCollection.get(col.collection) ?? []
    const name = pascalCase(col.singular ?? col.collection)

    schemas[name] = {
      type: 'object',
      ...(col.note ? { description: col.note } : {}),
      properties: Object.fromEntries(fields.map((f) => [f.field, fieldToOpenApiSchema(f)])),
      required: fields.filter((f) => f.required).map((f) => f.field)
    }

    const tag = col.display_name ?? col.collection
    const ref = { $ref: `#/components/schemas/${name}` }
    const listParams = [
      { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
      { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
      {
        name: 'sort',
        in: 'query',
        schema: { type: 'string' },
        description: 'Comma-separated fields; prefix - for descending'
      },
      { name: 'filter', in: 'query', schema: { type: 'string' }, description: 'JSON filter DSL' },
      {
        name: 'fields',
        in: 'query',
        schema: { type: 'string' },
        description: 'Comma-separated field list'
      },
      { name: 'search', in: 'query', schema: { type: 'string' } }
    ]

    paths[`/items/${col.collection}`] = {
      get: {
        tags: [tag],
        operationId: `list${name}`,
        summary: `List ${col.plural ?? col.collection}`,
        parameters: listParams,
        responses: {
          '200': {
            description: 'Paginated list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: ref },
                    total: { type: 'integer' },
                    limit: { type: 'integer' },
                    offset: { type: 'integer' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: [tag],
        operationId: `create${name}`,
        summary: `Create ${col.singular ?? col.collection}`,
        requestBody: { required: true, content: { 'application/json': { schema: ref } } },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: ref } }
              }
            }
          }
        }
      }
    }

    const idParam = {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' }
    }
    paths[`/items/${col.collection}/{id}`] = {
      get: {
        tags: [tag],
        operationId: `get${name}`,
        summary: `Get ${col.singular ?? col.collection} by id`,
        parameters: [idParam],
        responses: {
          '200': {
            description: 'Item',
            content: {
              'application/json': { schema: { type: 'object', properties: { data: ref } } }
            }
          },
          '404': { description: 'Not found' }
        }
      },
      patch: {
        tags: [tag],
        operationId: `update${name}`,
        summary: `Update ${col.singular ?? col.collection}`,
        parameters: [idParam],
        requestBody: { required: true, content: { 'application/json': { schema: ref } } },
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': { schema: { type: 'object', properties: { data: ref } } }
            }
          },
          '404': { description: 'Not found' }
        }
      },
      delete: {
        tags: [tag],
        operationId: `delete${name}`,
        summary: `Delete ${col.singular ?? col.collection}`,
        parameters: [idParam],
        responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } }
      }
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${projectName} API`,
      version: '1.0.0',
      description: 'Generated from the Nivaro schema registry — GET /api/dev-tools/openapi.json'
    },
    servers: [{ url: '/api' }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Static user token' }
      },
      schemas
    }
  }
}

// ─── Postman v2.1 generation ─────────────────────────────────────────────────

function postmanRequest(method: string, path: string, body?: unknown) {
  const segments = path.split('/').filter(Boolean)
  return {
    method,
    header: [{ key: 'Content-Type', value: 'application/json' }],
    url: {
      raw: `{{baseUrl}}/api${path}`,
      host: ['{{baseUrl}}'],
      path: ['api', ...segments]
    },
    ...(body !== undefined
      ? {
          body: {
            mode: 'raw',
            raw: JSON.stringify(body, null, 2),
            options: { raw: { language: 'json' } }
          }
        }
      : {})
  }
}

function generatePostman(
  collections: CMSCollection[],
  fieldsByCollection: Map<string, CMSField[]>,
  projectName: string
): Record<string, unknown> {
  const items = collections.map((col) => {
    const fields = fieldsByCollection.get(col.collection) ?? []
    const sampleBody = Object.fromEntries(
      fields
        .filter((f) => f.field !== 'id' && !f.hidden)
        .slice(0, 10)
        .map((f) => [
          f.field,
          tsType(f.type) === 'number' ? 0 : tsType(f.type) === 'boolean' ? false : ''
        ])
    )
    return {
      name: col.display_name ?? col.collection,
      item: [
        {
          name: `List ${col.collection}`,
          request: postmanRequest('GET', `/items/${col.collection}`)
        },
        {
          name: `Get ${col.collection} by id`,
          request: postmanRequest('GET', `/items/${col.collection}/:id`)
        },
        {
          name: `Create ${col.collection}`,
          request: postmanRequest('POST', `/items/${col.collection}`, sampleBody)
        },
        {
          name: `Update ${col.collection}`,
          request: postmanRequest('PATCH', `/items/${col.collection}/:id`, sampleBody)
        },
        {
          name: `Delete ${col.collection}`,
          request: postmanRequest('DELETE', `/items/${col.collection}/:id`)
        }
      ]
    }
  })

  return {
    info: {
      name: `${projectName} API`,
      description: 'Generated from the Nivaro schema registry',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{token}}', type: 'string' }]
    },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:3055', type: 'string' },
      { key: 'token', value: '', type: 'string' }
    ],
    item: items
  }
}

// ─── Bruno collection generation ─────────────────────────────────────────────

function generateBruno(collections: CMSCollection[], projectName: string): Record<string, unknown> {
  let seq = 0
  const brunoRequest = (name: string, method: string, path: string, body?: unknown) => ({
    type: 'http',
    name,
    seq: ++seq,
    request: {
      method,
      url: `{{baseUrl}}/api${path}`,
      headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
      auth: { mode: 'bearer', bearer: { token: '{{token}}' } },
      body:
        body !== undefined
          ? { mode: 'json', json: JSON.stringify(body, null, 2) }
          : { mode: 'none' }
    }
  })

  const items = collections.map((col) => ({
    type: 'folder',
    name: col.display_name ?? col.collection,
    items: [
      brunoRequest(`List ${col.collection}`, 'GET', `/items/${col.collection}`),
      brunoRequest(`Get ${col.collection} by id`, 'GET', `/items/${col.collection}/{{id}}`),
      brunoRequest(`Create ${col.collection}`, 'POST', `/items/${col.collection}`, {}),
      brunoRequest(`Update ${col.collection}`, 'PATCH', `/items/${col.collection}/{{id}}`, {}),
      brunoRequest(`Delete ${col.collection}`, 'DELETE', `/items/${col.collection}/{{id}}`)
    ]
  }))

  return {
    version: '1',
    name: `${projectName} API`,
    type: 'collection',
    environments: [
      {
        name: 'local',
        variables: [
          { name: 'baseUrl', value: 'http://localhost:3055', enabled: true },
          { name: 'token', value: '', enabled: true, secret: true }
        ]
      }
    ],
    items
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function devToolsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/types.ts', async (_req, reply) => {
    const { collections, fieldsByCollection, relations, projectName } = await loadSchema()
    const source = generateTypes(collections, fieldsByCollection, relations, projectName)
    return reply.type('text/plain; charset=utf-8').send(source)
  })

  app.get('/openapi.json', async (_req, reply) => {
    const { collections, fieldsByCollection, projectName } = await loadSchema()
    return reply.send(generateOpenApi(collections, fieldsByCollection, projectName))
  })

  app.get('/postman.json', async (_req, reply) => {
    const { collections, fieldsByCollection, projectName } = await loadSchema()
    return reply.send(generatePostman(collections, fieldsByCollection, projectName))
  })

  app.get('/bruno.json', async (_req, reply) => {
    const { collections, projectName } = await loadSchema()
    return reply.send(generateBruno(collections, projectName))
  })
}
