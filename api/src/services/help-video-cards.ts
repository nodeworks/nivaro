import { copyFile, link, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { getFile } from './files.js'
import {
  type BannerContent,
  bannerTree,
  CARD_FONT,
  type CardBrandShown,
  type CardMotion,
  type CardNode,
  type IntroCardContent,
  introTree,
  isStill,
  type OutroCardContent,
  outroTree
} from './help-video-card-design.js'
import { parseCardLogo } from './help-video-card-logo.js'
import {
  chapterBannerWindows,
  editedDuration,
  OUTRO_DEFAULT_TEXT,
  sourceToEdited,
  type VideoEdits
} from './help-video-edits.js'
import { CARD_FPS } from './help-video-render-plan.js'
import { getBrowser } from './pdf-layout.js'
import { openStoredObject } from './stored-object-stream.js'

// Draws a help video's intro card, outro card and chapter banners as frames
// for the render: one PNG for a still card, a numbered sequence for a moving
// one. The layout itself is help-video-card-design.ts, a copy of the
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
    // The cards' own logo (an image stored in the setting, migration 409)
    // comes first; the instance logo is only the fallback. A database behind
    // 409 has no such column.
    const cardLogo = await hasColumn('nivaro_settings', 'help_video_card_logo_image').catch(
      () => false
    )
    row = (await db('nivaro_settings')
      .where({ id: 1 })
      .first(
        'project_name',
        'project_color',
        'brand_logo',
        ...(cardLogo ? ['help_video_card_logo_image'] : [])
      )) as Record<string, unknown> | undefined
  } catch {
    row = undefined
  }
  const name = String(row?.project_name ?? '').trim() || null
  const color = cardAccent(row?.project_color)
  // A stored card logo is already the image the page draws (validated on save).
  if (parseCardLogo(row?.help_video_card_logo_image))
    return { name, color, logo: String(row?.help_video_card_logo_image) }
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

/** One card or banner as the render reads it. */
export interface CardClip {
  /** One PNG (still card) or an image2 pattern `…/f%05d.png` (moving card). */
  path: string
  /** True when `path` is an image2 pattern of `frames` images. */
  sequence: boolean
  frames: number
}
export interface CapturedCards {
  intro: CardClip | null
  outro: CardClip | null
  banners: CardClip[]
}

/** The motion of a card at `t_ms` into it: the shared player's cardMotionAt
 *  (packages/shared/src/components/help-videos/cards.ts). */
export function cardMotionAt(
  e: VideoEdits,
  side: 'intro' | 'outro',
  t_ms: number
): CardMotion | undefined {
  const c = e[side]
  if (!c) return undefined
  return {
    t_ms,
    duration_ms: c.duration_ms,
    animation: c.animation ?? 'none',
    transition: c.transition ?? 'cut',
    side
  }
}

/** A banner's motion: the shared player's bannerMotionAt. */
export function bannerMotionAt(
  e: VideoEdits,
  w: { start_ms: number; end_ms: number },
  editedMs: number
): CardMotion {
  return {
    t_ms: editedMs - w.start_ms,
    duration_ms: w.end_ms - w.start_ms,
    animation: e.banner_animation ?? 'none',
    transition: 'cut',
    side: 'banner'
  }
}

/** Which frames of a card need their own screenshot: the first always, then
 *  any frame whose look differs from the frame before it. Frame i is at
 *  i * 1000 / CARD_FPS ms. */
export function planCardFrames(frames: number, m: CardMotion | undefined): boolean[] {
  const moves = !!m && !(m.animation === 'none' && m.transition === 'cut')
  const at = (i: number) => (i * 1000) / CARD_FPS
  return Array.from({ length: frames }, (_, i) =>
    i === 0 ? true : !!m && moves && !isStill(m, at(i - 1), at(i))
  )
}

/** Every node's CSS in the order the page creates its elements (the page
 *  walks the tree breadth first with a queue; this walks it the same way). */
function cssInOrder(tree: CardNode): string[] {
  const out: string[] = []
  const queue: CardNode[] = [tree]
  while (queue.length) {
    const node = queue.shift() as CardNode
    out.push(node.css)
    for (const child of node.children ?? []) queue.push(child)
  }
  return out
}

