import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1: help-video recordings, renders, captions and posters are nivaro_files
// rows, but /api/files must never serve, change or delete them — not to a
// viewer, not to an admin. They answer the same 404 as an unknown file.

const SOURCE = '11111111-1111-4111-8111-111111111111'
const RENDER = '22222222-2222-4222-8222-222222222222'
const POSTER = '33333333-3333-4333-8333-333333333333'
const PLAIN = '44444444-4444-4444-8444-444444444444'
const UNKNOWN = '55555555-5555-4555-8555-555555555555'
const HIDDEN = new Set([SOURCE, RENDER, POSTER])

const state = vi.hoisted(() => ({ admin: false }))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: state.admin ? 'ADMIN-ROLE' : 'VIEWER-ROLE' }
    req.isAdmin = state.admin
  },
  requireAdmin: async () => {}
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/file-usage.js', () => ({
  findOrphanFiles: vi.fn(async () => ({ data: [], total: 0 })),
  getFileUsage: vi.fn(async () => [{ collection: 'x', count: 1 }]),
  getFileRefColumns: vi.fn(async () => [{ table: 'refs', column: 'file' }])
}))
vi.mock('../../../services/file-integrity.js', () => ({
  verifyFiles: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, missing: false })))
}))
const files = vi.hoisted(() => ({
  deleteFile: vi.fn(async () => undefined),
  updateFileMeta: vi.fn(async (id: string) => ({ id })),
  replaceFileContent: vi.fn(async (id: string) => ({ id }))
}))
vi.mock('../../../services/files.js', () => ({
  cleanDownloadName: (s: string) => s,
  createPresignedFile: vi.fn(),
  deleteFile: files.deleteFile,
  // Like SQL Server comparing a string to a uniqueidentifier: braces are
  // accepted, case is ignored and anything past 36 characters is dropped, so
  // '<uuid>xyz', '{<uuid>}' and '<uuid> ' all find the row '<uuid>'.
  getFile: vi.fn(async (raw: string) => {
    const id = raw.replace(/^\{/, '').slice(0, 36).toLowerCase()
    return id === UNKNOWN
      ? undefined
      : {
          id: id.toUpperCase(),
          filename_disk: `${id}.png`,
          filename_download: 'a.png',
          type: 'image/png'
        }
  }),
  listFiles: vi.fn(async () => ({ data: [], total: 0 })),
  readFileBuffer: vi.fn(async () => Buffer.from('png')),
  replaceFileContent: files.replaceFileContent,
  reportFileBandwidth: vi.fn(async () => undefined),
  updateFileMeta: files.updateFileMeta,
  uploadFile: vi.fn()
}))
const guard = vi.hoisted(() => ({ fail: false }))
vi.mock('../../../services/help-video-files.js', async (orig) => {
  const real = await orig<typeof import('../../../services/help-video-files.js')>()
  return {
    isUuid: real.isUuid,
    isHelpVideoFile: vi.fn(async (id: string) => {
      if (guard.fail) throw new Error('db down')
      return !real.isUuid(id) || HIDDEN.has(String(id).toLowerCase())
    }),
    helpVideoFileIds: vi.fn(async (ids: string[]) => {
      if (guard.fail) throw new Error('db down')
      return new Set(ids.filter((i) => HIDDEN.has(i.toLowerCase())).map((i) => i.toUpperCase()))
    })
  }
})
// Every object below exists in storage, rows or not: the route must decide.
const store = vi.hoisted(() => ({ reads: [] as string[] }))
vi.mock('../../../services/storage/index.js', () => ({
  getStorage: () => ({
    get: vi.fn(async (k: string) => {
      store.reads.push(k)
      return Buffer.from('bytes')
    }),
    put: vi.fn(async () => undefined),
    getUrl: vi.fn(async (k: string) => `/api/files/raw/${k}`)
  })
}))
vi.mock('../../../services/stored-object-stream.js', () => ({
  sendStoredObject: vi.fn(async (reply: { code(n: number): { send(b: string): unknown } }) =>
    reply.code(200).send('bytes')
  )
}))
vi.mock('sharp', () => ({
  default: () => {
    const p = {
      resize: () => p,
      webp: () => p,
      jpeg: () => p,
      png: () => p,
      toBuffer: async () => Buffer.from('img')
    }
    return p
  }
}))
vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    let disk: string | null = null
    const chain: Record<string, unknown> = {}
    for (const m of ['whereIn', 'select', 'groupBy', 'update', 'count']) chain[m] = () => chain
    chain.where = (col: unknown, val?: unknown) => {
      if (col === 'filename_disk') disk = String(val)
      return chain
    }
    // nivaro_files by filename_disk, compared like SQL Server (case-insensitive)
    chain.first = async () => {
      if (table !== 'nivaro_files' || disk === null) return undefined
      const id = [SOURCE, RENDER, POSTER, PLAIN].find(
        (x) => `${x}.png` === (disk as string).toLowerCase()
      )
      return id ? { id: id.toUpperCase() } : undefined
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    chain.then = (res: (v: unknown) => unknown) =>
      Promise.resolve([SOURCE, PLAIN].map((id) => ({ file: id.toUpperCase(), n: 2 }))).then(res)
    return chain
  }
  return { db: Object.assign(db, { raw: () => '' }) }
})

