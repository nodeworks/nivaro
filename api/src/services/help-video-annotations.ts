import { join } from 'node:path'
import type { Annotation } from './help-video-edits.js'
import { getBrowser } from './pdf-layout.js'

// Draws each annotation as a full-frame transparent PNG with the same look as
// the shared player's overlay (packages/shared/src/components/help-videos/
// annotationStyles.ts — keep the two in step). Text goes in through
// textContent inside the page; nothing an author types is parsed as HTML.
// The page never fetches anything: it is loaded with setContent and every
// request other than the blank document itself is aborted.

export const PALETTE = { accent: '#2563eb', warning: '#dc2626', neutral: '#111827' } as const

const SET_CONTENT_TIMEOUT_MS = 15_000

export function annotationOverlayFrames(
  a: Annotation
): Array<{ start_ms: number; end_ms: number; scale: number }> {
  if (a.type !== 'ripple') return [{ start_ms: a.start_ms, end_ms: a.end_ms, scale: 1 }]
  const third = Math.floor((a.end_ms - a.start_ms) / 3)
  return [
    { start_ms: a.start_ms, end_ms: a.start_ms + third, scale: 0.6 },
    { start_ms: a.start_ms + third, end_ms: a.start_ms + 2 * third, scale: 0.85 },
    { start_ms: a.start_ms + 2 * third, end_ms: a.end_ms, scale: 1 }
  ]
}

const PAGE = `<!doctype html><html><head><style>
html,body{margin:0;background:transparent;overflow:hidden;font-family:Arial,Helvetica,sans-serif}
#root{position:relative}
</style></head><body><div id="root"></div></body></html>`

// The api compiles without the DOM lib; this is the slice of it the page
// callback touches.
interface PageNode {
  style: Record<string, string>
  textContent: string | null
  setAttribute(name: string, value: string): void
  appendChild(child: PageNode): void
  append(...children: PageNode[]): void
}
interface PageDocument {
  getElementById(id: string): PageNode | null
  createElement(tag: string): PageNode
  createElementNS(ns: string, tag: string): PageNode
}

function isBlankDocument(url: string): boolean {
  return url === 'about:blank' || url.startsWith('data:')
}

export async function rasterizeAnnotations(
  annotations: Annotation[],
  size: { width: number; height: number },
  dir: string
): Promise<Array<{ path: string; start_ms: number; end_ms: number }>> {
  if (!annotations.length) return []
  const browser = await getBrowser()
  const page = await browser.newPage()
  const out: Array<{ path: string; start_ms: number; end_ms: number }> = []
  try {
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.isInterceptResolutionHandled()) return
      if (isBlankDocument(req.url())) void req.continue().catch(() => null)
      else void req.abort('blockedbyclient').catch(() => null)
    })
    await page.setViewport({ width: size.width, height: size.height })
    await page.setContent(PAGE, { waitUntil: 'load', timeout: SET_CONTENT_TIMEOUT_MS })
    let n = 0
    for (const a of annotations) {
      for (const frame of annotationOverlayFrames(a)) {
        // This callback runs inside Chromium as source text: it must not
        // declare named functions (tsx's keepNames would wrap them in a
        // __name helper the page does not have) or reach anything outside it.
        await page.evaluate(
          (data) => {
            const { a, scale, W, H, palette } = data
            const document = (globalThis as unknown as { document: PageDocument }).document
            const root = document.getElementById('root') as PageNode
            root.style.width = `${W}px`
            root.style.height = `${H}px`
            root.textContent = ''
            const color = palette[a.tone as keyof typeof palette]
            const x = a.rect.x * W
            const y = a.rect.y * H
            const w = a.rect.w * W
            const h = a.rect.h * H
            const unit = Math.max(2, Math.round(W / 640)) // scales line widths with the frame
            if (a.type === 'box' || a.type === 'callout') {
              const el = document.createElement('div')
              el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box;border-radius:${4 * unit}px;display:flex;align-items:center;justify-content:center;text-align:center;padding:${3 * unit}px;font-weight:600;font-size:${Math.max(12, Math.min(h * 0.45, 9 * unit))}px;line-height:1.2;`
              if (a.type === 'box') {
                el.style.border = `${1.5 * unit}px solid ${color}`
                el.style.color = color
              } else {
                el.style.background = color
                el.style.color = '#ffffff'
                el.style.boxShadow = '0 2px 10px rgba(0,0,0,0.35)'
              }
              el.textContent = a.text
              root.appendChild(el)
            } else if (a.type === 'ripple') {
              const r = (Math.min(w, h) / 2) * scale
              const el = document.createElement('div')
              el.style.cssText = `position:absolute;left:${x + w / 2 - r}px;top:${y + h / 2 - r}px;width:${2 * r}px;height:${2 * r}px;border-radius:50%;border:${1.5 * unit}px solid ${color};background:${color}33;box-sizing:border-box;`
              root.appendChild(el)
            } else if (a.type === 'arrow' && a.to) {
              const ns = 'http://www.w3.org/2000/svg'
              const svg = document.createElementNS(ns, 'svg')
              svg.setAttribute('width', String(W))
              svg.setAttribute('height', String(H))
              svg.style.position = 'absolute'
              svg.style.left = '0'
              svg.style.top = '0'
              const x2 = a.to.x * W
              const y2 = a.to.y * H
              const ang = Math.atan2(y2 - y, x2 - x)
              const head = 6 * unit
              const line = document.createElementNS(ns, 'line')
              line.setAttribute('x1', String(x))
              line.setAttribute('y1', String(y))
              line.setAttribute('x2', String(x2 - Math.cos(ang) * head * 0.8))
              line.setAttribute('y2', String(y2 - Math.sin(ang) * head * 0.8))
              line.setAttribute('stroke', color)
              line.setAttribute('stroke-width', String(2 * unit))
              line.setAttribute('stroke-linecap', 'round')
              const tri = document.createElementNS(ns, 'polygon')
              tri.setAttribute(
                'points',
                [
                  [0, 0],
                  [-Math.cos(ang - 0.5) * head, -Math.sin(ang - 0.5) * head],
                  [-Math.cos(ang + 0.5) * head, -Math.sin(ang + 0.5) * head]
                ]
                  .map(([dx, dy]) => `${x2 + dx},${y2 + dy}`)
                  .join(' ')
              )
              tri.setAttribute('fill', color)
              svg.append(line, tri)
              root.appendChild(svg)
            }
          },
          { a, scale: frame.scale, W: size.width, H: size.height, palette: PALETTE }
        )
        const path = join(dir, `annot-${++n}.png`)
        await page.screenshot({ path: path as `${string}.png`, omitBackground: true, type: 'png' })
        out.push({ path, start_ms: frame.start_ms, end_ms: frame.end_ms })
      }
    }
  } finally {
    await page.close().catch(() => null)
  }
  return out
}
