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
import {
  BlobSASPermissions,
  BlobServiceClient,
  type ContainerClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential
} from '@azure/storage-blob'
import type { StorageProvider } from './index.js'

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

export class AzureStorage implements StorageProvider {
  private container: ContainerClient
  private containerName: string
  private credential: StorageSharedKeyCredential
  private cdnUrl: string

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
    this.credential = new StorageSharedKeyCredential(accountName, accountKey)
    const service = BlobServiceClient.fromConnectionString(conn)
    this.container = service.getContainerClient(this.containerName)
  }

  async put(key: string, buffer: Buffer, mime: string): Promise<void> {
    await this.container
      .getBlockBlobClient(key)
      .uploadData(buffer, { blobHTTPHeaders: { blobContentType: mime } })
  }

  async get(key: string): Promise<Buffer> {
    return this.container.getBlockBlobClient(key).downloadToBuffer()
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
