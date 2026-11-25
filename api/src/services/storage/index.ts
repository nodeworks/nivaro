/**
 * Pluggable storage layer.
 *
 * Selected via env STORAGE_PROVIDER (local | s3 | azure, default local).
 * Env vars are read from process.env directly — see local.ts / s3.ts / azure.ts
 * for the provider-specific variables.
 */
import type { Readable } from 'node:stream'
import { getTenantId } from '../../db/tenant-context.js'
import { tenantSource } from '../deployment-mode.js'
import { scopedStorage } from './app-scope.js'
import { AzureStorage } from './azure.js'
import { instrumentStorage } from './instrument.js'
import { LocalStorage } from './local.js'
import { S3Storage } from './s3.js'

export interface StorageProvider {
  /** Persist a buffer under the given key. */
  put(key: string, buffer: Buffer, mime: string): Promise<void>
  /**
   * Persist a file that sits on disk under the given key WITHOUT reading it whole into memory
   * (streaming exports, renders). Resolves to the bytes stored.
   */
  putFile(key: string, path: string, mime: string, opts?: { signal?: AbortSignal }): Promise<number>
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
  /** Cheap existence check — never downloads the object. Used by the
   *  dead-file-link detection (nightly sweep + on-demand verify). */
  exists?(key: string): Promise<boolean>
  /** The stored object's size in bytes, or null when it is missing — never downloads it (Hub
   *  phase 6: a move's file pull skips objects already present at the same size). */
  size?(key: string): Promise<number | null>
  /** The object as a stream, never read whole (env S3/Azure; a move's source route, 0.3.215).
   *  Throws StoredObjectMissing when it is not there. */
  openStream?(key: string, rangeHeader?: string): Promise<StoredStream>
  /** A hash naming the bucket/container this provider writes to (never a credential): a move
   *  copies server-side when source and target name the same one (0.3.215). */
  storeId?(): string
  /** Server-side copy inside the same bucket/container from the source's FULL key `rawSource`
   *  (never scoped) to `key`; resolves to the copy's size (0.3.215). */
  copyFrom?(
    key: string,
    rawSource: string,
    mime: string,
    opts?: { signal?: AbortSignal }
  ): Promise<number>
}

/** An object opened as a stream (a byte range of it when one was asked for and satisfiable). */
export interface StoredStream {
  size: number
  range: { start: number; end: number } | null
  unsatisfiable: boolean
  stream: Readable
}

let _storage: StorageProvider | null = null
let _provider: string | null = null
let _appScoped = false

export function getStorageProviderName(): 'local' | 's3' | 'azure' {
  const name = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase()
  return name === 's3' || name === 'azure' ? name : 'local'
}

export function getStorage(): StorageProvider {
  const name = getStorageProviderName()
  // Hub phase 6: on a Hub shared deployment every key lives under apps/<tenantId>/ of the app
  // the call runs in (services/storage/app-scope.ts). Self-hosted and cloud: unwrapped.
  const appScoped = tenantSource() === 'hub'
  if (_storage && _provider === name && _appScoped === appScoped) return _storage

  // #2164: every call is timed for the Traffic Map's storage node.
  let base: StorageProvider
  if (name === 's3') base = instrumentStorage(new S3Storage(), name)
  else if (name === 'azure') base = instrumentStorage(new AzureStorage(), name)
  else base = instrumentStorage(new LocalStorage(), name)
  _storage = appScoped ? scopedStorage(base, () => getTenantId() ?? null) : base

  _provider = name
  _appScoped = appScoped
  return _storage
}
