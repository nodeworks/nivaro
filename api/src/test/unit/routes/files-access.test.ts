import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Record attachments follow their records (army 2026-10-25): a file the caller cannot
// read answers 404, one they may read but not change answers 403 on PATCH / replace /
// DELETE, and a non-admin library listing shows only their own uploads.

const PRIV = '11111111-1111-4111-8111-111111111111'
const PUBLIC = '22222222-2222-4222-8222-222222222222'
const state = vi.hoisted(() => ({ user: 'OWNER', admin: false }))
const listed = vi.hoisted(() => ({ calls: [] as any[] }))
const access = vi.hoisted(() => ({ read: true, change: true }))
vi.mock('../../../services/file-access.js', () => ({
  mayReadFile: vi.fn(async (_f: unknown, req: { isAdmin?: boolean }) => req.isAdmin || access.read),
  mayChangeFile: vi.fn(async (_f: unknown, req: { isAdmin?: boolean }) =>
    req.isAdmin || access.change ? { ok: true } : { ok: false, message: 'No', code: 'EDIT_LOCKED' }
  ),
  readableFileIdList: vi.fn(async (ids: string[]) =>
    access.read ? new Set(ids.map((i) => i.toLowerCase())) : new Set()
  )
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: state.user, role: 'R' }
    req.isAdmin = state.admin
  },
  requireAdmin: async () => {}
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/file-usage.js', () => ({
  findOrphanFiles: vi.fn(),
  forgetUnusedFiles: vi.fn(),
  getFileUsage: vi.fn(async () => []),
  getFileRefColumns: vi.fn(async () => [])
}))
vi.mock('../../../services/file-integrity.js', () => ({ verifyFiles: vi.fn(async () => []) }))
vi.mock('../../../services/help-video-files.js', async (orig) => {
  const real = await orig<typeof import('../../../services/help-video-files.js')>()
  return {
    isUuid: real.isUuid,
    isHelpVideoFile: vi.fn(async () => false),
    helpVideoFileIds: vi.fn(async () => new Set())
  }
})
vi.mock('../../../services/files.js', () => ({
  assertUploadContent: vi.fn(),
  cleanDownloadName: (s: string) => s,
  createPresignedFile: vi.fn(),
  deleteFile: vi.fn(),
  getFile: vi.fn(async (id: string) => ({
    id: id.toUpperCase(),
    filename_disk: `${id}.pdf`,
    filename_download: 'a.pdf',
    type: 'application/pdf',
    uploaded_by: 'OWNER',
    tags: id === PRIV ? JSON.stringify(['__private']) : null
  })),
  listFiles: vi.fn(async (opts: unknown) => {
    listed.calls.push(opts)
    return { data: [], total: 0 }
  }),
  readFileBuffer: vi.fn(async () => Buffer.from('pdf')),
  replaceFileContent: vi.fn(),
  reportFileBandwidth: vi.fn(async () => undefined),
  updateFileMeta: vi.fn(async (id: string) => ({ id })),
  uploadFile: vi.fn()
}))
vi.mock('../../../services/stored-object-stream.js', () => ({
  sendStoredObject: vi.fn(async (reply: { code(n: number): { send(b: string): unknown } }) =>
    reply.code(200).send('bytes')
  )
}))
vi.mock('../../../services/storage/index.js', () => ({
  getStorage: () => ({ get: vi.fn(), put: vi.fn(), getUrl: vi.fn() })
}))
vi.mock('../../../db/index.js', () => {
  const chain: any = {
    whereIn: () => chain,
    select: async () => [{ id: PUBLIC.toUpperCase(), uploaded_by: 'OWNER', tags: null }]
  }
  return { db: Object.assign(() => chain, { raw: () => '' }) }
})

import { filesRoutes } from '../../../routes/files.js'

async function app() {
  const a = Fastify()
  await a.register(import('@fastify/multipart'))
  await a.register(filesRoutes, { prefix: '/api/files' })
  return a
}

beforeEach(() => {
  state.user = 'SOMEONE-ELSE'
  state.admin = false
  access.read = true
  access.change = true
  listed.calls.length = 0
})

describe('record attachments follow the record', () => {
  it('a caller who cannot read the record gets 404 on GET, meta, PATCH and DELETE', async () => {
    access.read = false
    const a = await app()
    expect((await a.inject({ url: `/api/files/${PUBLIC}` })).statusCode).toBe(404)
    expect((await a.inject({ url: `/api/files/${PUBLIC}/meta` })).statusCode).toBe(404)
    expect(
      (await a.inject({ method: 'PATCH', url: `/api/files/${PUBLIC}`, payload: { title: 'x' } }))
        .statusCode
    ).toBe(404)
    expect((await a.inject({ method: 'DELETE', url: `/api/files/${PUBLIC}` })).statusCode).toBe(404)
  })

  it('a reader who may not change the record gets 403 on PATCH and DELETE', async () => {
    access.change = false
    const a = await app()
    expect((await a.inject({ url: `/api/files/${PUBLIC}` })).statusCode).toBe(200)
    const patch = await a.inject({
      method: 'PATCH',
      url: `/api/files/${PUBLIC}`,
      payload: { title: 'x' }
    })
    expect(patch.statusCode).toBe(403)
    expect(patch.json().code).toBe('EDIT_LOCKED')
    expect((await a.inject({ method: 'DELETE', url: `/api/files/${PUBLIC}` })).statusCode).toBe(403)
  })

  it('someone who may change it renames and deletes it', async () => {
    const a = await app()
    expect(
      (await a.inject({ method: 'PATCH', url: `/api/files/${PUBLIC}`, payload: { title: 'x' } }))
        .statusCode
    ).toBe(200)
    expect((await a.inject({ method: 'DELETE', url: `/api/files/${PUBLIC}` })).statusCode).toBe(204)
  })

  it('a non-admin library listing asks for their own uploads; an admin listing does not', async () => {
    const a = await app()
    await a.inject({ url: '/api/files' })
    expect(listed.calls[0].uploadedBy).toBe('SOMEONE-ELSE')
    state.admin = true
    await a.inject({ url: '/api/files' })
    expect(listed.calls[1].uploadedBy).toBeUndefined()
  })

  it('an id lookup answers nothing for files the caller cannot read', async () => {
    access.read = false
    const res = await (await app()).inject({
      url: `/api/files?filter=${encodeURIComponent(JSON.stringify({ id: { _in: [PUBLIC] } }))}`
    })
    expect(res.json()).toEqual({ data: [], total: 0 })
    expect(listed.calls).toHaveLength(0)
  })
})
