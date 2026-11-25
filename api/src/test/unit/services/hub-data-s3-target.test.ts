import dns from 'node:dns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writerFor } from '../../../services/hub-data-app/files-backup.js'
import {
  S3_PART_BYTES,
  s3AllowList,
  s3Location,
  s3PutStream,
  s3TargetAllowed,
  s3TargetDeps
} from '../../../services/hub-data-app/s3-target.js'

// Hub data care, APP side (security review): an app uploads its files only to an S3 bucket its
// own operator listed in HUB_FILES_BACKUP_S3, through safeFetch (checked and pinned address,
// private / link-local refused unless SSRF_ALLOW_HOSTS lists it, redirects refused). Whoever
// controls a Hub backup policy can never make an app send its files elsewhere.

const creds = { access_key_id: 'AKIDEXAMPLE', secret_access_key: 'secret-example' }
const body = (target: Record<string, unknown>) => ({
  set: 'nivaro-efp-staging-9',
  target: { kind: 's3', ...target },
  credentials: creds
})
const realFetch = s3TargetDeps.fetch
let prevSsrf: string | undefined

beforeEach(() => {
  prevSsrf = process.env.SSRF_ALLOW_HOSTS
  delete process.env.SSRF_ALLOW_HOSTS
})
afterEach(() => {
  s3TargetDeps.fetch = realFetch
  vi.restoreAllMocks()
  if (prevSsrf === undefined) delete process.env.SSRF_ALLOW_HOSTS
  else process.env.SSRF_ALLOW_HOSTS = prevSsrf
})

