import { join } from 'node:path'
import { db } from '../db/index.js'
import { getFile } from './files.js'
import {
  type BannerContent,
  bannerTree,
  CARD_FONT,
  type CardBrandShown,
  type CardNode,
  type IntroCardContent,
  introTree,
  type OutroCardContent,
  outroTree
} from './help-video-card-design.js'
import {
  chapterBannerWindows,
  editedDuration,
  editedSpanToSource,
  OUTRO_DEFAULT_TEXT,
  sourceToEdited,
  type VideoEdits
} from './help-video-edits.js'
import { getBrowser } from './pdf-layout.js'
import { openStoredObject } from './stored-object-stream.js'

// Draws a help video's intro card, outro card and chapter banners as PNGs for
// the render. The layout itself is help-video-card-design.ts, a copy of the
// shared player's packages/shared/src/components/help-videos/cardDesign.ts
// (a test fails when they differ); the words come from cardText, which
// mirrors the player's cards.ts. Like the annotations: every author string goes in through
// textContent, the page fetches nothing (setContent + every request other
// than the blank document or a data: URI is aborted), and the logo is handed
// over as a data URI read from storage here.

export const DEFAULT_CARD_ACCENT = '#00ceff'
export const INTRO_CHAPTER_MAX = 6
/** A logo larger than this is left out (the card shows the name instead). */
const MAX_LOGO_BYTES = 2 * 1024 * 1024
const LOGO_TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i
const SET_CONTENT_TIMEOUT_MS = 15_000

export interface CardBrand {
  name: string | null
  color: string
  /** A data: URI, or null. */
  logo: string | null
}

export type { CardNode } from './help-video-card-design.js'
export { bannerTree, introTree, outroTree } from './help-video-card-design.js'

export interface CardText {
  intro: IntroCardContent | null
  outro: OutroCardContent | null
  banners: Array<BannerContent & { id: string; start_ms: number; end_ms: number }>
}

export function cardAccent(v: unknown): string {
  const s = String(v ?? '').trim()
  const hex = s.startsWith('#') ? s : `#${s}`
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : DEFAULT_CARD_ACCENT
}

export function firstLine(text: unknown, max = 200): string {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean)
  return (line ?? '').slice(0, max)
}

/** What the cards say: the shared player's introContent / outroContent /
 *  bannerAt. */
export function cardText(e: VideoEdits, video: { title: unknown; description: unknown }): CardText {
  const videoTitle = String(video.title ?? '').trim()
  const kept = e.chapters
    .map((c) => ({ id: c.id, title: c.title, at: sourceToEdited(e, c.at_ms) }))
    .filter((c): c is { id: string; title: string; at: number } => c.at !== null)
    .sort((a, b) => a.at - b.at)
  let intro: CardText['intro'] = null
  if (e.intro?.enabled) {
    const all = e.intro.show_chapters ? kept.map((c) => c.title) : []
    intro = {
      title: e.intro.title.trim() || videoTitle || 'Untitled video',
      subtitle: e.intro.subtitle.trim() || firstLine(video.description),
      chapters: all.slice(0, INTRO_CHAPTER_MAX),
      more: Math.max(0, all.length - INTRO_CHAPTER_MAX),
      duration_ms: editedDuration(e)
    }
  }
  return {
    intro,
    outro: e.outro?.enabled
      ? { text: e.outro.text.trim() || OUTRO_DEFAULT_TEXT, title: videoTitle }
      : null,
    banners: chapterBannerWindows(e).map((b) => ({
      ...b,
      index: kept.findIndex((c) => c.id === b.id) + 1,
      total: kept.length
    }))
  }
}

/** The brand as the cards draw it for one video: the video's own name
 *  (card_brand) beats the instance name; the logo and colour stay. */
export function shownBrand(brand: CardBrand, e: VideoEdits): CardBrandShown {
  const own = e.card_brand?.trim()
  return { name: own || brand.name, color: brand.color, logo: brand.logo }
}

/** The instance brand (name, accent, logo) the cards are drawn in. Never
 *  throws: anything unreadable falls back to the name or the stock accent. */
export async function loadCardBrand(): Promise<CardBrand> {
  let row: Record<string, unknown> | undefined
  try {
    row = (await db('nivaro_settings')
      .where({ id: 1 })
      .first('project_name', 'project_color', 'brand_logo')) as Record<string, unknown> | undefined
  } catch {
    row = undefined
  }
  const name = String(row?.project_name ?? '').trim() || null
  const color = cardAccent(row?.project_color)
  let logo: string | null = null
  if (row?.brand_logo) {
    try {
      const f = await getFile(String(row.brand_logo))
      const type = String(f?.type ?? '')
      if (f?.filename_disk && LOGO_TYPES.test(type)) {
        const opened = await openStoredObject(String(f.filename_disk))
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of opened.stream as AsyncIterable<Buffer>) {
          size += chunk.length
          if (size > MAX_LOGO_BYTES) {
            chunks.length = 0
            break
          }
          chunks.push(Buffer.from(chunk))
        }
        if (chunks.length)
          logo = `data:${type.toLowerCase()};base64,${Buffer.concat(chunks).toString('base64')}`
      }
    } catch {
      logo = null
    }
  }
  return { name, color, logo }
}

