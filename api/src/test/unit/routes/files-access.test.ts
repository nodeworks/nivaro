import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Record attachments follow their records (army 2026-10-25): a file the caller cannot
// read answers 404, one they may read but not change answers 403 on PATCH / replace /
// DELETE, and a non-admin library listing shows only their own uploads.

const PRIV = '11111111-1111-4111-8111-111111111111'
const PUBLIC = '22222222-2222-4222-8222-222222222222'
const state = vi.hoisted(() => ({ user: 'OWNER', admin: false }))
const listed = vi.hoisted(() => ({ calls: [] as any[] }))
const access = vi.hoisted(() => ({
  read: true,
  change: true,
  // A DM / private-channel file the admin is not in: the normal rule refuses admins too.
  closed: false,
  compliance: [] as string[],
  // Use the real chatComplianceRead against the chat tables below.
  real: false,
  chat: {
    message: undefined as Record<string, unknown> | undefined,
    versions: [] as Array<Record<string, unknown>>
  }
}))
vi.mock('../../../services/file-access.js', async (orig) => ({
  mayReadFile: vi.fn(
    async (_f: unknown, req: { isAdmin?: boolean }) =>
      !access.closed && (req.isAdmin || access.read)
  ),
  chatComplianceRead: vi.fn(async (f: never, message: unknown, req: never) =>
    access.real
      ? (await orig<typeof import('../../../services/file-access.js')>()).chatComplianceRead(
          f,
          message,
          req
        )
      : access.compliance.includes(String(message))
  ),
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
  const chain = (t: string) => {
    const c: any = {
      whereIn: () => c,
      where: () => c,
      first: async () => (t === 'chat_messages' ? access.chat.message : undefined),
      select: async () =>
        t === 'nivaro_chat_message_history'
          ? access.chat.versions
          : [{ id: PUBLIC.toUpperCase(), uploaded_by: 'OWNER', tags: null }]
    }
    return c
  }
  return { db: Object.assign((t: string) => chain(t), { raw: () => '' }) }
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
  access.closed = false
  access.compliance = []
  access.real = false
  access.chat = { message: undefined, versions: [] }
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

describe('chat compliance reads (?chat_message=)', () => {
  it('an admin outside a DM gets 404 without the param or with a message that does not carry the file', async () => {
    state.admin = true
    access.closed = true
    access.compliance = ['41']
    const a = await app()
    expect((await a.inject({ url: `/api/files/${PUBLIC}?download=1` })).statusCode).toBe(404)
    expect(
      (await a.inject({ url: `/api/files/${PUBLIC}?download=1&chat_message=99` })).statusCode
    ).toBe(404)
  })

  it('an admin with the message that carries the file reads it (the helper logs it)', async () => {
    state.admin = true
    access.closed = true
    access.compliance = ['41']
    const a = await app()
    const { chatComplianceRead } = await import('../../../services/file-access.js')
    const r = await a.inject({ url: `/api/files/${PUBLIC}?download=1&chat_message=41` })
    expect(r.statusCode).toBe(200)
    expect(vi.mocked(chatComplianceRead)).toHaveBeenCalled()
  })

  it('a non-admin never takes the compliance path', async () => {
    state.admin = false
    access.closed = true
    access.compliance = ['41']
    const { chatComplianceRead } = await import('../../../services/file-access.js')
    vi.mocked(chatComplianceRead).mockClear()
    const a = await app()
    const r = await a.inject({ url: `/api/files/${PUBLIC}?download=1&chat_message=41` })
    expect(r.statusCode).toBe(404)
    expect(vi.mocked(chatComplianceRead)).not.toHaveBeenCalled()
  })
})

describe('chat compliance reads of a preserved version (real check)', () => {
  it('an admin follows a VERSION attachment via the parent message id; logged; a wrong id is 404', async () => {
    state.admin = true
    access.closed = true
    access.real = true
    // The file left the message in an edit; version 1 still carries it.
    access.chat = {
      message: { room: 'dm:A:B', attachments: '[]' },
      versions: [{ attachments: JSON.stringify([PUBLIC.toUpperCase()]) }]
    }
    const { logActivity } = await import('../../../services/activity.js')
    vi.mocked(logActivity).mockClear()
    const a = await app()
    const ok = await a.inject({ url: `/api/files/${PUBLIC}?download=1&chat_message=41` })
    expect(ok.statusCode).toBe(200)
    expect(vi.mocked(logActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'chat-admin-read',
        collection: 'chat_messages',
        item: '41',
        comment: expect.stringContaining(PUBLIC.toUpperCase())
      })
    )
    access.chat = { message: { room: 'dm:A:B', attachments: '[]' }, versions: [] }
    const no = await a.inject({ url: `/api/files/${PUBLIC}?download=1&chat_message=41` })
    expect(no.statusCode).toBe(404)
  })
})
