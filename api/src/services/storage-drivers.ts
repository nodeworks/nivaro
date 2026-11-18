/**
 * Settings-driven storage drivers (#527).
 *
 * The env-driven layer in services/storage/ keeps working exactly as before
 * (STORAGE_PROVIDER — the cloud repo's contract). This module adds a runtime
 * layer resolved from nivaro_settings.storage_driver + storage_config so a
 * self-hosted admin can point NEW uploads at S3/R2/MinIO or Azure Blob from
 * the Settings UI, no restart and no new npm dependency — S3 is signed with a
 * minimal SigV4 implementation and Azure with Shared Key auth, both over raw
 * fetch.
 *
 * Semantics that matter:
 *  - storage_driver null/''/'local' → the env-driven provider (local disk by
 *    default), byte-identical to historic behavior.
 *  - Existing files are NOT migrated. Reads try the active driver first and
 *    FALL BACK to the env/local provider, so flipping the driver never 404s
 *    history.
 *  - Config is cached 60s; `bustStorageDriverCache()` is called by the
 *    storage-config route so edits apply immediately.
 */
import { createHash, createHmac } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { db } from '../db/index.js'
import { readFallback } from './storage/fallback.js'
import { readFallbackUrl } from './storage/fallback-url.js'
import { getStorage } from './storage/index.js'
import { instrumentStorage } from './storage/instrument.js'

export type StorageDriverName = 'local' | 's3' | 'azure-blob'

export interface S3DriverConfig {
  bucket: string
  region?: string
  access_key_id: string
  secret_access_key: string
  /** Optional custom endpoint (R2 / MinIO) — forces path-style addressing. */
  endpoint?: string
}

export interface AzureBlobDriverConfig {
  account: string
  container: string
  account_key: string
}

export interface StorageDriver {
  name: string
  put(key: string, buffer: Buffer, mime: string): Promise<void>
  /** A file on disk, sent without reading it whole into memory; resolves to the bytes stored. */
  putFile(key: string, path: string, mime: string, opts?: { signal?: AbortSignal }): Promise<number>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}

// ─── SigV4 S3 driver (raw fetch, no SDK) ─────────────────────────────────────

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** A request body read from a file on disk (streamed; never held in memory). */
interface FileBody {
  path: string
  size: number
}

