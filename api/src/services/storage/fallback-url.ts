/**
 * Read-only fallback for uploaded files over HTTP: the SOURCE environment's API answers the
 * stored object (production refreshed down to staging / development keeps its files at home).
 *
 *   FILES_FALLBACK_URL    origin of the source API (https://efp-api.example.com)
 *   FILES_FALLBACK_TOKEN  the source's FILE_SOURCE_TOKEN (FILES_FALLBACK_TOKEN_FILE works)
 *
 * Asked only after this environment's own storage AND FILES_FALLBACK_DIR missed, and only from
 * inside the storage read — so every request reaching it already passed this environment's own
 * access check (services/file-access.ts). The source answers by nivaro_files id
 * (GET /api/internal/file-source/:id, routes/internal-file-source.ts): a key with no file row
 * here (session replays, upload parts, cached transforms) is never asked for.
 *
 * Read-only by construction: GET/HEAD only, the bytes stream straight through (never written
 * here, never buffered whole on the streaming path). A miss (404) is remembered for 60 s so a
 * missing file does not ask the source on every render; a source in trouble (401, 5xx,
 * unreachable) is left alone for 15 s. Off in cloud mode.
 */
import {
  type Agent as HttpAgent,
  type IncomingMessage,
  Agent as PlainAgent,
  request
} from 'node:http'
import { Agent as TlsAgent, request as tlsRequest } from 'node:https'
import { PassThrough, pipeline, Readable } from 'node:stream'
import { isMultiTenant } from '../deployment-mode.js'

export const FILE_SOURCE_PATH = '/api/internal/file-source'
export const FILE_SOURCE_TOKEN_MIN_LENGTH = 32

const CONNECT_TIMEOUT_MS = 5_000
const IDLE_TIMEOUT_MS = 30_000
const MISS_TTL_MS = 60_000
const TROUBLE_TTL_MS = 15_000
const MISS_CACHE_MAX = 10_000
/** The buffered path (thumbnails, PDFs, partner pushes) holds the file in memory anyway; past
 *  this a source copy is not worth the process. */
const BUFFER_MAX_BYTES = 512 * 1024 * 1024

/** The source origin, or null (unset, not http(s), carries credentials/path/query, cloud mode). */
export function filesFallbackUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isMultiTenant(env)) return null
  const raw = env.FILES_FALLBACK_URL?.trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password || u.search || u.hash) return null
  if (u.pathname !== '/' && u.pathname !== '') return null
  return u.origin
}

/** The bearer the source expects, or null when unset or too short to be the real one. */
export function filesFallbackToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = (env.FILES_FALLBACK_TOKEN ?? '').trim()
  return t.length >= FILE_SOURCE_TOKEN_MIN_LENGTH ? t : null
}

/** Both halves set and usable. */
export function fallbackSourceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!filesFallbackUrl(env) && !!filesFallbackToken(env)
}

/** Test seam: how a storage key becomes the file id the source answers by. */
export const fallbackUrlDeps = {
  async fileIdForKey(key: string): Promise<string | null> {
    const { db } = await import('../../db/index.js')
    const row = (await db('nivaro_files').where('filename_disk', key).first('id')) as
      | { id: unknown }
      | undefined
    return row?.id ? String(row.id) : null
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    void import('../io-holder.js')
      .then(({ getApp }) => getApp()?.log?.warn?.(meta ?? {}, msg))
      .catch(() => {})
  }
}

const misses = new Map<string, number>()
let troubleUntil = 0
let lastWarnAt = 0

/** Forget every remembered miss and trouble window (tests; a changed setting). */
export function resetFallbackUrlState(): void {
  misses.clear()
  troubleUntil = 0
  lastWarnAt = 0
}

function rememberMiss(key: string, now = Date.now()): void {
  if (misses.size >= MISS_CACHE_MAX) misses.clear()
  misses.set(key, now + MISS_TTL_MS)
}

function knownMiss(key: string, now = Date.now()): boolean {
  const until = misses.get(key)
  if (until === undefined) return false
  if (until > now) return true
  misses.delete(key)
  return false
}

function noteTrouble(reason: string, meta: Record<string, unknown>): void {
  const now = Date.now()
  troubleUntil = now + TROUBLE_TTL_MS
  // One line a minute: the source being down must not flood the log on a busy list page.
  if (now - lastWarnAt < 60_000) return
  lastWarnAt = now
  fallbackUrlDeps.warn(`file fallback source: ${reason}`, meta)
}

let plainAgent: HttpAgent | null = null
let tlsAgent: TlsAgent | null = null
function agentFor(protocol: string): HttpAgent | TlsAgent {
  if (protocol === 'https:') {
    tlsAgent ??= new TlsAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 })
    return tlsAgent
  }
  plainAgent ??= new PlainAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 })
  return plainAgent
}

/** Only one plain byte range goes to the source; anything else asks for the whole object. */
function passRange(header: string | undefined): string | undefined {
  if (!header) return undefined
  const h = header.trim()
  return /^bytes=(\d+-\d*|-\d+)$/.test(h) ? h : undefined
}

