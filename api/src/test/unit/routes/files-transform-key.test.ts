import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The transform cache key comes from the RESOLVED row's id, never the
// caller's string. SQL Server truncates '<O>/../<P>' to O, so a request for
// '<O>%2F..%2F<P>' passed the servable check on O while the key walked into
// P's transform directory.

const O = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const P = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const st = vi.hoisted(() => ({ gets: [] as string[], puts: [] as string[] }))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R' }
  },
  requireAdmin: async () => {}
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/file-usage.js', () => ({
  findOrphanFiles: vi.fn(),
  getFileUsage: vi.fn()
}))
vi.mock('../../../services/files.js', () => ({
  cleanDownloadName: (s: string) => s,
  createPresignedFile: vi.fn(),
  deleteFile: vi.fn(),
  // SQL Server comparing a string to a uniqueidentifier: the first 36 chars win.
  getFile: vi.fn(async (raw: string) => {
    const id = raw.slice(0, 36).toLowerCase()
    return id === O ? { id: O.toUpperCase(), filename_disk: 'o.png', type: 'image/png' } : undefined
  }),
  listFiles: vi.fn(),
  readFileBuffer: vi.fn(async () => Buffer.from('png')),
  replaceFileContent: vi.fn(),
  reportFileBandwidth: vi.fn(),
  updateFileMeta: vi.fn(),
  uploadFile: vi.fn()
}))
vi.mock('../../../services/help-video-files.js', () => ({
  isUuid: (s: string) => /^[0-9a-f-]{36}$/i.test(s),
  isHelpVideoFile: vi.fn(async () => false),
  helpVideoFileIds: vi.fn(async () => new Set())
}))
vi.mock('../../../services/storage/index.js', () => ({
  getStorage: () => ({
    get: vi.fn(async (k: string) => {
      st.gets.push(k)
      throw new Error('miss')
    }),
    put: vi.fn(async (k: string) => {
      st.puts.push(k)
    })
  })
}))
vi.mock('../../../services/storage-drivers.js', () => ({
  bustStorageDriverCache: vi.fn(),
  normalizeDriverName: vi.fn(),
  readStorageSettings: vi.fn(),
  testStorageDriver: vi.fn()
}))
vi.mock('../../../services/stored-object-stream.js', () => ({ sendStoredObject: vi.fn() }))
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
vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => '' }) }))

import { filesRoutes } from '../../../routes/files.js'

async function transform(idSegment: string) {
  const a = Fastify()
  await a.register(import('@fastify/multipart'))
  await a.register(filesRoutes, { prefix: '/api/files' })
  return a.inject({ method: 'GET', url: `/api/files/${idSegment}/transform?w=10` })
}

beforeEach(() => {
  st.gets = []
  st.puts = []
})

describe('transform cache key', () => {
  it('stays inside transforms/<resolved id, lower case>/ for a traversal-style id', async () => {
    const res = await transform(`${O}%2F..%2F${P}`)
    expect(res.statusCode).toBe(200)
    const keys = [...st.gets, ...st.puts]
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) {
      expect(k.startsWith(`transforms/${O}/`)).toBe(true)
      expect(k).not.toContain('..')
      expect(k).not.toContain(P)
      expect(k.slice(`transforms/${O}/`.length)).toMatch(/^[0-9a-f]{16}\.webp$/)
    }
  })

  it('lower-cases the row id (the database returns it upper case)', async () => {
    await transform(O.toUpperCase())
    for (const k of [...st.gets, ...st.puts]) expect(k.startsWith(`transforms/${O}/`)).toBe(true)
    expect(st.puts.length).toBe(1)
  })
})
