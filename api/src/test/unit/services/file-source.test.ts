import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The file source over HTTP: a lower environment (staging, development) reads a stored object
// it has no copy of from the source API (production). The real client
// (services/storage/fallback-url.ts) runs against the real route
// (routes/internal-file-source.ts) on a loopback port; the route reads a temp folder through the
// real stored-object stream.

const TOKEN = 'file-source-secret-for-tests-0123456789abcdef'
const { root } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-file-source-')) }
})
const rows = vi.hoisted(() => ({
  files: [] as Array<{ id: string; filename_disk: string | null; type: string; filesize: number }>,
  helpVideo: new Set<string>()
}))

vi.mock('../../../config.js', () => ({ config: { STORAGE_LOCAL_ROOT: root } }))
vi.mock('../../../db/index.js', () => ({
  db: (_table: string) => ({
    where: (_col: string, id: string) => ({
      first: async () => rows.files.find((f) => f.id === id)
    })
  })
}))
vi.mock('../../../services/help-video-files.js', () => ({
  isUuid: (v: unknown) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  isHelpVideoFile: async (id: string) => rows.helpVideo.has(id)
}))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/storage-drivers.js', () => ({
  getActiveStorageDriver: async () => ({ name: 'local' }),
  readOwnStoredObject: async () => {
    throw new Error('ENOENT')
  }
}))

import {
  fileSourceRefusal,
  internalFileSourceRoutes
} from '../../../routes/internal-file-source.js'
import {
  fallbackUrlDeps,
  fallbackUrlHas,
  filesFallbackToken,
  filesFallbackUrl,
  judgeFallbackSource,
  openFallbackUrl,
  peekFallbackUrl,
  probeFallbackSource,
  readFallbackUrl,
  resetFallbackUrlState
} from '../../../services/storage/fallback-url.js'

const PDF_ID = '11111111-2222-4333-8444-555555555555'
const VIDEO_ID = '99999999-2222-4333-8444-555555555555'
const GONE_ID = '77777777-2222-4333-8444-555555555555'
const keyToId: Record<string, string> = {
  'ab/report.pdf': PDF_ID,
  'ab/recording.webm': VIDEO_ID,
  'ab/gone.pdf': GONE_ID
}

let app: FastifyInstance
let base = ''
const logLines: string[] = []
const warnings: unknown[][] = []
const lookups: string[] = []
const saved = {
  url: process.env.FILES_FALLBACK_URL,
  token: process.env.FILES_FALLBACK_TOKEN,
  source: process.env.FILE_SOURCE_TOKEN,
  cloud: process.env.CLOUD_META_DB_URL
}
const restore = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

beforeAll(async () => {
  mkdirSync(join(root, 'ab'), { recursive: true })
  writeFileSync(join(root, 'ab/report.pdf'), '%PDF-1.7 0123456789')
  writeFileSync(join(root, 'ab/recording.webm'), 'webm')
  rows.files = [
    { id: PDF_ID, filename_disk: 'ab/report.pdf', type: 'application/pdf', filesize: 19 },
    { id: VIDEO_ID, filename_disk: 'ab/recording.webm', type: 'video/webm', filesize: 4 },
    { id: GONE_ID, filename_disk: 'ab/gone.pdf', type: 'application/pdf', filesize: 9 }
  ]
  rows.helpVideo.add(VIDEO_ID)
  delete process.env.FILES_FALLBACK_URL
  delete process.env.CLOUD_META_DB_URL
  process.env.FILE_SOURCE_TOKEN = TOKEN
  app = Fastify({
    forceCloseConnections: true,
    logger: { level: 'info', stream: { write: (l: string) => void logLines.push(l) } }
  })
  await app.register(internalFileSourceRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  fallbackUrlDeps.fileIdForKey = async (key) => {
    lookups.push(key)
    return keyToId[key] ?? null
  }
  fallbackUrlDeps.warn = (...args) => void warnings.push(args)
})

afterAll(async () => {
  await app.close()
  restore('FILES_FALLBACK_URL', saved.url)
  restore('FILES_FALLBACK_TOKEN', saved.token)
  restore('FILE_SOURCE_TOKEN', saved.source)
  restore('CLOUD_META_DB_URL', saved.cloud)
})

beforeEach(() => {
  resetFallbackUrlState()
  process.env.FILES_FALLBACK_URL = base
  process.env.FILES_FALLBACK_TOKEN = TOKEN
  lookups.length = 0
  warnings.length = 0
})

afterEach(() => {
  delete process.env.CLOUD_META_DB_URL
})

async function readAll(s: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of s) chunks.push(Buffer.from(c as Buffer))
  return Buffer.concat(chunks).toString()
}

