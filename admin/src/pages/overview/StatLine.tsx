import { LoadErrorNote, loadErrorText } from '@nivaro/shared'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import type { FigureKey, OverviewFigure, OverviewStats } from './api'
import { Bone, Section } from './parts'
import { deltaText, fmt } from './text'

/**
 * One compact line of numbers that change — records changed today (with changes per hour for
 * the last 24 hours), people active today, failed jobs and open issues — each against
 * yesterday and each a way in. On a phone the line scrolls sideways.
 */

const FIGURES: Record<
  FigureKey,
  { label: string; href: (dayStart: string) => string; upIsBad?: boolean }
> = {
  records_changed: {
    label: 'Records changed today',
    href: (dayStart) => `/activity?from=${encodeURIComponent(dayStart)}`
  },
  people_active: { label: 'People active today', href: () => '/security-center/presence' },
  failed_jobs: { label: 'Failed jobs, 24 h', href: () => '/jobs', upIsBad: true },
  open_issues: { label: 'Open issues', href: () => '/issues', upIsBad: true }
}

function DeltaChip({ figure }: { figure: OverviewFigure }) {
  const d = deltaText(figure.value, figure.previous, figure.compare)
  if (!d) return null
  const bad = FIGURES[figure.key].upIsBad
  return (
    <span
      className={cn(
        'text-[11.5px] font-medium tabular-nums',
        d.tone === 'flat' || !bad
          ? 'text-slate-500 dark:text-slate-400'
          : d.tone === 'up'
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-emerald-700 dark:text-emerald-300'
      )}
      data-tip={d.long}
    >
      {d.short}
      <span className='sr-only'> ({d.long})</span>
    </span>
  )
}

function HourBars({ hourly }: { hourly: number[] }) {
  const max = Math.max(1, ...hourly)
  const total = hourly.reduce((a, n) => a + n, 0)
  const peak = Math.max(0, ...hourly)
  return (
    <span
      role='img'
      aria-label={`Changes per hour, last 24 hours: ${fmt(total)} in all, at most ${fmt(peak)} in one hour`}
      data-tip='Changes per hour, last 24 hours'
      className='flex h-6 w-[96px] shrink-0 items-end gap-px'
    >
      {hourly.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed hour buckets
          key={i}
          className={cn(
            'flex-1 rounded-[1px] transition-[height] duration-500 ease-out',
            v === 0 ? 'bg-slate-200 dark:bg-white/10' : 'bg-nvr-cyan/70 dark:bg-nvr-cyan/60'
          )}
          style={{ height: `${v === 0 ? 8 : Math.max(16, (v / max) * 100)}%` }}
        />
      ))}
    </span>
  )
}

const CELL =
  'flex min-w-[164px] flex-1 snap-start flex-col gap-1 px-4 py-3 sm:min-w-0 transition-colors'

export function StatLine({
  stats,
  isLoading,
  error,
  onRetry,
  isAdmin
}: {
  stats: OverviewStats | undefined
  isLoading: boolean
  error: unknown
  onRetry: () => void
  isAdmin: boolean
}) {
  const cells = isAdmin ? 4 : 2
  return (
    <Section id='stats' title='Today' plain>
      <div
        className='flex snap-x snap-mandatory divide-x divide-slate-200 overflow-x-auto rounded-lg border border-slate-200 bg-white [scrollbar-width:thin] dark:divide-border dark:border-border dark:bg-card'
        data-overview-stats
      >
        {isLoading && !stats ? (
          Array.from({ length: cells }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton cells
            <div key={i} className={CELL} aria-hidden>
              <Bone className='h-3 w-28' />
              <div className='flex items-end justify-between gap-2'>
                <Bone className='h-6 w-12' />
                {i === 0 && <Bone className='h-6 w-[96px]' />}
              </div>
            </div>
          ))
        ) : error && !stats ? (
          <div className='px-4 py-3'>
            <LoadErrorNote message={loadErrorText(error, 'today’s figures')} onRetry={onRetry} />
          </div>
        ) : (
          (stats?.figures ?? []).map((f) => {
            const meta = FIGURES[f.key]
            return (
              <Link
                key={f.key}
                to={meta.href(stats?.day_start ?? '')}
                className={cn(
                  CELL,
                  f.key === 'records_changed' && 'min-w-[216px]',
                  'hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:hover:bg-white/[0.04] dark:focus-visible:bg-white/[0.04]'
                )}
                data-overview-figure={f.key}
              >
                <span className='truncate text-[12px] text-slate-600 dark:text-slate-300'>
                  {meta.label}
                </span>
                <span className='flex items-end justify-between gap-3'>
                  <span className='flex items-baseline gap-2'>
                    <span className='text-[22px] font-semibold leading-none tabular-nums tracking-tight text-slate-900 dark:text-slate-50'>
                      {fmt(f.value)}
                      {f.capped ? '+' : ''}
                    </span>
                    <DeltaChip figure={f} />
                  </span>
                  {f.key === 'records_changed' && stats && <HourBars hourly={stats.hourly} />}
                </span>
              </Link>
            )
          })
        )}
      </div>
    </Section>
  )
}
