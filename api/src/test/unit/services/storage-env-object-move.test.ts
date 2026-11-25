import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 0.3.215: a Hub move copies objects an env-driven S3 / Azure provider stored (STORAGE_PROVIDER).
// The source streams them (never read whole), says which store held them and — for an env
// bucket — the bucket's hash and the object's full key, so a target on the same bucket copies it
// server-side (CopyObject / Copy Blob). The SDK clients are stand-ins; nothing reaches a network.

const h = vi.hoisted(() => ({
  root: '',
  env: null as unknown,
  tenant: null as string | null
}))
vi.mock('../../../config.js', () => ({ config: { STORAGE_LOCAL_ROOT: '/tmp/nvr-env-move' } }))
vi.mock('../../../services/storage/index.js', () => ({
  getStorage: () => h.env,
  getStorageProviderName: () => 's3'
}))
vi.mock('../../../services/storage-drivers.js', () => ({
  getActiveStorageDriver: async () => ({ name: 'local' }),
  readOwnStoredObject: async () => {
    throw new Error('not used')
  }
}))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getTenantId: () => h.tenant
}))

import { scopedStorage } from '../../../services/storage/app-scope.js'
import { AzureStorage } from '../../../services/storage/azure.js'
import { StoredObjectMissing } from '../../../services/storage/missing.js'
import { S3Storage } from '../../../services/storage/s3.js'
import { openTransferObject } from '../../../services/stored-object-stream.js'

async function text(s: NodeJS.ReadableStream): Promise<string> {
  const parts: Buffer[] = []
  for await (const c of s) parts.push(Buffer.from(c as Buffer))
  return Buffer.concat(parts).toString()
}

const saved = { ...process.env }
beforeEach(() => {
  process.env = { ...saved }
  delete process.env.HUB_SHARED_DEPLOYMENT
  delete process.env.CLOUD_META_DB_URL
  h.tenant = null
})
afterEach(() => {
  process.env = { ...saved }
})

type Sent = { name: string; input: Record<string, unknown>; opts?: unknown }

function s3With(answer: (c: Sent) => unknown, env: Record<string, string> = {}) {
  process.env.STORAGE_S3_BUCKET = env.bucket ?? 'files-bucket'
  process.env.STORAGE_S3_REGION = env.region ?? 'eu-west-1'
  if (env.endpoint) process.env.STORAGE_S3_ENDPOINT = env.endpoint
  else delete process.env.STORAGE_S3_ENDPOINT
  const s3 = new S3Storage()
  const sent: Sent[] = []
  ;(s3 as unknown as { client: unknown }).client = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: object }, opts?: unknown) => {
      const c = { name: cmd.constructor.name, input: cmd.input as Record<string, unknown>, opts }
      sent.push(c)
      const out = answer(c)
      if (out instanceof Error) throw out
      return out
    })
  }
  return { s3, sent }
}

