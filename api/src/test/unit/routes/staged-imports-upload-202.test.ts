import fastifyMultipart from '@fastify/multipart'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// EFP prod 2026-11-16: POST /staged-imports read and validated a 30 MB invoices CSV inside the
// request — 17 s on a web process, its event loop stalled up to 13.4 s. The upload now stores
// the file, queues the run and answers 202; the worker reads (off the loop) and validates.

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
    }
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

import { stagedImportRoutes } from '../../../routes/staged-imports.js'
import { validateStagedRows } from '../../../services/staged-import-validation.js'
import { parseImportFileAsync } from '../../../services/staged-imports.js'

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

beforeEach(() => {
  inserted.length = 0
})

describe('POST /staged-imports', () => {
  it('stores the file, queues the run and answers 202 without reading or validating it', async () => {
    const app = await appWithRoutes()
    const res = await app.inject({
      method: 'POST',
      url: '/staged-imports',
      ...multipartBody(
        { import_key: 'invoices', sort: '5' },
        { name: 'big.csv', body: 'invoice_id,amount\n1,2\n' }
      )
    })
    expect(res.statusCode).toBe(202)
    expect(res.json().data).toEqual({ id: 77, import_key: 'invoices', status: 'queued' })
    expect(inserted).toEqual([
      expect.objectContaining({
        table: 'nivaro_import_queue',
        status: 'queued',
        file: 'file-1',
        import_key: 'invoices',
        sort: 5
      })
    ])
    expect(parseImportFileAsync).not.toHaveBeenCalled()
    expect(validateStagedRows).not.toHaveBeenCalled()
  })

  it('an empty file is refused at once and queues nothing', async () => {
    const app = await appWithRoutes()
    const res = await app.inject({
      method: 'POST',
      url: '/staged-imports',
      ...multipartBody({ import_key: 'invoices' }, { name: 'empty.csv', body: '' })
    })
    expect(res.statusCode).toBe(400)
    expect(inserted).toHaveLength(0)
  })
})
