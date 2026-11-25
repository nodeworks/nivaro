import Fastify from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The Hub's routes in OpenAPI: the instance's GET /api/dev-tools/openapi.json lists them only on a
// Hub (HUB=on); the public artefact (www/openapi.json) always lists them, each tagged "Hub mode
// only" in its own group, secrets write-only.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async () => undefined),
  requireAuth: vi.fn(async () => undefined),
  authenticate: vi.fn(async () => undefined)
}))
vi.mock('../../../services/collections.js', () => ({
  listCollections: vi.fn(async () => []),
  getRelations: vi.fn(async () => [])
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { devToolsRoutes } = await import('../../../routes/dev-tools.js')
const { generateOpenApi } = await import('../../../routes/dev-tools.js')
const { withHubOpenApi } = await import('../../../services/hub/api/openapi.js')
const { HUB_ROUTES } = await import('../../../services/hub/api/catalog.js')

beforeAll(async () => {
  await db.schema.createTable('nivaro_fields', (t) => {
    t.increments('id')
    t.string('collection')
    t.string('field')
    t.integer('sort')
  })
  await db.schema.createTable('nivaro_settings', (t) => {
    t.increments('id')
    t.string('project_name')
  })
})
afterAll(async () => {
  await db.destroy()
})

async function spec(hub: string | undefined) {
  const saved = process.env.HUB
  if (hub === undefined) delete process.env.HUB
  else process.env.HUB = hub
  try {
    const app = Fastify()
    await app.register(devToolsRoutes, { prefix: '/api/dev-tools' })
    const r = await app.inject({ method: 'GET', url: '/api/dev-tools/openapi.json' })
    await app.close()
    return r.json() as { paths: Record<string, unknown>; tags?: Array<{ name: string }> }
  } finally {
    if (saved === undefined) delete process.env.HUB
    else process.env.HUB = saved
  }
}

describe('instance OpenAPI', () => {
  it('a regular install lists no Hub route', async () => {
    const s = await spec(undefined)
    expect(Object.keys(s.paths).some((p) => p.startsWith('/hub'))).toBe(false)
    expect(JSON.stringify(s)).not.toContain('Hub ·')
  })

  it('a Hub lists every Hub route', async () => {
    const s = await spec('on')
    expect(s.paths['/hub/apps']).toBeDefined()
    expect(s.paths['/hub/environments/{envId}/promote/plan']).toBeDefined()
    const ops = Object.entries(s.paths)
      .filter(([p]) => p.startsWith('/hub'))
      .flatMap(([, v]) => Object.keys(v as object))
    expect(ops.length).toBe(HUB_ROUTES.length)
  })

  it('cloud mode never lists them', async () => {
    const saved = process.env.CLOUD_META_DB_URL
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    try {
      const s = await spec('on')
      expect(Object.keys(s.paths).some((p) => p.startsWith('/hub'))).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.CLOUD_META_DB_URL
      else process.env.CLOUD_META_DB_URL = saved
    }
  })
})

describe('public OpenAPI (www/openapi.json)', () => {
  const pub = withHubOpenApi(generateOpenApi([], new Map(), 'Nivaro'), {
    publicArtefact: true
  }) as {
    paths: Record<string, Record<string, Record<string, unknown>>>
    tags: Array<{ name: string; description: string }>
    'x-tagGroups': Array<{ name: string; tags: string[] }>
  }

  it('tags every Hub operation "Hub mode only", in its own group', () => {
    const hubOps = Object.entries(pub.paths)
      .filter(([p]) => p.startsWith('/hub'))
      .flatMap(([, v]) => Object.values(v))
    expect(hubOps.length).toBe(HUB_ROUTES.length)
    for (const op of hubOps) {
      expect((op.tags as string[])[0]).toMatch(/^Hub mode only · /)
      expect(op['x-hub-mode-only']).toBe(true)
      expect(String(op.description)).toContain('Hub mode only')
    }
    const group = pub['x-tagGroups'].find((g) => g.name === 'Hub mode only')
    expect(group?.tags.length).toBeGreaterThan(5)
    expect(group?.tags.every((t) => t.startsWith('Hub mode only'))).toBe(true)
  })

  it('names the API-key scope and keeps secrets write-only', () => {
    const plan = pub.paths['/hub/environments/{envId}/promote/plan'].post
    expect(String(plan.description)).toContain('hub:read')
    const start = pub.paths['/hub/environments/{envId}/promote'].post
    expect(String(start.description)).toContain('hub:write')
    const driver = pub.paths['/hub/drivers'].post as {
      requestBody: {
        content: {
          'application/json': { schema: { properties: Record<string, { writeOnly?: boolean }> } }
        }
      }
    }
    expect(driver.requestBody.content['application/json'].schema.properties.secret.writeOnly).toBe(
      true
    )
  })
})
