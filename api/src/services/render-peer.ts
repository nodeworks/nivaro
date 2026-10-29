import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/**
 * Render peer (#2789). The release image comes in two variants: the full one
 * ships Chromium (PDFs, help-video cards) and ffmpeg (help-video probes,
 * remuxes, conversions); the slim one (`nodeworks/nivaro:<v>-slim`,
 * NIVARO_IMAGE_VARIANT=slim) ships neither. A slim process with RENDER_URL set
 * hands that work to a process that has the binaries, over its internal
 * routes under /api/internal/render (routes/internal-render.ts), with the
 * shared RENDER_TOKEN as a bearer. Callers never see the difference:
 * htmlToPdf() returns the same Buffer, probeVideo() the same object.
 *
 * Without a local binary and without RENDER_URL the work fails with a 503
 * that says what is missing — never puppeteer's or spawn's own error.
 */

export const RENDER_PEER_PREFIX = '/api/internal/render'
/** The largest HTML a PDF render accepts (inline images make reports big). */
export const RENDER_PDF_MAX_BYTES = 32 * 1024 * 1024
/** A single file handed to the peer: an uploaded video is at most 1.2 GB. */
export const RENDER_FILE_MAX_BYTES = Math.round(1.3 * 1024 * 1024 * 1024)
/** Music uploads are capped at 40 MB before conversion. */
export const RENDER_MUSIC_MAX_BYTES = 48 * 1024 * 1024
/** The largest PDF the client accepts back from the peer. */
export const RENDER_PDF_OUT_MAX_BYTES = 128 * 1024 * 1024
/** The largest converted or remuxed file the client accepts back (ffmpeg
 *  itself is bounded at twice the upload cap). */
export const RENDER_FILE_OUT_MAX_BYTES = RENDER_FILE_MAX_BYTES * 2
/** JSON answers (probes, health, refusals). */
const RENDER_JSON_MAX_BYTES = 1024 * 1024

export type RenderFileOp =
  | 'probe-video'
  | 'probe-streams'
  | 'remux'
  | 'convert-upload'
  | 'convert-music'

/** The longest each kind of peer call may take before it is abandoned. */
const OP_TIMEOUT_MS: Record<RenderFileOp | 'pdf' | 'png' | 'health' | 'encoders', number> = {
  health: 5_000,
  encoders: 60_000,
  pdf: 120_000,
  png: 60_000,
  'probe-video': 120_000,
  'probe-streams': 120_000,
  remux: 20 * 60_000,
  'convert-upload': 60 * 60_000,
  'convert-music': 15 * 60_000
}

export function renderOpTimeoutMs(
  op: RenderFileOp | 'pdf' | 'png' | 'health' | 'encoders'
): number {
  return OP_TIMEOUT_MS[op]
}

/** 'slim' | 'full' when the release image says which it is, else null (dev, other builds). */
export function imageVariant(): 'slim' | 'full' | null {
  const v = (process.env.NIVARO_IMAGE_VARIANT ?? '').trim().toLowerCase()
  return v === 'slim' || v === 'full' ? v : null
}

/**
 * May RENDER_URL use plain http to this host? Only on a network the token
 * never leaves: loopback, a single-label name or a swarm `tasks.<service>`
 * alias (overlay DNS; a name with `_` is never a public DNS name either), or
 * a private address (RFC 1918, IPv6 unique-local). Anything else needs https:,
 * or the bearer and every document would cross the network in clear.
 */
export function plainHttpAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|]$/g, '')
  if (h === 'localhost' || h === '::1') return true
  const v = isIP(h)
  if (v === 4) {
    const [a, b] = h.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (v === 6) return /^f[cd][0-9a-f]{2}:/.test(h)
  if (!h.includes('.')) return true
  if (h.includes('_')) return true
  return /^tasks\.[^.]+$/.test(h)
}

/** RENDER_URL checked: `{ url }` (an origin, no trailing slash), `{ error }`
 *  when it is set but unusable, or null when unset. */
export function renderPeerTarget(
  env: NodeJS.ProcessEnv = process.env
): { url: string } | { error: string } | null {
  const raw = (env.RENDER_URL ?? '').trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { error: 'RENDER_URL is not a URL' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return { error: 'RENDER_URL must be an http(s) URL' }
  if (u.username || u.password)
    return { error: 'RENDER_URL must not carry credentials (RENDER_TOKEN is the credential)' }
  if (u.protocol === 'http:' && !plainHttpAllowed(u.hostname))
    return {
      error:
        'RENDER_URL must use https: unless the host is loopback, a single-label or tasks.<service> name, or a private (RFC 1918) address'
    }
  return { url: raw.replace(/\/+$/, '') }
}

/** RENDER_URL when it is set and usable, else null. */
export function renderPeerUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = renderPeerTarget(env)
  return t && 'url' in t ? t.url : null
}

