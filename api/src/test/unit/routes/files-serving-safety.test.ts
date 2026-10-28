import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// H1 (security audit 2026-10-27): an uploaded HTML/SVG/XML file must never be
// rendered as a document on the app origin. Only inline-safe types (raster
// images, PDF, audio, video, plain text) are served inline; every stored-file
// response carries nosniff + a sandboxing CSP; inline text is text/plain.
// The real sendStoredObject runs here (remote-driver path) so the headers
// are the ones a browser would get.

const ID = {
  html: '11111111-1111-4111-8111-111111111111',
  svg: '22222222-2222-4222-8222-222222222222',
  png: '33333333-3333-4333-8333-333333333333',
  pdf: '44444444-4444-4444-8444-444444444444',
  txt: '55555555-5555-4555-8555-555555555555',
  csv: '66666666-6666-4666-8666-666666666666',
  untyped: '77777777-7777-4777-8777-777777777777',
  xml: '88888888-8888-4888-8888-888888888888',
  mp4: '99999999-9999-4999-8999-999999999999',
  docx: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  lying: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}
const ROWS: Record<string, { type: string | null; name: string; disk: string }> = {
  [ID.html]: { type: 'text/html', name: 'x.html', disk: 'd-html.html' },
  [ID.svg]: { type: 'image/svg+xml', name: 'logo.svg', disk: 'd-svg.svg' },
  [ID.png]: { type: 'image/png', name: 'a.png', disk: 'd-png.png' },
  [ID.pdf]: { type: 'application/pdf', name: 'a.pdf', disk: 'd-pdf.pdf' },
  [ID.txt]: { type: 'text/plain', name: 'notes.txt', disk: 'd-txt.txt' },
  [ID.csv]: { type: 'text/csv', name: 'rows.csv', disk: 'd-csv.csv' },
  [ID.untyped]: { type: null, name: 'page.htm', disk: 'd-untyped' },
  [ID.xml]: { type: 'application/xhtml+xml', name: 'a.xhtml', disk: 'd-xml.xhtml' },
  [ID.mp4]: { type: 'video/mp4', name: 'clip.mp4', disk: 'd-mp4.mp4' },
  [ID.docx]: {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    name: 'a.docx',
    disk: 'd-docx.docx'
  },
  // An uploader's browser can claim any type: an HTML page labelled text/plain.
  [ID.lying]: { type: 'text/plain', name: 'evil.html', disk: 'd-lying.html' }
}

vi.mock('../../../services/file-access.js', () => ({
  mayReadFile: async () => true,
  mayChangeFile: async () => ({ ok: true }),
  readableFileIdList: async (ids: string[]) => new Set(ids.map((i) => i.toLowerCase())),
  chatComplianceRead: async () => false
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: 'R' }
    req.isAdmin = true
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
  getFile: vi.fn(async (id: string) => {
    const row = ROWS[id.toLowerCase()]
    return row
      ? { id, filename_disk: row.disk, filename_download: row.name, type: row.type }
      : undefined
  }),
  listFiles: vi.fn(async () => ({ data: [], total: 0 })),
  readFileBuffer: vi.fn(async () => Buffer.from('x')),
  replaceFileContent: vi.fn(),
  reportFileBandwidth: vi.fn(async () => undefined),
  updateFileMeta: vi.fn(),
  uploadFile: vi.fn()
}))
vi.mock('../../../services/storage/index.js', () => ({
  getStorage: () => ({
    get: vi.fn(async () => Buffer.from('<script>alert(1)</script>')),
    put: vi.fn(),
    getUrl: vi.fn()
  })
}))
vi.mock('../../../services/storage/local.js', () => ({ LocalStorage: class {} }))
vi.mock('../../../services/chaos/faults/storage.js', () => ({ storageChaos: () => null }))
vi.mock('../../../services/storage-drivers.js', () => ({
  getActiveStorageDriver: async () => ({ name: 's3' }),
  readStoredObject: async () => Buffer.from('0123456789'),
  bustStorageDriverCache: vi.fn(),
  normalizeDriverName: (s: string) => s,
  readStorageSettings: vi.fn(),
  testStorageDriver: vi.fn()
}))
vi.mock('../../../db/index.js', () => {
  const db = () => {
    let disk = ''
    const chain: Record<string, unknown> = {}
    chain.where = (_c: unknown, v: unknown) => {
      disk = String(v)
      return chain
    }
    chain.first = async () => {
      const id = Object.keys(ROWS).find((k) => ROWS[k].disk === disk)
      return id ? { id } : undefined
    }
    return chain
  }
  return { db: Object.assign(db, { raw: () => '' }) }
})

