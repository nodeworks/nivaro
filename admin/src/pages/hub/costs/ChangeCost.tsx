import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { BasisChip, CostInfo } from './CostFigure'
import {
  type BeforeAfter,
  type CostEstimate,
  cents,
  isUnknown,
  type OpCost,
  type PlanCostTotal,
  signedCents
} from './cost-api'

/**
 * Costs in a plan (Task 44c): each operation's "now → after" and the change's total row, and
 * the same before → after on stack, scale and move plans. All estimates at list price (or the
 * Hub's own rates for a stack); never part of what the plan hash binds.
 */

function Side({ e, empty }: { e: CostEstimate | null; empty: string }) {
  if (!e) return <span className='text-slate-500 dark:text-muted-foreground'>{empty}</span>
  if (isUnknown(e)) return <span className='text-slate-600 dark:text-slate-300'>No estimate</span>
  return (
    <span className='font-medium tabular-nums text-slate-900 dark:text-foreground'>
      {cents(e.monthlyCents, e.currency)}
      <span className='font-normal text-slate-500 dark:text-muted-foreground'>/mo</span>
    </span>
  )
}

/** "$12.00/mo → $48.20/mo (+$36.20)" with the basis chip and the lines of the after figure. */
export function BeforeAfterLine({
  cost,
  label,
  className
}: {
  cost: OpCost | BeforeAfter
  label: string
  className?: string
}) {
  const shown = cost.after ?? cost.before
  const unknown = isUnknown(cost.after) && isUnknown(cost.before)
  const currency = shown?.currency ?? 'USD'
  const delta = cost.deltaMonthlyCents
  return (
    <p
      className={cn(
        'm-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-slate-700 dark:text-slate-300',
        className
      )}
    >
      <span className='text-slate-500 dark:text-muted-foreground'>Cost</span>
      {unknown ? (
        <span>No estimate</span>
      ) : (
        <>
          <Side e={cost.before} empty='nothing now' />
          <span aria-hidden className='text-slate-400'>
            →
          </span>
          <span className='sr-only'>to</span>
          <Side e={cost.after} empty='nothing' />
          {delta !== 0 && (
            <span
              className={cn(
                'tabular-nums',
                delta < 0 ? 'text-emerald-700 dark:text-emerald-400' : undefined
              )}
            >
              ({signedCents(delta, currency)} a month)
            </span>
          )}
        </>
      )}
      {shown && <BasisChip estimate={shown} />}
      {shown && <CostInfo estimate={shown} label={label} />}
    </p>
  )
}

/** The change's total: monthly difference, one-time and yearly amounts, unknown ops, price time. */
export function PlanCostTotalRow({
  total,
  currency,
  approval
}: {
  total: PlanCostTotal
  currency: string
  /** On the approval card: says the prices were checked when the plan was made. */
  approval?: boolean
}) {
  const parts: string[] = [`${signedCents(total.deltaMonthlyCents, currency)} a month`]
  if (total.oneTimeCents > 0) parts.push(`${cents(total.oneTimeCents, currency)} once`)
  if (total.yearlyCents > 0) parts.push(`${cents(total.yearlyCents, currency)} a year`)
  return (
    <div className='flex max-w-[760px] flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] dark:border-border dark:bg-card'>
      <span className='font-medium text-slate-700 dark:text-slate-300'>
        {approval ? 'Estimated cost of what you approve' : 'This change, estimated'}
      </span>
      <span className='font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {parts.join(' · ')}
      </span>
      {total.unknownOps > 0 && (
        <span className='text-amber-800 dark:text-amber-300'>
          {total.unknownOps === 1
            ? '1 part has no estimate'
            : `${total.unknownOps} parts have no estimate`}
        </span>
      )}
      <span
        className='text-[11px] text-slate-500 dark:text-muted-foreground'
        data-tip={formatDateTime(total.checkedAt)}
      >
        {approval ? 'Prices checked' : 'List prices, checked'} {formatRelative(total.checkedAt)}
      </span>
    </div>
  )
}

/** The currency of a plan's costs (the first op that has a figure). */
export function planCurrency(ops: ReadonlyArray<{ cost?: OpCost }>): string {
  for (const op of ops) {
    const e = op.cost?.after ?? op.cost?.before
    if (e) return e.currency
  }
  return 'USD'
}
