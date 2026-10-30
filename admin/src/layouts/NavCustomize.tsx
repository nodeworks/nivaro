import { ChevronDown, ChevronUp, Eye, EyeOff, Pin, PinOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  applyNavLayout,
  type KeyedNavCategory,
  MAX_PINNED,
  moveItem,
  toggleHidden,
  togglePinned
} from './nav-layout'
import { RailSectionsEditor } from './RailSectionsEditor'
import type { NavLayoutApi } from './useNavLayout'

/**
 * #3227 — Customize mode for one category's panel: pin to the top, hide, and
 * move up / down inside a section. Edits start from what the person sees (their
 * own layout, else their role's starter) and save as their own. "Reset to
 * default" drops their own layout — they are back on the role's starter (or
 * the standard nav when the role has none).
 *
 * Only the items the role may open are listed (the caller passes permitted
 * categories), so nothing here can put a page on the sidebar the role cannot open.
 */
export function NavCustomizePanel({
  category,
  sections,
  layoutApi,
  onDone
}: {
  category: KeyedNavCategory
  /** Every main section this person may open (the rail), in default order. */
  sections: KeyedNavCategory[]
  layoutApi: NavLayoutApi
  onDone: () => void
}) {
  const t = useT()
  const { effective, personal, starter, save } = layoutApi
  const [confirmReset, setConfirmReset] = useState(false)
  // This panel's pages, or the main sections themselves (the icon rail).
  const [view, setView] = useState<'panel' | 'sections'>('panel')
  useEffect(() => {
    if (!confirmReset) return
    const tm = setTimeout(() => setConfirmReset(false), 4000)
    return () => clearTimeout(tm)
  }, [confirmReset])

  const [shownCat] = applyNavLayout([category], effective, { includeHidden: true })
  const shown = shownCat.items
  const pinnedCount = shown.filter((i) => i.pinned).length

  const iconBtn =
    'flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:pointer-events-none disabled:opacity-30'

  return (
    <div className='flex min-h-0 flex-1 flex-col' data-nav-customize={category.id}>
      <div
        role='tablist'
        aria-label='What to customize'
        className='mx-3 mb-2 mt-1 flex rounded-md bg-white/[0.05] p-0.5 text-[11.5px] font-medium'
      >
        {(
          [
            ['panel', 'This panel'],
            ['sections', 'Main sections']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type='button'
            role='tab'
            aria-selected={view === key}
            data-nav-customize-view={key}
            onClick={() => setView(key)}
            className={cn(
              'flex-1 rounded px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
              view === key ? 'bg-white/[0.1] text-white' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <p className='px-4 pb-2 text-[11px] leading-snug text-slate-500'>
        {view === 'panel'
          ? 'Pin, hide or reorder this panel for yourself.'
          : 'Hide the sections you never use and put the rest in your order.'}
      </p>
      {view === 'sections' ? (
        <div className='min-h-0 flex-1 overflow-y-auto pb-3'>
          <RailSectionsEditor
            sections={sections.map((c) => ({
              id: c.id,
              label: t(`nav.${c.label}`, c.label),
              zone: c.zone,
              icon: c.icon
            }))}
            layout={effective}
            onChange={(next) => void save(next)}
            tone='sidebar'
          />
        </div>
      ) : (
        <ul className='min-h-0 flex-1 space-y-px overflow-y-auto pb-3'>
          {shown.map((item, idx) => {
            const block = shown.filter(
              (i) => (i.section ?? '') === (item.section ?? '') && !!i.pinned === !!item.pinned
            )
            const pos = block.findIndex((i) => i.key === item.key)
            const label = t(`nav.${item.label}`, item.label)
            return (
              <li key={item.key} data-nav-customize-row={item.key}>
                {item.section && item.section !== shown[idx - 1]?.section && (
                  <p
                    className={cn(
                      'px-4 pb-1 text-[11px] font-semibold text-slate-400',
                      idx > 0 ? 'mt-3' : 'mt-0.5'
                    )}
                  >
                    {item.section}
                  </p>
                )}
                <div
                  className={cn(
                    'flex items-center gap-1 py-1 pl-4 pr-2 text-[12.5px]',
                    item.hidden ? 'text-slate-600 line-through' : 'text-slate-300'
                  )}
                >
                  <item.icon className='h-[14px] w-[14px] shrink-0 opacity-80' />
                  <span className='ml-1 min-w-0 flex-1 truncate'>{label}</span>
                  <button
                    type='button'
                    className={iconBtn}
                    disabled={pos <= 0}
                    onClick={() => void save(moveItem(effective, category.id, shown, item.key, -1))}
                    aria-label={`Move ${label} up`}
                  >
                    <ChevronUp className='h-3.5 w-3.5' />
                  </button>
                  <button
                    type='button'
                    className={iconBtn}
                    disabled={pos < 0 || pos >= block.length - 1}
                    onClick={() => void save(moveItem(effective, category.id, shown, item.key, 1))}
                    aria-label={`Move ${label} down`}
                  >
                    <ChevronDown className='h-3.5 w-3.5' />
                  </button>
                  <button
                    type='button'
                    className={cn(iconBtn, item.pinned && 'text-nvr-cyan hover:text-nvr-cyan')}
                    disabled={!item.pinned && pinnedCount >= MAX_PINNED}
                    aria-pressed={!!item.pinned}
                    onClick={() => void save(togglePinned(effective, category.id, item.key))}
                    aria-label={item.pinned ? `Unpin ${label}` : `Pin ${label} to the top`}
                    data-tip={item.pinned ? 'Unpin' : 'Pin to the top'}
                  >
                    {item.pinned ? (
                      <PinOff className='h-3.5 w-3.5' />
                    ) : (
                      <Pin className='h-3.5 w-3.5' />
                    )}
                  </button>
                  <button
                    type='button'
                    className={iconBtn}
                    aria-pressed={!!item.hidden}
                    onClick={() => void save(toggleHidden(effective, category.id, item.key))}
                    aria-label={item.hidden ? `Show ${label}` : `Hide ${label}`}
                    data-tip={item.hidden ? 'Show' : 'Hide'}
                  >
                    {item.hidden ? (
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
      )}
      <div className='flex shrink-0 items-center justify-between gap-2 border-t border-white/[0.07] px-3 py-2'>
        <button
          type='button'
          disabled={!personal}
          onClick={() => {
            if (!confirmReset) {
              setConfirmReset(true)
              return
            }
            setConfirmReset(false)
            void save(
              null,
              starter ? 'Back to your role’s sidebar' : 'Back to the standard sidebar'
            )
          }}
          className={cn(
            'rounded px-1.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:pointer-events-none disabled:opacity-40',
            confirmReset
              ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
              : 'text-slate-400 hover:bg-white/[0.06] hover:text-white'
          )}
          data-tip={
            personal
              ? 'Every panel and the main sections go back to the default'
              : 'You are already on the default'
          }
        >
          {confirmReset ? 'Click to confirm' : 'Reset to default'}
        </button>
        <button
          type='button'
          onClick={onDone}
          className='rounded bg-nvr-cyan px-2.5 py-1 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
        >
          Done
        </button>
      </div>
    </div>
  )
}
