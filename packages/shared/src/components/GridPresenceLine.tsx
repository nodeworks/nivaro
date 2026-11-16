import type { ReactNode } from 'react'
import type { GridEditor } from '../lib/grid-presence'
import { cn } from '../lib/utils'
import { UserChip } from './item-edit/UserChip'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/**
 * The page-level line of a budget / planning grid (realtime round 8, item 22):
 * "Beth Ray is editing allocations for 4471 · March". One person reads as a sentence; more
 * become a short list of people, each with the row they are in. Each person keeps the colour
 * their cell outline uses. Names come from the server (the people already passed the read gate
 * of the row they are in, as did the viewer); row and cell labels come from the viewer's own
 * page — a row not on it falls back to its id.
 */
export function GridPresenceLine({
  editors,
  noun,
  rowLabel,
  cellLabel,
  className
}: {
  editors: GridEditor[]
  /** What the page edits, plural: "forecasts", "allocations". */
  noun: string
  rowLabel: (item: string) => string | null | undefined
  cellLabel?: (field: string, item: string) => string | null | undefined
  className?: string
}) {
  if (editors.length === 0) return null
  const where = (e: GridEditor) => {
    const row = rowLabel(e.item) || e.item
    const cell = e.field ? cellLabel?.(e.field, e.item) : null
    return cell ? `${row} · ${cell}` : row
  }
  const shown = editors.slice(0, 3)
  const more = editors.length - shown.length
  // Everyone in the same row (one project's matrix): name the row once, then each person's cell.
  const oneRow = editors.every((e) => e.item === editors[0].item)
  const cellOnly = (e: GridEditor) => (e.field ? cellLabel?.(e.field, e.item) : null)
  return (
    <div
      role='status'
      aria-live='polite'
      data-grid-presence-line
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-600 dark:text-slate-300',
        className
      )}
    >
      {editors.length === 1 ? (
        <Person editor={editors[0]}>
          <span className='font-medium text-slate-900 dark:text-slate-50'>{editors[0].name}</span>{' '}
          is editing {noun} for{' '}
          <span className='font-medium text-slate-900 dark:text-slate-50'>{where(editors[0])}</span>
        </Person>
      ) : (
        <>
          <span>
            Editing {noun}
            {oneRow && (
              <>
                {' '}
                for{' '}
                <span className='font-medium text-slate-900 dark:text-slate-50'>
                  {rowLabel(editors[0].item) || editors[0].item}
                </span>
              </>
            )}
            :
          </span>
          {shown.map((e) => {
            const at = oneRow ? cellOnly(e) : where(e)
            return (
              <Person key={`${e.userId}|${e.page}`} editor={e}>
                <span className='font-medium text-slate-900 dark:text-slate-50'>{e.name}</span>
                {at && <span className='text-slate-500 dark:text-slate-400'> · {at}</span>}
              </Person>
            )
          })}
          {more > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  data-grid-presence-more
                  className='rounded text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-300 dark:decoration-slate-600 dark:hover:text-white'
                >
                  and {more} more
                </button>
              </PopoverTrigger>
              <PopoverContent align='end' className='w-72 p-2'>
                <ul className='space-y-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                  {editors.slice(shown.length).map((e) => {
                    const at = oneRow ? cellOnly(e) : where(e)
                    return (
                      <li key={`${e.userId}|${e.page}`}>
                        <Person editor={e}>
                          <span className='font-medium text-slate-900 dark:text-slate-50'>
                            {e.name}
                          </span>
                          {at && (
                            <span className='text-slate-500 dark:text-slate-400'> · {at}</span>
                          )}
                        </Person>
                      </li>
                    )
                  })}
                </ul>
              </PopoverContent>
            </Popover>
          )}
        </>
      )}
    </div>
  )
}

function Person({ editor, children }: { editor: GridEditor; children: ReactNode }) {
  // The whole entry opens the person's user card (message, profile) — the same card as anywhere
  // a person is named. Reads as text until hovered.
  return (
    <UserChip userId={editor.userId}>
      <button
        type='button'
        data-grid-presence-person
        aria-label={`Show ${editor.name}`}
        className='inline-flex min-w-0 cursor-pointer items-baseline gap-1.5 rounded text-left decoration-slate-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:decoration-slate-600'
      >
        <span
          aria-hidden
          className='h-2 w-2 shrink-0 translate-y-[-1px] self-center rounded-full'
          style={{ background: editor.color }}
        />
        {/* Wraps on a narrow screen instead of cutting off where the person is. */}
        <span className='min-w-0 break-words'>{children}</span>
      </button>
    </UserChip>
  )
}
