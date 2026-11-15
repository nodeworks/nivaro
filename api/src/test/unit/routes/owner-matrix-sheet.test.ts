import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { fixtureContext, G1 } from '../../fixtures/owner-matrix-sheet.js'

// The spreadsheet routes: download → upload preview (writes nothing) → apply
// bound to the preview hash (409 when the matrix moved).

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: 'ADMIN-1' }
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/config-live.js', () => ({ markConfigRead: vi.fn() }))
vi.mock('../../../services/pipeline-engine.js', () => ({ bustOwnerGroupCache: vi.fn() }))
const versions = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../../services/owner-matrix-versions.js', () => ({
  snapshotOwnerMatrixVersion: vi.fn(async () => {
    versions.calls++
    return 7
  })
}))
const state = vi.hoisted(() => ({ hash: 'a'.repeat(64), applied: 0 }))
vi.mock('../../../services/owner-matrix-sheet-db.js', async () => {
  const { fixtureContext: fx } = await import('../../fixtures/owner-matrix-sheet.js')
  class OwnerSheetStaleError extends Error {}
  return {
    OwnerSheetStaleError,
    loadOwnerSheetContext: vi.fn(async (id: string) =>
      id === 'MISSING' ? null : { ...fx({ matrixHash: state.hash }), lookUp: async () => {} }
    ),
    applyOwnerSheetOps: vi.fn(async () => {
      state.applied++
      return {
        groups_added: 0,
        groups_removed: 0,
        groups_changed: 1,
        people_added: 0,
        people_removed: 1,
        teams_added: 0,
        teams_removed: 0,
        inserted: []
      }
    })
  }
})

import { ownerMatrixSheetRoutes } from '../../../routes/owner-matrix-sheet.js'

async function app() {
  const a = Fastify()
  await a.register(import('@fastify/multipart'))
  await a.register(ownerMatrixSheetRoutes, { prefix: '/api/pipelines' })
  return a
}

function multipart(file: Buffer, name = 'owners.xlsx') {
  const B = 'b0undary29'
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${B}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ),
      file,
      Buffer.from(`\r\n--${B}--\r\n`)
    ])
  }
}

/** The downloaded file with Bob taken off G1. */
async function editedFile(a: Awaited<ReturnType<typeof app>>): Promise<Buffer> {
  const res = await a.inject({ method: 'GET', url: '/api/pipelines/TPL/owner-matrix/sheet' })
  const wb = XLSX.read(res.rawPayload, { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Owners)
  const header = Object.keys(rows[0])
  for (const r of rows) if (r['Group ID'] === G1) r.People = 'Ann Lee <ann@example.com>; No Mail'
  const out = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(out, XLSX.utils.json_to_sheet(rows, { header }), 'Owners')
  return XLSX.write(out, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

beforeEach(() => {
  state.hash = 'a'.repeat(64)
  state.applied = 0
  versions.calls = 0
})

describe('owner matrix spreadsheet routes', () => {
  it('downloads an .xlsx named after the pipeline', async () => {
    const a = await app()
    const res = await a.inject({ method: 'GET', url: '/api/pipelines/TPL/owner-matrix/sheet' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('spreadsheetml')
    expect(res.headers['content-disposition']).toContain('Purchase approval - owner matrix.xlsx')
    const wb = XLSX.read(res.rawPayload, { type: 'buffer' })
    expect(wb.SheetNames).toEqual(['Owners', 'README', 'Lists'])
    const missing = await a.inject({
      method: 'GET',
      url: '/api/pipelines/MISSING/owner-matrix/sheet'
    })
    expect(missing.statusCode).toBe(404)
  })

  it('preview: changes per step + a hash; nothing is written', async () => {
    const a = await app()
    const file = await editedFile(a)
    const res = await a.inject({
      method: 'POST',
      url: '/api/pipelines/TPL/owner-matrix/sheet/preview',
      ...multipart(file)
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.plan_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(data.nothing_to_do).toBe(false)
    expect(data.ops).toBeUndefined()
    expect(data.steps[0].changes[0].people_removed.map((p: { email: string }) => p.email)).toEqual([
      'bob@example.com'
    ])
    expect(state.applied).toBe(0)
  })

  it('apply with the preview hash writes once, after storing a version', async () => {
    const a = await app()
    const file = await editedFile(a)
    const pre = await a.inject({
      method: 'POST',
      url: '/api/pipelines/TPL/owner-matrix/sheet/preview',
      ...multipart(file)
    })
    const hash = pre.json().data.plan_hash
    const res = await a.inject({
      method: 'POST',
      url: `/api/pipelines/TPL/owner-matrix/sheet/apply?hash=${hash}`,
      ...multipart(file)
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ applied: true, version: 7, groups_changed: 1 })
    expect(versions.calls).toBe(1)
    expect(state.applied).toBe(1)
  })

  it('stale apply: the matrix changed since the preview → 409 with the fresh preview', async () => {
    const a = await app()
    const file = await editedFile(a)
    const pre = await a.inject({
      method: 'POST',
      url: '/api/pipelines/TPL/owner-matrix/sheet/preview',
      ...multipart(file)
    })
    const hash = pre.json().data.plan_hash
    state.hash = 'b'.repeat(64) // someone edited the matrix
    const res = await a.inject({
      method: 'POST',
      url: `/api/pipelines/TPL/owner-matrix/sheet/apply?hash=${hash}`,
      ...multipart(file)
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('OWNER_SHEET_STALE')
    expect(res.json().data.plan_hash).not.toBe(hash)
    expect(state.applied).toBe(0)
    expect(versions.calls).toBe(0)
  })

  it('apply refuses a file with problems, and needs a preview hash', async () => {
    const a = await app()
    const ctx = fixtureContext()
    const bad = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      bad,
      XLSX.utils.json_to_sheet([
        {
          Step: 'Nowhere',
          'Group name': '',
          Region: '',
          'Project Type': '',
          People: '',
          'Group ID': ctx.groups[0].id
        }
      ]),
      'Owners'
    )
    const file = XLSX.write(bad, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const pre = await a.inject({
      method: 'POST',
      url: '/api/pipelines/TPL/owner-matrix/sheet/preview',
      ...multipart(file)
    })
    expect(pre.json().data.errors).toBeGreaterThan(0)
    const res = await a.inject({
      method: 'POST',
      url: `/api/pipelines/TPL/owner-matrix/sheet/apply?hash=${pre.json().data.plan_hash}`,
      ...multipart(file)
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('OWNER_SHEET_PROBLEMS')
    const noHash = await a.inject({
      method: 'POST',
      url: '/api/pipelines/TPL/owner-matrix/sheet/apply',
      ...multipart(file)
    })
    expect(noHash.statusCode).toBe(400)
    expect(state.applied).toBe(0)
  })
})