/** Banner overlays in SOURCE time: each banner's edited window, cut into the
 *  source spans of the kept pieces it crosses (so it honours cuts and speed). */
export function bannerSourceSpans(
  e: VideoEdits,
  banners: CardText['banners']
): Array<{ index: number; start_ms: number; end_ms: number }> {
  return banners.flatMap((b, index) =>
    editedSpanToSource(e, b.start_ms, b.end_ms).map((s) => ({ index, ...s }))
  )
}

// The api compiles without the DOM lib; this is the slice the page callback touches.
interface PageNode {
  style: Record<string, string>
  textContent: string | null
  setAttribute(name: string, value: string): void
  appendChild(child: PageNode): void
}
interface PageDocument {
  getElementById(id: string): PageNode | null
  createElement(tag: string): PageNode
  images: ArrayLike<{ decode(): Promise<void> }>
}

const PAGE = `<!doctype html><html><head><style>
html,body{margin:0;background:transparent;overflow:hidden;font-family:${CARD_FONT}}
#root{position:relative;overflow:hidden}
</style></head><body><div id="root"></div></body></html>`

function isAllowed(url: string): boolean {
  return url === 'about:blank' || url.startsWith('data:')
}

/** Rasterizes the cards to PNGs in `dir`: intro/outro are opaque full frames,
 *  banners full-frame transparent overlays (one per banner, in order). */
export async function rasterizeCards(
  text: CardText,
  brand: CardBrandShown,
  size: { width: number; height: number },
  dir: string
): Promise<{ intro: string | null; outro: string | null; banners: string[] }> {
  const out = {
    intro: null as string | null,
    outro: null as string | null,
    banners: [] as string[]
  }
  const jobs: Array<{ tree: CardNode; path: string; opaque: boolean }> = []
  if (text.intro) {
    out.intro = join(dir, 'card-intro.png')
    jobs.push({ tree: introTree(text.intro, brand, size.width), path: out.intro, opaque: true })
  }
  if (text.outro) {
    out.outro = join(dir, 'card-outro.png')
    jobs.push({ tree: outroTree(text.outro, brand, size.width), path: out.outro, opaque: true })
  }
  text.banners.forEach((b, i) => {
    const path = join(dir, `card-banner-${i + 1}.png`)
    out.banners.push(path)
    jobs.push({ tree: bannerTree(b, brand, size.width), path, opaque: false })
  })
  if (!jobs.length) return out
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.isInterceptResolutionHandled()) return
      if (isAllowed(req.url())) void req.continue().catch(() => null)
      else void req.abort('blockedbyclient').catch(() => null)
    })
    await page.setViewport({ width: size.width, height: size.height })
    await page.setContent(PAGE, { waitUntil: 'load', timeout: SET_CONTENT_TIMEOUT_MS })
    for (const job of jobs) {
      // Runs inside Chromium as source text: no named functions (tsx's
      // keepNames would wrap them in a helper the page does not have), so the
      // tree is walked with an explicit stack.
      await page.evaluate(
        async (data) => {
          const document = (globalThis as unknown as { document: PageDocument }).document
          const root = document.getElementById('root') as PageNode
          root.style.width = `${data.W}px`
          root.style.height = `${data.H}px`
          root.textContent = ''
          const stack: Array<{ node: CardNode; parent: PageNode }> = [
            { node: data.tree, parent: root }
          ]
          while (stack.length) {
            const { node, parent } = stack.shift() as { node: CardNode; parent: PageNode }
            const el = document.createElement(node.tag)
            el.style.cssText = node.css
            if (node.tag === 'img' && node.src?.startsWith('data:image/')) {
              el.setAttribute('src', node.src)
            } else if (node.text !== undefined) el.textContent = node.text
            parent.appendChild(el)
            for (const child of node.children ?? []) stack.push({ node: child, parent: el })
          }
          await Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => null)))
        },
        { tree: job.tree, W: size.width, H: size.height }
      )
      await page.screenshot({
        path: job.path as `${string}.png`,
        omitBackground: !job.opaque,
        type: 'png'
      })
    }
  } finally {
    await page.close().catch(() => null)
  }
  return out
}
