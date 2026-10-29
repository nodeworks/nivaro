import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'

/**
 * #21 — the rows one job run passed over (the run's progress `skipped` list, ≤ 200), each with
 * its reason and a link to the record when the run named its collection. GET
 * /api/job-runs/:id/skipped.
 */
interface SkippedAnswer {
  run: { id: number; job_id: string; sentence: string; skipped_count: number }
  rows: Array<{ id: string | number; collection: string | null; reason: string | null }>
  total: number
  truncated: boolean
}

export function JobRunSkippedSheet({
  runId,
  onClose
}: {
  runId: number | null
  onClose: () => void
}) {
  const q = useQuery({
    queryKey: ['job-run-skipped', runId],
    enabled: runId != null,
    queryFn: () =>
      api.get<{ data: SkippedAnswer }>(`/job-runs/${runId}/skipped`).then((r) => r.data.data)
  })
  const d = q.data
  return (
    <Sheet open={runId != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className='flex w-full flex-col gap-3 sm:max-w-[520px]'>
        <SheetTitle className='text-[14px]'>Rows this run passed over</SheetTitle>
        <SheetDescription className='text-[12px]'>
          {d ? d.run.sentence : 'Loading…'}
        </SheetDescription>
        <div className='min-h-0 flex-1 overflow-y-auto'>
          {q.isLoading ? (
            <div className='space-y-2' role='status' aria-label='Loading'>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className='h-7 w-full' />
              ))}
            </div>
          ) : q.isError ? (
            <p className='text-[12.5px] text-red-600 dark:text-red-400'>Could not read this run.</p>
          ) : !d || d.rows.length === 0 ? (
            <p className='text-[12.5px] text-muted-foreground'>This run recorded no row ids.</p>
          ) : (
            <>
              <ul className='m-0 list-none divide-y divide-slate-100 rounded-lg border border-slate-200 p-0 dark:divide-border dark:border-border'>
                {d.rows.map((r) => (
                  <li
                    key={`${r.collection ?? ''}:${r.id}`}
                    className='flex min-w-0 items-baseline gap-3 px-3 py-1.5 text-[12px]'
                  >
                    {r.collection ? (
                      <Link
                        to={`/collections/${encodeURIComponent(r.collection)}/${encodeURIComponent(String(r.id))}`}
                        className='shrink-0 font-mono text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
                      >
                        {r.collection}/{r.id}
                      </Link>
                    ) : (
                      <span className='shrink-0 font-mono text-slate-700 dark:text-foreground'>
                        {r.id}
                      </span>
                    )}
                    <span className='min-w-0 flex-1 break-words text-slate-600 dark:text-muted-foreground'>
                      {r.reason ?? 'no reason recorded'}
                    </span>
                  </li>
                ))}
              </ul>
              {d.truncated && (
                <p className='mt-2 text-[11.5px] text-muted-foreground'>
                  Showing the first {d.rows.length} of {d.total.toLocaleString()} — a run keeps up
                  to 200.
                </p>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