import { filesRoutes } from '../../../routes/files.js'

async function app() {
  const a = Fastify()
  await a.register(import('@fastify/multipart'))
  await a.register(filesRoutes, { prefix: '/api/files' })
  return a
}

const BOUNDARY = 'hvboundary'
const multipart =
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
  `Content-Type: image/png\r\n\r\npng\r\n--${BOUNDARY}--\r\n`

async function hit(method: string, url: string) {
  const a = await app()
  if (method === 'REPLACE') {
    return a.inject({
      method: 'POST',
      url,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart
    })
  }
  return a.inject({
    method: method as 'GET',
    url,
    ...(method === 'PATCH' ? { payload: { title: 'x' } } : {})
  })
}

const ROUTES: Array<[string, (id: string) => string]> = [
  ['GET', (id) => `/api/files/${id}`],
  ['GET', (id) => `/api/files/${id}/meta`],
  ['GET', (id) => `/api/files/${id}/usage`],
  ['GET', (id) => `/api/files/${id}/transform?w=10`],
  ['PATCH', (id) => `/api/files/${id}`],
  ['DELETE', (id) => `/api/files/${id}`]
]

beforeEach(() => {
  vi.clearAllMocks()
  state.admin = false
  guard.fail = false
  store.reads = []
})

const T = (id: string) => `transforms/${id}/0123456789abcdef.webp`

