import { Maximize2, X } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { MINI_PANEL } from './miniPlayer'

// Where the one player instance lives (#1500). The player is rendered through
// a React portal into a `stage` element the sheet owns; React listens for
// events on that element itself, so the stage can be MOVED — into the sheet,
// a Document Picture-in-Picture window or the floating panel — without the
// React tree or the <video> being rebuilt. Each place below adopts the stage
// when it mounts; nothing here ever creates a second player.

const chromeButton =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-600 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none dark:text-muted-foreground dark:hover:bg-white/5 dark:hover:text-foreground'

/** Puts `stage` inside this element while it is mounted. */
export function StageSlot({ stage, className }: { stage: HTMLElement; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stage.parentElement !== el) el.appendChild(stage)
  }, [stage])
  return <div ref={ref} className={className} data-hv-stage-slot />
}

/** The small bar above a popped-out player: the title, back to the sheet, close. */
export function MiniChrome({
  title,
  onPopIn,
  onClose
}: {
  title: string
  onPopIn: () => void
  onClose: () => void
}) {
  return (
    <div
      className='flex h-9 shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-2 text-[12.5px] dark:border-border dark:bg-card'
      data-hv-mini-chrome
    >
      <span className='min-w-0 flex-1 truncate font-medium text-slate-900 dark:text-foreground'>
        {title}
      </span>
      <button
        type='button'
        aria-label='Back to the video'
        title='Back to the video'
        className={chromeButton}
        onClick={onPopIn}
        data-hv-mini-back
      >
        <Maximize2 className='h-3.5 w-3.5' />
      </button>
      <button
        type='button'
        aria-label='Close'
        title='Close'
        className={chromeButton}
        onClick={onClose}
        data-hv-mini-close
      >
        <X className='h-4 w-4' />
      </button>
    </div>
  )
}

/**
 * The floating panel: browsers without Document Picture-in-Picture get the
 * player docked to the page's bottom-right corner. The page keeps that much
 * room at the bottom (body padding, like the pinned chat panel), and the
 * panel is dock-aware so a pinned chat panel moves it over.
 */
export function MiniPanel({
  stage,
  title,
  onPopIn,
  onClose
}: {
  stage: HTMLElement
  title: string
  onPopIn: () => void
  onClose: () => void
}) {
  useLayoutEffect(() => {
    const body = document.body
    const before = body.style.paddingBottom
    body.style.paddingBottom = `${MINI_PANEL.height + MINI_PANEL.margin * 2}px`
    body.dataset.nvrMiniPlayer = '1'
    return () => {
      body.style.paddingBottom = before
      delete body.dataset.nvrMiniPlayer
    }
  }, [])
  return createPortal(
    <section
      aria-label={`Mini player: ${title}`}
      className='fixed z-50 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-card'
      style={{
        right: MINI_PANEL.margin,
        bottom: MINI_PANEL.margin,
        width: MINI_PANEL.width,
        maxWidth: `calc(100vw - ${MINI_PANEL.margin * 2}px)`
      }}
      data-hv-mini-panel
      data-nvr-dock-aware
      data-nvr-recording-hide
    >
      <MiniChrome title={title} onPopIn={onPopIn} onClose={onClose} />
      <StageSlot
        stage={stage}
        className='[&>[data-hv-player]]:rounded-none [&>[data-hv-player]]:border-0'
      />
    </section>,
    document.body
  )
}

/** The PiP window's document, made ready for our DOM: the page's stylesheets
 *  (copied, as the API requires — the window starts empty), the theme class
 *  and colour scheme, and a body that fills the window. */
export function preparePipDocument(pip: Window, from: Document): void {
  const doc = pip.document
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = doc.createElement('style')
      style.textContent = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n')
      doc.head.appendChild(style)
    } catch {
      // Cross-origin stylesheet: link to it instead.
      if (sheet.href) {
        const link = doc.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        if (sheet.media.mediaText) link.media = sheet.media.mediaText
        doc.head.appendChild(link)
      }
    }
  }
  const root = from.documentElement
  doc.documentElement.className = root.className
  for (const name of root.getAttributeNames()) {
    if (name.startsWith('data-'))
      doc.documentElement.setAttribute(name, root.getAttribute(name) ?? '')
  }
  const own = doc.createElement('style')
  own.textContent =
    'html,body{margin:0;height:100%;overflow:hidden}body{display:flex;flex-direction:column;background:var(--background,#fff)}[data-hv-mini-root]{display:flex;flex-direction:column;flex:1;min-height:0}[data-hv-stage-slot]{display:flex;flex-direction:column;flex:1;min-height:0}[data-hv-stage-slot]>[data-hv-player]{flex:1;min-height:0;border:0;border-radius:0}'
  doc.head.appendChild(own)
  doc.title = from.title
}

/** The chrome bar and the stage inside a Document Picture-in-Picture window. */
export function PipContents({
  body,
  stage,
  title,
  onPopIn,
  onClose
}: {
  body: HTMLElement
  stage: HTMLElement
  title: string
  onPopIn: () => void
  onClose: () => void
}) {
  return createPortal(
    <div data-hv-mini-root data-hv-mini-pip>
      <MiniChrome title={title} onPopIn={onPopIn} onClose={onClose} />
      <StageSlot stage={stage} />
    </div>,
    body
  )
}
