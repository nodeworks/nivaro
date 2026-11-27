import { Info, Loader2 } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { ToneChip } from '../hub-parts'
import {
  asOfWords,
  BASIS_COPY,
  type CostEstimate,
  caveats,
  cents,
  hourly,
  isEstimate,
  isUnknown,
  SOURCE_COPY,
  signedCents,
  unitPrice
} from './cost-api'

/**
 * The one way a cost shows in the Hub (Task 44c): the amount ("About $48.20 a month"), a basis
 * chip (List price, Plan price, Hub rates, Plus usage, Free) and, on the info button, every line
 * with its quantity, unit price and where the figure came from, what the estimate leaves out and
 * the price date. An unknown price reads "No estimate", never $0.
 */

const qtyWords = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })

/** The lines of an estimate, for the popover and the tests. */
export function CostBreakdown({ estimate: e }: { estimate: CostEstimate }) {
  const asOf = asOfWords(e.priceAsOf)
  const notes = caveats(e)
  if (isUnknown(e))
    return (
      <div className='space-y-1.5 text-[12px]'>
        <p className='m-0 font-medium text-slate-900 dark:text-foreground'>No estimate</p>
        <p className='m-0 text-slate-600 dark:text-slate-300'>
          The Hub has no price for this yet. It still runs; the bill shows what it cost.
        </p>
        {notes.map((n) => (
          <p key={n} className='m-0 text-slate-500 dark:text-muted-foreground'>
            {n}
          </p>
        ))}
      </div>
    )
  return (
    <div className='space-y-2 text-[12px]'>
      <p className='m-0 font-medium text-slate-900 dark:text-foreground'>
        Estimate · {BASIS_COPY[e.basis]?.label ?? e.basis}
      </p>
      {e.lines.length > 0 ? (
        <table className='w-full border-collapse text-[11.5px]'>
          <tbody>
            {e.lines.map((l, i) => (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                key={i}
                className='border-t border-slate-100 align-top first:border-0 dark:border-border'
              >
                <td className='py-1 pr-2'>
                  <span className='block text-slate-800 dark:text-foreground'>{l.label}</span>
                  <span className='block text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                    {l.kind === 'tax' || l.kind === 'discount'
                      ? SOURCE_COPY[l.source]
                      : `${qtyWords(l.qty)} ${l.unit} × ${unitPrice(l.unitCents, e.currency)} · ${SOURCE_COPY[l.source]}`}
                  </span>
                </td>
                <td
                  className={cn(
                    'whitespace-nowrap py-1 text-right tabular-nums',
                    l.monthlyCents < 0
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-slate-800 dark:text-foreground'
                  )}
                >
                  {l.monthlyCents < 0
                    ? `−${cents(-l.monthlyCents, e.currency)}`
                    : cents(l.monthlyCents, e.currency)}
                </td>
              </tr>
            ))}
            <tr className='border-t border-slate-200 font-medium dark:border-border'>
              <td className='py-1 pr-2 text-slate-900 dark:text-foreground'>A month</td>
              <td className='whitespace-nowrap py-1 text-right tabular-nums text-slate-900 dark:text-foreground'>
                {cents(e.monthlyCents, e.currency)}
              </td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p className='m-0 tabular-nums text-slate-700 dark:text-slate-300'>
          {cents(e.monthlyCents, e.currency)} a month
        </p>
      )}
      {(e.oneTimeCents > 0 || e.yearlyCents > 0) && (
        <p className='m-0 tabular-nums text-slate-700 dark:text-slate-300'>
          {e.oneTimeCents > 0 && `${cents(e.oneTimeCents, e.currency)} once`}
          {e.oneTimeCents > 0 && e.yearlyCents > 0 && ' · '}
          {e.yearlyCents > 0 && `${cents(e.yearlyCents, e.currency)} a year`}
        </p>
      )}
      <ul className='m-0 list-none space-y-0.5 p-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        <li>
          {e.basis === 'rate_card'
            ? 'At the Hub’s own rates, not a provider bill.'
            : 'At list price; the provider’s bill is the truth.'}
          {asOf ? ` ${asOf[0].toUpperCase()}${asOf.slice(1)}.` : ''}
        </li>
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  )
}

