/**
 * A screenshot of the page for Report a problem (#1390), with every typed
 * value masked first — the same rule session replay applies (all inputs
 * masked, `.nvr-no-record` blocked). html2canvas renders a CLONE of the
 * document, and the masking happens on that clone, so the live page is never
 * touched.
 *
 * html2canvas is an optional peer dependency of @nivaro/react (the admin
 * already ships it): loaded on demand, and without it the report simply goes
 * without a screenshot.
 */

const MASK = '••••••'
const UNMASKED_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'range',
  'color',
  'image',
  'hidden'
])

/** Mask every typed value and blank every `.nvr-no-record` element under `root`. */
export function maskInputsIn(root: Document | Element): void {
  for (const el of Array.from(root.querySelectorAll('input'))) {
    const input = el as HTMLInputElement
    if (UNMASKED_INPUT_TYPES.has((input.type || 'text').toLowerCase())) continue
    const had = input.value !== ''
    input.value = had ? MASK : ''
    input.setAttribute('value', had ? MASK : '')
  }
  for (const el of Array.from(root.querySelectorAll('textarea'))) {
    const ta = el as HTMLTextAreaElement
    const had = ta.value !== ''
    ta.value = had ? MASK : ''
    ta.textContent = had ? MASK : ''
  }
  for (const el of Array.from(root.querySelectorAll('select'))) {
    const sel = el as HTMLSelectElement
    for (const opt of Array.from(sel.options)) opt.textContent = MASK
  }
  for (const el of Array.from(
    root.querySelectorAll('[contenteditable=""], [contenteditable="true"]')
  )) {
    el.textContent = el.textContent ? MASK : ''
  }
  for (const el of Array.from(root.querySelectorAll('.nvr-no-record'))) {
    ;(el as HTMLElement).style.visibility = 'hidden'
  }
}

type Html2Canvas = (
  el: HTMLElement,
  opts: Record<string, unknown>
) => Promise<{ toDataURL(type: string, quality?: number): string }>

async function loadHtml2Canvas(): Promise<Html2Canvas | null> {
  try {
    const mod = (await import('html2canvas')) as unknown as { default?: Html2Canvas }
    return mod.default ?? (mod as unknown as Html2Canvas)
  } catch {
    return null
  }
}

/**
 * A downscaled JPEG data URI of the page (≤ 1280px wide), or null when
 * html2canvas is missing or the capture fails. Elements carrying `ignoreAttr`
 * (the reporter's own button) are left out.
 */
export async function captureMaskedScreenshot(
  opts: { ignoreAttr?: string; maxWidth?: number } = {}
): Promise<string | null> {
  if (typeof document === 'undefined') return null
  const html2canvas = await loadHtml2Canvas()
  if (!html2canvas) return null
  const ignoreAttr = opts.ignoreAttr ?? 'data-report-problem'
  try {
    const canvas = await html2canvas(document.body, {
      logging: false,
      scale: Math.min(1, (opts.maxWidth ?? 1280) / Math.max(1, window.innerWidth)),
      ignoreElements: (el: Element) => el.hasAttribute(ignoreAttr),
      onclone: (doc: Document) => maskInputsIn(doc)
    })
    const uri = canvas.toDataURL('image/jpeg', 0.7)
    // The server caps a screenshot at 2.5MB; a lower quality usually fits.
    return uri.length > 2_400_000 ? canvas.toDataURL('image/jpeg', 0.4) : uri
  } catch {
    return null
  }
}

/**
 * A downscaled JPEG data URI of one element (the layout editor's canvas for
 * the AI visual critique, #2690), typed values masked like the page capture;
 * null when html2canvas is missing or the capture fails. `ignoreSelector`
 * leaves elements out (editor badges, drop lines).
 */
export async function captureElementImage(
  el: HTMLElement,
  opts: { maxWidth?: number; ignoreSelector?: string; maxChars?: number } = {}
): Promise<string | null> {
  if (typeof document === 'undefined') return null
  const html2canvas = await loadHtml2Canvas()
  if (!html2canvas) return null
  const width = Math.max(1, el.scrollWidth || el.clientWidth)
  try {
    const canvas = await html2canvas(el, {
      logging: false,
      backgroundColor: null,
      scale: Math.min(1, (opts.maxWidth ?? 1200) / width),
      ignoreElements: (node: Element) =>
        !!opts.ignoreSelector && node.matches?.(opts.ignoreSelector),
      onclone: (doc: Document) => maskInputsIn(doc)
    })
    const cap = opts.maxChars ?? 1_900_000
    for (const q of [0.7, 0.5, 0.35]) {
      const uri = canvas.toDataURL('image/jpeg', q)
      if (uri.length <= cap) return uri
    }
    return null
  } catch {
    return null
  }
}
