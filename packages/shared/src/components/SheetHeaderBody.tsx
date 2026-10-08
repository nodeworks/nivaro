import { QueryStatStrip, type QueryWidgetStat } from './QueryStatStrip'

/** The figure strip above a sheet. A failed header query says so: tiles summed
 *  over no rows would read as real zero figures. */
export function SheetHeaderBody({
  stats,
  rows,
  params,
  loading,
  error
}: {
  stats: QueryWidgetStat[]
  rows: Array<Record<string, unknown>>
  params: Record<string, unknown>
  loading: boolean
  error: boolean
}) {
  if (error) {
    return (
      <p className='text-[12px] text-slate-500 dark:text-slate-400' data-sheet-header-error>
        Couldn't load these figures. Close the sheet and open it again to retry.
      </p>
    )
  }
  return <QueryStatStrip stats={stats} rows={rows} effectiveParams={params} loading={loading} />
}