/** A URL with any password in it masked (as the env viewer does). */
export function maskUrl(raw: string | null): string | null {
  if (!raw) return raw
  return raw.replace(/(:\/\/[^/\s:@]*):[^@\s]*@/, '$1:••••••@').slice(0, 200)
}

/** The shortest RENDER_TOKEN a render server accepts. */
export const RENDER_TOKEN_MIN_LENGTH = 32

/** The shared secret (RENDER_TOKEN, or RENDER_TOKEN_FILE through the secrets loader). */
export function renderPeerToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = (env.RENDER_TOKEN ?? '').trim()
  return t.length > 0 ? t : null
}

/** Timing-safe bearer check. Both sides are hashed first, so the compare
 *  never leaks the token's length either. */
export function bearerMatches(header: string | string[] | undefined, token: string): boolean {
  const h = Array.isArray(header) ? header[0] : header
  if (!h || !/^Bearer\s+/i.test(h)) return false
  const given = createHash('sha256')
    .update(h.replace(/^Bearer\s+/i, '').trim())
    .digest()
  const want = createHash('sha256').update(token).digest()
  return timingSafeEqual(given, want)
}

export type RenderError = Error & { statusCode: number; code: string }

function renderError(statusCode: number, code: string, message: string): RenderError {
  return Object.assign(new Error(message), { statusCode, code })
}

/** Passes bytes through and fails past `max` (a body whose length is not
 *  known up front — chunked uploads, streamed answers). `onBytes` may veto a
 *  chunk by returning an error. */
export function byteCap(max: number, onBytes?: (n: number) => Error | undefined): Transform {
  let n = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length
      const veto = onBytes?.(chunk.length)
      if (veto) cb(veto)
      else if (n > max)
        cb(renderError(413, 'RENDER_TOO_LARGE', 'The render answer or file is too large'))
      else cb(null, chunk)
    }
  })
}

function tooLarge(): RenderError {
  return renderError(
    502,
    'RENDER_PEER_TOO_LARGE',
    'The render server sent more than this server accepts'
  )
}

/** The answer's body, refused past `max` (Content-Length first, then counted). */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!res.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of Readable.fromWeb(res.body as unknown as WebReadableStream)) {
    const b = c as Buffer
    n += b.length
    if (n > max) throw tooLarge()
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse((await readCapped(res, RENDER_JSON_MAX_BYTES)).toString('utf8')) as T
}

/** The readable refusal when neither a local binary nor a render peer exists. */
export function renderUnavailable(what: 'pdf' | 'ffmpeg'): RenderError {
  const target = renderPeerTarget()
  if (target && 'error' in target) return renderError(503, 'RENDER_UNAVAILABLE', target.error)
  const slim = imageVariant() === 'slim'
  const missing = what === 'pdf' ? 'Chromium' : 'ffmpeg'
  const job = what === 'pdf' ? 'make PDFs' : 'read or convert videos and audio'
  const why = slim
    ? `it runs the slim image, which has no ${missing}`
    : `${missing} is not installed`
  return renderError(
    503,
    'RENDER_UNAVAILABLE',
    `This server cannot ${job}: ${why}, and no render server is configured (RENDER_URL).`
  )
}

function peerOrThrow(what: 'pdf' | 'ffmpeg'): { url: string; token: string } {
  const url = renderPeerUrl()
  if (!url) throw renderUnavailable(what)
  const token = renderPeerToken()
  if (!token)
    throw renderError(
      503,
      'RENDER_UNAVAILABLE',
      'RENDER_URL is set but RENDER_TOKEN is not: this server cannot reach its render server.'
    )
  return { url, token }
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([t, signal]) : t
}

/** A peer refusal becomes the same error the local code would have thrown
 *  (statusCode + code + message), so callers keep their own handling. */
async function peerFailure(res: Response): Promise<RenderError> {
  let body: { message?: string; error?: string; code?: string } = {}
  try {
    body = await readJson<typeof body>(res)
  } catch {
    /* not JSON */
  }
  if (res.status === 401)
    return renderError(
      503,
      'RENDER_PEER_AUTH',
      'The render server refused this server (RENDER_TOKEN does not match).'
    )
  if (res.status === 404 && !body.code)
    return renderError(
      503,
      'RENDER_PEER_MISSING',
      'The render server does not offer rendering (RENDER_TOKEN is not set there, or it runs an older version).'
    )
  const message = body.message || body.error || `The render server answered ${res.status}`
  return renderError(res.status, body.code || 'RENDER_PEER_FAILED', message)
}