describe('/api/files hides help-video files', () => {
  for (const who of ['viewer', 'admin'] as const) {
    for (const [label, id] of [
      ['source', SOURCE],
      ['render', RENDER],
      ['poster', POSTER]
    ] as const) {
      for (const [method, url] of ROUTES) {
        it(`${who}: ${method} ${url(':id')} answers 404 for a ${label}`, async () => {
          state.admin = who === 'admin'
          const unknown = await hit(method, url(UNKNOWN))
          const res = await hit(method, url(id))
          expect(res.statusCode).toBe(404)
          // byte-for-byte the answer an unknown file gets
          expect(res.statusCode).toBe(unknown.statusCode)
          expect(res.json()).toEqual(unknown.json())
        })
      }
      it(`${who}: POST /:id/replace answers 404 for a ${label}`, async () => {
        state.admin = who === 'admin'
        const res = await hit('REPLACE', `/api/files/${id}/replace`)
        expect(res.statusCode).toBe(404)
        expect(res.json()).toEqual({ error: 'Not found' })
        expect(files.replaceFileContent).not.toHaveBeenCalled()
      })
      it(`${who}: GET /raw/<key> answers 404 for a ${label} object and its transforms`, async () => {
        state.admin = who === 'admin'
        expect((await hit('GET', `/api/files/raw/${id}.png`)).statusCode).toBe(404)
        expect((await hit('GET', `/api/files/raw/${id.toUpperCase()}.PNG`)).statusCode).toBe(404)
        expect((await hit('GET', `/api/files/raw/${T(id)}`)).statusCode).toBe(404)
        expect((await hit('GET', `/api/files/raw/${T(id.toUpperCase())}`)).statusCode).toBe(404)
        expect(store.reads).toEqual([])
      })
    }
  }

  it('never deletes, patches or replaces a help-video file', async () => {
    state.admin = true
    await hit('DELETE', `/api/files/${RENDER}`)
    await hit('PATCH', `/api/files/${POSTER}`)
    await hit('REPLACE', `/api/files/${RENDER}/replace`)
    expect(files.deleteFile).not.toHaveBeenCalled()
    expect(files.updateFileMeta).not.toHaveBeenCalled()
    expect(files.replaceFileContent).not.toHaveBeenCalled()
  })

  it('verify and usage counts treat a help-video file as unknown', async () => {
    const a = await app()
    const v = await a.inject({
      method: 'POST',
      url: '/api/files/verify',
      payload: { ids: [SOURCE, PLAIN] }
    })
    expect(Object.keys(v.json().data)).toEqual([PLAIN])
    const c = await a.inject({
      method: 'POST',
      url: '/api/files/usage/counts',
      payload: { ids: [SOURCE, PLAIN] }
    })
    expect(c.json().data[SOURCE]).toBe(0)
    expect(c.json().data[PLAIN.toUpperCase()]).toBe(2)
  })

  it('ordinary files are unaffected', async () => {
    for (const admin of [false, true]) {
      state.admin = admin
      expect((await hit('GET', `/api/files/${PLAIN}`)).statusCode).toBe(200)
      expect((await hit('GET', `/api/files/${PLAIN}/meta`)).statusCode).toBe(200)
      expect((await hit('GET', `/api/files/${PLAIN}/usage`)).statusCode).toBe(200)
      expect((await hit('GET', `/api/files/${PLAIN}/transform?w=10`)).statusCode).toBe(200)
      expect((await hit('PATCH', `/api/files/${PLAIN}`)).statusCode).toBe(200)
      expect((await hit('REPLACE', `/api/files/${PLAIN}/replace`)).statusCode).toBe(200)
      expect((await hit('GET', `/api/files/raw/${PLAIN}.png`)).statusCode).toBe(200)
      expect((await hit('GET', `/api/files/raw/${T(PLAIN)}`)).statusCode).toBe(200)
      expect((await hit('DELETE', `/api/files/${PLAIN}`)).statusCode).toBe(204)
    }
    expect(files.deleteFile).toHaveBeenCalledWith(PLAIN.toUpperCase())
  })

  // The guard checks the RESOLVED row's id, never the caller's string: SQL
  // Server would match each of these spellings to the help-video file.
  const SPELLINGS: Array<[string, (id: string) => string]> = [
    ['<uuid>xyz', (id) => `${id}xyz`],
    ['{<uuid>}', (id) => encodeURIComponent(`{${id}}`)],
    ['upper case', (id) => id.toUpperCase()],
    ['trailing %20', (id) => `${id}%20`],
    ['trailing space', (id) => `${id} `]
  ]
  for (const [label, spell] of SPELLINGS) {
    for (const who of ['viewer', 'admin'] as const) {
      it(`${who}: a help-video id spelled ${label} still answers 404 everywhere`, async () => {
        state.admin = who === 'admin'
        for (const [method, url] of ROUTES) {
          const res = await hit(method, url(spell(SOURCE)))
          expect(res.statusCode, `${method} ${url(spell(SOURCE))}`).toBe(404)
        }
        const rep = await hit('REPLACE', `/api/files/${spell(RENDER)}/replace`)
        expect(rep.statusCode).toBe(404)
        expect(files.deleteFile).not.toHaveBeenCalled()
        expect(files.updateFileMeta).not.toHaveBeenCalled()
        expect(files.replaceFileContent).not.toHaveBeenCalled()
      })
    }
  }

  it('raw: a non-canonical key that would reach the same object answers 404', async () => {
    for (const key of [
      `.%2F${PLAIN}.png`,
      `a//${PLAIN}.png`,
      `${PLAIN}.png/`,
      `/${PLAIN}.png`,
      `a%5C${PLAIN}.png`,
      `${PLAIN}.png%20`
    ]) {
      expect((await hit('GET', `/api/files/raw/${key}`)).statusCode, key).toBe(404)
    }
    expect(store.reads).toEqual([])
  })

  it('raw is an allow-list: a key with no servable row is never read from storage', async () => {
    for (const key of [
      'orphan.png',
      'storage-probe/x.txt',
      `transforms/${PLAIN}/not-a-hash.webp`,
      `transforms/${PLAIN}/0123456789abcdef.gif`,
      `tenant/transforms/${PLAIN}/0123456789abcdef.webp`
    ]) {
      expect((await hit('GET', `/api/files/raw/${key}`)).statusCode, key).toBe(404)
    }
    expect(store.reads).toEqual([])
  })

  it("raw reads the matched row's stored key, never the caller's spelling", async () => {
    const res = await hit('GET', `/api/files/raw/${PLAIN.toUpperCase()}.PNG`)
    expect(res.statusCode).toBe(200)
    expect(store.reads).toEqual([`${PLAIN}.png`])
  })

  it('fails closed: when the help-video lookup errors nothing is served', async () => {
    guard.fail = true
    const { sendStoredObject } = await import('../../../services/stored-object-stream.js')
    for (const [method, url] of [
      ['GET', `/api/files/${PLAIN}`],
      ['GET', `/api/files/${PLAIN}/meta`],
      ['GET', `/api/files/${PLAIN}/transform?w=10`],
      ['GET', `/api/files/raw/${PLAIN}.png`],
      ['GET', `/api/files/raw/${T(PLAIN)}`],
      ['PATCH', `/api/files/${PLAIN}`],
      ['DELETE', `/api/files/${PLAIN}`]
    ] as const) {
      expect((await hit(method, url)).statusCode, `${method} ${url}`).toBe(500)
    }
    expect((await hit('REPLACE', `/api/files/${PLAIN}/replace`)).statusCode).toBe(500)
    const a = await app()
    for (const url of ['/api/files/verify', '/api/files/usage/counts']) {
      const r = await a.inject({ method: 'POST', url, payload: { ids: [PLAIN] } })
      expect(r.statusCode, url).toBe(500)
    }
    expect(sendStoredObject).not.toHaveBeenCalled()
    expect(store.reads).toEqual([])
    expect(files.deleteFile).not.toHaveBeenCalled()
    expect(files.updateFileMeta).not.toHaveBeenCalled()
    expect(files.replaceFileContent).not.toHaveBeenCalled()
  })

  it('verify and usage counts ignore ids that are not exact uuids', async () => {
    const a = await app()
    const v = await a.inject({
      method: 'POST',
      url: '/api/files/verify',
      payload: { ids: [`${SOURCE}xyz`, `{${SOURCE}}`] }
    })
    expect(v.json().data).toEqual({})
    const { verifyFiles } = await import('../../../services/file-integrity.js')
    expect(verifyFiles).toHaveBeenCalledWith([])
    const c = await a.inject({
      method: 'POST',
      url: '/api/files/usage/counts',
      payload: { ids: [`${SOURCE}xyz`] }
    })
    expect(c.json().data).toEqual({ [`${SOURCE}xyz`]: 0 })
  })
})
