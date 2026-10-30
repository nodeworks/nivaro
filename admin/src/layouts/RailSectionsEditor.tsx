import { ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react'
import type { ElementType } from 'react'
import { cn } from '@/lib/utils'
import { applyRail, moveSection, type NavLayout, toggleSectionHidden } from './nav-layout'

/**
 * The main sections (the icon rail): show / hide and move up or down. Used by
 * the person's own Customize panel (tone 'sidebar') and by Roles → Sidebar for a
 * role's starter (tone 'card'). Sections move only inside their own group, and
 * the last section shown cannot be hidden.
 */
export interface RailSectionItem {
  id: string
  label: string
  zone?: string
  icon: ElementType
}

export function RailSectionsEditor({
  sections,
  layout,
  onChange,
  tone,
  disabled = false
}: {
  /** Every main section this person / role may open, in default order. */
  sections: RailSectionItem[]
  layout: NavLayout | null
  onChange: (next: NavLayout | null) => void
  tone: 'sidebar' | 'card'
  disabled?: boolean
}) {
  const shown = applyRail(sections, layout, { includeHidden: true })
  const shownCount = shown.filter((s) => !s.railHidden).length
  const btn =
    tone === 'sidebar'
      ? 'flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:pointer-events-none disabled:opacity-30'
      : 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:pointer-events-none disabled:opacity-30 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-200'

  return (
    <ul className='space-y-px' data-rail-sections-editor>
      {shown.map((sec, idx) => {
        const block = shown.filter((s) => (s.zone ?? '') === (sec.zone ?? ''))
        const pos = block.findIndex((s) => s.id === sec.id)
        const startsGroup = idx > 0 && (shown[idx - 1].zone ?? '') !== (sec.zone ?? '')
        const lastShown = !sec.railHidden && shownCount <= 1
        return (
          <li key={sec.id} data-rail-section-row={sec.id}>
            {startsGroup && (
              <div
                aria-hidden
                className={cn(
                  'mx-4 my-1.5 h-px',
                  tone === 'sidebar' ? 'bg-white/[0.08]' : 'bg-slate-100 dark:bg-border'
                )}
              />
            )}
            <div
              className={cn(
                'flex items-center gap-1 py-1 pl-4 pr-2',
                tone === 'sidebar' ? 'text-[12.5px]' : 'text-[13px]',
                sec.railHidden
                  ? tone === 'sidebar'
                    ? 'text-slate-600 line-through'
                    : 'text-slate-400 line-through dark:text-slate-500'
                  : tone === 'sidebar'
                    ? 'text-slate-300'
                    : 'text-slate-700 dark:text-slate-200'
              )}
            >
              <sec.icon className='h-[14px] w-[14px] shrink-0 opacity-80' />
              <span className='ml-1 min-w-0 flex-1 truncate'>{sec.label}</span>
              <button
                type='button'
                className={btn}
                disabled={disabled || pos <= 0}
                onClick={() => onChange(moveSection(layout, shown, sec.id, -1))}
                aria-label={`Move ${sec.label} up`}
              >
                <ChevronUp className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                className={btn}
                disabled={disabled || pos < 0 || pos >= block.length - 1}
                onClick={() => onChange(moveSection(layout, shown, sec.id, 1))}
                aria-label={`Move ${sec.label} down`}
              >
                <ChevronDown className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                className={btn}
                disabled={disabled || lastShown}
                aria-pressed={!!sec.railHidden}
                onClick={() => onChange(toggleSectionHidden(layout, sections, sec.id))}
                aria-label={sec.railHidden ? `Show ${sec.label}` : `Hide ${sec.label}`}
                data-tip={
                  lastShown ? 'At least one section stays' : sec.railHidden ? 'Show' : 'Hide'
                }
              >
                {sec.railHidden ? (
                  <EyeOff className='h-3.5 w-3.5' />
                ) : (
                  <Eye className='h-3.5 w-3.5' />
                )}
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
