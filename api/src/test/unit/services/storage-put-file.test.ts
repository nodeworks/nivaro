import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Storage drivers take a file on disk (`putFile`) and send it without reading it whole into
// memory (streaming exports, 2026-11-18): S3 settings driver = one signed PUT streamed from disk
// (payload hash read as a stream too), Azure settings driver = one streamed Put Blob, the env S3
// provider = multipart parts read one at a time.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { fileParts } from '../../../services/storage/s3.js'
import { buildDriver } from '../../../services/storage-drivers.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nvr-putfile-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fileParts (env S3 multipart)', () => {
  it('yields the file in parts of the asked size, the last one short', async () => {
    const path = join(dir, 'f.bin')
    writeFileSync(path, Buffer.alloc(25, 7))
    const sizes: number[] = []
    for await (const p of fileParts(path, 10)) sizes.push(p.length)
    expect(sizes).toEqual([10, 10, 5])
    const empty = join(dir, 'e.bin')
    writeFileSync(empty, '')
    const none: Buffer[] = []
    for await (const p of fileParts(empty, 10)) none.push(p)
    expect(none).toEqual([])
  })
})

describe('settings S3 driver putFile', () => {
  it('streams one signed PUT with Content-Length and the file’s own payload hash', async () => {
    const body = Buffer.from('x'.repeat(300_000))
    const path = join(dir, 'export.csv')
    writeFileSync(path, body)
    const got: { headers?: http.IncomingHttpHeaders; bytes: number; url?: string } = { bytes: 0 }
    const srv = http.createServer((req, res) => {
      got.headers = req.headers
      got.url = req.url
      req.on('data', (c: Buffer) => {
        got.bytes += c.length
      })
      req.on('end', () => res.end())
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port
    try {
      const driver = buildDriver('s3', {
        bucket: 'b',
        access_key_id: 'AK',
        secret_access_key: 'SK',
        endpoint: `http://127.0.0.1:${port}`
      })
      expect(await driver.putFile('exports/x.csv', path, 'text/csv')).toBe(body.length)
    } finally {
      srv.close()
    }
    expect(got.url).toBe('/b/exports/x.csv')
    expect(got.bytes).toBe(body.length)
    expect(got.headers?.['content-length']).toBe(String(body.length))
    expect(got.headers?.['transfer-encoding']).toBeUndefined()
    expect(got.headers?.['x-amz-content-sha256']).toBe(
      createHash('sha256').update(body).digest('hex')
    )
    expect(String(got.headers?.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//)
  })
})

describe('settings Azure driver putFile', () => {
  it('signs the file’s length and sends it as a stream', async () => {
    const path = join(dir, 'export.xlsx')
    writeFileSync(path, Buffer.alloc(1234, 1))
    const calls: Array<{ url: string; init: Record<string, any> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: Record<string, any>) => {
        calls.push({ url, init })
        let n = 0
        for await (const c of init.body as AsyncIterable<Uint8Array>) n += c.length
        calls[0].init.sent = n
        return new Response(null, { status: 201 })
      })
    )
    const driver = buildDriver('azure-blob', {
      account: 'acct',
      container: 'c',
      account_key: Buffer.from('k').toString('base64')
    })
    expect(await driver.putFile('exports/x.xlsx', path, 'application/xlsx')).toBe(1234)
    expect(calls[0].url).toBe('https://acct.blob.core.windows.net/c/exports/x.xlsx')
    expect(calls[0].init.headers['content-length']).toBe('1234')
    expect(calls[0].init.headers['x-ms-blob-type']).toBe('BlockBlob')
    expect(calls[0].init.duplex).toBe('half')
    expect(calls[0].init.sent).toBe(1234)
  })
})
