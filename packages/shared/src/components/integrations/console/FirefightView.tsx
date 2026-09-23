import { CheckCircle2, Clock, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigation } from '../../../context'
import { cn } from '../../../lib/utils'
import { useRefreshSignals, useSignals } from './api'
import { oldestSeen, SignalCard } from './SignalCard'
import { agoText, exactTime, TONE_BORDER, TONE_SOFT, TONE_TEXT } from './tone'
import type { RowView, SignalAction, SignalView } from './types'

export interface FirefightViewProps {
  onOpenRecord?: (collection: string, id: string) => void
  /** Move to another console tab, carrying context (e.g. `{ apiId }`). */
  onJumpTab?: (tab: string, context?: Record<string, unknown>) => void
  /** Expand this signal on first load (a notification deep link). */
  focusSignal?: string
}

/** A signal is on the Firefight list when it has something to show. */
const isProblem = (s: SignalView) => !!s.error || s.rows.length > 0 || s.snoozed.length > 0

/** Critical first, then the problem that has been open longest. */
export function rankSignals(signals: SignalView[]): SignalView[] {
  return [...signals].sort((a, b) => {
    if (!!a.error !== !!b.error) return a.error ? 1 : -1
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
    const oa = oldestSeen(a)
    const ob = oldestSeen(b)
    if (oa && ob && oa !== ob) return oa < ob ? -1 : 1
    if (!oa !== !ob) return oa ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

export function FirefightView({ onOpenRecord, onJumpTab, focusSignal }: FirefightViewProps) {
  const { data, isLoading, isError, error } = useSignals()
  const refresh = useRefreshSignals()
  const nav = useNavigation()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [seeded, setSeeded] = useState(false)
  // Re-render every 30s so "checked 2m ago" stays true between fetches.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const problems = useMemo(() => rankSignals((data?.signals ?? []).filter(isProblem)), [data])
  const clear = useMemo(() => (data?.signals ?? []).filter((s) => !isProblem(s)), [data])

  // Open the focused signal, or the only one, on first load.
  useEffect(() => {
    if (seeded || !data) return
    setSeeded(true)
    const first = focusSignal ?? (problems.length === 1 ? problems[0].id : null)
    if (first) setExpanded(new Set([first]))
  }, [data, problems, focusSignal, seeded])

  const total = problems.reduce((n, s) => n + (s.error ? 0 : s.count), 0)
  const critical = problems.reduce(
    (n, s) => n + (s.error || s.severity !== 'critical' ? 0 : s.count),
    0
  )
  const errored = problems.filter((s) => s.error).length

  const onExplain = (action: SignalAction, row: RowView) => {
    const p = action.payload ?? {}
    if (p.api_id != null) {
      onJumpTab?.('partners', { apiId: Number(p.api_id) })
      return
    }
    if (p.flow != null) {
      const path = `/flows/${p.flow}`
      const url = nav.consoleUrl ? nav.consoleUrl(path) : path
      if (url) {
        if (/^https?:/.test(url)) window.open(url, '_blank', 'noopener')
        else nav.navigate(url)
      }
      return
    }
    onJumpTab?.('inbound', { ...p, row: row.key })
  }

  if (isLoading) {
    return (
      <div className='space-y-3' aria-busy>
        <div className='h-5 w-72 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className='h-[62px] animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]'
          />
        ))}
      </div>
    )
  }
  if (isError || !data) {
    const msg =
      (error as { response?: { error?: string } })?.response?.error ??
      (error instanceof Error ? error.message : null)
    return (
      <p
        className={cn(
          'rounded-lg border px-4 py-3 text-[12.5px]',
          TONE_BORDER.negative,
          TONE_SOFT.negative,
          TONE_TEXT.negative
        )}
      >
        Couldn't load integration problems{msg ? ` · ${msg}` : ''}.
      </p>
    )
  }

  const checked = data.checked_at
  return (
    <div className='space-y-4' data-ic-firefight>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
        <p className='text-[13px] text-muted-foreground' data-ic-summary>
          {total === 0 && errored === 0 ? (
            <span className='font-medium text-foreground'>Nothing needs attention</span>
          ) : (
            <>
              <span className='font-semibold tabular-nums text-foreground'>{total}</span> problem
              {total === 1 ? '' : 's'}
              {' · '}
              <span
                className={cn(
                  'font-semibold tabular-nums',
                  critical > 0 ? TONE_TEXT.negative : 'text-foreground'
                )}
              >
                {critical}
              </span>{' '}
              critical
              {errored > 0 && (
                <>
                  {' · '}
                  <span className={cn('font-medium', TONE_TEXT.negative)}>
                    {errored} check{errored === 1 ? '' : 's'} couldn't run
                  </span>
                </>
              )}
            </>
          )}
          {' · '}
          <span data-tip={exactTime(checked)}>last checked {agoText(checked)}</span>
        </p>
        <button
          type='button'
          data-ic-refresh
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
          className='ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')} />
          {refresh.isPending ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {data.stale && (
        <div
          role='status'
          data-ic-stale
          className={cn(
            'flex items-start gap-2 rounded-lg border px-4 py-2.5 text-[12.5px]',
            TONE_BORDER.warning,
            TONE_SOFT.warning,
            TONE_TEXT.warning
          )}
        >
          <Clock className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <span>
            {checked
              ? `Last checked ${agoText(checked)} — the checker may be down.`
              : 'No check has run yet — the checker may be down.'}{' '}
            What you see below may be out of date; “Check now” runs one immediately.
          </span>
        </div>
      )}
      {refresh.isError && (
        <p className={cn('text-[12.5px]', TONE_TEXT.negative)}>
          The check didn't finish ·{' '}
          {(refresh.error as { response?: { error?: string } })?.response?.error ??
            (refresh.error instanceof Error ? refresh.error.message : 'try again')}
        </p>
      )}

      {problems.length === 0 ? (
        <div
          data-ic-empty
          className='flex flex-col items-start gap-1 rounded-lg border border-border bg-card px-5 py-6'
        >
          <p className='flex items-center gap-2 text-[14px] font-semibold text-foreground'>
            <CheckCircle2 className={cn('h-4 w-4', TONE_TEXT.positive)} />
            No integration problems right now
          </p>
          <p className='text-[12.5px] text-muted-foreground'>
            Checked {agoText(checked)}. Every partner call, push and import is watched; anything
            that goes wrong shows up here, most urgent first.
          </p>
        </div>
      ) : (
        <div className='space-y-2'>
          {problems.map((s) => (
            <SignalCard
              key={s.id}
              signal={s}
              expanded={expanded.has(s.id)}
              onToggle={() =>
                setExpanded((e) => {
                  const n = new Set(e)
                  if (n.has(s.id)) n.delete(s.id)
                  else n.add(s.id)
                  return n
                })
              }
              onOpenRecord={onOpenRecord}
              onExplain={onExplain}
            />
          ))}
        </div>
      )}

      {clear.length > 0 && (
        <p className='text-[12px] leading-relaxed text-muted-foreground' data-ic-clear>
          <span className='font-medium text-foreground'>Also checked, all clear:</span>{' '}
          {clear.map((s) => s.label).join(' · ')}
        </p>
      )}
    </div>
  )
}
