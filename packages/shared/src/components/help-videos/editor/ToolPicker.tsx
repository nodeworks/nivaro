import {
  EyeOff,
  type LucideIcon,
  MessageSquareText,
  MousePointerClick,
  MoveUpRight,
  Scan,
  Square
} from 'lucide-react'
import { memo } from 'react'
import type { Tool } from './tools'

export const TOOLS: Array<{ tool: Tool; label: string; icon: LucideIcon; what: string }> = [
  { tool: 'callout', label: 'Callout', icon: MessageSquareText, what: 'a label with text' },
  { tool: 'arrow', label: 'Arrow', icon: MoveUpRight, what: 'an arrow, from tail to tip' },
  { tool: 'box', label: 'Box', icon: Square, what: 'an outline around something' },
  { tool: 'ripple', label: 'Ripple', icon: MousePointerClick, what: 'a click ripple' },
  { tool: 'zoom', label: 'Zoom', icon: Scan, what: 'an area to zoom into' },
  { tool: 'blur', label: 'Blur', icon: EyeOff, what: 'an area to blur out' }
]

/** One toggle per drawing tool. Pressing the active one (or Escape) puts it
 *  down; drawing a shape puts it down too. Labels show on wide screens; the
 *  icons carry the name everywhere else (editor layout.tsx decides the width). */
export const ToolPicker = memo(function ToolPicker({
  tool,
  onTool
}: {
  tool: Tool | null
  onTool: (t: Tool | null) => void
}) {
  return (
    <div data-hvx-group>
      <span className='pl-1 text-[12px] text-muted-foreground' aria-hidden>
        Draw
      </span>
      <fieldset
        className='flex overflow-hidden rounded-md border border-input'
        aria-label='Draw on the picture'
      >
        {TOOLS.map(({ tool: t, label, icon: Icon, what }) => {
          const active = tool === t
          return (
            <button
              key={t}
              type='button'
              aria-pressed={active}
              aria-label={label}
              title={`${label}: drag on the picture to draw ${what}`}
              onClick={() => onTool(active ? null : t)}
              className={`inline-flex h-8 min-w-[34px] items-center justify-center gap-1.5 border-l border-input px-2 text-[12.5px] transition-colors duration-150 first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none ${active ? 'bg-nvr-cyan/15 font-semibold text-foreground' : 'bg-background text-foreground hover:bg-muted'}`}
              data-hv-tool={t}
            >
              <Icon className='h-3.5 w-3.5 shrink-0' aria-hidden />
              <span data-hvx-tool-label>{label}</span>
            </button>
          )
        })}
      </fieldset>
    </div>
  )
})
