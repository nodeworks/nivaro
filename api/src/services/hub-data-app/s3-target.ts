import { createHash, createHmac } from 'node:crypto'
import { type SafeFetchInit, safeFetch } from '../../lib/ssrf.js'

/**
 * Hub data care, APP side: the S3 target of a files backup, guarded by the app's OWN operator.
 *
 * The Hub sends the bucket, prefix, endpoint and key pair, but an app uploads its files only to a
 * bucket its operator listed in HUB_FILES_BACKUP_S3 (comma list; unset = every S3 backup
 * refused, 403 S3_NOT_ALLOWED):
 *
 *   s3://<bucket>[/<prefix>]                  AWS S3 (https://<bucket>.s3.<region>.amazonaws.com)
 *   https://<endpoint host[:port]>/<bucket>[/<prefix>]   an S3-compatible store (path style)
 *
 * A target matches an entry with the same endpoint (none = AWS) and bucket, and a prefix equal
 * to or under the entry's. Every request goes through safeFetch (lib/ssrf.ts): the host is
 * resolved and checked, the connection pinned to the checked address (no DNS rebinding), and a
 * private, loopback or link-local address refused unless SSRF_ALLOW_HOSTS also lists it.
 * Redirects are refused. Requests are SigV4-signed here, so no other S3 client is involved.
 */

export interface S3Target {
  bucket: string
  prefix: string
  region: string | null
  endpoint: string | null
}

export interface S3Creds {
  access_key_id: string
  secret_access_key: string
}

interface AllowEntry {
  endpoint: string | null
  bucket: string
  prefix: string
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const cleanPrefix = (p: string) => p.replace(/^\/+|\/+$/g, '')

/** The entries of HUB_FILES_BACKUP_S3 (a bad entry is ignored, never widened). */
export function s3AllowList(env: NodeJS.ProcessEnv = process.env): AllowEntry[] {
  const out: AllowEntry[] = []
  for (const raw of String(env.HUB_FILES_BACKUP_S3 ?? '').split(',')) {
    const s = raw.trim()
    if (!s) continue
    let endpoint: string | null = null
    let rest: string
    if (s.startsWith('s3://')) rest = s.slice(5)
    else {
      let u: URL
      try {
        u = new URL(s)
      } catch {
        continue
      }
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) continue
      endpoint = u.origin
      rest = u.pathname
    }
    const [bucket, ...pre] = cleanPrefix(rest).split('/')
    if (!bucket || !BUCKET_RE.test(bucket)) continue
    const prefix = cleanPrefix(pre.join('/'))
    if (prefix.includes('..')) continue
    out.push({ endpoint, bucket, prefix })
  }
  return out
}

/** The target matches an entry: same endpoint and bucket, prefix equal to or under the entry's. */
export function s3TargetAllowed(t: S3Target, env: NodeJS.ProcessEnv = process.env): boolean {
  const prefix = cleanPrefix(t.prefix)
  return s3AllowList(env).some(
    (e) =>
      e.endpoint === (t.endpoint ?? null) &&
      e.bucket === t.bucket &&
      (!e.prefix || prefix === e.prefix || prefix.startsWith(`${e.prefix}/`))
  )
}

function uriEncodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

const sha256Hex = (d: Buffer | string) => createHash('sha256').update(d).digest('hex')
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d, 'utf8').digest()

export type S3Fetch = (url: string, init: SafeFetchInit) => Promise<Response>

export const s3TargetDeps: { fetch: S3Fetch } = {
  fetch: (url, init) => safeFetch(url, init)
}

/** The URL, Host and canonical path of an object. */
export function s3Location(t: S3Target, key: string): { url: string; host: string; path: string } {
  const encodedKey = key.split('/').map(uriEncodeSegment).join('/')
  if (t.endpoint) {
    const u = new URL(t.endpoint)
    const path = `/${uriEncodeSegment(t.bucket)}/${encodedKey}`
    return { url: `${u.origin}${path}`, host: u.host, path }
  }
  const host = `${t.bucket}.s3.${t.region || 'us-east-1'}.amazonaws.com`
  const path = `/${encodedKey}`
  return { url: `https://${host}${path}`, host, path }
}

