/**
 * S3 / Cloudflare R2 storage provider.
 *
 * Env vars:
 *   STORAGE_S3_BUCKET      bucket name (required)
 *   STORAGE_S3_REGION      region (default us-east-1; use "auto" for R2)
 *   STORAGE_S3_ENDPOINT    custom endpoint for R2 / MinIO (optional; forces path-style)
 *   STORAGE_S3_ACCESS_KEY  access key id
 *   STORAGE_S3_SECRET      secret access key
 *   STORAGE_CDN_URL        when set, getUrl() returns `${CDN_URL}/${key}` instead of presigning
 *
 * Presigned URLs are generated with a small built-in SigV4 query signer
 * (@aws-sdk/s3-request-presigner is not installed).
 */
import { createHash, createHmac } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3'
import type { StorageProvider } from './index.js'

const PRESIGN_EXPIRES = 3600 // 1 hour
/** putFile: files up to this size go up in one PUT; bigger ones as a multipart upload. */
export const S3_SINGLE_PUT_MAX = 16 * 1024 * 1024
/** putFile: one multipart part (S3's minimum is 5 MiB; 10,000 parts → ~80 GB). */
export const S3_PART_SIZE = 8 * 1024 * 1024

/** The file's bytes, one part at a time (never more than one part in memory). */
export async function* fileParts(path: string, partSize: number): AsyncGenerator<Buffer> {
  const fh = await open(path, 'r')
  try {
    for (;;) {
      const buf = Buffer.alloc(partSize)
      let filled = 0
      while (filled < partSize) {
        const { bytesRead } = await fh.read(buf, filled, partSize - filled, null)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      if (filled === 0) return
      yield filled === partSize ? buf : buf.subarray(0, filled)
      if (filled < partSize) return
    }
  } finally {
    await fh.close().catch(() => {})
  }
}

function env(name: string): string {
  return process.env[name] ?? ''
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** RFC 3986 strict URI encoding as required by SigV4. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export class S3Storage implements StorageProvider {
  private client: S3Client
  private bucket: string
  private region: string
  private endpoint: string
  private accessKey: string
  private secret: string
  private cdnUrl: string

  constructor() {
    this.bucket = env('STORAGE_S3_BUCKET')
    this.region = env('STORAGE_S3_REGION') || 'us-east-1'
    this.endpoint = env('STORAGE_S3_ENDPOINT')
    this.accessKey = env('STORAGE_S3_ACCESS_KEY')
    this.secret = env('STORAGE_S3_SECRET')
    this.cdnUrl = env('STORAGE_CDN_URL').replace(/\/+$/, '')
    if (!this.bucket) {
      throw new Error('STORAGE_S3_BUCKET is required when STORAGE_PROVIDER=s3')
    }

    this.client = new S3Client({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: this.accessKey, secretAccessKey: this.secret }
    })
  }

  async put(key: string, buffer: Buffer, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ContentType: mime })
    )
  }

  /**
   * A file on disk: one PUT when small, else a multipart upload read part by part (8 MiB in
   * memory at a time — never the whole file; every part is a plain Buffer, so the SDK signs it
   * like any other body). A failed multipart upload is aborted so no parts are left billed.
   */
  async putFile(
    key: string,
    path: string,
    mime: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<number> {
    const { signal } = opts
    const { size } = await stat(path)
    if (size <= S3_SINGLE_PUT_MAX) {
      signal?.throwIfAborted()
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: await readFile(path),
          ContentType: mime
        }),
        { abortSignal: signal }
      )
      return size
    }
    const created = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: mime })
    )
    const uploadId = created.UploadId
    if (!uploadId) throw new Error(`S3 multipart upload of ${key} was not started`)
    try {
      const parts: Array<{ ETag: string | undefined; PartNumber: number }> = []
      let n = 0
      for await (const body of fileParts(path, S3_PART_SIZE)) {
        signal?.throwIfAborted()
        n++
        const res = await this.client.send(
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: n,
            Body: body
          })
        )
        parts.push({ ETag: res.ETag, PartNumber: n })
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts }
        })
      )
      return size
    } catch (err) {
      await this.client
        .send(
          new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })
        )
        .catch(() => null)
      throw err
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    if (!res.Body) throw new Error(`S3 object has no body: ${key}`)
    const bytes = await res.Body.transformToByteArray()
    return Buffer.from(bytes)
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch {
      return false
    }
  }

  async delete(key: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch(() => null)
  }

  getUrl(key: string): string {
    if (this.cdnUrl) return `${this.cdnUrl}/${key}`
    return this.presign('GET', key, PRESIGN_EXPIRES)
  }

  async getUploadUrl(key: string, _mime: string): Promise<string> {
    return this.presign('PUT', key, PRESIGN_EXPIRES)
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key)
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
    return keys
  }

  /** SigV4 query-string presigner (UNSIGNED-PAYLOAD, host-only signed header). */
  private presign(method: 'GET' | 'PUT', key: string, expiresIn: number): string {
    let host: string
    let path: string
    const encodedKey = key.split('/').map(uriEncode).join('/')
    if (this.endpoint) {
      const url = new URL(this.endpoint)
      host = url.host
      const basePath = url.pathname.replace(/\/+$/, '')
      path = `${basePath}/${uriEncode(this.bucket)}/${encodedKey}`
    } else {
      host = `${this.bucket}.s3.${this.region}.amazonaws.com`
      path = `/${encodedKey}`
    }

    const now = new Date()
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
    const dateStamp = amzDate.slice(0, 8)
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`

    const params: [string, string][] = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.accessKey}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expiresIn)],
      ['X-Amz-SignedHeaders', 'host']
    ]
    const canonicalQuery = params
      .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
      .sort()
      .join('&')

    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD'
    ].join('\n')

    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join(
      '\n'
    )

    const kDate = hmac(`AWS4${this.secret}`, dateStamp)
    const kRegion = hmac(kDate, this.region)
    const kService = hmac(kRegion, 's3')
    const kSigning = hmac(kService, 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

    const protocol = this.endpoint ? new URL(this.endpoint).protocol : 'https:'
    return `${protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`
  }
}
