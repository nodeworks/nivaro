import { cn } from '@/lib/utils'

/**
 * The freeze alert's cause (event_loop monitors, 2026-11-13): what was running on the process
 * while its event loop stalled. The API stores it in the monitor's state while the monitor fails
 * (services/stall-cause-words.ts builds it); names are resolved when the alert was built.
 */

export interface StallCulpritView {
  id: string
  method: string
  route: string
  action: string
  collection: string | null
  collection_label: string | null
  user_id: string | null
  user_name: string | null
  app: string | null
  page: string | null
  page_label: string | null
  ms: number
  running: boolean
  share: number
  waiting_sql: boolean | null
  sentence: string
  likely: boolean
}

export interface StallCauses {
  headline: string | null
  nodes: Array<{
    node: string
    role: string | null
    at: number
    ms: number
    stalls: number
    culprits: StallCulpritView[]
  }>
}

/** Mirrors the API's fmtStallMs: "850 ms", "1.2 s", "63 s", "2 min 5 s". */
export function fmtStallMs(ms: number): string {
  const v = Math.max(0, Math.round(ms))
  if (v < 1000) return `${v} ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')} s`
  if (v < 90_000) return `${Math.round(v / 1000)} s`
  const m = Math.floor(v / 60_000)
  const s = Math.round((v % 60_000) / 1000)
  return s ? `${m} min ${s} s` : `${m} min`
}

const CAUSE_LINE =
  /^(Most likely cause|Possible cause): |^No request was running on |^Worst stall on |^ {2}\d+\. /

/** The monitor's detail without the lines this panel shows itself. */
export function detailWithoutCause(detail: string, causes: StallCauses | null): string {
  if (!causes) return detail
  return detail
    .split('\n')
    .filter((l) => !CAUSE_LINE.test(l))
    .join('\n')
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function StallCausePanel({ causes }: { causes: StallCauses }) {
  const likely = !!causes.headline?.startsWith('Most likely cause')
  return (
    <div className='mt-2 overflow-hidden rounded-md border border-slate-200 dark:border-border'>
      {causes.headline && (
        <p
          className={cn(
            'border-b px-3 py-2 text-[12.5px] leading-snug',
            likely
              ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
              : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
          )}
        >
          {causes.headline}
        </p>
      )}
      {causes.nodes.map((n) => (
        <div
          key={`${n.node}-${n.at}`}
          className='border-b border-slate-100 last:border-b-0 dark:border-border'
        >
          <p className='px-3 pt-2 text-[11.5px] font-medium text-slate-600 dark:text-muted-foreground'>
            Worst stall on {n.node}
            {n.role ? ` (${n.role})` : ''}: {fmtStallMs(n.ms)} at {clock(n.at)}
            {n.stalls > 1 ? ` · ${n.stalls} stalls recorded` : ''}
          </p>
          {n.culprits.length === 0 ? (
            <p className='px-3 pb-2 pt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
              No request was running then.
            </p>
          ) : (
            <div className='overflow-x-auto px-3 pb-2 pt-1'>
              <table className='w-full min-w-[560px] text-left text-[12px]'>
                <thead>
                  <tr className='text-[10.5px] uppercase tracking-wide text-slate-400 dark:text-muted-foreground'>
                    <th className='py-1 pr-3 font-medium'>Request</th>
                    <th className='py-1 pr-3 font-medium'>Person</th>
                    <th className='py-1 pr-3 font-medium'>Screen</th>
                    <th className='py-1 pr-3 text-right font-medium'>Took</th>
                    <th className='py-1 text-right font-medium'>Of the stall</th>
                  </tr>
                </thead>
                <tbody>
                  {n.culprits.map((c) => (
                    <tr
                      key={c.id}
                      className='border-t border-slate-100 align-top dark:border-border'
                    >
                      <td className='py-1.5 pr-3'>
                        <span className='font-medium text-slate-800 dark:text-foreground'>
                          {c.method} {c.action}
                          {c.collection_label ? ` on ${c.collection_label}` : ''}
                        </span>
                        {c.likely && (
                          <span className='ml-1.5 rounded-full bg-red-100 px-1.5 py-px text-[10px] font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300'>
                            Likely cause
                          </span>
                        )}
                        <span className='block font-mono text-[10.5px] text-slate-400 dark:text-muted-foreground'>
                          {c.route}
                        </span>
                        {c.waiting_sql && (
                          <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                            Was waiting on the database
                          </span>
                        )}
                      </td>
                      <td className='py-1.5 pr-3 text-slate-700 dark:text-foreground'>
                        {c.user_name ?? '—'}
                      </td>
                      <td className='py-1.5 pr-3 text-slate-700 dark:text-foreground'>
                        {c.page_label ?? '—'}
                        {c.app && c.page_label && (
                          <span className='block text-[10.5px] text-slate-400 dark:text-muted-foreground'>
                            {c.app}
                          </span>
                        )}
                      </td>
                      <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums text-slate-700 dark:text-foreground'>
                        {fmtStallMs(c.ms)}
                        {c.running && (
                          <span className='block text-[10.5px] text-amber-600 dark:text-amber-400'>
                            still running
                          </span>
                        )}
                      </td>
                      <td className='whitespace-nowrap py-1.5 text-right tabular-nums text-slate-700 dark:text-foreground'>
                        {Math.round(c.share * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
