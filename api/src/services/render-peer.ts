import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
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

export type RenderFileOp =
  | 'probe-video'
  | 'probe-streams'
  | 'remux'
  | 'convert-upload'
  | 'convert-music'

/** The longest each kind of peer call may take before it is abandoned. */
const OP_TIMEOUT_MS: Record<RenderFileOp | 'pdf' | 'health', number> = {
  health: 5_000,
  pdf: 120_000,
  'probe-video': 120_000,
  'probe-streams': 120_000,
  remux: 20 * 60_000,
  'convert-upload': 60 * 60_000,
  'convert-music': 15 * 60_000
}

export function renderOpTimeoutMs(op: RenderFileOp | 'pdf' | 'health'): number {
  return OP_TIMEOUT_MS[op]
}

/** 'slim' | 'full' when the release image says which it is, else null (dev, other builds). */
export function imageVariant(): 'slim' | 'full' | null {
  const v = (process.env.NIVARO_IMAGE_VARIANT ?? '').trim().toLowerCase()
  return v === 'slim' || v === 'full' ? v : null
}

/** RENDER_URL as an origin with no trailing slash, or null when unset or not http(s). */
export function renderPeerUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.RENDER_URL ?? '').trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return raw.replace(/\/+$/, '')
  } catch {
    return null
  }
}

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

/** The readable refusal when neither a local binary nor a render peer exists. */
export function renderUnavailable(what: 'pdf' | 'ffmpeg'): RenderError {
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
    body = (await res.json()) as typeof body
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
  opts: { format?: 'A4' | 'Letter'; landscape?: boolean; margin?: string } = {}
): Promise<Buffer> {
  const { url, token } = peerOrThrow('pdf')
  const body = JSON.stringify({
    html,
    format: opts.format,
    landscape: opts.landscape,
    margin: opts.margin
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
  return Buffer.from(await res.arrayBuffer())
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
  if (!params.output) return (await res.json()) as T
  if (!res.body) throw renderError(502, 'RENDER_PEER_FAILED', 'The render server sent no file')
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream),
      createWriteStream(params.output)
    )
  } catch (err) {
    throw networkFailure(err)
  }
  return decodeMeta<T>(res.headers.get(RENDER_META_HEADER)) as T
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
  const url = renderPeerUrl()
  if (!url) return { configured: false, ok: false, url: null }
  const token = renderPeerToken()
  if (!token) return { configured: true, ok: false, url, error: 'RENDER_TOKEN is not set' }
  const t0 = Date.now()
  try {
    const res = await fetch(`${url}${RENDER_PEER_PREFIX}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(renderOpTimeoutMs('health'))
    })
    const ms = Date.now() - t0
    if (!res.ok) {
      const e = await peerFailure(res)
      return { configured: true, ok: false, url, ms, error: e.message }
    }
    const j = (await res.json()) as { chromium?: boolean; ffmpeg?: boolean; version?: string }
    return {
      configured: true,
      ok: true,
      url,
      ms,
      chromium: !!j.chromium,
      ffmpeg: !!j.ffmpeg,
      version: j.version ?? null
    }
  } catch (err) {
    return { configured: true, ok: false, url, error: networkFailure(err).message }
  }
}