function networkFailure(err: unknown): RenderError {
  const e = err as Error
  if (e?.name === 'TimeoutError')
    return renderError(504, 'RENDER_PEER_TIMEOUT', 'The render server took too long to answer.')
  if (e?.name === 'AbortError')
    return Object.assign(e, { statusCode: 409, code: 'RENDER_CANCELLED' })
  return renderError(
    503,
    'RENDER_PEER_UNREACHABLE',
    `The render server could not be reached (${String(e?.message ?? err).slice(0, 200)}).`
  )
}

/** Render HTML to a PDF on the peer. Same contract as pdf-layout's htmlToPdf. */
export async function peerHtmlToPdf(
  html: string,
  opts: {
    format?: 'A4' | 'Letter'
    landscape?: boolean
    margin?: string
    allowOrigins?: string[]
  } = {}
): Promise<Buffer> {
  const { url, token } = peerOrThrow('pdf')
  const body = JSON.stringify({
    html,
    format: opts.format,
    landscape: opts.landscape,
    margin: opts.margin,
    // The origins THIS instance serves (its files, logos): the peer lets the
    // document load from them as it would here (#2789 security review).
    allow_origins: opts.allowOrigins
  })
  if (Buffer.byteLength(body) > RENDER_PDF_MAX_BYTES)
    throw renderError(413, 'RENDER_TOO_LARGE', 'This document is too large to turn into a PDF.')
  let res: Response
  try {
    res = await fetch(`${url}${RENDER_PEER_PREFIX}/pdf`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
      signal: withTimeout(renderOpTimeoutMs('pdf'))
    })
  } catch (err) {
    throw networkFailure(err)
  }
  if (!res.ok) throw await peerFailure(res)
  try {
    return await readCapped(res, RENDER_PDF_OUT_MAX_BYTES)
  } catch (err) {
    if ((err as RenderError).code === 'RENDER_PEER_TOO_LARGE') throw err
    throw networkFailure(err)
  }
}

/** The largest PNG the client accepts back from the peer (a form image, #3216). */
export const RENDER_PNG_OUT_MAX_BYTES = 24 * 1024 * 1024

/** Render HTML to a PNG on the peer. Same contract as pdf-layout's htmlToPng. */
export async function peerHtmlToPng(
  html: string,
  opts: { width?: number; maxHeight?: number; scale?: number; allowOrigins?: string[] } = {}
): Promise<Buffer> {
  const { url, token } = peerOrThrow('pdf')
  const body = JSON.stringify({
    html,
    width: opts.width,
    max_height: opts.maxHeight,
    scale: opts.scale,
    allow_origins: opts.allowOrigins
  })
  if (Buffer.byteLength(body) > RENDER_PDF_MAX_BYTES)
    throw renderError(413, 'RENDER_TOO_LARGE', 'This page is too large to turn into an image.')
  let res: Response
  try {
    res = await fetch(`${url}${RENDER_PEER_PREFIX}/png`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
      signal: withTimeout(renderOpTimeoutMs('png'))
    })
  } catch (err) {
    throw networkFailure(err)
  }
  if (!res.ok) throw await peerFailure(res)
  try {
    return await readCapped(res, RENDER_PNG_OUT_MAX_BYTES)
  } catch (err) {
    if ((err as RenderError).code === 'RENDER_PEER_TOO_LARGE') throw err
    throw networkFailure(err)
  }
}

/** The largest PDF whose pages the peer draws (#3186). */
export const RENDER_PDF_PAGES_MAX_BYTES = 20 * 1024 * 1024

