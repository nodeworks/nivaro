/**
 * Copy a figure as a picture: the render side (browser only).
 *
 * The widget's own DOM is painted with html2canvas (already shipped by the
 * admin; an optional peer of @nivaro/react, loaded on demand). Everything runs
 * on a CLONE of the page, so the viewer's screen is never touched:
 *   - the clone is forced to the light theme (`.dark` dropped), white ground;
 *   - the host's chrome (anything marked `data-widget-image-ignore`: menus,
 *     buttons, its own title row) is removed;
 *   - a header is put on top: title, "As of …", the filters in effect;
 *   - drawn at 2x so it stays crisp pasted into an email or Teams.
 * The figures are the ones already on screen — computed as the viewer — so no
 * server renderer is involved and nothing new is read.
 */
import { type WidgetImageLabel, widgetImageSubtitleLines } from './widget-image'

/** Hosts mark their own chrome (menu button, title row, toolbars) with this. */
export const WIDGET_IMAGE_IGNORE_ATTR = 'data-widget-image-ignore'

type Html2Canvas = (
  el: HTMLElement,
  opts: Record<string, unknown>
) => Promise<{ toBlob(cb: (b: Blob | null) => void, type?: string): void }>

async function loadHtml2Canvas(): Promise<Html2Canvas> {
  const mod = (await import('html2canvas')) as unknown as { default?: Html2Canvas }
  const fn = mod.default ?? (mod as unknown as Html2Canvas)
  if (typeof fn !== 'function') throw new Error('html2canvas missing')
  return fn
}

/** A picture narrower than this is drawn at this width (a phone's widget column would give a
 *  sliver nobody can paste into an email); the copy reflows at the wider size. */
export const MIN_PICTURE_WIDTH = 640

