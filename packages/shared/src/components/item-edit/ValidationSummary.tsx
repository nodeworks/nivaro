import { AlertCircle, Check, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '../../lib/utils'

export interface ValidationSummaryItem {
  field: string
  label: string
  message: string
  /** Step / tab / section the field lives on — shown when the form has more than one. */
  location?: string | null
}

const COLLAPSED_LIMIT = 6

/**
 * "Can't save yet" — the inline summary a failed save leaves at the top of the
 * record body. One row per problem, in form order, each a button that jumps
 * to (and, on steps layouts, switches to) the field. The field's own inline
 * error stays; this is the map. Dismissable; the host unmounts it as soon as
 * the errors clear.
 *
 * A problem fixed while the summary shows stays as a struck-through "fixed"
 * row (a01-7): the box keeps its height, so the fields below do not jump under
 * the cursor while the person works down the list.
 */
export function ValidationSummary({
  items,
  onJump,
  onDismiss
}: {
  items: ValidationSummaryItem[]
  onJump: (field: string) => void
  onDismiss: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  // Ordered walk (#14): "Next" (and Enter on a row) visits the problems in
  // layout order — the cursor is the next row to visit.
  const [cursor, setCursor] = useState(0)
  // Every problem this summary has listed, in first-seen order (a Map keeps a
  // key's first position when it is set again with a newer message).
  const seenRef = useRef<Map<string, ValidationSummaryItem>>(new Map())
  for (const it of items) seenRef.current.set(it.field, it)
  if (items.length === 0) return null
  const n = items.length
  const open = new Set(items.map((i) => i.field))
  const rows = [...seenRef.current.values()]
  const locations = new Set(rows.map((i) => i.location).filter(Boolean))
  const showLocation = locations.size > 1 || (locations.size === 1 && rows.some((i) => !i.location))
  const visible = expanded ? rows : rows.slice(0, COLLAPSED_LIMIT)
  const hidden = rows.length - visible.length
  const visit = (idx: number) => {
    const it = items[idx]
    if (!it) return
    onJump(it.field)
    setCursor((idx + 1) % n)
    if (idx + 1 >= COLLAPSED_LIMIT) setExpanded(true)
  }
  return (
    <div
      role='alert'
      aria-live='polite'
      data-validation-summary
      className='rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 dark:border-red-500/30 dark:bg-red-400/10'
    >
      <div className='flex items-center gap-2'>
        <AlertCircle className='h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400' aria-hidden />
        <span className='text-[12.5px] font-medium text-red-800 dark:text-red-300'>
          Can’t save yet — {n} field{n === 1 ? '' : 's'} need{n === 1 ? 's' : ''} attention
        </span>
        {n > 1 && (
          <button
            type='button'
            onClick={() => visit(cursor % n)}
            data-validation-next
            className='ml-1 inline-flex h-6 items-center gap-1 rounded-md border border-red-300 bg-white px-2 text-[11px] font-medium text-red-800 hover:bg-red-100 dark:border-red-500/40 dark:bg-transparent dark:text-red-200 dark:hover:bg-red-400/20'
          >
            Next issue ({(cursor % n) + 1}/{n}) →
          </button>
        )}
        <button
          type='button'
          onClick={onDismiss}
          aria-label='Dismiss'
          className='ml-auto rounded p-0.5 text-red-500 hover:bg-red-100 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-400/20'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      <ul className='nvr-stagger-direct mt-1.5 space-y-0.5'>
        {visible.map((it) => {
          const idx = items.findIndex((i) => i.field === it.field)
          const fixed = !open.has(it.field)
          return (
            <li
              key={it.field}
              data-validation-fixed={fixed ? '' : undefined}
              className={cn(
                'nvr-section-enter flex items-baseline gap-2 rounded-sm px-1 -mx-1 text-[12px]',
                !fixed && idx === cursor % n && n > 1 && 'bg-red-100/70 dark:bg-red-400/15'
              )}
            >
              {fixed ? (
                <span className='inline-flex shrink-0 items-center gap-1 font-medium text-emerald-700 line-through decoration-emerald-600/60 dark:text-emerald-400'>
                  <Check className='h-3 w-3 shrink-0 no-underline' aria-hidden />
                  {it.label}
                </span>
              ) : (
                <button
                  type='button'
                  onClick={() => visit(idx)}
                  className='shrink-0 font-medium text-red-800 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-red-300'
                >
                  {it.label}
                </button>
              )}
              <span
                className={cn(
                  'min-w-0 flex-1',
                  fixed
                    ? 'text-emerald-700/80 dark:text-emerald-400/80'
                    : 'text-red-800/90 dark:text-red-200/90'
                )}
              >
                {fixed ? 'Fixed' : it.message}
              </span>
              {showLocation && it.location && (
                <span className='shrink-0 text-[11px] text-red-600/80 dark:text-red-400/70'>
                  {it.location}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {hidden > 0 && (
        <button
          type='button'
          onClick={() => setExpanded(true)}
          className={cn(
            'mt-1 text-[11.5px] font-medium text-red-700 underline decoration-dotted underline-offset-2 dark:text-red-300'
          )}
        >
          Show {hidden} more
        </button>
      )}
    </div>
  )
}
