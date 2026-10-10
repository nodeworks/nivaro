import { consoleLine } from './replay-context'

/**
 * What "Report a problem" (#1390) takes from the browser: the last console
 * warnings and errors, and a screenshot of the page with every typed value
 * masked. Both are best-effort — a report goes out without them when the
 * browser refuses.
 */

const TAIL_MAX = 40
const tail: string[] = []
let consoleInstalled = false

/**
 * Keep the last console warnings and errors in memory (never sent anywhere
 * until the person files a report). Idempotent; call it once at startup so
 * the tail covers what happened before the report was opened.
 */
export function startProblemConsoleTail(): void {
  if (consoleInstalled || typeof console === 'undefined') return
  consoleInstalled = true
  for (const level of ['warn', 'error'] as const) {
    const original = console[level]
    console[level] = (...args: unknown[]) => {
      original.apply(console, args)
      try {
        tail.push(`[${level}] ${consoleLine(args, 300)}`)
        if (tail.length > TAIL_MAX) tail.shift()
      } catch {
        /* never break the console */
      }
    }
  }
}

/** The console lines captured so far, oldest first. */
export function problemConsoleTail(): string[] {
  return [...tail]
}

/** Elements carrying this attribute are left out of the screenshot. */
export const PROBLEM_REPORT_EXCLUDE_ATTR = 'data-nvr-report-problem'

const MASK_STYLE_ID = 'nvr-problem-shot-mask'
// Applied for the length of the capture only. html-to-image copies each
// element's COMPUTED style into its clone, so text made transparent here is
// transparent in the image; the stripe says a value was there.
const MASK_CSS = `
html[data-nvr-shot-masking] input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),
html[data-nvr-shot-masking] textarea,
html[data-nvr-shot-masking] select,
html[data-nvr-shot-masking] [contenteditable]:not([contenteditable=false]),
html[data-nvr-shot-masking] .nvr-no-record {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  caret-color: transparent !important;
  background-image: repeating-linear-gradient(135deg, rgba(148,163,184,.28) 0 6px, transparent 6px 12px) !important;
}
html[data-nvr-shot-masking] .nvr-no-record * { visibility: hidden !important; }
`

/** Largest data URI the server takes for a screenshot. */
export const PROBLEM_SCREENSHOT_MAX = 2_400_000

const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/**
 * A JPEG of what the person sees right now, typed values masked, the report
 * control itself left out. Null when `html-to-image` is not installed in the
 * host app or the browser cannot render the page.
 */
export async function captureProblemScreenshot(): Promise<string | null> {
  if (typeof document === 'undefined') return null
  let toJpeg: typeof import('html-to-image')['toJpeg']
  try {
    toJpeg = (await import('html-to-image')).toJpeg
  } catch {
    return null
  }
  const root = document.documentElement
  let style = document.getElementById(MASK_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = MASK_STYLE_ID
    style.textContent = MASK_CSS
    document.head.appendChild(style)
  }
  root.setAttribute('data-nvr-shot-masking', '')
  try {
    const width = window.innerWidth
    const height = window.innerHeight
    const shoot = (quality: number) =>
      toJpeg(document.body, {
        quality,
        width,
        height,
        pixelRatio: Math.min(1, 1280 / Math.max(1, width)),
        backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
        skipFonts: true,
        cacheBust: false,
        imagePlaceholder: TRANSPARENT_PIXEL,
        filter: (node) =>
          !(node instanceof Element && node.hasAttribute(PROBLEM_REPORT_EXCLUDE_ATTR))
      })
    let shot = await shoot(0.72)
    if (shot.length > PROBLEM_SCREENSHOT_MAX) shot = await shoot(0.45)
    return shot.length > PROBLEM_SCREENSHOT_MAX ? null : shot
  } catch {
    return null
  } finally {
    root.removeAttribute('data-nvr-shot-masking')
  }
}
