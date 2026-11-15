import type { ReactNode } from 'react'
import type { GridEditor } from '../lib/grid-presence'
import { cn } from '../lib/utils'

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
    const row = rowLabel(e.item) || `#${e.item}`
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
                  {rowLabel(editors[0].item) || `#${editors[0].item}`}
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
          {more > 0 && <span className='text-slate-500 dark:text-slate-400'>and {more} more</span>}
        </>
      )}
    </div>
  )
}

function Person({ editor, children }: { editor: GridEditor; children: ReactNode }) {
  return (
    <span className='inline-flex min-w-0 items-center gap-1.5' data-grid-presence-person>
      <span
        aria-hidden
        className='h-2 w-2 shrink-0 rounded-full'
        style={{ background: editor.color }}
      />
      <span className='min-w-0 truncate'>{children}</span>
    </span>
  )
}