import { filesRoutes } from '../../../routes/files.js'

async function get(url: string, headers: Record<string, string> = {}) {
  const a = Fastify()
  await a.register(import('@fastify/multipart'))
  await a.register(filesRoutes, { prefix: '/api/files' })
  return a.inject({ method: 'GET', url, headers })
}

function expectHardened(res: { headers: Record<string, unknown> }) {
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  // PDFs drop `sandbox` (Firefox/Safari viewers blank under it, review A14) but load nothing.
  expect(res.headers['content-security-policy']).toBe(
    res.headers['content-type'] === 'application/pdf'
      ? "default-src 'none'; object-src 'none'"
      : "sandbox; default-src 'none'"
  )
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/files/:id serves only inline-safe types inline', () => {
  for (const [label, id] of [
    ['HTML', ID.html],
    ['SVG', ID.svg],
    ['XHTML', ID.xml],
    ['an untyped .htm', ID.untyped],
    ['an Office file', ID.docx]
  ] as const) {
    it(`${label} is an attachment`, async () => {
      const res = await get(`/api/files/${id}`)
      expect(res.statusCode).toBe(200)
      expect(String(res.headers['content-disposition'])).toMatch(/^attachment;/)
      expectHardened(res)
    })
  }

  it('an untyped file falls back to its name, and HTML stays HTML-typed for the download', async () => {
    const res = await get(`/api/files/${ID.untyped}`)
    expect(res.headers['content-type']).toBe('text/html')
  })

  for (const [label, id, type] of [
    ['PNG', ID.png, 'image/png'],
    ['PDF', ID.pdf, 'application/pdf'],
    ['MP4', ID.mp4, 'video/mp4']
  ] as const) {
    it(`${label} previews inline with its own type`, async () => {
      const res = await get(`/api/files/${id}`)
      expect(String(res.headers['content-disposition'])).toMatch(/^inline;/)
      expect(res.headers['content-type']).toBe(type)
      expectHardened(res)
    })
  }

  it('plain text and CSV preview inline as text/plain; charset=utf-8', async () => {
    for (const id of [ID.txt, ID.csv, ID.lying]) {
      const res = await get(`/api/files/${id}`)
      expect(String(res.headers['content-disposition'])).toMatch(/^inline;/)
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
      expectHardened(res)
    }
  })

  it('?download=1 is an attachment for a safe type too', async () => {
    const res = await get(`/api/files/${ID.png}?download=1`)
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment;/)
    expectHardened(res)
  })

  it('range requests still work, hardened', async () => {
    const res = await get(`/api/files/${ID.mp4}`, { range: 'bytes=2-4' })
    expect(res.statusCode).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 2-4/10')
    expect(res.body).toBe('234')
    expectHardened(res)
  })
})

describe('GET /api/files/raw/* applies the same rule', () => {
  it('an HTML object downloads, hardened', async () => {
    const res = await get('/api/files/raw/d-html.html')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment')
    expectHardened(res)
  })

  it('an SVG object downloads', async () => {
    const res = await get('/api/files/raw/d-svg.svg')
    expect(res.headers['content-disposition']).toBe('attachment')
    expectHardened(res)
  })

  it('a PNG object stays inline', async () => {
    const res = await get('/api/files/raw/d-png.png')
    expect(res.headers['content-disposition']).toBe('inline')
    expect(res.headers['content-type']).toBe('image/png')
    expectHardened(res)
  })

  it('a text object is re-labelled text/plain', async () => {
    const res = await get('/api/files/raw/d-txt.txt')
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
  })
})
