import { join } from 'node:path'
import { db } from '../db/index.js'
import { getFile } from './files.js'
import {
  chapterBannerWindows,
  editedSpanToSource,
  OUTRO_DEFAULT_TEXT,
  sourceToEdited,
  type VideoEdits
} from './help-video-edits.js'
import { getBrowser } from './pdf-layout.js'
import { openStoredObject } from './stored-object-stream.js'

// Draws a help video's intro card, outro card and chapter banners as PNGs for
// the render, with the same layout as the shared player's CardLayer
// (packages/shared/src/components/help-videos/CardLayer.tsx + cards.ts — keep
// them in step). Like the annotations: every author string goes in through
// textContent, the page fetches nothing (setContent + every request other
// than the blank document or a data: URI is aborted), and the logo is handed
// over as a data URI read from storage here.

export const CARD_COLORS = {
  ground: '#0f172a',
  title: '#ffffff',
  body: '#cbd5e1',
  label: '#94a3b8',
  item: '#e2e8f0',
  banner: 'rgba(15, 23, 42, 0.88)'
} as const
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

export interface CardText {
  intro: { title: string; subtitle: string; chapters: string[]; more: number } | null
  outro: string | null
  banners: Array<{ id: string; title: string; start_ms: number; end_ms: number }>
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
 *  chapterBannerWindows. */
export function cardText(e: VideoEdits, video: { title: unknown; description: unknown }): CardText {
  let intro: CardText['intro'] = null
  if (e.intro?.enabled) {
    const all = e.intro.show_chapters
      ? e.chapters
          .map((c) => ({ title: c.title, at: sourceToEdited(e, c.at_ms) }))
          .filter((c) => c.at !== null)
          .sort((a, b) => (a.at as number) - (b.at as number))
          .map((c) => c.title)
      : []
    intro = {
      title: e.intro.title.trim() || String(video.title ?? '').trim() || 'Untitled video',
      subtitle: e.intro.subtitle.trim() || firstLine(video.description),
      chapters: all.slice(0, INTRO_CHAPTER_MAX),
      more: Math.max(0, all.length - INTRO_CHAPTER_MAX)
    }
  }
  return {
    intro,
    outro: e.outro?.enabled ? e.outro.text.trim() || OUTRO_DEFAULT_TEXT : null,
    banners: chapterBannerWindows(e)
  }
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

// ── the card as a tree of plain nodes ────────────────────────────────────────
// Built here in Node (so it is testable), then materialised inside Chromium by
// a loop with no helper functions: author strings only ever become text nodes.

export interface CardNode {
  tag: 'div' | 'span' | 'img'
  css: string
  text?: string
  /** img only: a data: URI. */
  src?: string
  children?: CardNode[]
}

const clampLines = (n: number) =>
  `display:-webkit-box;-webkit-line-clamp:${n};-webkit-box-orient:vertical;overflow:hidden;`

function brandMark(brand: CardBrand, u: number, center: boolean): CardNode | null {
  if (brand.logo) {
    return {
      tag: 'img',
      src: brand.logo,
      css: `height:${56 * u}px;max-width:${360 * u}px;object-fit:contain;object-position:${center ? 'center' : 'left center'};display:block;${center ? 'margin:0 auto;' : ''}`
    }
  }
  if (!brand.name) return null
  return {
    tag: 'div',
    text: brand.name,
    css: `color:${CARD_COLORS.label};font-size:${20 * u}px;font-weight:700;letter-spacing:${2 * u}px;text-transform:uppercase;`
  }
}

function rule(brand: CardBrand, u: number, center: boolean): CardNode {
  return {
    tag: 'div',
    css: `width:${72 * u}px;height:${6 * u}px;border-radius:${3 * u}px;background:${brand.color};margin:${28 * u}px ${center ? 'auto' : '0'};`
  }
}

/** The intro card (opaque, full frame). */
export function introTree(
  intro: NonNullable<CardText['intro']>,
  brand: CardBrand,
  width: number
): CardNode {
  const u = width / 1280
  const kids: CardNode[] = []
  const mark = brandMark(brand, u, false)
  if (mark) kids.push(mark)
  kids.push(rule(brand, u, false))
  kids.push({
    tag: 'div',
    text: intro.title,
    css: `color:${CARD_COLORS.title};font-size:${54 * u}px;font-weight:700;line-height:1.15;${clampLines(2)}`
  })
  if (intro.subtitle) {
    kids.push({
      tag: 'div',
      text: intro.subtitle,
      css: `color:${CARD_COLORS.body};font-size:${26 * u}px;line-height:1.35;margin-top:${16 * u}px;${clampLines(2)}`
    })
  }
  if (intro.chapters.length) {
    const list: CardNode[] = [
      {
        tag: 'div',
        text: 'In this video',
        css: `color:${CARD_COLORS.label};font-size:${16 * u}px;font-weight:700;letter-spacing:${1.5 * u}px;text-transform:uppercase;margin-bottom:${10 * u}px;`
      },
      ...intro.chapters.map(
        (t, i): CardNode => ({
          tag: 'div',
          css: `color:${CARD_COLORS.item};font-size:${21 * u}px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`,
          children: [
            {
              tag: 'span',
              text: String(i + 1),
              css: `color:${brand.color};font-weight:700;margin-right:${12 * u}px;`
            },
            { tag: 'span', text: t, css: '' }
          ]
        })
      )
    ]
    if (intro.more > 0) {
      list.push({
        tag: 'div',
        text: `and ${intro.more} more`,
        css: `color:${CARD_COLORS.label};font-size:${18 * u}px;margin-top:${4 * u}px;`
      })
    }
    kids.push({ tag: 'div', css: `margin-top:${34 * u}px;`, children: list })
  }
  return {
    tag: 'div',
    css: `position:absolute;inset:0;background:${CARD_COLORS.ground};display:flex;flex-direction:column;justify-content:center;padding:0 ${110 * u}px;`,
    children: kids
  }
}

/** The outro card (opaque, full frame). */
export function outroTree(text: string, brand: CardBrand, width: number): CardNode {
  const u = width / 1280
  const kids: CardNode[] = []
  const mark = brandMark(brand, u, true)
  if (mark) kids.push(mark)
  kids.push(rule(brand, u, true))
  kids.push({
    tag: 'div',
    text,
    css: `color:${CARD_COLORS.title};font-size:${42 * u}px;font-weight:700;line-height:1.25;${clampLines(3)}`
  })
  return {
    tag: 'div',
    css: `position:absolute;inset:0;background:${CARD_COLORS.ground};display:flex;flex-direction:column;justify-content:center;text-align:center;padding:0 ${140 * u}px;`,
    children: kids
  }
}

/** A chapter banner: a lower-third panel on a transparent frame. */
export function bannerTree(title: string, brand: CardBrand, width: number): CardNode {
  const u = width / 1280
  return {
    tag: 'div',
    css: `position:absolute;left:${52 * u}px;bottom:${130 * u}px;max-width:${760 * u}px;display:flex;align-items:center;gap:${14 * u}px;background:${CARD_COLORS.banner};border-radius:${10 * u}px;padding:${14 * u}px ${24 * u}px;box-shadow:0 ${4 * u}px ${18 * u}px rgba(0,0,0,0.35);box-sizing:border-box;`,
    children: [
      {
        tag: 'span',
        css: `width:${12 * u}px;height:${12 * u}px;border-radius:50%;background:${brand.color};flex-shrink:0;`
      },
      {
        tag: 'span',
        text: title,
        css: `color:${CARD_COLORS.title};font-size:${28 * u}px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`
      }
    ]
  }
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
html,body{margin:0;background:transparent;overflow:hidden;font-family:Arial,Helvetica,sans-serif}
#root{position:relative;overflow:hidden}
</style></head><body><div id="root"></div></body></html>`

function isAllowed(url: string): boolean {
  return url === 'about:blank' || url.startsWith('data:')
}

/** Rasterizes the cards to PNGs in `dir`: intro/outro are opaque full frames,
 *  banners full-frame transparent overlays (one per banner, in order). */
export async function rasterizeCards(
  text: CardText,
  brand: CardBrand,
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
    jobs.push({ tree: bannerTree(b.title, brand, size.width), path, opaque: false })
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
