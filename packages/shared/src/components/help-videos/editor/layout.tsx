import { ChevronRight } from 'lucide-react'
import { type ReactNode, useCallback, useId, useState } from 'react'

/**
 * The editor's page layout, as one scoped stylesheet.
 *
 * Why not Tailwind responsive classes: a host app's own stylesheet loads after
 * the shared one and re-declares the base utilities (`flex-col`, `shrink-0`,
 * `hidden`…) at the same specificity, so a `lg:flex-row` here silently loses in
 * efp-new and the video spills under the timeline. Attribute selectors in a
 * style element the editor owns cannot be overridden that way.
 *
 * Breakpoints follow the EDITOR's width (a container query), not the window's:
 * a host sidebar takes 250 px the window size never sees.
 *
 * Areas: tools across the top; the picture with the side panel beside it; the
 * timeline full width at the bottom (time needs every pixel of width). Narrow:
 * one column that scrolls — tools, picture, timeline, side panel.
 */
const CSS = `
[data-hvx-root]{container-type:inline-size;container-name:hvx}
[data-hvx-head]{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 16px;border-bottom:1px solid hsl(var(--border))}
[data-hvx-head-title]{display:flex;flex:1 1 260px;flex-wrap:wrap;align-items:baseline;gap:2px 12px;min-width:0}
[data-hvx-head-actions]{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px 14px;margin-left:auto}
[data-hvx-edit]{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:"tools" "stage" "timeline" "side";align-content:start;min-height:0;flex:1 1 0;overflow-y:auto}
[data-hvx-tools]{grid-area:tools;display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:8px 16px;border-bottom:1px solid hsl(var(--border))}
[data-hvx-group]{display:flex;align-items:center;gap:6px}
[data-hvx-sep]{display:none;width:1px;height:20px;background:hsl(var(--border))}
[data-hvx-tool-label]{display:none}
[data-hvx-stage]{grid-area:stage;min-width:0;min-height:0;height:min(58cqi,460px);padding:12px 16px;background:hsl(var(--muted)/.45)}
[data-hvx-timeline]{grid-area:timeline;min-width:0}
[data-hvx-side]{grid-area:side;min-width:0;border-top:1px solid hsl(var(--border));background:hsl(var(--background))}
@container hvx (min-width: 720px){
  [data-hvx-sep]{display:block}
}
@container hvx (min-width: 960px){
  [data-hvx-head]{flex-wrap:nowrap}
  [data-hvx-edit]{grid-template-columns:minmax(0,1fr) 320px;grid-template-rows:auto minmax(220px,1fr) auto;grid-template-areas:"tools tools" "stage side" "timeline timeline";overflow:hidden}
  [data-hvx-stage]{height:auto}
  [data-hvx-side]{border-top:0;border-left:1px solid hsl(var(--border));overflow-y:auto}
  [data-hvx-timeline]{max-height:46vh;overflow-y:auto}
  [data-hvx-edit][data-hvx-noside]{grid-template-columns:minmax(0,1fr);grid-template-areas:"tools" "stage" "timeline"}
}
@container hvx (min-width: 1280px){
  [data-hvx-tool-label]{display:inline}
  [data-hvx-edit]{grid-template-columns:minmax(0,1fr) 340px}
  [data-hvx-edit][data-hvx-noside]{grid-template-columns:minmax(0,1fr)}
}
`

/** Mount once inside the editor (duplicates are harmless: same rules). */
export function EditorLayoutStyle() {
  return <style>{CSS}</style>
}

/** A thin divider between toolbar groups (shown once the editor is wide). */
export function ToolSep() {
  return <span data-hvx-sep aria-hidden />
}

const OPEN_KEY = 'nvr_hv_side_open'
const DEFAULT_OPEN = ['chapters']

function readOpen(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_KEY)
    const v = raw ? JSON.parse(raw) : null
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : DEFAULT_OPEN
  } catch {
    return DEFAULT_OPEN
  }
}

/** Which side-panel sections are open, remembered per browser. */
export function useOpenSections(): [Set<string>, (key: string) => void] {
  const [open, setOpen] = useState<Set<string>>(() => new Set(readOpen()))
  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...next]))
      } catch {
        // a blocked store only means the choice is not remembered
      }
      return next
    })
  }, [])
  return [open, toggle]
}

/**
 * One collapsible row of the side panel: a title, a short summary of what is
 * set ("3 chapters", "Off"), and the panel underneath. The panel stays mounted
 * while closed so a half-typed caption or an open popover keeps its state.
 */
export function SideSection({
  id,
  title,
  summary,
  open,
  onToggle,
  children
}: {
  id: string
  title: string
  summary: string
  open: boolean
  onToggle: (id: string) => void
  children: ReactNode
}) {
  const bodyId = useId()
  return (
    <div className='border-b border-border' data-hv-side-section={id}>
      <button
        type='button'
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggle(id)}
        className='flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none'
        data-hv-side-toggle={id}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <span className='text-[13px] font-semibold text-foreground'>{title}</span>
        <span
          className='ml-auto truncate pl-2 text-[12px] tabular-nums text-muted-foreground'
          data-hv-side-summary={id}
        >
          {summary}
        </span>
      </button>
      <div id={bodyId} hidden={!open} className='px-4 pb-4 pt-0.5'>
        {children}
      </div>
    </div>
  )
}