/**
 * One request to the source with the connect / idle timeouts. Resolves with the response
 * (headers in, body not yet read). Never logs the token.
 */
export function sourceRequest(
  method: 'GET' | 'HEAD',
  path: string,
  opts: { origin: string; token: string | null; range?: string }
): Promise<IncomingMessage> {
  const url = new URL(path, opts.origin)
  const headers: Record<string, string> = { 'Accept-Encoding': 'identity' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.range) headers.Range = opts.range
  const send = url.protocol === 'https:' ? tlsRequest : request
  return new Promise((resolve, reject) => {
    const req = send(url, { method, headers, agent: agentFor(url.protocol) })
    const connectTimer = setTimeout(
      () => req.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })),
      CONNECT_TIMEOUT_MS
    )
    req.once('socket', (socket) => {
      const connected = () => clearTimeout(connectTimer)
      // A kept-alive socket is already connected.
      if (!(socket as { connecting?: boolean }).connecting) connected()
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected)
    })
    // Idle: no bytes either way for this long, headers or body alike.
    req.setTimeout(IDLE_TIMEOUT_MS, () =>
      req.destroy(Object.assign(new Error('idle timeout'), { code: 'ETIMEDOUT' }))
    )
    req.once('response', (res) => {
      clearTimeout(connectTimer)
      resolve(res)
    })
    req.once('error', (err) => {
      clearTimeout(connectTimer)
      reject(err)
    })
    req.end()
  })
}

export interface RemoteObject {
  size: number
  range: { start: number; end: number } | null
  unsatisfiable: boolean
  stream: Readable
}

function parseContentRange(
  v: string | undefined
): { start: number; end: number; size: number } | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(v ?? '').trim())
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), size: Number(m[3]) }
}

/**
 * The source's copy of `key`, streamed: null when there is no fallback source, no file row for
 * the key here, or the source has no copy (a 404, remembered 60 s). The body goes through
 * stream.pipeline into the returned stream, so a source error ends that stream with the error
 * (the response is cut, never the process).
 */
export async function openFallbackUrl(
  key: string,
  rangeHeader?: string,
  /** P6-36: throw (status 502) on trouble instead of answering null, so "not there" and "could
   *  not ask" stay apart; a 404, a known miss or no configured source are still null. */
  opts: { throwOnTrouble?: boolean } = {}
): Promise<RemoteObject | null> {
  const trouble = (why: string): null => {
    if (opts.throwOnTrouble)
      throw Object.assign(new Error(`The fallback source could not be read (${why})`), {
        status: 502
      })
    return null
  }
  const origin = filesFallbackUrl()
  const token = filesFallbackToken()
  if (!origin || !token || !key) return null
  if (knownMiss(key)) return null
  if (Date.now() < troubleUntil) return trouble('backing off')
  let id: string | null
  try {
    id = await fallbackUrlDeps.fileIdForKey(key)
  } catch {
    return trouble('lookup')
  }
  if (!id) {
    rememberMiss(key)
    return null
  }
  let res: IncomingMessage
  try {
    res = await sourceRequest('GET', `${FILE_SOURCE_PATH}/${encodeURIComponent(id)}`, {
      origin,
      token,
      range: passRange(rangeHeader)
    })
  } catch (err) {
    noteTrouble('unreachable', { origin, code: (err as { code?: string }).code ?? null })
    return trouble('unreachable')
  }
  const status = res.statusCode ?? 0
  const drop = () => res.resume()
  if (status === 404) {
    drop()
    rememberMiss(key)
    return null
  }
  if (status === 416) {
    drop()
    const m = /^bytes \*\/(\d+)$/.exec(String(res.headers['content-range'] ?? '').trim())
    return {
      size: m ? Number(m[1]) : 0,
      range: null,
      unsatisfiable: true,
      stream: Readable.from([])
    }
  }
  if (status !== 200 && status !== 206) {
    drop()
    noteTrouble(status === 401 ? 'token refused (401)' : `answered ${status}`, { origin, status })
    return trouble(`answered ${status}`)
  }
  let size: number
  let range: RemoteObject['range'] = null
  if (status === 206) {
    const cr = parseContentRange(res.headers['content-range'] as string | undefined)
    if (!cr) {
      res.destroy()
      noteTrouble('206 without a Content-Range', { origin })
      return trouble('206 without a Content-Range')
    }
    size = cr.size
    range = { start: cr.start, end: cr.end }
  } else {
    size = Number(res.headers['content-length'])
    if (!Number.isFinite(size) || size < 0) {
      res.destroy()
      noteTrouble('answer without a Content-Length', { origin })
      return null
    }
  }
  const out = new PassThrough()
  pipeline(res, out, () => {
    // The error (if any) already reached `out`; nothing else to do — never rethrow here.
  })
  return { size, range, unsatisfiable: false, stream: out }
}

/**
 * Does the source hold a copy of `key`? One HEAD request with the same caches as a read:
 * true = the source has it, false = it answered 404 (remembered 60 s) or there is no file row
 * for the key here, null = unknown (no source configured, or the source is in trouble — never
 * a reason to call a file missing).
 */
