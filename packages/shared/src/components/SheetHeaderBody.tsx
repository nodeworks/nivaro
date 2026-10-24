import { latestAsOf, type SheetHeaderAsOf } from '../lib/sheet-def'
import { formatDate } from '../lib/utils'
import { QueryStatStrip, type QueryWidgetStat } from './QueryStatStrip'

/** The figure strip above a sheet. A failed header query says so: tiles summed
 *  over no rows would read as real zero figures. */
export function SheetHeaderBody({
  stats,
  rows,
  params,
  loading,
  error,
  asOf,
  note
}: {
  stats: QueryWidgetStat[]
  rows: Array<Record<string, unknown>>
  params: Record<string, unknown>
  loading: boolean
  error: boolean
  asOf?: SheetHeaderAsOf
  /** What the tiles cover ("Project lifetime — every funding year"). */
  note?: string
}) {
  if (error) {
    return (
      <p className='text-[12px] text-slate-500 dark:text-slate-400' data-sheet-header-error>
        Couldn't load these figures. Close the sheet and open it again to retry.
      </p>
    )
  }
  const latest = !loading && asOf ? latestAsOf(rows, asOf.field) : null
  return (
    <>
      <QueryStatStrip stats={stats} rows={rows} effectiveParams={params} loading={loading} />
      {asOf && latest && (
        <p
          className='mt-1.5 text-[11px] text-slate-500 dark:text-slate-400'
          data-sheet-header-as-of
        >
          {asOf.label} {formatDate(latest)}
        </p>
      )}
      {note && (
        <p className='mt-1 text-[11px] text-slate-500 dark:text-slate-400' data-sheet-header-note>
          {note}
        </p>
      )}
    </>
  )
}
