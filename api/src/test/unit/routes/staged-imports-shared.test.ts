import fastifyMultipart from '@fastify/multipart'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Ruling P5-10 item 6 (review I6): staged imports run on the import drainer, which a Hub shared
// deployment does not run (per-app draining is phase 6). The upload and requeue answer 409
// IMPORTS_NOT_ON_SHARED there instead of "queued" forever. Self-hosted and cloud are unchanged.

const inserted = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: 'admin', email: 'a@x' }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/files.js', async (orig) => ({
  ...(await orig<object>()),
  uploadFileBuffer: vi.fn(async () => ({ id: 'file-1' }))
}))
vi.mock('../../../db/index.js', async (orig) => {
  const db = (table: string) => ({
    insert: (row: Record<string, unknown>) => {
      inserted.push({ table, ...row })
      return { returning: async () => [{ id: 77 }] }
    },
    where: () => ({
      first: async () => ({ id: 9, status: 'done', file: 'file-1' }),
      update: async (row: Record<string, unknown>) => {
        inserted.push({ table, ...row })
        return 1
      }
    })
  })
  return { ...(await orig<object>()), db }
})
vi.mock('../../../services/staged-import-worker.js', () => ({
  publishStanding: vi.fn(async () => {})
}))
vi.mock('../../../services/staged-imports.js', async (orig) => ({
  ...(await orig<object>()),
  getImportDefinition: vi.fn(async (key: string) => ({ id: 3, key, is_active: true })),
  parseImportFile: vi.fn(() => {
    throw new Error('the upload must not read the file')
  }),
  parseImportFileAsync: vi.fn(async () => {
    throw new Error('the upload must not read the file')
  })
}))
vi.mock('../../../services/staged-import-validation.js', async (orig) => ({
  ...(await orig<object>()),
  validateStagedRows: vi.fn(async () => {
    throw new Error('the upload must not validate the file')
  })
}))

import { ERROR_HINTS } from '../../../lib/error-hints.js'
import { stagedImportRoutes } from '../../../routes/staged-imports.js'

function multipartBody(fields: Record<string, string>, file: { name: string; body: string }) {
  const boundary = '----nivarotest'
  const parts = Object.entries(fields).map(
    ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
  )
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n${file.body}\r\n`
  )
  return {
    payload: `${parts.join('')}--${boundary}--\r\n`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  }
}

async function appWithRoutes() {
  const app = Fastify()
  await app.register(fastifyMultipart)
  await app.register(stagedImportRoutes, { prefix: '/staged-imports' })
  return app
}

const saved = { ...process.env }
beforeEach(() => {
  inserted.length = 0
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
})
afterEach(() => {
  process.env = { ...saved }
})

const upload = (app: Awaited<ReturnType<typeof appWithRoutes>>) =>
  app.inject({
    method: 'POST',
    url: '/staged-imports',
    ...multipartBody({ import_key: 'invoices' }, { name: 'a.csv', body: 'a,b\n1,2\n' })
  })

const REFUSAL = {
  error: 'Staged imports are not available on a shared deployment yet.',
  code: 'IMPORTS_NOT_ON_SHARED'
}

describe('staged imports on a shared deployment', () => {
  beforeEach(() => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
  })

  it('the upload answers 409 IMPORTS_NOT_ON_SHARED and queues nothing', async () => {
    const res = await upload(await appWithRoutes())
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual(REFUSAL)
    expect(inserted).toEqual([])
  })

  it('a requeue answers the same', async () => {
    const app = await appWithRoutes()
    const res = await app.inject({ method: 'POST', url: '/staged-imports/9/requeue' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual(REFUSAL)
    expect(inserted).toEqual([])
  })

  it('the code has a plain hint', () => {
    expect(ERROR_HINTS.IMPORTS_NOT_ON_SHARED).toBe(
      'Ask whoever runs the shared deployment when staged imports will be available here.'
    )
  })
})

for (const [name, env] of [
  ['self-hosted', {}],
  ['cloud', { CLOUD_META_DB_URL: 'postgres://meta/x' }]
] as const) {
  it(`${name}: the upload still queues (202)`, async () => {
    Object.assign(process.env, env)
    const res = await upload(await appWithRoutes())
    expect(res.statusCode).toBe(202)
    expect(inserted).toHaveLength(1)
  })
}