describe('env S3 provider (0.3.215)', () => {
  it('openStream streams the body with its size; a Range is answered from a HEAD of the size', async () => {
    const { s3, sent } = s3With((c) =>
      c.name === 'HeadObjectCommand'
        ? { ContentLength: 10 }
        : {
            ContentLength: c.input.Range ? 3 : 10,
            Body: Readable.from([Buffer.from(c.input.Range ? '234' : '0123456789')])
          }
    )
    const whole = await s3.openStream('a/b.pdf')
    expect(whole.size).toBe(10)
    expect(whole.range).toBeNull()
    expect(await text(whole.stream)).toBe('0123456789')
    const part = await s3.openStream('a/b.pdf', 'bytes=2-4')
    expect(part).toMatchObject({ size: 10, range: { start: 2, end: 4 }, unsatisfiable: false })
    expect(await text(part.stream)).toBe('234')
    expect(sent.find((c) => c.input.Range)?.input.Range).toBe('bytes=2-4')
    expect((await s3.openStream('a/b.pdf', 'bytes=50-')).unsatisfiable).toBe(true)
  })

  it('a missing key is StoredObjectMissing; any other error is thrown as it is', async () => {
    const missing = s3With(() => Object.assign(new Error('nope'), { name: 'NoSuchKey' }))
    await expect(missing.s3.openStream('x')).rejects.toBeInstanceOf(StoredObjectMissing)
    const slow = s3With(() =>
      Object.assign(new Error('SlowDown'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } })
    )
    const err = await slow.s3.openStream('x').catch((e) => e)
    expect(err).not.toBeInstanceOf(StoredObjectMissing)
    expect(err.name).toBe('SlowDown')
  })

  it('storeId hashes endpoint/region and bucket, never names them', () => {
    const a = s3With(() => ({})).s3.storeId()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toContain('files-bucket')
    expect(s3With(() => ({})).s3.storeId()).toBe(a)
    expect(s3With(() => ({}), { bucket: 'other' }).s3.storeId()).not.toBe(a)
    expect(s3With(() => ({}), { region: 'us-east-1' }).s3.storeId()).not.toBe(a)
    const r2 = s3With(() => ({}), { endpoint: 'https://acct.r2.cloudflarestorage.com/' })
    expect(r2.s3.storeId()).not.toBe(a)
    expect(
      s3With(() => ({}), { endpoint: 'https://ACCT.r2.cloudflarestorage.com' }).s3.storeId()
    ).toBe(r2.s3.storeId())
  })

  it('copyFrom asks the bucket to copy (CopyObject, source key encoded) and reads the size back', async () => {
    const { s3, sent } = s3With((c) =>
      c.name === 'HeadObjectCommand' ? { ContentLength: 42 } : {}
    )
    const ac = new AbortController()
    const n = await s3.copyFrom('apps/shop-e1/ab/r é.pdf', 'ab/r é.pdf', 'application/pdf', {
      signal: ac.signal
    })
    expect(n).toBe(42)
    const copy = sent.find((c) => c.name === 'CopyObjectCommand')
    expect(copy?.input).toMatchObject({
      Bucket: 'files-bucket',
      Key: 'apps/shop-e1/ab/r é.pdf',
      CopySource: 'files-bucket/ab/r%20%C3%A9.pdf',
      ContentType: 'application/pdf',
      MetadataDirective: 'REPLACE'
    })
    expect(copy?.opts).toEqual({ abortSignal: ac.signal })
    expect(sent.at(-1)?.input).toEqual({ Bucket: 'files-bucket', Key: 'apps/shop-e1/ab/r é.pdf' })
  })
})

describe('env Azure provider (0.3.215)', () => {
  const KEY = Buffer.from('k'.repeat(32)).toString('base64')
  function azureWith(blob: (name: string) => Record<string, unknown>, account = 'acct') {
    process.env.STORAGE_AZURE_CONNECTION_STRING = `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${KEY};EndpointSuffix=core.windows.net`
    process.env.STORAGE_AZURE_CONTAINER = 'files'
    const az = new AzureStorage()
    ;(az as unknown as { container: unknown }).container = {
      getBlockBlobClient: (name: string) => ({
        url: `https://${account}.blob.core.windows.net/files/${name}`,
        ...blob(name)
      })
    }
    return az
  }

  it('openStream streams a download; a 404 is StoredObjectMissing', async () => {
    const az = azureWith(() => ({
      download: async (offset: number, count?: number) => ({
        contentLength: count ?? 10,
        readableStreamBody: Readable.from([Buffer.from(count ? '234' : '0123456789')]),
        offset
      }),
      getProperties: async () => ({ contentLength: 10 })
    }))
    const whole = await az.openStream('a.pdf')
    expect(whole.size).toBe(10)
    expect(await text(whole.stream)).toBe('0123456789')
    const part = await az.openStream('a.pdf', 'bytes=2-4')
    expect(part.range).toEqual({ start: 2, end: 4 })
    expect(await text(part.stream)).toBe('234')

    const gone = azureWith(() => ({
      download: async () => {
        throw Object.assign(new Error('BlobNotFound'), { statusCode: 404 })
      }
    }))
    await expect(gone.openStream('a.pdf')).rejects.toBeInstanceOf(StoredObjectMissing)
  })

  it('storeId hashes account and container; copyFrom copies inside the container', async () => {
    const calls: string[] = []
    const az = azureWith((name) => ({
      beginCopyFromURL: async (url: string) => {
        calls.push(`copy ${name} <- ${url}`)
        return { pollUntilDone: async () => ({}) }
      },
      setHTTPHeaders: async (h: { blobContentType: string }) => {
        calls.push(`type ${name} ${h.blobContentType}`)
      },
      getProperties: async () => ({ contentLength: 7 })
    }))
    expect(az.storeId()).toMatch(/^[0-9a-f]{64}$/)
    expect(az.storeId()).not.toBe(azureWith(() => ({}), 'other').storeId())
    expect(await az.copyFrom('apps/shop-e1/a.pdf', 'a.pdf', 'application/pdf')).toBe(7)
    expect(calls).toEqual([
      'copy apps/shop-e1/a.pdf <- https://acct.blob.core.windows.net/files/a.pdf',
      'type apps/shop-e1/a.pdf application/pdf'
    ])
  })
})

