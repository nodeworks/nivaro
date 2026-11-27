import { cn } from '@/lib/utils'
import { BeforeAfterLine } from './ChangeCost'
import { CostFigure, CostInfo, EstimateStrip } from './CostFigure'
import { type BeforeAfter, type CreateEstimate, cents, isUnknown } from './cost-api'
import { useCreateEstimate, useStackEstimate } from './use-costs'

/**
 * Stack, Create app, scale and move figures (Task 44c). A Docker stack is priced at the Hub's own
 * chargeback rates (size template × replicas, files, database, flat per environment, the host
 * region's factor); provider parts at their list prices.
 */

/** Under the stack settings form: what the stack costs now → at the size picked. */
export function StackEstimate({ envId, size }: { envId: number; size: string }) {
  const q = useStackEstimate(envId, { size })
  const d = q.data && typeof q.data === 'object' && 'after' in q.data ? q.data : undefined
  return (
    <EstimateStrip>
      {q.isError && !d ? (
        <span className='text-[12.5px] text-slate-600 dark:text-slate-300'>
          No estimate (the Hub could not work it out just now)
        </span>
      ) : !d ? (
        <span className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Working out the cost…
        </span>
      ) : (
        <CostFigure
          estimate={d.after}
          before={d.before}
          loading={q.isFetching}
          label='the stack estimate'
        />
      )}
    </EstimateStrip>
  )
}

/** A scale or move plan's figure (null = the Hub sent none: an older Hub, or no rates). */
export function PlanBeforeAfter({
  cost,
  className
}: {
  cost?: BeforeAfter | null
  className?: string
}) {
  if (!cost || (!cost.before && !cost.after)) return null
  return <BeforeAfterLine cost={cost} label='the cost of this plan' className={className} />
}

/**
 * Create app: per environment its stack at the Hub's rates and its provider parts, with the
 * total. Asked 400 ms after the form settles; the last figure stays while the next loads.
 */
export function CreateEstimateCard({ input, ready }: { input: unknown; ready: boolean }) {
  const q = useCreateEstimate(ready ? input : null)
  const d = q.data && Array.isArray(q.data.environments) ? q.data : undefined
  if (!ready && !d) return null
  return (
    <section
      aria-label='Estimated cost of the new app'
      className='space-y-2 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
        <h3 className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Estimated cost
        </h3>
        {d ? (
          <CreateTotal d={d} fetching={q.isFetching} />
        ) : q.isError ? (
          <span className='text-[12.5px] text-slate-600 dark:text-slate-300'>
            No estimate (the Hub could not work it out just now)
          </span>
        ) : (
          <span className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            Working out the cost…
          </span>
        )}
      </div>
      {d && d.environments.length > 0 && (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 text-[12px] dark:divide-border'>
          {d.environments.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: environments are positional on the form
            <li key={i} className='flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5'>
              <span className='min-w-[6rem] font-mono text-[12px] font-medium text-slate-800 dark:text-foreground'>
                {e.key || `Environment ${i + 1}`}
              </span>
              {e.stack && (
                <span className='inline-flex items-center gap-1 text-slate-600 dark:text-slate-300'>
                  Stack{' '}
                  {isUnknown(e.stack) ? (
                    'no estimate'
                  ) : (
                    <span className='tabular-nums text-slate-900 dark:text-foreground'>
                      {cents(e.stack.monthlyCents, e.stack.currency)}/mo
                    </span>
                  )}
                  <CostInfo estimate={e.stack} label={`the stack of ${e.key}`} />
                </span>
              )}
              {e.providers.map((p, j) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
                  key={j}
                  className='inline-flex items-center gap-1 text-slate-600 dark:text-slate-300'
                >
                  <span className='font-mono text-[11px]'>{p.type}</span>{' '}
                  {!p.estimate || isUnknown(p.estimate) ? (
                    'no estimate'
                  ) : (
                    <span className='tabular-nums text-slate-900 dark:text-foreground'>
                      {cents(p.estimate.monthlyCents, p.estimate.currency)}/mo
                    </span>
                  )}
                  {p.estimate && <CostInfo estimate={p.estimate} label={p.type} />}
                </span>
              ))}
              <span className='ml-auto font-medium tabular-nums text-slate-900 dark:text-foreground'>
                {cents(e.monthlyCents, d.currency)}/mo
              </span>
            </li>
          ))}
        </ul>
      )}
      {d?.note && (
        <p className='m-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>{d.note}</p>
      )}
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        An estimate: stacks at the Hub’s own rates, provider parts at list price. Tax, data transfer
        and credits are not counted unless a part lists them.
      </p>
    </section>
  )
}

function CreateTotal({ d, fetching }: { d: CreateEstimate; fetching: boolean }) {
  return (
    <span
      className={cn('text-[13px] text-slate-700 dark:text-slate-300', fetching && 'opacity-70')}
    >
      About{' '}
      <span className='font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {cents(d.monthlyCents, d.currency)}
      </span>{' '}
      a month
      {d.oneTimeCents > 0 && (
        <span className='tabular-nums'> · {cents(d.oneTimeCents, d.currency)} once</span>
      )}
      {d.unknown > 0 && (
        <span className='ml-1.5 text-amber-800 dark:text-amber-300'>
          · {d.unknown === 1 ? '1 part has no estimate' : `${d.unknown} parts have no estimate`}
        </span>
      )}
    </span>
  )
}
