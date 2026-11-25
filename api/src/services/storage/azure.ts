/**
 * Azure Blob Storage provider.
 *
 * Env vars:
 *   STORAGE_AZURE_CONNECTION_STRING  full connection string (required)
 *   STORAGE_AZURE_CONTAINER          container name (required)
 *   STORAGE_CDN_URL                  when set, getUrl() returns `${CDN_URL}/${key}`
 *
 * URLs are SAS-signed (read for getUrl, create+write for getUploadUrl).
 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import {
  BlobSASPermissions,
  BlobServiceClient,
  type ContainerClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential
} from '@azure/storage-blob'
import type { StorageProvider, StoredStream } from './index.js'
import { StoredObjectMissing } from './missing.js'
import { parseByteRange } from './range.js'

const SAS_EXPIRES_MS = 3600 * 1000 // 1 hour

function parseConnectionString(conn: string): { accountName: string; accountKey: string } {
  const parts = new Map(
    conn
      .split(';')
      .filter(Boolean)
      .map((p) => {
        const idx = p.indexOf('=')
        return [p.slice(0, idx), p.slice(idx + 1)] as [string, string]
      })
  )
  return {
    accountName: parts.get('AccountName') ?? '',
    accountKey: parts.get('AccountKey') ?? ''
  }
}

/** A 404 / BlobNotFound from the SDK: the blob is not there. */
export function azureMissing(err: unknown): boolean {
  const e = err as { statusCode?: unknown; code?: unknown; details?: { errorCode?: unknown } }
  return (
    e?.statusCode === 404 || e?.code === 'BlobNotFound' || e?.details?.errorCode === 'BlobNotFound'
  )
}

/** The SDK's download body as a Node stream. */
function azureBody(body: NodeJS.ReadableStream | undefined, key: string): Readable {
  if (!body) throw new Error(`Azure blob has no body: ${key}`)
  return body instanceof Readable ? body : Readable.from(body as AsyncIterable<Buffer>)
}

export class AzureStorage implements StorageProvider {
  private container: ContainerClient
  private containerName: string
  private credential: StorageSharedKeyCredential
  private cdnUrl: string
  private accountName: string

  constructor() {
    const conn = process.env.STORAGE_AZURE_CONNECTION_STRING ?? ''
    this.containerName = process.env.STORAGE_AZURE_CONTAINER ?? ''
    this.cdnUrl = (process.env.STORAGE_CDN_URL ?? '').replace(/\/+$/, '')
    if (!conn || !this.containerName) {
      throw new Error(
        'STORAGE_AZURE_CONNECTION_STRING and STORAGE_AZURE_CONTAINER are required when STORAGE_PROVIDER=azure'
      )
    }
    const { accountName, accountKey } = parseConnectionString(conn)
    this.accountName = accountName
    this.credential = new StorageSharedKeyCredential(accountName, accountKey)
    const service = BlobServiceClient.fromConnectionString(conn)
    this.container = service.getContainerClient(this.containerName)
  }

  async put(key: string, buffer: Buffer, mime: string): Promise<void> {
    await this.container
      .getBlockBlobClient(key)
      .uploadData(buffer, { blobHTTPHeaders: { blobContentType: mime } })
  }

  /** A file on disk, uploaded in blocks straight from the file (never read whole). */
  async putFile(
    key: string,
    path: string,
    mime: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<number> {
    const { size } = await stat(path)
    await this.container.getBlockBlobClient(key).uploadFile(path, {
      blobHTTPHeaders: { blobContentType: mime },
      abortSignal: opts.signal
    })
    return size
  }

  async get(key: string): Promise<Buffer> {
    return this.container.getBlockBlobClient(key).downloadToBuffer()
  }

  /**
   * The blob as a stream, never read whole (Hub moves, 0.3.215). A single `Range` header is
   * answered after reading the size. A missing blob throws StoredObjectMissing; any other error
   * is thrown as it is (a move counts it as failed, never missing).
   */
  async openStream(key: string, rangeHeader?: string): Promise<StoredStream> {
    const blob = this.container.getBlockBlobClient(key)
    try {
      if (rangeHeader) {
        const size = Number((await blob.getProperties()).contentLength ?? 0)
        const r = parseByteRange(rangeHeader, size)
        if (r === 'unsatisfiable')
          return { size, range: null, unsatisfiable: true, stream: Readable.from([]) }
        if (r) {
          const res = await blob.download(r.start, r.end - r.start + 1)
          return {
            size,
            range: r,
            unsatisfiable: false,
            stream: azureBody(res.readableStreamBody, key)
          }
        }
      }
      const res = await blob.download(0)
      const stream = azureBody(res.readableStreamBody, key)
      const size = Number(res.contentLength)
      if (!Number.isFinite(size) || size < 0) {
        stream.destroy()
        throw Object.assign(new Error('Azure answered without the blob size'), { status: 502 })
      }
      return { size, range: null, unsatisfiable: false, stream }
    } catch (err) {
      throw azureMissing(err) ? new StoredObjectMissing() : err
    }
  }

  /** Who this store is, for a move's same-container check: a hash of the account and the
   *  container. Never a credential; the names themselves never leave the process. */
  storeId(): string {
    return createHash('sha256')
      .update(`azure|${this.accountName.toLowerCase()}|${this.containerName}`)
      .digest('hex')
  }

  /**
   * Server-side copy inside this container (Hub moves, 0.3.215): Copy Blob from the source's
   * FULL name `rawSource` (same account: authorised by the account key), then the content type.
   * No byte passes through this process. Resolves to the copy's size.
   */
  async copyFrom(
    key: string,
    rawSource: string,
    mime: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<number> {
    const dest = this.container.getBlockBlobClient(key)
    const src = this.container.getBlockBlobClient(rawSource)
    const poller = await dest.beginCopyFromURL(src.url, { abortSignal: opts.signal })
    await poller.pollUntilDone()
    await dest.setHTTPHeaders({ blobContentType: mime }, { abortSignal: opts.signal })
    const props = await dest.getProperties({ abortSignal: opts.signal })
    return typeof props.contentLength === 'number' ? props.contentLength : -1
  }

  async exists(key: string): Promise<boolean> {
    try {
      return await this.container.getBlockBlobClient(key).exists()
    } catch {
      return false
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      const props = await this.container.getBlockBlobClient(key).getProperties()
      return typeof props.contentLength === 'number' ? props.contentLength : null
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    await this.container
      .getBlockBlobClient(key)
      .deleteIfExists()
      .catch(() => null)
  }

  getUrl(key: string): string {
    if (this.cdnUrl) return `${this.cdnUrl}/${key}`
    return this.sasUrl(key, 'r')
  }

  async getUploadUrl(key: string, _mime: string): Promise<string> {
    return this.sasUrl(key, 'cw')
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    for await (const blob of this.container.listBlobsFlat({ prefix })) {
      keys.push(blob.name)
    }
    return keys
  }

  private sasUrl(key: string, permissions: string): string {
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.containerName,
        blobName: key,
        permissions: BlobSASPermissions.parse(permissions),
        startsOn: new Date(Date.now() - 5 * 60 * 1000),
        expiresOn: new Date(Date.now() + SAS_EXPIRES_MS)
      },
      this.credential
    ).toString()
    return `${this.container.getBlockBlobClient(key).url}?${sas}`
  }
}