describe('the per-app scope on a shared deployment (0.3.215 methods)', () => {
  it('copyFrom scopes the destination only; storeId passes through', async () => {
    const seen: unknown[][] = []
    const base = {
      copyFrom: async (...args: unknown[]) => {
        seen.push(args)
        return 1
      },
      storeId: () => 'hash'
    }
    const scoped = scopedStorage(base, () => 'shop-e1')
    await scoped.copyFrom('ab/r.pdf', 'ab/r.pdf', 'application/pdf')
    expect(seen[0].slice(0, 3)).toEqual(['apps/shop-e1/ab/r.pdf', 'ab/r.pdf', 'application/pdf'])
    expect(scoped.storeId()).toBe('hash')
    await expect(scoped.copyFrom('../x', 'ab/r.pdf', 'x')).rejects.toMatchObject({
      code: 'BAD_KEY'
    })
  })
})

describe('openTransferObject on an env object provider (0.3.215)', () => {
  function envProvider() {
    const opened: string[] = []
    return {
      opened,
      provider: {
        openStream: async (key: string) => {
          opened.push(key)
          if (key.endsWith('gone.pdf')) throw new StoredObjectMissing()
          return { size: 3, range: null, unsatisfiable: false, stream: Readable.from(['abc']) }
        },
        get: async () => {
          throw new Error('never read whole')
        },
        storeId: () => 'bucket-hash'
      }
    }
  }

  it('dedicated: streamed from the env bucket, with its hash and the key at the bucket root', async () => {
    const e = envProvider()
    h.env = e.provider
    const o = await openTransferObject('ab/r.pdf', 's3')
    expect(o).toMatchObject({
      size: 3,
      store: 'env',
      store_id: 'bucket-hash',
      stored_key: 'ab/r.pdf'
    })
    expect(await text(o.stream)).toBe('abc')
  })

  it('shared: the full key is the app scope (apps/<tenant>/…)', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'pool-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = 'd'.repeat(40)
    h.tenant = 'shop-e1'
    const e = envProvider()
    h.env = scopedStorage(e.provider, () => h.tenant)
    const o = await openTransferObject('ab/r.pdf', 'local')
    expect(o).toMatchObject({ store: 'env', stored_key: 'apps/shop-e1/ab/r.pdf' })
    expect(e.opened).toEqual(['apps/shop-e1/ab/r.pdf'])
  })

  it('a missing env object falls through to the fallbacks and is missing there too', async () => {
    h.env = envProvider().provider
    await expect(openTransferObject('ab/gone.pdf', 's3')).rejects.toBeInstanceOf(
      StoredObjectMissing
    )
  })
})