/** Draw a PDF's first pages as JPEGs on the peer. Same contract as pdf-pages' pdfPageImages. */
export async function peerPdfPages(
  pdf: Buffer,
  opts: { maxPages: number; width: number }
): Promise<{ pages: Buffer[]; total: number }> {
  const { url, token } = peerOrThrow('pdf')
  if (pdf.length > RENDER_PDF_PAGES_MAX_BYTES)
    throw renderError(413, 'RENDER_TOO_LARGE', 'This PDF is too large to draw.')
  let res: Response
  try {
    res = await fetch(
      `${url}${RENDER_PEER_PREFIX}/pdf-pages?max_pages=${opts.maxPages}&width=${opts.width}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/pdf' },
        body: new Uint8Array(pdf),
        signal: withTimeout(renderOpTimeoutMs('pdf'))
      }
    )
  } catch (err) {
    throw networkFailure(err)
  }
  if (!res.ok) throw await peerFailure(res)
  let body: { pages?: unknown; total?: unknown }
  try {
    body = JSON.parse((await readCapped(res, RENDER_PDF_OUT_MAX_BYTES)).toString('utf8'))
  } catch (err) {
    if ((err as RenderError).code === 'RENDER_PEER_TOO_LARGE') throw err
    throw networkFailure(err)
  }
  const pages = Array.isArray(body.pages)
    ? body.pages
        .filter((p): p is string => typeof p === 'string')
        .map((p) => Buffer.from(p, 'base64'))
    : []
  return { pages, total: Number(body.total) || pages.length }
}

/** The header a file op's JSON result rides on when the body is a file. */
export const RENDER_META_HEADER = 'x-nivaro-render-meta'

export function encodeMeta(meta: unknown): string {
  return Buffer.from(JSON.stringify(meta ?? null)).toString('base64url')
}

export function decodeMeta<T>(header: string | null): T | null {
  if (!header) return null
  try {
    return JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

/**
 * Stream one file to the peer for one fixed operation. With `output`, the
 * answer's body is a file written there (stream.pipeline, never .pipe) and the
 * JSON result rides the RENDER_META_HEADER; without, the body is the result.
 */
export async function peerFileOp<T>(
  op: RenderFileOp,
  input: string,
  params: { mime?: string; output?: string; signal?: AbortSignal } = {}
): Promise<T> {
  const { url, token } = peerOrThrow('ffmpeg')
  const size = await stat(input)
    .then((s) => s.size)
    .catch(() => -1)
  if (size < 0) throw renderError(422, 'RENDER_INPUT_MISSING', 'The file to process is missing')
  const limit = op === 'convert-music' ? RENDER_MUSIC_MAX_BYTES : RENDER_FILE_MAX_BYTES
  if (size > limit)
    throw renderError(413, 'RENDER_TOO_LARGE', 'This file is too large for the render server.')
  const q = new URLSearchParams()
  if (params.mime) q.set('mime', params.mime)
  const signal = withTimeout(renderOpTimeoutMs(op), params.signal)
  let res: Response
  try {
    res = await fetch(`${url}${RENDER_PEER_PREFIX}/file/${op}?${q.toString()}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream'
      },
      body: Readable.toWeb(createReadStream(input)) as unknown as RequestInit['body'],
      // Node's fetch needs this for a streamed request body.
      duplex: 'half',
      signal
    } as RequestInit & { duplex: 'half' })
  } catch (err) {
    throw networkFailure(err)
  }
  if (!res.ok) throw await peerFailure(res)
  if (!params.output) return readJson<T>(res)
  if (!res.body) throw renderError(502, 'RENDER_PEER_FAILED', 'The render server sent no file')
  const outMax = op === 'convert-music' ? RENDER_MUSIC_MAX_BYTES : RENDER_FILE_OUT_MAX_BYTES
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > outMax) {
    await res.body.cancel().catch(() => undefined)
    throw tooLarge()
  }
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream),
      byteCap(outMax),
      createWriteStream(params.output)
    )
  } catch (err) {
    if ((err as RenderError).code === 'RENDER_TOO_LARGE') throw tooLarge()
    throw networkFailure(err)
  }
  return decodeMeta<T>(res.headers.get(RENDER_META_HEADER)) as T
}

