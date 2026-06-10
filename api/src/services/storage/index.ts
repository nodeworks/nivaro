/**
 * Pluggable storage layer.
 *
 * Selected via env STORAGE_PROVIDER (local | s3 | azure, default local).
 * Env vars are read from process.env directly — see local.ts / s3.ts / azure.ts
 * for the provider-specific variables.
 */
import { AzureStorage } from './azure.js'
import { LocalStorage } from './local.js'
import { S3Storage } from './s3.js'

export interface StorageProvider {
  /** Persist a buffer under the given key. */
  put(key: string, buffer: Buffer, mime: string): Promise<void>
  /** Read a full object into memory. Throws if missing. */
  get(key: string): Promise<Buffer>
  /** Delete an object (no-op when missing). */
  delete(key: string): Promise<void>
  /**
   * Public URL for the object — presigned for s3/azure, an
   * /api/files/raw/<key> path for local storage.
   */
  getUrl(key: string): string | Promise<string>
  /** Presigned PUT url for direct client uploads (s3/azure only). */
  getUploadUrl?(key: string, mime: string): Promise<string>
  /** List object keys under a prefix (used by the cleanup job). */
  list?(prefix: string): Promise<string[]>
}

let _storage: StorageProvider | null = null
let _provider: string | null = null

export function getStorageProviderName(): 'local' | 's3' | 'azure' {
  const name = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase()
  return name === 's3' || name === 'azure' ? name : 'local'
}

export function getStorage(): StorageProvider {
  const name = getStorageProviderName()
  if (_storage && _provider === name) return _storage

  if (name === 's3') _storage = new S3Storage()
  else if (name === 'azure') _storage = new AzureStorage()
  else _storage = new LocalStorage()

  _provider = name
  return _storage
}