describe('configuration', () => {
  it('takes a plain http(s) origin only, never in cloud mode', () => {
    expect(filesFallbackUrl({ FILES_FALLBACK_URL: 'https://efp-api.example.com/' })).toBe(
      'https://efp-api.example.com'
    )
    expect(filesFallbackUrl({ FILES_FALLBACK_URL: 'http://10.0.0.5:3055' })).toBe(
      'http://10.0.0.5:3055'
    )
    expect(filesFallbackUrl({})).toBeNull()
    expect(filesFallbackUrl({ FILES_FALLBACK_URL: 'file:///etc/passwd' })).toBeNull()
    expect(filesFallbackUrl({ FILES_FALLBACK_URL: 'https://u:p@efp-api.example.com' })).toBeNull()
    expect(filesFallbackUrl({ FILES_FALLBACK_URL: 'https://efp-api.example.com/api' })).toBeNull()
    expect(filesFallbackUrl({ FILES_FALLBACK_URL: 'https://efp-api.example.com/?x=1' })).toBeNull()
    expect(
      filesFallbackUrl({
        FILES_FALLBACK_URL: 'https://efp-api.example.com',
        CLOUD_META_DB_URL: 'x'
      })
    ).toBeNull()
    expect(filesFallbackToken({ FILES_FALLBACK_TOKEN: 'short' })).toBeNull()
    expect(filesFallbackToken({ FILES_FALLBACK_TOKEN: ` ${TOKEN}\n` })).toBe(TOKEN)
  })

  it('mounts the source only with a long token, outside cloud mode, and not where it reads a source', () => {
    expect(fileSourceRefusal({})).toBe('unset')
    expect(fileSourceRefusal({ FILE_SOURCE_TOKEN: 'short' })).toMatch(/shorter than 32/)
    expect(fileSourceRefusal({ FILE_SOURCE_TOKEN: TOKEN, CLOUD_META_DB_URL: 'x' })).toMatch(/cloud/)
    expect(
      fileSourceRefusal({ FILE_SOURCE_TOKEN: TOKEN, FILES_FALLBACK_URL: 'https://prod' })
    ).toMatch(/FILES_FALLBACK_URL/)
    expect(fileSourceRefusal({ FILE_SOURCE_TOKEN: TOKEN })).toBeNull()
  })
})