export async function fallbackUrlHas(key: string): Promise<boolean | null> {
  const origin = filesFallbackUrl()
  const token = filesFallbackToken()
  if (!origin || !token || !key) return null
  if (knownMiss(key)) return false
  if (Date.now() < troubleUntil) return null
  let id: string | null
  try {
    id = await fallbackUrlDeps.fileIdForKey(key)
  } catch {
    return null
  }
  if (!id) return false
  let res: IncomingMessage
  try {
    res = await sourceRequest('HEAD', `${FILE_SOURCE_PATH}/${encodeURIComponent(id)}`, {
      origin,
      token
    })
  } catch (err) {
    noteTrouble('unreachable', { origin, code: (err as { code?: string }).code ?? null })
    return null
  }
  const status = res.statusCode ?? 0
  res.resume()
  if (status === 200 || status === 206) return true
  if (status === 404) {
    rememberMiss(key)
    return false
  }
  noteTrouble(status === 401 ? 'token refused (401)' : `answered ${status}`, { origin, status })
  return null
}

/** The source's whole copy in memory (callers that buffer anyway), or null. */
export async function readFallbackUrl(key: string): Promise<Buffer | null> {
  const o = await openFallbackUrl(key)
  if (!o || o.unsatisfiable) return null
  if (o.size > BUFFER_MAX_BYTES) {
    o.stream.destroy()
    return null
  }
  const chunks: Buffer[] = []
  try {
    for await (const c of o.stream) chunks.push(Buffer.from(c as Buffer))
  } catch {
    return null
  }
  return Buffer.concat(chunks)
}

/** The first `bytes` of the source's copy (one ranged request), or null. */
export async function peekFallbackUrl(key: string, bytes: number): Promise<Buffer | null> {
  if (bytes <= 0) return Buffer.alloc(0)
  const o = await openFallbackUrl(key, `bytes=0-${bytes - 1}`)
  if (!o) return null
  if (o.unsatisfiable) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let got = 0
  try {
    for await (const c of o.stream) {
      const b = Buffer.from(c as Buffer)
      chunks.push(b)
      got += b.length
      if (got >= bytes) break
    }
  } catch {
    return null
  } finally {
    o.stream.destroy()
  }
  return Buffer.concat(chunks).subarray(0, bytes)
}

export type FallbackSourceVerdict = { status: 'ok' | 'warn'; summary: string }

/**
 * Readiness: a HEAD for an id no file has, with the token (expect 404) and without (expect 401).
 * `probe` answers a status, or null when the source could not be reached.
 */
export function judgeFallbackSource(input: {
  url: string | null
  rawUrl: string | undefined
  token: string | null
  withToken: number | null
  withoutToken: number | null
}): FallbackSourceVerdict {
  if (!input.url)
    return {
      status: 'warn',
      summary: `FILES_FALLBACK_URL is not a plain http(s) origin (${input.rawUrl ? 'check the value' : 'unset'}).`
    }
  if (!input.token)
    return {
      status: 'warn',
      summary: `FILES_FALLBACK_TOKEN is missing or shorter than ${FILE_SOURCE_TOKEN_MIN_LENGTH} characters: files this environment has no copy of show as missing.`
    }
  if (input.withToken === null)
    return {
      status: 'warn',
      summary: `${input.url} cannot be reached: files this environment has no copy of show as missing.`
    }
  if (input.withToken === 401)
    return {
      status: 'warn',
      summary: `${input.url} refuses FILES_FALLBACK_TOKEN (401): it must equal the source's FILE_SOURCE_TOKEN.`
    }
  if (input.withToken === 404 && input.withoutToken === 401)
    return {
      status: 'ok',
      summary: `Files this environment has no copy of are read from ${input.url}.`
    }
  if (input.withToken === 404)
    return {
      status: 'warn',
      summary: `${input.url} does not serve files (no FILE_SOURCE_TOKEN set there, or an older version).`
    }
  return {
    status: 'warn',
    summary: `${input.url} answered ${input.withToken} for a file it does not have (expected 404).`
  }
}

/** A file id no row will ever have (the probe's "known missing" id). */
export const PROBE_MISSING_ID = '00000000-0000-0000-0000-000000000000'

export async function probeFallbackSource(
  env: NodeJS.ProcessEnv = process.env
): Promise<FallbackSourceVerdict> {
  const url = filesFallbackUrl(env)
  const token = filesFallbackToken(env)
  const ask = async (withToken: boolean): Promise<number | null> => {
    if (!url) return null
    try {
      const res = await sourceRequest('HEAD', `${FILE_SOURCE_PATH}/${PROBE_MISSING_ID}`, {
        origin: url,
        token: withToken ? token : null
      })
      res.resume()
      return res.statusCode ?? null
    } catch {
      return null
    }
  }
  const withToken = url && token ? await ask(true) : null
  const withoutToken = url && token && withToken === 404 ? await ask(false) : null
  return judgeFallbackSource({
    url,
    rawUrl: env.FILES_FALLBACK_URL,
    token,
    withToken,
    withoutToken
  })
}