/** The cards as frames in `dir`: a still card is one PNG, a moving card a
 *  numbered sequence where only frames that change are screenshotted and the
 *  rest are hard links to the frame before. Every frame is transparent where
 *  the card is (an intro's transition shows the recording through it).
 *  Banners are full-frame transparent overlays timed in edited time. */
export async function captureCards(
  text: CardText,
  brand: CardBrandShown,
  size: { width: number; height: number },
  dir: string,
  e: VideoEdits
): Promise<CapturedCards> {
  type Job = {
    name: string
    frames: number
    motion: CardMotion | undefined
    build: (t: number) => CardNode
  }
  const framesOf = (ms: number) => Math.max(1, Math.round((ms / 1000) * CARD_FPS))
  const jobs: Job[] = []
  if (text.intro && e.intro) {
    const c = text.intro
    jobs.push({
      name: 'intro',
      frames: framesOf(e.intro.duration_ms),
      motion: cardMotionAt(e, 'intro', 0),
      build: (t) => introTree(c, brand, size.width, cardMotionAt(e, 'intro', t))
    })
  }
  if (text.outro && e.outro) {
    const c = text.outro
    jobs.push({
      name: 'outro',
      frames: framesOf(e.outro.duration_ms),
      motion: cardMotionAt(e, 'outro', 0),
      build: (t) => outroTree(c, brand, size.width, cardMotionAt(e, 'outro', t))
    })
  }
  text.banners.forEach((b, i) => {
    jobs.push({
      name: `banner-${i + 1}`,
      frames: framesOf(b.end_ms - b.start_ms),
      motion: bannerMotionAt(e, b, b.start_ms),
      build: (t) => bannerTree(b, brand, size.width, bannerMotionAt(e, b, b.start_ms + t))
    })
  })
  const out: CapturedCards = { intro: null, outro: null, banners: [] }
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
      const plan = planCardFrames(job.frames, job.motion)
      const moving = plan.some((p, i) => i > 0 && p)
      const folder = moving ? join(dir, `card-${job.name}`) : dir
      if (moving) await mkdir(folder, { recursive: true })
      const fileAt = (i: number) =>
        moving
          ? join(folder, `f${String(i + 1).padStart(5, '0')}.png`)
          : join(dir, `card-${job.name}.png`)
      // Runs inside Chromium as source text: no named functions (tsx's
      // keepNames would wrap them in a helper the page does not have), so the
      // tree is walked with an explicit queue. The created elements are kept
      // in creation order so later frames only rewrite their CSS.
      await page.evaluate(
        async (data) => {
          const g = globalThis as unknown as {
            document: PageDocument
            __nvrCardNodes: PageNode[]
          }
          const document = g.document
          const root = document.getElementById('root') as PageNode
          root.style.width = `${data.W}px`
          root.style.height = `${data.H}px`
          root.textContent = ''
          g.__nvrCardNodes = []
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
            g.__nvrCardNodes.push(el)
            for (const child of node.children ?? []) stack.push({ node: child, parent: el })
          }
          await Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => null)))
        },
        { tree: job.build(0), W: size.width, H: size.height }
      )
      let last = ''
      for (let i = 0; i < (moving ? job.frames : 1); i++) {
        const path = fileAt(i)
        if (!plan[i]) {
          await link(last, path).catch(() => copyFile(last, path))
          continue
        }
        if (i > 0) {
          await page.evaluate(
            (list) => {
              const nodes = (globalThis as unknown as { __nvrCardNodes: PageNode[] }).__nvrCardNodes
              for (let k = 0; k < list.length; k++) nodes[k].style.cssText = list[k]
            },
            cssInOrder(job.build((i * 1000) / CARD_FPS))
          )
        }
        await page.screenshot({ path: path as `${string}.png`, omitBackground: true, type: 'png' })
        last = path
      }
      const clip: CardClip = moving
        ? { path: join(folder, 'f%05d.png'), sequence: true, frames: job.frames }
        : { path: fileAt(0), sequence: false, frames: 1 }
      if (job.name === 'intro') out.intro = clip
      else if (job.name === 'outro') out.outro = clip
      else out.banners.push(clip)
    }
  } finally {
    await page.close().catch(() => null)
  }
  return out
}
