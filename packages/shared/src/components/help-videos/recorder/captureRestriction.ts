/**
 * Keeps the recorder's own controls out of a recording of this tab.
 *
 * Chrome's Element Capture (RestrictionTarget, Chrome 132+) narrows a capture
 * of the current tab to one element and what is inside it; anything else on
 * the page is left out of the frames, even when it paints on top. The capture
 * is restricted to <body>, and the recording bar renders in a host that sits
 * beside <body> under <html> (outsideCaptureHost), so everything the app shows
 * (dialogs, menus, toasts) is recorded and the controls are not.
 *
 * Only when <body> fills the viewport: the restricted frame is the element's
 * box, and recorded clicks and the pointer path are fractions of the viewport.
 * Anywhere else (another browser, another tab or window picked, a page whose
 * body scrolls) nothing changes and the bar shows in the video as before.
 */

type RestrictionTargetCtor = { fromElement(el: Element): Promise<unknown> }
type RestrictableTrack = MediaStreamTrack & { restrictTo?: (target: unknown) => Promise<void> }

/** Px of slack when comparing <body>'s box with the viewport. */
const FIT_SLACK = 2

export const OUTSIDE_CAPTURE_ATTR = 'data-hv-outside-capture'

/** Can this browser restrict a tab capture to an element? */
export function canRestrictCapture(win: Window = window): boolean {
  const ctor = (win as unknown as { RestrictionTarget?: RestrictionTargetCtor }).RestrictionTarget
  return typeof ctor?.fromElement === 'function'
}

/** Does <body> cover exactly the viewport (so its frame is the viewport)? */
export function bodyFillsViewport(doc: Document = document): boolean {
  const win = doc.defaultView
  if (!win || !doc.body) return false
  const r = doc.body.getBoundingClientRect()
  return (
    Math.abs(r.left) <= FIT_SLACK &&
    Math.abs(r.top) <= FIT_SLACK &&
    Math.abs(r.width - win.innerWidth) <= FIT_SLACK &&
    Math.abs(r.height - win.innerHeight) <= FIT_SLACK
  )
}

/**
 * Restricts `track` (a capture of this tab) to <body>. Resolves to a release
 * that undoes the page change, or null when the capture stays whole (no
 * support, another surface, a body that does not fill the viewport, or the
 * browser refused — e.g. another tab was picked).
 */
export async function restrictCaptureToPage(
  track: MediaStreamTrack | undefined,
  doc: Document = document
): Promise<(() => void) | null> {
  const win = doc.defaultView
  const t = track as RestrictableTrack | undefined
  if (!win || !t || typeof t.restrictTo !== 'function' || !canRestrictCapture(win)) return null
  if (t.getSettings?.().displaySurface !== 'browser') return null
  if (!bodyFillsViewport(doc)) return null
  const body = doc.body
  const root = doc.documentElement
  const before = {
    isolation: body.style.isolation,
    color: root.style.backgroundColor,
    image: root.style.backgroundImage
  }
  // Element Capture needs the element to form its own stacking context.
  body.style.isolation = 'isolate'
  // With no background of its own, <html> takes <body>'s for the whole page
  // and <body> paints none — a body-only capture then records black behind
  // the app (seen in Chrome 154). Giving <html> the same background keeps the
  // page looking the same and makes <body> paint its own.
  const look = win.getComputedStyle(body)
  root.style.backgroundColor = look.backgroundColor
  root.style.backgroundImage = look.backgroundImage
  const undo = () => {
    body.style.isolation = before.isolation
    root.style.backgroundColor = before.color
    root.style.backgroundImage = before.image
  }
  try {
    const ctor = (win as unknown as { RestrictionTarget: RestrictionTargetCtor }).RestrictionTarget
    await t.restrictTo(await ctor.fromElement(body))
    return undo
  } catch {
    undo()
    return null
  }
}

/** The host beside <body> the recording bar renders into while the capture
 *  is restricted (created once per document, removed by releaseOutsideHost). */
export function outsideCaptureHost(doc: Document = document): HTMLElement {
  const found = doc.documentElement.querySelector<HTMLElement>(`:scope > [${OUTSIDE_CAPTURE_ATTR}]`)
  if (found) return found
  const el = doc.createElement('div')
  el.setAttribute(OUTSIDE_CAPTURE_ATTR, '')
  doc.documentElement.appendChild(el)
  return el
}

export function releaseOutsideHost(doc: Document = document): void {
  doc.documentElement.querySelector(`:scope > [${OUTSIDE_CAPTURE_ATTR}]`)?.remove()
}
