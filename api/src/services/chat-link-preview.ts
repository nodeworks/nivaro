import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { assertSafeUrl } from '../lib/ssrf.js'

/**
 * Link previews for chat (#930): title, description and site name of an
 * external page. Server-side so the browser never talks to the page, with
 * the SSRF guard on the URL and on every redirect hop, a short timeout, a
 * size cap, and a 24-hour cache. Images are deliberately not returned — a
 * preview image would make every reader's browser fetch a third-party URL.
 */

export interface LinkPreview {
  url: string
  title: string | null
  description: string | null
  site: string | null
  ok: boolean
}

const TTL_SECONDS = 24 * 3600
const MAX_BYTES = 512 * 1024
const memory = new Map<string, { at: number; v: LinkPreview }>()

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

function meta(html: string, keys: string[]): string | null {
  for (const k of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["'][^>]*>`,
      'i'
    )
    const m = html.match(re)
    const v = m?.[1] ?? m?.[2]
    if (v) return decode(v).slice(0, 300)
  }
  return null
}

/** Pure: pull the preview fields out of a page's HTML. */
export function parsePreviewHtml(url: string, html: string): LinkPreview {
  const title =
    meta(html, ['og:title', 'twitter:title']) ??
    (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
      ? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)![1]).slice(0, 300)
      : null)
  let site = meta(html, ['og:site_name', 'application-name'])
  if (!site) {
    try {
      site = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      site = null
    }
  }
  return {
    url,
    title: title || null,
    description: meta(html, ['og:description', 'twitter:description', 'description']),
    site,
    ok: !!title
  }
}

async function fetchPage(url: string): Promise<LinkPreview> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    await assertSafeUrl(current)
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { 'user-agent': 'NivaroLinkPreview/1.0', accept: 'text/html' }
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) break
      current = new URL(loc, current).toString()
      continue
    }
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !type.includes('html')) {
      return { url, title: null, description: null, site: new URL(url).hostname, ok: false }
    }
    const reader = res.body?.getReader()
    if (!reader) break
    const chunks: Uint8Array[] = []
    let size = 0
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      size += value.length
      // The head is all a preview needs.
      if (Buffer.concat(chunks).toString('utf8').includes('</head>')) break
    }
    void reader.cancel().catch(() => {})
    return parsePreviewHtml(url, Buffer.concat(chunks).toString('utf8'))
  }
  return { url, title: null, description: null, site: null, ok: false }
}

export async function linkPreview(app: FastifyInstance, url: string): Promise<LinkPreview> {
  const key = `nvr:linkprev:${createHash('sha1').update(url).digest('hex')}`
  const mem = memory.get(key)
  if (mem && Date.now() - mem.at < TTL_SECONDS * 1000) return mem.v
  const redis = (
    app as unknown as {
      redis?: {
        get: (k: string) => Promise<string | null>
        set: (...a: unknown[]) => Promise<unknown>
      }
    }
  ).redis
  try {
    const hit = redis ? await redis.get(key) : null
    if (hit) return JSON.parse(hit) as LinkPreview
  } catch {
    /* cache is optional */
  }
  let v: LinkPreview
  try {
    v = await fetchPage(url)
  } catch {
    let site: string | null = null
    try {
      site = new URL(url).hostname
    } catch {
      site = null
    }
    v = { url, title: null, description: null, site, ok: false }
  }
  memory.set(key, { at: Date.now(), v })
  if (memory.size > 2000) memory.delete(memory.keys().next().value as string)
  try {
    await redis?.set(key, JSON.stringify(v), 'EX', TTL_SECONDS)
  } catch {
    /* cache is optional */
  }
  return v
}
