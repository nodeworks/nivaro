import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'

/**
 * DB Health → Session replay (#1368): what recording stores, per page (route
 * pattern) and per frontend build over the last 7 days, today's use of the
 * daily cap, and the sampling rule each page runs under. Figures come from
 * the per-day rollup the events route keeps, so they outlive the chunks.
 */

export interface ReplayCostSummary {
  days: number
  by_route: Array<{ route: string; bytes: number; chunks: number; sampling: number }>
  by_build: Array<{ build: string; bytes: number; chunks: number }>
  by_day: Array<{
    day: string
    bytes: number
    accepted: number
    rejected: number
    cap_hit_at: string | null
  }>
  cap: { cap_bytes: number | null; used_bytes: number; reached: boolean }
  today_bytes: number
  bytes_per_day: number
  /** #1411 — where recordings live. */
  storage: {
    recordings: number
    hot_bytes: number
    cold_recordings: number
    cold_bytes: number
    cache_bytes: number
  } | null
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

const pct = (share: number) => `${Math.round(share * 1000) / 10}%`

function Table({
  head,
  rows,
  empty
}: {
  head: string[]
  rows: Array<Array<React.ReactNode>>
  empty: string
}) {
  if (rows.length === 0) return <p className='text-[12px] text-slate-400'>{empty}</p>
  return (
    <table className='w-full text-left'>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th
              key={h}
              className={`pb-1.5 pr-3 text-[10.5px] font-medium uppercase tracking-wide text-slate-400 ${i > 0 ? 'text-right' : ''}`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static rows
          <tr key={i} className='border-t border-slate-100 dark:border-border/50'>
            {r.map((c, j) => (
              <td
                // biome-ignore lint/suspicious/noArrayIndexKey: static cells
                key={j}
                className={`py-1 pr-3 text-[12px] text-slate-700 dark:text-slate-200 ${j > 0 ? 'text-right tabular-nums' : 'max-w-[280px] truncate font-mono text-[11.5px]'}`}
              >
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function SessionReplayCostPanel() {
  const q = useQuery({
    queryKey: ['ops', '/ops-db/session-replay'],
    queryFn: () =>
      api.get<{ data: ReplayCostSummary }>('/ops-db/session-replay').then((r) => r.data.data),
    staleTime: 30_000
  })
  const d = q.data
  const total = d ? d.by_day.reduce((a, x) => a + x.bytes, 0) : 0
  const peak = d ? Math.max(1, ...d.by_day.map((x) => x.bytes)) : 1
  const rejected = d ? d.by_day.reduce((a, x) => a + x.rejected, 0) : 0
  const capShare = d?.cap.cap_bytes ? Math.min(1, d.cap.used_bytes / d.cap.cap_bytes) : 0

  return (
    <section
      data-session-replay-cost
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <header className='flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <div>
          <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Session replay
          </h2>
          <p className='mt-0.5 text-[11px] text-slate-400'>
            What recording stores, per page and per build over 7 days; the daily cap and sampling
            (#1368)
          </p>
        </div>
        <Link to='/settings' className='text-[11.5px] text-slate-500 underline'>
          Limits in Settings → Session replay
        </Link>
      </header>
      <div className='space-y-4 p-4'>
        {q.isError ? (
          <p className='text-[12px] text-amber-600'>Could not load recording cost.</p>
        ) : !d ? (
          <Skeleton className='h-24 w-full' />
        ) : (
          <>
            <div className='flex flex-wrap gap-x-8 gap-y-2 text-[12.5px]'>
              <div>
                <span className='text-slate-400'>Today</span>
                <br />
                <b>{formatBytes(Math.max(d.cap.used_bytes, d.today_bytes))}</b>
                {d.cap.cap_bytes ? (
                  <>
                    {' '}
                    of {formatBytes(d.cap.cap_bytes)} cap
                    {d.cap.reached && (
                      <span className='ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800 dark:bg-amber-400/15 dark:text-amber-300'>
                        reached — recorders stopped
                      </span>
                    )}
                  </>
                ) : (
                  <span className='text-slate-400'> · no daily cap</span>
                )}
                {d.cap.cap_bytes ? (
                  <div className='mt-1 h-1.5 w-40 overflow-hidden rounded bg-slate-100 dark:bg-muted'>
                    <div
                      className={`h-full ${d.cap.reached ? 'bg-amber-500' : 'bg-nvr-cyan'}`}
                      style={{ width: `${Math.round(capShare * 100)}%` }}
                    />
                  </div>
                ) : null}
              </div>
              <div>
                <span className='text-slate-400'>Last {d.days} days</span>
                <br />
                <b>{formatBytes(total)}</b> · {formatBytes(d.bytes_per_day)}/day
              </div>
              {d.storage && (
                <div data-replay-tiers>
                  <span className='text-slate-400'>Hot · cold</span>
                  <br />
                  <b>{formatBytes(d.storage.hot_bytes)}</b> in the database ·{' '}
                  <b>{formatBytes(d.storage.cold_bytes)}</b> in storage (
                  {d.storage.cold_recordings.toLocaleString()} of{' '}
                  {d.storage.recordings.toLocaleString()} recordings)
                  {d.storage.cache_bytes > 0 && (
                    <span className='text-slate-400'>
                      {' '}
                      · {formatBytes(d.storage.cache_bytes)} reloaded for viewing
                    </span>
                  )}
                </div>
              )}
              <div>
                <span className='text-slate-400'>Refused uploads (7 days)</span>
                <br />
                <b>{rejected.toLocaleString()}</b>
              </div>
            </div>
            <div
              className='flex h-16 items-end gap-1.5'
              role='img'
              aria-label='Stored bytes per day'
            >
              {d.by_day.map((x) => (
                <div key={x.day} className='flex flex-1 flex-col items-center gap-1'>
                  <div
                    className={`w-full rounded-sm ${x.cap_hit_at ? 'bg-amber-400' : 'bg-nvr-cyan/70'}`}
                    style={{ height: `${Math.max(2, Math.round((x.bytes / peak) * 48))}px` }}
                    data-tip={`${x.day}: ${formatBytes(x.bytes)}, ${x.accepted} chunk(s)${x.cap_hit_at ? ' — cap hit' : ''}`}
                  />
                  <span className='text-[9.5px] text-slate-400'>{x.day.slice(5)}</span>
                </div>
              ))}
            </div>
            <div className='grid gap-5 xl:grid-cols-[3fr_2fr]'>
              <Table
                head={['Page', 'Stored', 'Chunks', 'Recorded']}
                empty='No chunks attributed to a page yet.'
                rows={d.by_route.map((r) => [
                  r.route || '(not stamped)',
                  formatBytes(r.bytes),
                  r.chunks.toLocaleString(),
                  pct(r.sampling)
                ])}
              />
              <Table
                head={['Build', 'Stored', 'Chunks']}
                empty='No builds yet.'
                rows={d.by_build.map((b) => [
                  b.build || '(not stamped)',
                  formatBytes(b.bytes),
                  b.chunks.toLocaleString()
                ])}
              />
            </div>
          </>
        )}
      </div>
    </section>
  )
}
