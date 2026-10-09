import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { assertSafeUrl } from '../lib/ssrf.js'

// Free music for help videos from Openverse (api.openverse.org), the open
// search over Freesound, Jamendo, Wikimedia and others. Only CC0 and public
// domain audio is ever offered or imported, so a video needs no credit and
// commercial use is fine; the license is checked again on the item itself
// at import, never taken from the browser. Audio is fetched by the server
// (the item's own url, SSRF-checked on every redirect hop) so a browser
// never talks to a third-party host.
//
// HELP_VIDEO_OPENVERSE=off turns it off (an instance without internet).
// OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET (optional) lift the
// anonymous rate limit; HELP_VIDEO_OPENVERSE_URL points at another API.

export interface OpenverseTrack {
  id: string
  title: string
  creator: string | null
  license: 'cc0' | 'pdm'
  license_url: string | null
  duration_ms: number | null
  provider: string | null
  landing_url: string | null
  attribution: string | null
}

/** Where a music file came from (kept with it, shown to authors). */
export interface MusicOrigin {
  provider: 'openverse'
  id: string
  creator: string | null
  license: 'cc0' | 'pdm'
  license_url: string | null
  landing_url: string | null
  source: string | null
}

export const OPENVERSE_LICENSES = ['cc0', 'pdm'] as const
const MAX_MS = 20 * 60_000
const PAGE_SIZE = 20
const SEARCH_TTL_MS = 10 * 60_000
const TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 90_000
const MAX_REDIRECTS = 3
const UA = 'Nivaro help-video music (+https://nivaro.dev)'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class OpenverseError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

export function openverseEnabled(): boolean {
  return (process.env.HELP_VIDEO_OPENVERSE ?? '').trim().toLowerCase() !== 'off'
}

function base(): string {
  return (process.env.HELP_VIDEO_OPENVERSE_URL || 'https://api.openverse.org/v1').replace(
    /\/+$/,
    ''
  )
}

let token: { value: string; until: number } | null = null

async function authHeader(): Promise<Record<string, string>> {
  const id = process.env.OPENVERSE_CLIENT_ID?.trim()
  const secret = process.env.OPENVERSE_CLIENT_SECRET?.trim()
  if (!id || !secret) return {}
  if (token && token.until > Date.now()) return { Authorization: `Bearer ${token.value}` }
  try {
    const res = await fetch(`${base()}/auth_tokens/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: id,
        client_secret: secret
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) return {}
    const j = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!j.access_token) return {}
    token = {
      value: j.access_token,
      until: Date.now() + Math.max(60, Number(j.expires_in ?? 3600) - 60) * 1000
    }
    return { Authorization: `Bearer ${token.value}` }
  } catch {
    return {} // anonymous still works, with the lower limit
  }
}

async function api(path: string): Promise<unknown> {
  if (!openverseEnabled()) {
    throw new OpenverseError(503, 'OPENVERSE_OFF', 'Free music search is switched off here')
  }
  let res: Response
  try {
    res = await fetch(`${base()}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA, ...(await authHeader()) },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    throw new OpenverseError(502, 'OPENVERSE_UNREACHABLE', 'Openverse could not be reached')
  }
  if (res.status === 404) throw new OpenverseError(404, 'OPENVERSE_NOT_FOUND', 'Track not found')
  if (res.status === 429) {
    throw new OpenverseError(
      429,
      'OPENVERSE_BUSY',
      'Openverse is limiting searches right now. Try again in a minute'
    )
  }
  if (!res.ok) {
    throw new OpenverseError(502, 'OPENVERSE_UNREACHABLE', `Openverse answered ${res.status}`)
  }
  return res.json()
}

const str = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
  return s || null
}
const httpUrl = (v: unknown): string | null => {
  const s = str(v, 500)
  return s && /^https?:\/\//i.test(s) ? s : null
}

/** One Openverse result as we offer it, or null when it may not be offered
 *  (not CC0 / public domain, no audio, mature, too long). */
export function toTrack(raw: unknown): (OpenverseTrack & { audio_url: string }) | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = String(r.id ?? '')
  const license = String(r.license ?? '').toLowerCase()
  const audio = httpUrl(r.url)
  if (!UUID_RE.test(id) || !audio) return null
  if (!(OPENVERSE_LICENSES as readonly string[]).includes(license)) return null
  if (r.mature === true) return null
  const d = Number(r.duration)
  const duration = Number.isFinite(d) && d > 0 ? Math.round(d) : null
  if (duration && duration > MAX_MS) return null
  return {
    id: id.toLowerCase(),
    title: str(r.title, 200)?.replace(/\.(mp3|wav|ogg|flac|m4a|aiff?)$/i, '') || 'Untitled',
    creator: str(r.creator, 200),
    license: license as 'cc0' | 'pdm',
    license_url: httpUrl(r.license_url),
    duration_ms: duration,
    provider: str(r.source ?? r.provider, 60),
    landing_url: httpUrl(r.foreign_landing_url),
    attribution: str(r.attribution, 500),
    audio_url: audio
  }
}

const searches = new Map<string, { at: number; value: SearchResult }>()
export interface SearchResult {
  results: OpenverseTrack[]
  page: number
  page_count: number
  result_count: number
}