/** The width the picture is drawn at: the on-screen width, never under MIN_PICTURE_WIDTH. */
export function pictureWidth(onScreen: number): number {
  return Math.max(MIN_PICTURE_WIDTH, Math.round(onScreen) || 1)
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

/** Build the header block in the clone's own document. */
function buildHeader(doc: Document, label: WidgetImageLabel): HTMLElement {
  const head = doc.createElement('div')
  head.setAttribute('data-widget-image-header', '1')
  head.style.cssText = `flex:none;margin:0 0 10px;padding:0 0 8px;border-bottom:1px solid #e2e8f0;font-family:${FONT};text-align:left;`
  const title = doc.createElement('div')
  title.textContent = label.title
  title.style.cssText =
    'font-size:15px;font-weight:600;line-height:1.3;color:#0f172a;word-break:break-word;'
  head.appendChild(title)
  for (const line of widgetImageSubtitleLines(label)) {
    const p = doc.createElement('div')
    p.textContent = line
    p.style.cssText = 'margin-top:2px;font-size:11.5px;line-height:1.4;color:#475569;'
    head.appendChild(p)
  }
  return head
}

/**
 * Paint `el` to a PNG (2x, white, light theme) with `label` printed on top.
 * Throws when html2canvas is missing or the paint fails; the caller says so.
 */
export async function renderWidgetImage(
  el: HTMLElement,
  label: WidgetImageLabel,
  opts: { scale?: number } = {}
): Promise<Blob> {
  const html2canvas = await loadHtml2Canvas()
  const rect = el.getBoundingClientRect()
  const width = pictureWidth(rect.width)
  const height = Math.max(1, Math.round(rect.height))
  // Narrower on screen than the picture: the copy reflows at the picture width, so its height
  // is whatever the content needs there (charts keep their drawn height, centred).
  const widened = width > Math.round(rect.width)
  const canvas = await html2canvas(el, {
    scale: opts.scale ?? 2,
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
    // The clone's window must be at least as wide as the picture, or it lays out in the
    // phone's width again.
    windowWidth: Math.max(window.innerWidth, width + 32),
    onclone: (doc: Document, cloned: HTMLElement) => {
      const root = doc.documentElement
      root.classList.remove('dark')
      doc.body.classList.remove('dark')
      root.style.colorScheme = 'light'
      for (const n of Array.from(cloned.querySelectorAll(`[${WIDGET_IMAGE_IGNORE_ATTR}]`))) {
        n.remove()
      }
      // Alone on the page, at the size it has on screen: no grid placement,
      // no neighbours, no page chrome around it.
      for (const child of Array.from(doc.body.children)) {
        if (child !== cloned && !child.contains(cloned))
          (child as HTMLElement).style.display = 'none'
      }
      doc.body.style.margin = '0'
      doc.body.style.background = '#ffffff'
      if (cloned.parentElement !== doc.body) doc.body.appendChild(cloned)
      const s = cloned.style
      s.gridColumn = 'auto'
      s.gridRow = 'auto'
      s.margin = '0'
      s.boxShadow = 'none'
      s.background = '#ffffff'
      s.color = '#0f172a'
      s.borderColor = '#e2e8f0'
      s.width = `${width}px`
      s.maxWidth = 'none'
      s.height = widened ? 'auto' : `${height}px`
      s.minHeight = '0'
      s.maxHeight = 'none'
      s.overflow = 'hidden'
      s.boxSizing = 'border-box'
      if (!s.display) s.display = 'flex'
      if (getComputedStyle(cloned).display === 'flex') s.flexDirection = 'column'
      if (widened) {
        // Drawn charts were sized for the narrow column: let them take the picture's width at
        // their own height, centred, instead of a strip down the left edge.
        for (const svg of Array.from(cloned.querySelectorAll('svg'))) {
          const w = Number(svg.getAttribute('width'))
          const h = Number(svg.getAttribute('height'))
          if (!(w > 120 && h > 0)) continue
          if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
          svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
          svg.setAttribute('width', '100%')
          let box = svg.parentElement
          for (let i = 0; box && box !== cloned && i < 3; i++, box = box.parentElement) {
            box.style.width = '100%'
            box.style.maxWidth = 'none'
          }
        }
      }
      const head = buildHeader(doc, label)
      cloned.insertBefore(head, cloned.firstChild)
      // The header takes room the figure had: grow the card by the same.
      const used = Math.ceil(head.getBoundingClientRect().height + 10)
      if (!widened) {
        s.height = `${height + used}px`
      } else {
        // Reflowed at the picture width the card would end right under the figure: keep the
        // room it has on screen (a KPI's number stays centred under the rule) and at least
        // the card's top padding below the content, so nothing sits on the frame's edge.
        s.minHeight = `${height + used}px`
        const view = doc.defaultView ?? window
        const top = Number.parseFloat(view.getComputedStyle(cloned).paddingTop) || 0
        const bottom = Number.parseFloat(view.getComputedStyle(cloned).paddingBottom) || 0
        s.paddingBottom = `${Math.max(24, top, bottom)}px`
      }
    }
  })
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('picture was empty')
  return blob
}

/** Save a blob as a file download. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked after the browser has taken the download, not under it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export type CopyOrSaveResult = 'copied' | 'saved'

/**
 * Put the PNG on the clipboard; where the browser refuses (no image clipboard,
 * permission denied, insecure page) save it as a file instead. The promise is
 * handed to the clipboard unresolved so the browser still counts the click as
 * the user's gesture while the picture is being painted. A paint that failed
 * rejects — the caller says so.
 */
export async function copyPngOrSave(
  png: Promise<Blob>,
  fileName: string
): Promise<CopyOrSaveResult> {
  // A paint that fails before anything reads it must not go unhandled.
  png.catch(() => undefined)
  if (
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.clipboard?.write
  ) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      return 'copied'
    } catch {
      /* falls through to the file */
    }
  }
  downloadBlob(await png, fileName)
  return 'saved'
}
