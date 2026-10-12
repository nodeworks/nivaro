import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A render or export made from records is private to its maker (tag `__private`): another
// signed-in user can neither list it nor GET / PATCH / download it; the maker and admins can.

const PRIV = '11111111-1111-4111-8111-111111111111'
const PUBLIC = '22222222-2222-4222-8222-222222222222'
const state = vi.hoisted(() => ({ user: 'OWNER', admin: false }))
const listed = vi.hoisted(() => ({ calls: [] as any[] }))

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
vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => '' }) }))

import { filesRoutes } from '../../../routes/files.js'
import { PRIVATE_TAG, viewerMaySeeFile } from '../../../services/private-files.js'

async function app() {
  const a = Fastify()
  await a.register(import('@fastify/multipart'))
  await a.register(filesRoutes, { prefix: '/api/files' })
  return a
}

beforeEach(() => {
  state.user = 'OWNER'
  state.admin = false
  listed.calls.length = 0
})

describe('private renders and exports', () => {
  it('the maker can download it', async () => {
    const res = await (await app()).inject({ url: `/api/files/${PRIV}?download=1` })
    expect(res.statusCode).toBe(200)
  })

  it('another user gets the same 404 as an unknown file on GET, meta and PATCH', async () => {
    state.user = 'SOMEONE-ELSE'
    const a = await app()
    for (const [method, url] of [
      ['GET', `/api/files/${PRIV}`],
      ['GET', `/api/files/${PRIV}?download=1`],
      ['GET', `/api/files/${PRIV}/meta`]
    ] as const) {
      expect((await a.inject({ method, url })).statusCode).toBe(404)
    }
    const patch = await a.inject({
      method: 'PATCH',
      url: `/api/files/${PRIV}`,
      payload: { title: 'x' }
    })
    expect(patch.statusCode).toBe(404)
  })

  it('another user still gets ordinary files', async () => {
    state.user = 'SOMEONE-ELSE'
    expect((await (await app()).inject({ url: `/api/files/${PUBLIC}` })).statusCode).toBe(200)
  })

  it('an administrator can open it', async () => {
    state.user = 'ADMIN'
    state.admin = true
    expect((await (await app()).inject({ url: `/api/files/${PRIV}` })).statusCode).toBe(200)
  })

  it('the list is asked for as the caller, so the query can drop private rows', async () => {
    state.user = 'SOMEONE-ELSE'
    await (await app()).inject({ url: '/api/files' })
    expect(listed.calls[0].viewer).toEqual({ id: 'SOMEONE-ELSE', isAdmin: false })
  })

  it('viewerMaySeeFile', () => {
    const f = { tags: JSON.stringify([PRIVATE_TAG]), uploaded_by: 'aa-bb' }
    expect(viewerMaySeeFile(f, { id: 'AA-BB' })).toBe(true)
    expect(viewerMaySeeFile(f, { id: 'other' })).toBe(false)
    expect(viewerMaySeeFile(f, undefined)).toBe(false)
    expect(viewerMaySeeFile(f, { id: 'x', isAdmin: true })).toBe(true)
    expect(viewerMaySeeFile({ tags: null, uploaded_by: 'a' }, { id: 'other' })).toBe(true)
  })
})