/** SigV4 canonical query: keys sorted, both sides strictly encoded, `k=` for a bare key. */
export function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncodeSegment(k)}=${uriEncodeSegment(query[k])}`)
    .join('&')
}

/** One SigV4-signed request through safeFetch, redirects refused. */
export async function s3Request(
  t: S3Target,
  creds: S3Creds,
  method: 'GET' | 'PUT' | 'DELETE' | 'POST',
  key: string,
  body?: Buffer,
  now = new Date(),
  query: Record<string, string> = {}
): Promise<Response> {
  const loc = s3Location(t, key)
  const qs = canonicalQuery(query)
  const { host, path } = loc
  const url = qs ? `${loc.url}?${qs}` : loc.url
  const region = t.region || 'us-east-1'
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const scope = `${day}/${region}/s3/aws4_request`
  const payloadHash = sha256Hex(body ?? '')
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  }
  if (method === 'PUT') headers['content-type'] = 'application/octet-stream'
  if (method === 'POST' && body) headers['content-type'] = 'application/xml'
  const names = Object.keys(headers).sort()
  const canonical = [
    method,
    path,
    qs,
    names.map((h) => `${h}:${headers[h].trim()}\n`).join(''),
    names.join(';'),
    payloadHash
  ].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n')
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${creds.secret_access_key}`, day), region), 's3'),
    'aws4_request'
  )
  const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex')
  const { host: _h, ...send } = headers
  return s3TargetDeps.fetch(url, {
    method,
    headers: {
      ...send,
      Authorization: `AWS4-HMAC-SHA256 Credential=${creds.access_key_id}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`
    },
    ...(body ? { body: new Uint8Array(body) } : {}),
    redirect: 'error',
    timeoutMs: body ? Math.max(30_000, Math.ceil(body.length / 1_000_000) * 2_000) : 30_000
  })
}

/** Objects are sent in parts of this size: never more than one part per object in memory. */
export const S3_PART_BYTES = 8 * 1024 * 1024

async function ok(res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  await res.body?.cancel().catch(() => undefined)
  throw new Error(`S3 ${what} failed: ${res.status}`)
}

/**
 * Uploads a stream without holding it whole: one PUT when it ends inside the first part, else a
 * multipart upload, part by part (8 MiB in memory at a time); a failed multipart is aborted so no
 * parts are left billed. Answers the bytes stored.
 */
export async function s3PutStream(
  t: S3Target,
  creds: S3Creds,
  key: string,
  src: AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer | Uint8Array | string>
): Promise<number> {
  let buf: Buffer[] = []
  let size = 0
  let total = 0
  let uploadId: string | null = null
  const etags: string[] = []
  const flushPart = async () => {
    const part = Buffer.concat(buf)
    buf = []
    size = 0
    if (!uploadId) {
      const res = await ok(
        await s3Request(t, creds, 'POST', key, undefined, new Date(), { uploads: '' }),
        'create upload'
      )
      const m = /<UploadId>([^<]+)<\/UploadId>/.exec(await res.text())
      if (!m) throw new Error('S3 create upload: no UploadId')
      uploadId = m[1]
    }
    const n = etags.length + 1
    const res = await ok(
      await s3Request(t, creds, 'PUT', key, part, new Date(), {
        partNumber: String(n),
        uploadId
      }),
      `part ${n}`
    )
    await res.body?.cancel().catch(() => undefined)
    const etag = res.headers.get('etag')
    if (!etag) throw new Error(`S3 part ${n}: no ETag`)
    etags.push(etag)
  }
  try {
    for await (const chunk of src) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
      buf.push(b)
      size += b.length
      total += b.length
      if (size >= S3_PART_BYTES) await flushPart()
    }
    if (!uploadId) {
      const res = await ok(await s3Request(t, creds, 'PUT', key, Buffer.concat(buf)), 'PUT')
      await res.body?.cancel().catch(() => undefined)
      return total
    }
    if (size > 0) await flushPart()
    const xml = `<CompleteMultipartUpload>${etags
      .map(
        (e, i) =>
          `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/[<>&]/g, '')}</ETag></Part>`
      )
      .join('')}</CompleteMultipartUpload>`
    const done = await ok(
      await s3Request(t, creds, 'POST', key, Buffer.from(xml), new Date(), { uploadId }),
      'complete upload'
    )
    await done.body?.cancel().catch(() => undefined)
    return total
  } catch (err) {
    if (uploadId) {
      const id: string = uploadId
      await s3Request(t, creds, 'DELETE', key, undefined, new Date(), { uploadId: id })
        .then((r) => r.body?.cancel())
        .catch(() => undefined)
    }
    throw err
  }
}
