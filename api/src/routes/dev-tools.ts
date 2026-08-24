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

  // Typed SDK client (#164): the generated interfaces PLUS a thin typed
  // wrapper over @nivaro/sdk keyed by collection name — item reads/writes
  // autocomplete against THIS instance's schema.
  app.get('/typed-client.ts', async (_req, reply) => {
    const { collections, fieldsByCollection, relations, projectName } = await loadSchema()
    const types = generateTypes(collections, fieldsByCollection, relations, projectName)
    const names = collections.map((c) => c.collection)
    const mapEntries = names
      .map((n) => `  ${JSON.stringify(n)}: ${pascalCase(n)}`)
      .join('\n')
    const wrapper = `

// ─── Typed client wrapper ─────────────────────────────────────────────────────
// Usage:
//   import { createTypedNivaro } from './typed-client'
//   const cms = createTypedNivaro({ url: '...', token: '...' })
//   const rows = await cms.items('workflows').list({ limit: 25 })

import { createNivaro, type NivaroConfig } from '@nivaro/sdk'

export interface NivaroCollections {
${mapEntries}
}

export function createTypedNivaro(config: NivaroConfig) {
  const client = createNivaro(config)
  return {
    client,
    items<C extends keyof NivaroCollections>(collection: C) {
      type Row = NivaroCollections[C]
      return {
        list: (params?: Record<string, unknown>) =>
          client.request<{ data: Row[]; total?: number }>({
            method: 'GET',
            path: \`/items/\${String(collection)}\`,
            params
          } as never) as Promise<{ data: Row[]; total?: number }>,
        get: (id: string | number) =>
          client.request<{ data: Row }>({
            method: 'GET',
            path: \`/items/\${String(collection)}/\${id}\`
          } as never) as Promise<{ data: Row }>,
        create: (data: Partial<Row>) =>
          client.request<{ data: Row }>({
            method: 'POST',
            path: \`/items/\${String(collection)}\`,
            body: data
          } as never) as Promise<{ data: Row }>,
        update: (id: string | number, data: Partial<Row>) =>
          client.request<{ data: Row }>({
            method: 'PATCH',
            path: \`/items/\${String(collection)}/\${id}\`,
            body: data
          } as never) as Promise<{ data: Row }>,
        remove: (id: string | number) =>
          client.request({
            method: 'DELETE',
            path: \`/items/\${String(collection)}/\${id}\`
          } as never) as Promise<void>
      }
    }
  }
}
`
    return reply.type('text/plain; charset=utf-8').send(types + wrapper)
  })

  // SDK mock server (#345): a dependency-free node script embedding this
  // instance's schema — fake /api/items endpoints with type-plausible data
  // for offline frontend development.
  app.get('/mock-server.mjs', async (_req, reply) => {
    const { collections, fieldsByCollection } = await loadSchema()
    const schema: Record<string, Array<{ field: string; type: string }>> = {}
    for (const c of collections) {
      schema[c.collection] = (fieldsByCollection.get(c.collection) ?? [])
        .filter((f) => f.type !== 'alias')
        .map((f) => ({ field: f.field, type: f.type ?? 'string' }))
        .slice(0, 60)
    }
    const script = `#!/usr/bin/env node
// Nivaro mock API — generated from a live instance's schema (#345).
// Run: node mock-server.mjs [port]   (default 3999)
// Serves GET /api/items/:collection (25 fake rows), GET /api/items/:collection/:id,
// and accepts POST/PATCH/DELETE with echo responses. No auth, no persistence.
import { createServer } from 'node:http'

const SCHEMA = ${JSON.stringify(schema)}

let seed = 42
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const WORDS = ['alpha','bravo','delta','echo','ridge','north','union','harbor','summit','mesa']
function fake(type, field, i) {
  if (field === 'id') return i + 1
  if (/int|number|decimal|float/.test(type)) return Math.round(rand() * 10000) / 100
  if (/bool/.test(type)) return rand() > 0.5
  if (/date|time/.test(type)) return new Date(Date.now() - rand() * 90 * 864e5).toISOString()
  if (/uuid/.test(type)) return '00000000-0000-4000-8000-' + String(i).padStart(12, '0')
  return WORDS[Math.floor(rand() * WORDS.length)] + '-' + (i + 1)
}
function rows(collection, count = 25) {
  const fields = SCHEMA[collection] ?? [{ field: 'id', type: 'integer' }]
  return Array.from({ length: count }, (_, i) =>
    Object.fromEntries(fields.map((f) => [f.field, fake(f.type, f.field, i)]))
  )
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const m = url.pathname.match(/^\\/api\\/items\\/([a-z0-9_]+)(?:\\/([^/]+))?$/i)
  res.setHeader('content-type', 'application/json')
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', '*')
  res.setHeader('access-control-allow-methods', '*')
  if (req.method === 'OPTIONS') return res.end()
  if (!m) {
    res.statusCode = 404
    return res.end(JSON.stringify({ error: 'mock: only /api/items/* is served' }))
  }
  const [, collection, id] = m
  if (!SCHEMA[collection]) {
    res.statusCode = 404
    return res.end(JSON.stringify({ error: 'unknown collection: ' + collection }))
  }
  if (req.method === 'GET' && !id) {
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 25)
    return res.end(JSON.stringify({ data: rows(collection, limit), total: 250 }))
  }
  if (req.method === 'GET') {
    return res.end(JSON.stringify({ data: { ...rows(collection, 1)[0], id } }))
  }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const payload = (() => { try { return JSON.parse(body || '{}') } catch { return {} } })()
    if (req.method === 'DELETE') { res.statusCode = 204; return res.end() }
    res.statusCode = req.method === 'POST' ? 201 : 200
    res.end(JSON.stringify({ data: { id: id ?? Math.floor(rand() * 100000), ...payload }, mock: true }))
  })
})
const port = Number(process.argv[2]) || 3999
server.listen(port, () => console.log('nivaro mock api on http://localhost:' + port))
`
    reply.header('content-disposition', 'attachment; filename="mock-server.mjs"')
    return reply.type('text/plain; charset=utf-8').send(script)
  })

  app.get('/openapi.json', async (_req, reply) => {
    const { collections, fieldsByCollection, projectName } = await loadSchema()
    return reply.send(generateOpenApi(collections, fieldsByCollection, projectName))
  })

  app.get('/postman.json', async (_req, reply) => {
    const { collections, fieldsByCollection, projectName } = await loadSchema()
    return reply.send(generatePostman(collections, fieldsByCollection, projectName))
  })

  // Changelogs (#163/#315): what changed in the API surface, and when.
  app.get('/graphql-changelog', async (_req, reply) => {
    const { db } = await import('../db/index.js')
    const rows = await db('nivaro_graphql_schema_log')
      .orderBy('id', 'desc')
      .limit(30)
      .select('id', 'at', 'diff', 'breaking')
    return reply.send({ data: rows })
  })

  app.get('/api-changelog', async (_req, reply) => {
    const { db } = await import('../db/index.js')
    const rows = await db('nivaro_api_changelog')
      .orderBy('id', 'desc')
      .limit(30)
      .select('id', 'version', 'at', 'diff', 'breaking')
    return reply.send({ data: rows })
  })

  app.get('/bruno.json', async (_req, reply) => {
    const { collections, projectName } = await loadSchema()
    return reply.send(generateBruno(collections, projectName))
  })
}