describe('the source route (production side)', () => {
  const get = (id: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/internal/file-source/${id}`, headers })
  const bearer = { authorization: `Bearer ${TOKEN}` }

  it('refuses without the token, with a wrong one, and with a session or API key', async () => {
    expect((await get(PDF_ID)).statusCode).toBe(401)
    expect((await get(PDF_ID, { authorization: 'Bearer nope' })).statusCode).toBe(401)
    expect((await get(PDF_ID, { authorization: `Bearer ${TOKEN}x` })).statusCode).toBe(401)
    expect((await get(PDF_ID, { cookie: 'sessionId=abc' })).statusCode).toBe(401)
    expect((await get(PDF_ID, { authorization: 'Bearer nvk_live_api_key' })).statusCode).toBe(401)
    expect((await get(PDF_ID, { authorization: TOKEN })).statusCode).toBe(401)
  })

  it('serves the stored object with its type and length, uncompressed, no-store', async () => {
    const res = await get(PDF_ID, { ...bearer, 'accept-encoding': 'gzip' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('%PDF-1.7 0123456789')
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-length']).toBe('19')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-encoding']).toBeUndefined()
  })

  it('answers a byte range', async () => {
    const res = await get(PDF_ID, { ...bearer, range: 'bytes=9-12' })
    expect(res.statusCode).toBe(206)
    expect(res.body).toBe('0123')
    expect(res.headers['content-range']).toBe('bytes 9-12/19')
  })

  it('404s unknown ids, non-uuids, rows without an object, and help-video files', async () => {
    expect((await get('00000000-0000-0000-0000-000000000000', bearer)).statusCode).toBe(404)
    expect((await get('..%2F..%2Fetc%2Fpasswd', bearer)).statusCode).toBe(404)
    expect((await get(`${PDF_ID}x`, bearer)).statusCode).toBe(404)
    expect((await get(VIDEO_ID, bearer)).statusCode).toBe(404)
    expect((await get(GONE_ID, bearer)).statusCode).toBe(404)
  })

  it('HEAD answers type and size without the body, 404 when missing', async () => {
    const ok = await app.inject({
      method: 'HEAD',
      url: `/api/internal/file-source/${PDF_ID}`,
      headers: bearer
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-length']).toBe('19')
    expect(ok.body).toBe('')
    const miss = await app.inject({
      method: 'HEAD',
      url: `/api/internal/file-source/${GONE_ID.replace('7', '6')}`,
      headers: bearer
    })
    expect(miss.statusCode).toBe(404)
  })

  it('never writes the token to the log', async () => {
    await get(PDF_ID, { authorization: `Bearer ${TOKEN}-wrong` })
    await get(PDF_ID, bearer)
    await new Promise((r) => setTimeout(r, 20))
    const all = logLines.join('\n')
    expect(all).toContain('file source read')
    expect(all).toContain('wrong or missing FILE_SOURCE_TOKEN')
    expect(all).not.toContain(TOKEN)
  })

  it('is not mounted without FILE_SOURCE_TOKEN, with a short one, or in cloud mode', async () => {
    for (const env of [
      { FILE_SOURCE_TOKEN: undefined },
      { FILE_SOURCE_TOKEN: 'short-token' },
      { FILE_SOURCE_TOKEN: TOKEN, CLOUD_META_DB_URL: 'mssql://meta' }
    ]) {
      const before = { t: process.env.FILE_SOURCE_TOKEN, c: process.env.CLOUD_META_DB_URL }
      restore('FILE_SOURCE_TOKEN', env.FILE_SOURCE_TOKEN)
      restore('CLOUD_META_DB_URL', env.CLOUD_META_DB_URL)
      const bare = Fastify()
      await bare.register(internalFileSourceRoutes, { prefix: '/api' })
      const res = await bare.inject({
        method: 'GET',
        url: `/api/internal/file-source/${PDF_ID}`,
        headers: { authorization: `Bearer ${env.FILE_SOURCE_TOKEN ?? TOKEN}` }
      })
      expect(res.statusCode).toBe(404)
      await bare.close()
      restore('FILE_SOURCE_TOKEN', before.t)
      restore('CLOUD_META_DB_URL', before.c)
    }
  })
})

describe('the fallback client (lower-environment side)', () => {
  it('streams the source copy by the key’s file id', async () => {
    const o = await openFallbackUrl('ab/report.pdf')
    expect(o?.size).toBe(19)
    expect(await readAll(o!.stream)).toBe('%PDF-1.7 0123456789')
    expect(lookups).toEqual(['ab/report.pdf'])
  })

  it('passes a byte range through', async () => {
    const o = await openFallbackUrl('ab/report.pdf', 'bytes=9-12')
    expect(o?.range).toEqual({ start: 9, end: 12 })
    expect(o?.size).toBe(19)
    expect(await readAll(o!.stream)).toBe('0123')
    const bad = await openFallbackUrl('ab/report.pdf', 'bytes=40-')
    expect(bad?.unsatisfiable).toBe(true)
    expect(bad?.size).toBe(19)
  })

  it('a source 404 is the normal missing file, remembered so the source is asked once', async () => {
    expect(await openFallbackUrl('ab/gone.pdf')).toBeNull()
    expect(await openFallbackUrl('ab/gone.pdf')).toBeNull()
    expect(lookups).toEqual(['ab/gone.pdf'])
    // A key with no file row here (session replay, upload part) is never sent to the source.
    expect(await openFallbackUrl('replays/abc.json')).toBeNull()
    expect(await openFallbackUrl('replays/abc.json')).toBeNull()
    expect(lookups).toEqual(['ab/gone.pdf', 'replays/abc.json'])
  })

  it('asks whether the source holds a copy with one HEAD (the File missing check)', async () => {
    expect(await fallbackUrlHas('ab/report.pdf')).toBe(true)
    expect(await fallbackUrlHas('ab/gone.pdf')).toBe(false)
    // A key with no file row here is not the source's either.
    expect(await fallbackUrlHas('replays/abc.json')).toBe(false)
  })

  it('help-video files never come over', async () => {
    expect(await openFallbackUrl('ab/recording.webm')).toBeNull()
  })

  it('buffers for callers that need the whole file, peeks with one range', async () => {
    expect((await readFallbackUrl('ab/report.pdf'))?.toString()).toBe('%PDF-1.7 0123456789')
    expect((await peekFallbackUrl('ab/report.pdf', 4))?.toString()).toBe('%PDF')
  })

  it('a refused token is a miss plus one warning without the token, then a short backoff', async () => {
    process.env.FILES_FALLBACK_TOKEN = `${TOKEN}-not-the-one`
    expect(await openFallbackUrl('ab/report.pdf')).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(JSON.stringify(warnings)).toContain('401')
    expect(JSON.stringify(warnings)).not.toContain(TOKEN)
    lookups.length = 0
    process.env.FILES_FALLBACK_TOKEN = TOKEN
    // Still inside the 15 s trouble window: the source is not asked.
    expect(await openFallbackUrl('ab/report.pdf')).toBeNull()
    expect(lookups).toEqual([])
  })

  it('is off in cloud mode and without a token', async () => {
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    expect(await openFallbackUrl('ab/report.pdf')).toBeNull()
    delete process.env.CLOUD_META_DB_URL
    delete process.env.FILES_FALLBACK_TOKEN
    expect(await openFallbackUrl('ab/report.pdf')).toBeNull()
    expect(lookups).toEqual([])
  })
})

describe('readiness: file-fallback-source', () => {
  it('passes when the source answers 404 with the token and 401 without', async () => {
    expect((await probeFallbackSource()).status).toBe('ok')
  })
  it('warns on a refused token, an unreachable source, or a source that does not serve files', async () => {
    const wrong = await probeFallbackSource({
      FILES_FALLBACK_URL: base,
      FILES_FALLBACK_TOKEN: `${TOKEN}-not-the-one`
    })
    expect(wrong).toMatchObject({ status: 'warn' })
    expect(wrong.summary).toMatch(/401/)
    expect(wrong.summary).not.toContain(TOKEN)
    const down = await probeFallbackSource({
      FILES_FALLBACK_URL: 'http://127.0.0.1:9',
      FILES_FALLBACK_TOKEN: TOKEN
    })
    expect(down.summary).toMatch(/cannot be reached/)
    expect(
      judgeFallbackSource({
        url: base,
        rawUrl: base,
        token: TOKEN,
        withToken: 404,
        withoutToken: 404
      }).summary
    ).toMatch(/does not serve files/)
    expect(
      judgeFallbackSource({
        url: base,
        rawUrl: base,
        token: null,
        withToken: null,
        withoutToken: null
      }).summary
    ).toMatch(/FILES_FALLBACK_TOKEN/)
  })
})

describe('streaming: a large source file is never held whole', () => {
  let slow: Server
  let slowBase = ''
  let release: () => void = () => {}
  let written = 0
  const CHUNK = Buffer.alloc(1024 * 1024, 7)
  const TOTAL_CHUNKS = 256 // a 256 MB body

  beforeAll(async () => {
    slow = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401
        return res.end()
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(CHUNK.length * TOTAL_CHUNKS)
      })
      // One chunk, then hold until the reader has seen it: if the client buffered the whole
      // body before handing it over, it would wait here forever.
      written += CHUNK.length
      res.write(CHUNK)
      release = () => {
        const pump = () => {
          while (written < CHUNK.length * TOTAL_CHUNKS) {
            written += CHUNK.length
            if (!res.write(CHUNK)) return void res.once('drain', pump)
          }
          res.end()
        }
        pump()
      }
    })
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()))
    const addr = slow.address()
    slowBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })
  afterAll(() => new Promise<void>((r) => slow.close(() => r())))

  it('hands over the first bytes before the source has sent the rest', async () => {
    process.env.FILES_FALLBACK_URL = slowBase
    const o = await openFallbackUrl('ab/report.pdf')
    expect(o?.size).toBe(CHUNK.length * TOTAL_CHUNKS)
    const it = o!.stream[Symbol.asyncIterator]()
    const first = await it.next()
    expect((first.value as Buffer).length).toBeGreaterThan(0)
    expect(written).toBe(CHUNK.length)
    // Drain the rest while keeping only a running count — the process never holds 256 MB.
    release()
    let total = (first.value as Buffer).length
    const heapBefore = process.memoryUsage().heapUsed
    for (let r = await it.next(); !r.done; r = await it.next()) total += (r.value as Buffer).length
    expect(total).toBe(CHUNK.length * TOTAL_CHUNKS)
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(128 * 1024 * 1024)
  }, 30_000)
})