describe('HUB_FILES_BACKUP_S3', () => {
  const env = {
    HUB_FILES_BACKUP_S3:
      's3://efp-backups/hub, https://minio.example.com/bkt, ftp://x/y, https://u:p@x.example.com/b2, s3://Bad_Bucket'
  } as NodeJS.ProcessEnv

  it('reads only well-formed entries', () => {
    expect(s3AllowList(env)).toEqual([
      { endpoint: null, bucket: 'efp-backups', prefix: 'hub' },
      { endpoint: 'https://minio.example.com', bucket: 'bkt', prefix: '' }
    ])
  })

  it('matches endpoint, bucket and a prefix at or under the entry’s', () => {
    const t = (o: Partial<{ bucket: string; prefix: string; endpoint: string | null }>) => ({
      bucket: 'efp-backups',
      prefix: 'hub',
      region: 'us-east-1',
      endpoint: null,
      ...o
    })
    expect(s3TargetAllowed(t({}), env)).toBe(true)
    expect(s3TargetAllowed(t({ prefix: 'hub/staging' }), env)).toBe(true)
    expect(s3TargetAllowed(t({ prefix: 'hubx' }), env)).toBe(false)
    expect(s3TargetAllowed(t({ prefix: '' }), env)).toBe(false)
    expect(s3TargetAllowed(t({ bucket: 'other' }), env)).toBe(false)
    expect(s3TargetAllowed(t({ endpoint: 'https://evil.example.com' }), env)).toBe(false)
    expect(
      s3TargetAllowed(
        t({ bucket: 'bkt', prefix: 'any/thing', endpoint: 'https://minio.example.com' }),
        env
      )
    ).toBe(true)
    expect(s3TargetAllowed(t({}), {} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('refuses an unlisted target before any request leaves', () => {
    const spy = vi.fn()
    s3TargetDeps.fetch = spy
    expect(() =>
      writerFor(body({ bucket: 'efp-backups', prefix: 'hub' }), {} as NodeJS.ProcessEnv)
    ).toThrow(expect.objectContaining({ code: 'S3_NOT_ALLOWED', statusCode: 403 }))
    expect(() =>
      writerFor(
        body({ bucket: 'efp-backups', prefix: 'hub', endpoint: 'https://evil.example.com' }),
        env
      )
    ).toThrow(expect.objectContaining({ code: 'S3_NOT_ALLOWED' }))
    expect(() => writerFor(body({ bucket: 'efp-backups', prefix: '../x' }), env)).toThrow(
      expect.objectContaining({ code: 'BAD_TARGET' })
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('sends a listed upload through the guarded fetch, signed, redirects refused', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = []
    s3TargetDeps.fetch = async (url, init) => {
      calls.push({ url, init: init as Record<string, unknown> })
      return new Response('', { status: 200 })
    }
    const { writer } = writerFor(
      body({ bucket: 'bkt', prefix: 'apps', endpoint: 'https://minio.example.com' }),
      env
    )
    await writer.put('a/b c.txt', Buffer.from('hi'))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://minio.example.com/bkt/apps/nivaro-efp-staging-9/a/b%20c.txt')
    expect(calls[0].init.redirect).toBe('error')
    expect(String((calls[0].init.headers as Record<string, string>).Authorization)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//
    )
    expect(
      s3Location({ bucket: 'efp-backups', prefix: '', region: 'eu-west-1', endpoint: null }, 'k')
        .url
    ).toBe('https://efp-backups.s3.eu-west-1.amazonaws.com/k')
  })

  it('refuses a listed endpoint on a private address (real guard, no connection)', async () => {
    const e = { HUB_FILES_BACKUP_S3: 'https://10.1.2.3/bkt' } as NodeJS.ProcessEnv
    const { writer } = writerFor(
      body({ bucket: 'bkt', prefix: '', endpoint: 'https://10.1.2.3' }),
      e
    )
    await expect(writer.put('x', Buffer.from('x'))).rejects.toThrow(/private|loopback/i)
  })

  it('refuses a listed name that resolves to a link-local address (DNS rebinding)', async () => {
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never)
    const e = { HUB_FILES_BACKUP_S3: 'https://s3.rebind.example/bkt' } as NodeJS.ProcessEnv
    const { writer } = writerFor(
      body({ bucket: 'bkt', prefix: '', endpoint: 'https://s3.rebind.example' }),
      e
    )
    await expect(writer.put('x', Buffer.from('x'))).rejects.toThrow(/private|reserved/i)
    expect(lookup).toHaveBeenCalled()
  })

  it('streams a large object in parts (never whole), and aborts the upload when a part fails', async () => {
    const calls: Array<{ method: string; url: string; bytes: number }> = []
    let failPart = 0
    s3TargetDeps.fetch = async (url, init) => {
      const body = init.body as Uint8Array | undefined
      calls.push({ method: String(init.method), url, bytes: body?.byteLength ?? 0 })
      const u = new URL(url)
      if (init.method === 'POST' && u.searchParams.has('uploads'))
        return new Response(
          '<InitiateMultipartUploadResult><UploadId>U1</UploadId></InitiateMultipartUploadResult>'
        )
      if (init.method === 'PUT' && u.searchParams.has('partNumber')) {
        if (Number(u.searchParams.get('partNumber')) === failPart)
          return new Response('', { status: 500 })
        return new Response('', { headers: { etag: `"e${u.searchParams.get('partNumber')}"` } })
      }
      return new Response('', { status: 200 })
    }
    const t = {
      bucket: 'bkt',
      prefix: '',
      region: 'us-east-1',
      endpoint: 'https://minio.example.com'
    }
    const src = function* () {
      for (let i = 0; i < 20; i++) yield Buffer.alloc(1024 * 1024, i)
    }
    expect(await s3PutStream(t, creds, 'k/big.bin', src())).toBe(20 * 1024 * 1024)
    const parts = calls.filter((c) => c.method === 'PUT')
    expect(parts.length).toBe(3)
    expect(Math.max(...parts.map((p) => p.bytes))).toBeLessThanOrEqual(S3_PART_BYTES + 1024 * 1024)
    expect(calls.at(-1)?.url).toContain('uploadId=U1')
    calls.length = 0
    failPart = 2
    await expect(s3PutStream(t, creds, 'k/big.bin', src())).rejects.toThrow(/part 2/)
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('uploadId=U1'))).toBe(true)
    // small objects stay one PUT
    calls.length = 0
    expect(await s3PutStream(t, creds, 'k/s.txt', [Buffer.from('hi')])).toBe(2)
    expect(calls.map((c) => c.method)).toEqual(['PUT'])
  })
})
