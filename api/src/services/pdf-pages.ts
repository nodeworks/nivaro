import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { getBrowser, hasLocalChromium } from './pdf-layout.js'
import { peerPdfPages, renderPeerUrl, renderUnavailable } from './render-peer.js'

/**
 * PDF pages as pictures (#3186): a scanned paper form has no text to read,
 * and a provider that cannot take a PDF (the OpenAI-compatible gateway) can
 * still look at its pages. Each page is drawn by pdf.js in Chromium — locally
 * when this process has Chromium, otherwise on the render peer (RENDER_URL,
 * the slim image) — and comes back as a JPEG.
 *
 * The page the PDF is drawn in loads nothing from the network: it lives on a
 * made-up origin whose three files (the page, pdf.js and its worker) and the
 * PDF itself are answered from memory; every other request is aborted. pdf.js
 * runs with eval off. Only the first `maxPages` pages are drawn.
 */

export const PDF_PAGES_MAX = 6
const ORIGIN = 'https://pdf-pages.invalid'
const RENDER_TIMEOUT_MS = 60_000

export interface PdfPageImages {
  /** JPEG bytes, first page first. */
  pages: Buffer[]
  /** Pages in the PDF (more than `pages.length` when it was cut). */
  total: number
}

export interface PdfPageOptions {
  maxPages?: number
  /** Width in pixels each page is drawn at (400-2400). */
  width?: number
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : fallback
}

export function pageOptions(opts: PdfPageOptions = {}) {
  return {
    maxPages: clamp(opts.maxPages, 1, PDF_PAGES_MAX, 4),
    width: clamp(opts.width, 400, 2400, 1600)
  }
}

/** Local when this process has Chromium, else on the render peer, else a 503 that says why. */
export async function pdfPageImages(
  pdf: Buffer,
  opts: PdfPageOptions = {}
): Promise<PdfPageImages> {
  if (!(await hasLocalChromium())) {
    if (renderPeerUrl()) return peerPdfPages(pdf, pageOptions(opts))
    throw renderUnavailable('pdf')
  }
  return pdfPageImagesLocal(pdf, opts)
}

let sources: Promise<{ lib: string; worker: string }> | null = null
function pdfjsSources() {
  if (!sources)
    sources = (async () => {
      const require = createRequire(import.meta.url)
      const root = dirname(require.resolve('pdfjs-dist/package.json'))
      const [lib, worker] = await Promise.all([
        readFile(join(root, 'legacy/build/pdf.min.mjs'), 'utf8'),
        readFile(join(root, 'legacy/build/pdf.worker.min.mjs'), 'utf8')
      ])
      return { lib, worker }
    })().catch((err) => {
      sources = null
      throw err
    })
  return sources
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
import * as pdfjs from '/pdf.mjs'
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs'
window.__draw = async (maxPages, width) => {
  const doc = await pdfjs.getDocument({ url: '/doc.pdf', isEvalSupported: false, useSystemFonts: true }).promise
  const n = Math.min(doc.numPages, maxPages)
  const pages = []
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: Math.min(4, width / base.width) })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    pages.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
    page.cleanup()
  }
  const total = doc.numPages
  await doc.destroy()
  return { pages, total }
}
window.__ready = true
</script></body></html>`

/** The local draw; also what the render peer's own route calls. */
export async function pdfPageImagesLocal(
  pdf: Buffer,
  opts: PdfPageOptions = {}
): Promise<PdfPageImages> {
  const { maxPages, width } = pageOptions(opts)
  const { lib, worker } = await pdfjsSources()
  const files: Record<string, { type: string; body: string | Buffer }> = {
    [`${ORIGIN}/`]: { type: 'text/html', body: PAGE },
    [`${ORIGIN}/pdf.mjs`]: { type: 'text/javascript', body: lib },
    [`${ORIGIN}/pdf.worker.mjs`]: { type: 'text/javascript', body: worker },
    [`${ORIGIN}/doc.pdf`]: { type: 'application/pdf', body: pdf }
  }
  const b = await getBrowser()
  const page = await b.newPage()
  try {
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.isInterceptResolutionHandled()) return
      const url = req.url()
      const file = files[url]
      if (file)
        void req
          .respond({ status: 200, contentType: file.type, body: file.body })
          .catch(() => undefined)
      else if (url.startsWith('blob:') || url.startsWith('data:') || url === 'about:blank')
        void req.continue().catch(() => undefined)
      else void req.abort('blockedbyclient').catch(() => undefined)
    })
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS })
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Drawing the PDF pages took too long')),
        RENDER_TIMEOUT_MS
      )
    })
    try {
      const out = (await Promise.race([
        page.evaluate(`window.__draw(${maxPages}, ${width})`),
        late
      ])) as { pages: string[]; total: number }
      return {
        pages: out.pages.map((p) => Buffer.from(p, 'base64')),
        total: Number(out.total) || 0
      }
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await page.close().catch(() => undefined)
  }
}
