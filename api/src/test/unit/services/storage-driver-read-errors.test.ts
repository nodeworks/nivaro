import { afterEach, describe, expect, it, vi } from 'vitest'
import { StoredObjectMissing } from '../../../services/storage/missing.js'
import { buildDriver } from '../../../services/storage-drivers.js'

// R6-I-1 (ruling P6-33): a saved-settings driver says "not there" only for a real 404; any other
// failed read (throttling, a refused credential) stays an error with its status, so a move's file
// route answers 5xx (the row fails) and never reports the object missing.

const drivers = {
  s3: () =>
    buildDriver('s3', {
      bucket: 'b',
      access_key_id: 'AK',
      secret_access_key: 'SK',
      endpoint: 'https://s3.example.com'
    }),
  azure: () =>
    buildDriver('azure-blob', {
      account: 'acct',
      container: 'c',
      account_key: Buffer.from('k').toString('base64')
    })
}

afterEach(() => vi.unstubAllGlobals())

describe('saved-settings driver read errors', () => {
  for (const [name, make] of Object.entries(drivers)) {
    it(`${name}: a 404 is StoredObjectMissing`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('NoSuchKey', { status: 404 }))
      )
      await expect(make().get('a/b.pdf')).rejects.toBeInstanceOf(StoredObjectMissing)
    })

    for (const status of [503, 403, 500])
      it(`${name}: a ${status} is an error with that status, never "missing"`, async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => new Response('nope', { status }))
        )
        const err = await make()
          .get('a/b.pdf')
          .catch((e) => e)
        expect(err).not.toBeInstanceOf(StoredObjectMissing)
        expect(err.status).toBe(status)
      })
  }
})

// R6-M-3: a saved-settings object is streamed (never read whole), with a Range passed through.
describe('saved-settings driver streams (R6-M-3)', () => {
  for (const [name, make] of Object.entries(drivers)) {
    it(`${name}: a ranged read streams the body and reads the size from Content-Range`, async () => {
      const seen: Array<Record<string, string>> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_u: string, init: { headers: Record<string, string> }) => {
          seen.push(init.headers)
          return new Response('cdef', {
            status: 206,
            headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' }
          })
        })
      )
      const d = make() as { openStream?: (k: string, r?: string) => Promise<unknown> }
      const o = (await d.openStream?.('a/b.pdf', 'bytes=2-5')) as {
        size: number
        range: { start: number; end: number } | null
        stream: AsyncIterable<Buffer>
      }
      expect(o.size).toBe(10)
      expect(o.range).toEqual({ start: 2, end: 5 })
      const chunks: Buffer[] = []
      for await (const c of o.stream) chunks.push(Buffer.from(c))
      expect(Buffer.concat(chunks).toString()).toBe('cdef')
      const h = seen[0]
      expect(name === 's3' ? h.range : h['x-ms-range']).toBe('bytes=2-5')
    })

    it(`${name}: a whole read takes its size from Content-Length; a 404 is missing; a 503 is not`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('abc', { status: 200, headers: { 'content-length': '3' } }))
      )
      const d = make() as { openStream: (k: string, r?: string) => Promise<{ size: number }> }
      expect((await d.openStream('a/b.pdf')).size).toBe(3)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('x', { status: 404 }))
      )
      await expect(d.openStream('a/b.pdf')).rejects.toBeInstanceOf(StoredObjectMissing)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('x', { status: 503 }))
      )
      const err = await d.openStream('a/b.pdf').catch((e) => e)
      expect(err).not.toBeInstanceOf(StoredObjectMissing)
      expect(err.status).toBe(503)
    })
  }
})