/** SHA-256 of a file, read as a stream (SigV4 signs the payload hash). */
async function sha256OfFile(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** Request time for a body of `bytes`: 30 s, plus a second per MiB, at most 30 minutes. */
function bodyTimeoutMs(bytes: number): number {
  return Math.min(30 * 60_000, 30_000 + Math.ceil(bytes / (1024 * 1024)) * 1000)
}

/** fetch options for a body: a Buffer as is, a file as a stream with its length. */
function fetchBody(
  body: Buffer | FileBody | undefined,
  signal?: AbortSignal
): {
  init: Record<string, unknown>
  headers: Record<string, string>
  timeoutMs: number
} {
  if (!body) return { init: {}, headers: {}, timeoutMs: 30_000 }
  if (Buffer.isBuffer(body))
    // Node's fetch accepts a Buffer body directly.
    return { init: { body }, headers: {}, timeoutMs: bodyTimeoutMs(body.length) }
  return {
    // Streamed from disk; the explicit length keeps it one plain (not chunked) request.
    init: { body: Readable.toWeb(createReadStream(body.path, { signal })), duplex: 'half' },
    headers: { 'content-length': String(body.size) },
    timeoutMs: bodyTimeoutMs(body.size)
  }
}

/** RFC 3986 strict URI encoding as required by SigV4 (slashes preserved per segment). */
function uriEncodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

class SettingsS3Driver implements StorageDriver {
  readonly name = 's3'
  private cfg: Required<Pick<S3DriverConfig, 'bucket' | 'access_key_id' | 'secret_access_key'>> & {
    region: string
    endpoint: string
  }

  constructor(cfg: S3DriverConfig) {
    if (!cfg.bucket || !cfg.access_key_id || !cfg.secret_access_key) {
      throw new Error('S3 storage config requires bucket, access_key_id and secret_access_key')
    }
    this.cfg = {
      bucket: cfg.bucket,
      region: cfg.region?.trim() || 'us-east-1',
      access_key_id: cfg.access_key_id,
      secret_access_key: cfg.secret_access_key,
      endpoint: (cfg.endpoint ?? '').trim().replace(/\/+$/, '')
    }
  }

  private target(key: string): { url: string; host: string; path: string } {
    const encodedKey = key.split('/').map(uriEncodeSegment).join('/')
    if (this.cfg.endpoint) {
      const u = new URL(this.cfg.endpoint)
      const basePath = u.pathname.replace(/\/+$/, '')
      const path = `${basePath}/${uriEncodeSegment(this.cfg.bucket)}/${encodedKey}`
      return { url: `${u.protocol}//${u.host}${path}`, host: u.host, path }
    }
    const host = `${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com`
    const path = `/${encodedKey}`
    return { url: `https://${host}${path}`, host, path }
  }

  private async signedFetch(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    body?: Buffer | FileBody,
    mime?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const { url, host, path } = this.target(key)
    const now = new Date()
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
    const dateStamp = amzDate.slice(0, 8)
    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`
    const payloadHash =
      body && !Buffer.isBuffer(body) ? await sha256OfFile(body.path) : sha256Hex(body ?? '')

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate
    }
    if (method === 'PUT' && mime) headers['content-type'] = mime

    const signedHeaderNames = Object.keys(headers).sort()
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join('')
    const signedHeaders = signedHeaderNames.join(';')

    const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join(
      '\n'
    )
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join(
      '\n'
    )
    const kDate = hmac(`AWS4${this.cfg.secret_access_key}`, dateStamp)
    const kRegion = hmac(kDate, this.cfg.region)
    const kService = hmac(kRegion, 's3')
    const kSigning = hmac(kService, 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

    const { host: _h, ...sendHeaders } = headers
    const sent = fetchBody(body, signal)
    return fetch(url, {
      method,
      headers: {
        ...sendHeaders,
        ...sent.headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
      },
      ...(sent.init as RequestInit),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(sent.timeoutMs)])
        : AbortSignal.timeout(sent.timeoutMs)
    })
  }

  async put(key: string, buffer: Buffer, mime: string): Promise<void> {
    const res = await this.signedFetch('PUT', key, buffer, mime || 'application/octet-stream')
    if (!res.ok) {
      throw new Error(`S3 PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
  }

  /** One signed PUT streamed from disk (the payload hash is read first, also as a stream). */
  async putFile(
    key: string,
    path: string,
    mime: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<number> {
    const { size } = await stat(path)
    if (size > 5 * 1024 ** 3) throw new Error(`S3 PUT ${key}: one upload holds at most 5 GB`)
    const res = await this.signedFetch(
      'PUT',
      key,
      { path, size },
      mime || 'application/octet-stream',
      opts.signal
    )
    if (!res.ok) {
      throw new Error(`S3 PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
    return size
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.signedFetch('GET', key)
    if (!res.ok) {
      throw new Error(`S3 GET ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  async delete(key: string): Promise<void> {
    const res = await this.signedFetch('DELETE', key)
    // 404 = already gone; that's a successful delete.
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE ${key} failed: ${res.status}`)
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const res = await this.signedFetch('HEAD', key)
      return res.ok
    } catch {
      return false
    }
  }
}

// ─── Azure Blob Shared Key driver (raw fetch, no SDK) ────────────────────────

class SettingsAzureBlobDriver implements StorageDriver {
  readonly name = 'azure-blob'
  private account: string
  private container: string
  private keyBuf: Buffer

  constructor(cfg: AzureBlobDriverConfig) {
    if (!cfg.account || !cfg.container || !cfg.account_key) {
      throw new Error('Azure Blob storage config requires account, container and account_key')
    }
    this.account = cfg.account
    this.container = cfg.container
    this.keyBuf = Buffer.from(cfg.account_key, 'base64')
  }

  private url(key: string): string {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/')
    return `https://${this.account}.blob.core.windows.net/${encodeURIComponent(this.container)}/${encodedKey}`
  }

  private async signedFetch(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    body?: Buffer | FileBody,
    mime?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const date = new Date().toUTCString()
    const msHeaders: Record<string, string> = {
      'x-ms-date': date,
      'x-ms-version': '2021-08-06'
    }
    if (method === 'PUT') msHeaders['x-ms-blob-type'] = 'BlockBlob'

    const bodyBytes = !body ? 0 : Buffer.isBuffer(body) ? body.length : body.size
    const contentLength = bodyBytes > 0 ? String(bodyBytes) : ''
    const contentType = method === 'PUT' && mime ? mime : ''

    const canonicalizedHeaders = Object.keys(msHeaders)
      .sort()
      .map((h) => `${h}:${msHeaders[h]}\n`)
      .join('')
    const canonicalizedResource = `/${this.account}/${this.container}/${key}`

    const stringToSign = [
      method,
      '', // Content-Encoding
      '', // Content-Language
      contentLength,
      '', // Content-MD5
      contentType,
      '', // Date (using x-ms-date instead)
      '', // If-Modified-Since
      '', // If-Match
      '', // If-None-Match
      '', // If-Unmodified-Since
      '', // Range
      canonicalizedHeaders + canonicalizedResource
    ].join('\n')

    const signature = createHmac('sha256', this.keyBuf)
      .update(stringToSign, 'utf8')
      .digest('base64')

    const headers: Record<string, string> = {
      ...msHeaders,
      Authorization: `SharedKey ${this.account}:${signature}`
    }
    if (contentType) headers['Content-Type'] = contentType

    const sent = fetchBody(body, signal)
    return fetch(this.url(key), {
      method,
      headers: { ...headers, ...sent.headers },
      ...(sent.init as RequestInit),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(sent.timeoutMs)])
        : AbortSignal.timeout(sent.timeoutMs)
    })
  }

  async put(key: string, buffer: Buffer, mime: string): Promise<void> {
    const res = await this.signedFetch('PUT', key, buffer, mime || 'application/octet-stream')
    if (!res.ok) {
      throw new Error(`Azure PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
  }

  /** One Put Blob streamed from disk (a single Put Blob holds up to 5,000 MiB). */
  async putFile(
    key: string,
    path: string,
    mime: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<number> {
    const { size } = await stat(path)
    if (size > 5000 * 1024 ** 2)
      throw new Error(`Azure PUT ${key}: one upload holds at most 5,000 MiB`)
    const res = await this.signedFetch(
      'PUT',
      key,
      { path, size },
      mime || 'application/octet-stream',
      opts.signal
    )
    if (!res.ok) {
      throw new Error(`Azure PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
    return size
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.signedFetch('GET', key)
    if (!res.ok) {
      throw new Error(`Azure GET ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  async delete(key: string): Promise<void> {
    const res = await this.signedFetch('DELETE', key)
    if (!res.ok && res.status !== 404) {
      throw new Error(`Azure DELETE ${key} failed: ${res.status}`)
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const res = await this.signedFetch('HEAD', key)
      return res.ok
    } catch {
      return false
    }
  }
}

// ─── Env-provider wrapper (the 'local' / historic path) ──────────────────────

function envDriver(): StorageDriver {
  const storage = getStorage()
  return {
    name: 'local',
    put: (key, buffer, mime) => storage.put(key, buffer, mime),
    putFile: (key, path, mime, opts) => storage.putFile(key, path, mime, opts),
    get: (key) => storage.get(key),
    delete: (key) => storage.delete(key),
    exists: async (key) => (storage.exists ? storage.exists(key) : true)
  }
}

// ─── Resolution + cache ──────────────────────────────────────────────────────

export function normalizeDriverName(v: unknown): StorageDriverName {
  const name = String(v ?? '')
    .trim()
    .toLowerCase()
  if (name === 's3') return 's3'
  if (name === 'azure-blob' || name === 'azure') return 'azure-blob'
  return 'local'
}

/** Build a driver from an explicit (driver, config) pair — throws on bad config. */
export function buildDriver(
  driver: StorageDriverName,
  config: Record<string, unknown> | null
): StorageDriver {
  if (driver === 's3') return new SettingsS3Driver((config ?? {}) as unknown as S3DriverConfig)
  if (driver === 'azure-blob') {
    return new SettingsAzureBlobDriver((config ?? {}) as unknown as AzureBlobDriverConfig)
  }
  return envDriver()
}

let _cache: { fetched: number; driver: StorageDriver } | null = null
const CACHE_TTL_MS = 60_000

export function bustStorageDriverCache(): void {
  _cache = null
}

/** Read the configured driver + parsed config straight from settings (no cache). */
export async function readStorageSettings(): Promise<{
  driver: StorageDriverName
  config: Record<string, unknown> | null
}> {
  try {
    const row = (await db('nivaro_settings')
      .where({ id: 1 })
      .first('storage_driver', 'storage_config')) as
      | { storage_driver?: string | null; storage_config?: string | null }
      | undefined
    const driver = normalizeDriverName(row?.storage_driver)
    let config: Record<string, unknown> | null = null
    if (row?.storage_config) {
      try {
        const parsed = JSON.parse(String(row.storage_config))
        if (parsed && typeof parsed === 'object') config = parsed as Record<string, unknown>
      } catch {
        config = null
      }
    }
    return { driver, config }
  } catch {
    // Pre-migration DB / transient failure — historic behavior.
    return { driver: 'local', config: null }
  }
}

/**
 * The active storage driver for NEW writes. Broken/missing config degrades to
 * the env/local provider (an upload must never fail because of a half-typed
 * settings row) — the storage-test endpoint is where misconfiguration is
 * surfaced loudly.
 */
export async function getActiveStorageDriver(): Promise<StorageDriver> {
  if (_cache && Date.now() - _cache.fetched < CACHE_TTL_MS) return _cache.driver
  const { driver, config } = await readStorageSettings()
  let resolved: StorageDriver
  try {
    resolved = buildDriver(driver, config)
  } catch {
    resolved = envDriver()
  }
  // #2164: timed for the Traffic Map's storage node. The env provider is already timed inside
  // getStorage(), so it is not wrapped twice; the Settings "Test connection" probe builds its
  // driver with buildDriver and is not counted.
  const timed = resolved.name === 'local' ? resolved : instrumentStorage(resolved, resolved.name)
  _cache = { fetched: Date.now(), driver: timed }
  return timed
}

/**
 * Read a stored object: active driver first, then the env/local provider —
 * so switching drivers never 404s files uploaded before the switch (existing
 * files are deliberately NOT migrated). After an environment refresh, a key
 * this environment has no copy of is read from the source, read-only:
 * FILES_FALLBACK_DIR first, then FILES_FALLBACK_URL (unless `remote: false`
 * — the source route itself never asks another source).
 */
export async function readStoredObject(
  key: string,
  opts: { remote?: boolean } = {}
): Promise<Buffer> {
  try {
    return await readOwnStoredObject(key)
  } catch (err) {
    if (opts.remote === false) throw err
    const copy = await readFallbackUrl(key)
    if (copy) return copy
    throw err
  }
}

/** This environment's copy (active driver, env/local provider, FILES_FALLBACK_DIR) — never
 *  the HTTP source. */
export async function readOwnStoredObject(key: string): Promise<Buffer> {
  const active = await getActiveStorageDriver()
  try {
    return await active.get(key)
  } catch (err) {
    try {
      if (active.name === 'local') throw err
      return await getStorage().get(key)
    } catch (err2) {
      // After an environment refresh: the source's uploads, read-only (FILES_FALLBACK_DIR).
      const copy = await readFallback(key)
      if (copy) return copy
      throw err2
    }
  }
}

/**
 * Delete a stored object wherever it lives: the active driver AND the
 * env/local provider (a file may predate the current driver). Both attempts
 * are best-effort — deleteFile already treats storage deletes that way.
 */
export async function deleteStoredObject(key: string): Promise<void> {
  const active = await getActiveStorageDriver()
  await active.delete(key).catch(() => null)
  if (active.name !== 'local') {
    await getStorage()
      .delete(key)
      .catch(() => null)
  }
}

/**
 * Write+read+delete a tiny probe object against a candidate (or the active)
 * driver. Returns the failure detail instead of throwing — this feeds the
 * Settings "Test connection" button.
 */
export async function testStorageDriver(
  driver: StorageDriverName,
  config: Record<string, unknown> | null
): Promise<{ ok: boolean; error?: string }> {
  let d: StorageDriver
  try {
    d = buildDriver(driver, config)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const key = `storage-probe/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`
  const payload = Buffer.from(`nivaro storage probe ${new Date().toISOString()}`)
  try {
    await d.put(key, payload, 'text/plain')
    const back = await d.get(key)
    if (!back.equals(payload)) {
      await d.delete(key).catch(() => null)
      return { ok: false, error: 'Probe object read back with different content' }
    }
    await d.delete(key)
    return { ok: true }
  } catch (err) {
    // Best-effort cleanup if the probe landed but a later step failed.
    await d.delete(key).catch(() => null)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