/** Searches CC0 / public domain audio. Cached ten minutes per query. */
export async function searchOpenverse(q: string, page = 1): Promise<SearchResult> {
  const query = q.replace(/\s+/g, ' ').trim().slice(0, 100)
  if (!query) return { results: [], page: 1, page_count: 0, result_count: 0 }
  const p = Math.min(20, Math.max(1, Math.floor(page) || 1))
  const key = `${query.toLowerCase()}|${p}`
  const hit = searches.get(key)
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.value
  const qs = new URLSearchParams({
    q: query,
    license: OPENVERSE_LICENSES.join(','),
    page: String(p),
    page_size: String(PAGE_SIZE),
    mature: 'false'
  })
  const j = (await api(`/audio/?${qs}`)) as {
    results?: unknown[]
    page_count?: number
    result_count?: number
  }
  const value: SearchResult = {
    results: (j.results ?? []).flatMap((r) => {
      const t = toTrack(r)
      if (!t) return []
      const { audio_url: _a, ...rest } = t
      return [rest]
    }),
    page: p,
    page_count: Math.min(20, Number(j.page_count ?? 0) || 0),
    result_count: Number(j.result_count ?? 0) || 0
  }
  if (searches.size > 300) searches.clear()
  searches.set(key, { at: Date.now(), value })
  return value
}

const items = new Map<string, { at: number; value: OpenverseTrack & { audio_url: string } }>()

/** One item, re-read from Openverse (its license checked again). */
export async function openverseTrack(id: string): Promise<OpenverseTrack & { audio_url: string }> {
  if (!UUID_RE.test(id)) throw new OpenverseError(404, 'OPENVERSE_NOT_FOUND', 'Track not found')
  const key = id.toLowerCase()
  const hit = items.get(key)
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.value
  const t = toTrack(await api(`/audio/${key}/`))
  if (!t) {
    throw new OpenverseError(
      422,
      'OPENVERSE_LICENSE',
      'That track is not public domain (CC0), so it cannot be used'
    )
  }
  if (items.size > 500) items.clear()
  items.set(key, { at: Date.now(), value: t })
  return t
}

/** GETs a public URL, checking every redirect hop against private hosts. */
async function safeGet(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<Response> {
  let at = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(at).catch(() => {
      throw new OpenverseError(502, 'OPENVERSE_UNREACHABLE', 'The track’s address is not allowed')
    })
    let res: Response
    try {
      res = await fetch(at, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, Accept: 'audio/*', ...headers },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      throw new OpenverseError(502, 'OPENVERSE_UNREACHABLE', 'The track could not be downloaded')
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) break
      at = new URL(loc, at).toString()
      continue
    }
    if (!res.ok || !res.body) {
      throw new OpenverseError(
        502,
        'OPENVERSE_UNREACHABLE',
        `The track could not be downloaded (${res.status})`
      )
    }
    return res
  }
  throw new OpenverseError(502, 'OPENVERSE_UNREACHABLE', 'The track redirected too many times')
}

function capped(max: number): Transform {
  let n = 0
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      n += chunk.length
      if (n > max) done(new OpenverseError(413, 'MUSIC_TOO_LARGE', 'The track is over 40 MB'))
      else done(null, chunk)
    }
  })
}

/** Downloads a track's audio to `path` (at most `maxBytes`). */
export async function downloadTrack(
  t: { audio_url: string },
  path: string,
  maxBytes: number
): Promise<void> {
  const res = await safeGet(t.audio_url, DOWNLOAD_TIMEOUT_MS)
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > maxBytes) {
    throw new OpenverseError(413, 'MUSIC_TOO_LARGE', 'The track is over 40 MB')
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
    capped(maxBytes),
    createWriteStream(path)
  )
}

const PREVIEW_BYTES = 512 * 1024
const previews = new Map<string, { at: number; type: string; bytes: Buffer }>()

/**
 * The opening of a track for "Listen" (the editor plays ten seconds): at most
 * 512 KB, asked for with a Range header and cut off there when the host sends
 * more. Kept a while per track, so a second listen does not wait on the CDN
 * again (Freesound's can be slow).
 */
export async function previewBytes(t: {
  id: string
  audio_url: string
}): Promise<{ type: string; bytes: Buffer }> {
  const hit = previews.get(t.id)
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS * 3) return hit
  const res = await safeGet(t.audio_url, TIMEOUT_MS * 2, { Range: `bytes=0-${PREVIEW_BYTES - 1}` })
  const raw = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const type = raw.startsWith('audio/') ? raw : 'application/octet-stream'
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const parts: Buffer[] = []
  let n = 0
  try {
    while (n < PREVIEW_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(Buffer.from(value))
      n += value.byteLength
    }
  } catch {
    if (!n) {
      throw new OpenverseError(502, 'OPENVERSE_UNREACHABLE', 'The track could not be downloaded')
    }
  } finally {
    void reader.cancel().catch(() => null)
  }
  const bytes = Buffer.concat(parts).subarray(0, PREVIEW_BYTES)
  if (previews.size >= 40) previews.delete(previews.keys().next().value as string)
  previews.set(t.id, { at: Date.now(), type, bytes })
  return { type, bytes }
}

export function originOf(t: OpenverseTrack): MusicOrigin {
  return {
    provider: 'openverse',
    id: t.id,
    creator: t.creator,
    license: t.license,
    license_url: t.license_url,
    landing_url: t.landing_url,
    source: t.provider
  }
}

const httpOrNull = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim().slice(0, 500) : ''
  return /^https?:\/\//i.test(s) ? s : null
}
const textOrNull = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
  return s || null
}

/** A music file's origin, kept only in its known shape (packages carry it). */
export function normalizeOrigin(v: unknown): MusicOrigin | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const license = String(o.license ?? '').toLowerCase()
  if (o.provider !== 'openverse') return null
  if (!(OPENVERSE_LICENSES as readonly string[]).includes(license)) return null
  const id = textOrNull(o.id, 64)
  if (!id) return null
  return {
    provider: 'openverse',
    id,
    creator: textOrNull(o.creator, 200),
    license: license as MusicOrigin['license'],
    license_url: httpOrNull(o.license_url),
    landing_url: httpOrNull(o.landing_url),
    source: textOrNull(o.source, 60)
  }
}