/** The peer's help-video encoder report (what renders there can use). */
export async function peerEncoders<T>(fresh = false): Promise<T> {
  const { url, token } = peerOrThrow('ffmpeg')
  let res: Response
  try {
    res = await fetch(`${url}${RENDER_PEER_PREFIX}/encoders${fresh ? '?fresh=1' : ''}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: withTimeout(renderOpTimeoutMs('encoders'))
    })
  } catch (err) {
    throw networkFailure(err)
  }
  if (!res.ok) throw await peerFailure(res)
  return (await readJson<{ hardware: T }>(res)).hardware
}

export interface RenderPeerHealth {
  configured: boolean
  ok: boolean
  url: string | null
  chromium?: boolean
  ffmpeg?: boolean
  version?: string | null
  ms?: number
  error?: string
}

/** Does the peer answer, and what can it do? Never throws. */
export async function probeRenderPeer(): Promise<RenderPeerHealth> {
  const target = renderPeerTarget()
  if (!target) return { configured: false, ok: false, url: null }
  const shown = maskUrl((process.env.RENDER_URL ?? '').trim())
  if ('error' in target) return { configured: true, ok: false, url: shown, error: target.error }
  const { url } = target
  const token = renderPeerToken()
  if (!token) return { configured: true, ok: false, url: shown, error: 'RENDER_TOKEN is not set' }
  const t0 = Date.now()
  try {
    const res = await fetch(`${url}${RENDER_PEER_PREFIX}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(renderOpTimeoutMs('health'))
    })
    const ms = Date.now() - t0
    if (!res.ok) {
      const e = await peerFailure(res)
      return { configured: true, ok: false, url: shown, ms, error: e.message }
    }
    const j = await readJson<{ chromium?: boolean; ffmpeg?: boolean; version?: string }>(res)
    return {
      configured: true,
      ok: true,
      url: shown,
      ms,
      chromium: !!j.chromium,
      ffmpeg: !!j.ffmpeg,
      version: j.version ?? null
    }
  } catch (err) {
    return { configured: true, ok: false, url: shown, error: networkFailure(err).message }
  }
}

/**
 * Does this process have somewhere for its PDFs and video work to run? The
 * readiness check and /api/preflight share this verdict.
 *
 *   ok   the binaries are here, or the render server answers and has what
 *        this process lacks;
 *   fail this process needs the render server and it is missing, refused,
 *        unreachable or lacks a binary — on the slim image that is a config
 *        error people would meet as 503s, so a deploy gate must stop it
 *        (start or update the worker before the web tasks);
 *   warn the same gap on a process that is not the slim image (a dev box
 *        without ffmpeg), or a RENDER_URL that is set but broken while the
 *        binaries are here anyway.
 */
export function judgeRenderSetup(
  local: { chromium: boolean; ffmpeg: boolean },
  peer: RenderPeerHealth,
  variant: 'slim' | 'full' | null,
  role: string | undefined = process.env.NIVARO_ROLE
): { status: 'ok' | 'warn' | 'fail'; summary: string } {
  return canaryLenient(judgeRenderSetupFor(local, peer, variant), role)
}

/**
 * A deploy canary (NIVARO_ROLE=canary) serves nobody and runs on its own
 * Redis without the worker, so what would fail elsewhere only warns there:
 * its preflight gates the migrations and the build, and the post-roll
 * preflight on a real web task gates the render server and the media worker.
 */
export function canaryLenient<T extends { status: 'ok' | 'warn' | 'fail'; summary: string }>(
  v: T,
  role: string | undefined = process.env.NIVARO_ROLE
): T {
  if (v.status !== 'fail' || (role ?? '').trim().toLowerCase() !== 'canary') return v
  return { ...v, status: 'warn', summary: `Canary (serves nobody): ${v.summary}` }
}

function judgeRenderSetupFor(
  local: { chromium: boolean; ffmpeg: boolean },
  peer: RenderPeerHealth,
  variant: 'slim' | 'full' | null
): { status: 'ok' | 'warn' | 'fail'; summary: string } {
  const needsPeer = !(local.chromium && local.ffmpeg)
  if (!needsPeer) {
    if (peer.configured && !peer.ok)
      return {
        status: 'warn',
        summary: `Chromium and ffmpeg are installed here; RENDER_URL is set but does not answer (${peer.error}).`
      }
    return { status: 'ok', summary: 'Chromium and ffmpeg are installed here.' }
  }
  const missing = [!local.chromium && 'Chromium', !local.ffmpeg && 'ffmpeg'].filter(Boolean)
  if (!peer.configured)
    return {
      status: variant === 'slim' ? 'fail' : 'warn',
      summary: `No ${missing.join(' or ')} here and no RENDER_URL: PDFs, video uploads and music refuse with a 503. Set RENDER_URL and RENDER_TOKEN to a full-image process.`
    }
  if (!peer.ok)
    return {
      status: 'fail',
      summary: `The render server (RENDER_URL) does not answer: ${peer.error}`
    }
  const lacks = [
    !local.chromium && !peer.chromium && 'Chromium',
    !local.ffmpeg && !peer.ffmpeg && 'ffmpeg'
  ].filter(Boolean)
  if (lacks.length)
    return {
      status: 'fail',
      summary: `The render server answers but has no ${lacks.join(' or ')} either.`
    }
  return {
    status: 'ok',
    summary: `The render server answers in ${peer.ms} ms (version ${peer.version}).`
  }
}
