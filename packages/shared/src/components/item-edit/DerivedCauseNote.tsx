import { CornerDownRight } from 'lucide-react'
import {
  CAUSE_FRESH_MS,
  causeSentence,
  type DerivedCause,
  useDerivedCause
} from '../../lib/derived-causes'
import { liveMotionAllowed } from '../../lib/live-preference'
import { cn, formatDate, formatDateTime, formatRelative } from '../../lib/utils'

/**
 * Under a derived field (rt9 #10): "Moved 2 days later because PO due date changed · 3 min ago".
 * Quiet slate text; a note that just happened carries a faint cyan wash that fades (Normal live
 * mode only, never with reduced motion). The tip says what it was and what it is now.
 */
export function DerivedCauseNote({
  collection,
  itemId,
  field,
  type,
  currency,
  value
}: {
  collection: string
  itemId: string
  field: string
  type?: string | null
  /** The field shows money in this currency (fieldCurrency): "Up $1,200". */
  currency?: string | null
  /** The field's value on screen: an empty field never explains a move it no longer shows. */
  value?: unknown
}) {
  const cause = useDerivedCause(collection, itemId, field)
  if (!cause) return null
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null
  return <DerivedCauseLine cause={cause} type={type} currency={currency} />
}

function shown(v: unknown, type?: string | null, currency?: string | null): string {
  if (v == null || v === '') return 'empty'
  const t = String(type ?? '').toLowerCase()
  if (t === 'date') return formatDate(String(v))
  if (/date|time/.test(t)) return formatDateTime(String(v))
  const n = typeof v === 'number' ? v : Number(v)
  if (currency && Number.isFinite(n))
    try {
      return n.toLocaleString('en-US', { style: 'currency', currency })
    } catch {
      /* plain number below */
    }
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return String(v)
}

export function DerivedCauseLine({
  cause,
  type,
  currency,
  now = Date.now()
}: {
  cause: DerivedCause
  type?: string | null
  currency?: string | null
  now?: number
}) {
  const fresh = now - Date.parse(cause.at) < CAUSE_FRESH_MS && liveMotionAllowed()
  const sentence = causeSentence(cause, type, currency)
  const cut = sentence.lastIndexOf(' ')
  const head = cut > 0 ? sentence.slice(0, cut + 1) : ''
  const last = cut > 0 ? sentence.slice(cut + 1) : sentence
  return (
    <p
      data-derived-cause={cause.field}
      data-tip={`Was ${shown(cause.from, type, currency)} · now ${shown(cause.to, type, currency)}`}
      className={cn(
        'flex items-start gap-1 rounded px-0.5 text-[11.5px] leading-[1.35rem] text-slate-500 dark:text-slate-400',
        fresh && 'nvr-derived-fresh'
      )}
    >
      <CornerDownRight
        className='mt-[0.3rem] h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500'
        aria-hidden
      />
      <span className='min-w-0'>
        {head}
        {/* The sentence's last word and the time are one unit: a line never starts with
            "· 26m ago". */}
        <span className='whitespace-nowrap'>
          {last}
          <span className='text-slate-400 dark:text-slate-500'>
            {'\u00a0·\u00a0'}
            {formatRelative(cause.at)}
          </span>
        </span>
      </span>
    </p>
  )
}