/** The info button that opens an estimate's lines (inside a sheet it portals into the sheet). */
export function CostInfo({ estimate, label }: { estimate: CostEstimate; label: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setContainer(ref.current?.closest<HTMLElement>('[role=dialog]') ?? null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={ref}
          type='button'
          aria-label={`How ${label} is made`}
          data-tip='What it is made of'
          className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
        >
          <Info className='h-3.5 w-3.5' aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        container={container}
        align='start'
        className='w-[min(22rem,calc(100vw-2rem))] p-3'
      >
        <CostBreakdown estimate={estimate} />
      </PopoverContent>
    </Popover>
  )
}

/** The basis chip: how the figure was priced. */
export function BasisChip({ estimate: e }: { estimate: CostEstimate }) {
  if (isUnknown(e)) return null
  const copy = BASIS_COPY[e.basis]
  if (!copy) return null
  return (
    <ToneChip tone='neutral' compact tip={copy.hint}>
      {copy.label}
    </ToneChip>
  )
}

/**
 * An estimate as a figure: "About $48.20 a month", the basis chip and the lines on the info
 * button. `before` adds the difference from what it costs now ("+$3.20 a month vs now").
 */
export function CostFigure({
  estimate,
  before,
  label = 'this estimate',
  loading,
  size = 'md',
  className
}: {
  estimate: CostEstimate | null
  before?: CostEstimate | null
  label?: string
  /** A newer figure is on its way; the shown one stays until it lands. */
  loading?: boolean
  size?: 'md' | 'sm'
  className?: string
}) {
  const e = isEstimate(estimate) ? estimate : null
  const unknown = isUnknown(e)
  const delta =
    e && !unknown && before && !isUnknown(before) ? e.monthlyCents - before.monthlyCents : null
  return (
    <span
      className={cn(
        'inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1',
        size === 'sm' ? 'text-[12px]' : 'text-[13px]',
        className
      )}
    >
      {!e ? (
        <span className='text-slate-500 dark:text-muted-foreground'>
          {loading ? 'Working out the cost…' : 'No estimate'}
        </span>
      ) : unknown ? (
        <span className='text-slate-600 dark:text-slate-300'>No estimate</span>
      ) : (
        <span className='text-slate-700 dark:text-slate-300'>
          About{' '}
          <span className='font-semibold tabular-nums text-slate-900 dark:text-foreground'>
            {cents(e.monthlyCents, e.currency)}
          </span>{' '}
          a month
          {e.oneTimeCents > 0 && (
            <span className='tabular-nums'> · {cents(e.oneTimeCents, e.currency)} once</span>
          )}
        </span>
      )}
      {delta != null && delta !== 0 && e && (
        <span
          className={cn(
            'tabular-nums',
            delta > 0
              ? 'text-slate-700 dark:text-slate-300'
              : 'text-emerald-700 dark:text-emerald-400'
          )}
        >
          ({signedCents(delta, e.currency)} vs now)
        </span>
      )}
      {e && <BasisChip estimate={e} />}
      {e && <CostInfo estimate={e} label={label} />}
      {loading && e && (
        <Loader2
          className='h-3.5 w-3.5 animate-spin text-slate-400 motion-reduce:animate-none'
          aria-label='Updating'
        />
      )}
    </span>
  )
}

/**
 * The run-rate chip on a row ("$12.40/mo", hourly on hover). `unknown` = the resource is costed
 * but has no price ("No estimate").
 */
export function CostChip({
  monthlyCents,
  currency,
  unknown,
  free,
  what
}: {
  monthlyCents: number
  currency: string
  unknown?: boolean
  free?: boolean
  /** "this resource", "this environment": said in the tip. */
  what: string
}) {
  if (unknown)
    return (
      <ToneChip tone='neutral' compact tip={`The Hub has no price for ${what} yet.`}>
        No estimate
      </ToneChip>
    )
  if (free)
    return (
      <ToneChip tone='neutral' compact tip={`The provider does not charge for ${what}.`}>
        Free
      </ToneChip>
    )
  return (
    <ToneChip
      tone='neutral'
      compact
      tip={`About ${hourly(monthlyCents, currency)} an hour, an estimate of what ${what} costs running as it is now.`}
      className='font-sans tabular-nums'
    >
      {cents(monthlyCents, currency)}/mo
    </ToneChip>
  )
}

/** A labelled estimate block under a form: a quiet strip, the figure, then what it depends on. */
export function EstimateStrip({
  children,
  aside,
  id
}: {
  children: ReactNode
  aside?: ReactNode
  id?: string
}) {
  return (
    <div
      id={id}
      className='flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/40'
    >
      <span className='text-[12px] font-medium text-slate-600 dark:text-slate-300'>Estimate</span>
      <span aria-live='polite' className='min-w-0 flex-[1_1_auto]'>
        {children}
      </span>
      {aside}
    </div>
  )
}
