import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CalendarRange, ChevronDown, ChevronRight, CircleCheck } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { QueryErrorState } from '../QueryErrorState'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { TrendBars } from './charts'
import { DrillSheet } from './drill'
import type {
  DaBreakdown,
  DaCell,
  DaCond,
  DaMailOutcome,
  DaOutcome,
  DaPerson,
  DaSummary
} from './types'
import {
  Delta,
  DrillContext,
  FilterPicker,
  Num,
  type OpenDrill,
  OutcomeChip,
  Panel,
  Segmented,
  ShareBar
} from './ui'
import { fmtInt, fmtRange, mins, pct, titleize, useParamState, writeDrill } from './url'

/**
 * Delivery analytics (admin): what was sent, over which channel, what reached
 * people, what failed and why, and whether anyone read or acted on it. Every
 * number opens the rows behind it (a side panel), every row opens one
 * notification or one email, and the whole state — window, filters, drill,
 * leaf — lives in the URL. Reads GET /delivery-analytics/*. Needs
 * `<NivaroProvider>` (and a NavigationContext for record / person links).
 */

const WINDOWS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' }
] as const

const CHANNEL_OPTIONS = [
  { value: 'inapp', label: 'In-app' },
  { value: 'push', label: 'Push' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
  { value: 'teams', label: 'Teams' }
]

const BREAKDOWNS: Array<{ key: string; label: string }> = [
  { key: 'category', label: 'Category' },
  { key: 'sender', label: 'Sender' },
  { key: 'sender_type', label: 'Sender type' },
  { key: 'reason', label: 'Why they got it' },
  { key: 'collection', label: 'Collection' },
  { key: 'recipient_role', label: 'Recipient role' },
  { key: 'lane', label: 'Lane' },
  { key: 'kind', label: 'Kind' }
]

const CHANNEL_COLUMNS: Array<{ key: DaOutcome; label: string; tip: string }> = [
  { key: 'delivered', label: 'Delivered', tip: 'Reached the inbox, the device or the relay' },
  { key: 'deferred', label: 'Held', tip: 'Held for the daily summary email' },
  {
    key: 'skipped',
    label: 'Skipped',
    tip: 'Left out on purpose: rules off, no device, no address'
  },
  {
    key: 'dropped',
    label: 'Dropped',
    tip: 'Not sent: test mode, a bounced address, an inactive account'
  },
  { key: 'failed', label: 'Failed', tip: 'Tried and could not deliver' },
  { key: 'not_recorded', label: 'Not recorded', tip: 'Sent before delivery tracking' }
]

const th =
  'whitespace-nowrap px-3 py-2 text-[11px] font-semibold text-slate-500 dark:text-muted-foreground'

function periodWord(preset: string): string {
  return preset === '24h'
    ? 'previous 24 hours'
    : preset === 'custom'
      ? 'previous period'
      : `previous ${preset.replace('d', ' days')}`
}

export function DeliveryAnalyticsView({
  className,
  compactHeader = false,
  search,
  onSearchChange
}: {
  className?: string
  /** Host already shows the title (a tab of a page): drop the heading. */
  compactHeader?: boolean
  /** The host's URL query; pass it with `onSearchChange` so drills are links and Back works. */
  search?: URLSearchParams
  onSearchChange?: (next: URLSearchParams, opts: { replace?: boolean }) => void
}) {
  const client = useNivaroClient()
  const [params, setParams] = useParamState(search, onSearchChange)

  const pageQuery = useMemo(() => {
    const q = new URLSearchParams()
    const w = params.get('window') ?? '7d'
    q.set('window', w)
    if (w === 'custom') {
      const f = params.get('from')
      const t = params.get('to')
      if (f) q.set('from', f)
      if (t) q.set('to', t)
    }
    for (const k of ['category', 'channel', 'collection', 'sender'] as const) {
      const v = params.get(k)
      if (v) q.set(k, v)
    }
    q.set('acted_hours', params.get('acted') ?? '24')
    return q
  }, [params])
  const pageKey = pageQuery.toString()

  const summaryQ = useQuery({
    queryKey: ['delivery-analytics', 'summary', pageKey],
    queryFn: () =>
      client
        .request<{ data: DaSummary }>(get(`/delivery-analytics/summary?${pageKey}`))
        .then((r) => r.data),
    staleTime: 60_000,
    placeholderData: (prev) => prev
  })
  const summary = summaryQ.data

  const by = params.get('by') ?? 'category'
  const breakdownQ = useQuery({
    queryKey: ['delivery-analytics', 'breakdown', pageKey, by, summary?.asof],
    enabled: !!summary && by !== 'category',
    queryFn: () => {
      const q = new URLSearchParams(pageQuery)
      q.set('by', by)
      if (summary) {
        q.set('from', summary.window.from)
        q.set('to', summary.window.to)
        q.set('asof', summary.asof)
      }
      return client
        .request<{ data: DaBreakdown }>(get(`/delivery-analytics/breakdown?${q.toString()}`))
        .then((r) => r.data)
    },
    staleTime: 60_000
  })
  const breakdown = by === 'category' ? summary?.breakdown : breakdownQ.data

  const open = useCallback<OpenDrill>(
    (cell, label, opts) =>
      setParams((p) => {
        writeDrill(p, cell, label)
        if (opts?.sort) p.set('ds', opts.sort)
      }),
    [setParams]
  )

  const setPage = (k: string, v: string | null) =>
    setParams((p) => {
      if (v) p.set(k, v)
      else p.delete(k)
    })

  // Names the page already knows, for the drill's condition chips.
  const labels = useMemo(() => {
    const m = new Map<string, string>()
    if (!summary) return m
    for (const s of summary.options.senders) m.set(`sender=${s.value}`, s.label)
    for (const c of summary.options.categories) m.set(`category=${c.value}`, c.label)
    for (const p of [
      ...summary.people.unread,
      ...summary.people.never_read,
      ...summary.people.floods
    ])
      m.set(`recipient=${p.id}`, p.name)
    for (const t of summary.email.templates) m.set(`template=${t.key}`, t.label)
    for (const r of summary.email.reasons) m.set(`reason=${r.key}`, r.label)
    for (const b of [summary.breakdown, breakdown])
      for (const r of b?.rows ?? []) m.set(`${b?.by}=${r.key}`, r.label)
    for (const c of summary.channels)
      for (const s of c.statuses) m.set(`ch.${c.channel}=${s.status}`, s.label)
    return m
  }, [summary, breakdown])

  const preset = params.get('window') ?? '7d'
  const acted = Number(params.get('acted') ?? 24)

  return (
    <DrillContext.Provider value={open}>
      <div className={cn('flex flex-1 min-h-0 flex-col', className)} data-nvr-delivery-analytics=''>
        <header
          className={cn(
            'shrink-0 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 dark:border-border dark:bg-card'
          )}
        >
          {!compactHeader && (
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Delivery analytics
            </h1>
          )}
          <p className='m-0 max-w-[80ch] text-[12px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
            What was sent, where it went, what failed and why, and whether people read and acted on
            it. Every number opens the notifications or emails behind it.
          </p>
          <div className='mt-2.5 flex flex-wrap items-center gap-2'>
            <Segmented
              ariaLabel='Window'
              value={WINDOWS.some((w) => w.value === preset) ? preset : 'custom'}
              options={[...WINDOWS]}
              onChange={(v) =>
                setParams((p) => {
                  p.set('window', String(v))
                  p.delete('from')
                  p.delete('to')
                })
              }
            />
            <CustomWindow
              active={preset === 'custom'}
              from={params.get('from')}
              to={params.get('to')}
              onApply={(f, t) =>
                setParams((p) => {
                  p.set('window', 'custom')
                  p.set('from', f)
                  p.set('to', t)
                })
              }
            />
            <span className='hidden h-5 w-px bg-slate-200 sm:block dark:bg-border' aria-hidden />
            <FilterPicker
              label='Category'
              allLabel='All'
              value={params.get('category')}
              options={summary?.options.categories ?? []}
              onChange={(v) => setPage('category', v)}
            />
            <FilterPicker
              label='Channel'
              allLabel='All'
              value={params.get('channel')}
              options={CHANNEL_OPTIONS}
              onChange={(v) => setPage('channel', v)}
            />
            <FilterPicker
              label='Collection'
              allLabel='All'
              value={params.get('collection')}
              options={(summary?.options.collections ?? []).map((c) => ({
                ...c,
                label: titleize(c.label)
              }))}
              onChange={(v) => setPage('collection', v)}
            />
            <FilterPicker
              label='Sender'
              allLabel='Anyone'
              value={params.get('sender')}
              options={summary?.options.senders ?? []}
              onChange={(v) => setPage('sender', v)}
            />
            <span className='flex-1' />
            <Segmented
              ariaLabel='Acted within'
              prefix='Acted within'
              value={acted}
              options={[4, 24, 72].map((h) => ({
                value: h,
                label: `${h}h`,
                tip: `An action on the record within ${h} hours of the send counts as acted`
              }))}
              onChange={(v) => setPage('acted', v === 24 ? null : String(v))}
            />
          </div>
          {summary && (
            <p className='mt-2 text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
              {fmtRange(summary.window.from, summary.window.to)}
              {summaryQ.isFetching && <span className='ml-2'>Updating…</span>}
            </p>
          )}
        </header>

        <div className='flex-1 overflow-y-auto bg-slate-50 px-4 py-5 sm:px-6 dark:bg-background'>
          {summaryQ.isError && !summary ? (
            <QueryErrorState
              error={summaryQ.error}
              what='delivery analytics'
              onRetry={() => void summaryQ.refetch()}
            />
          ) : !summary ? (
            <LoadingBody />
          ) : (
            <div className='space-y-5'>
              <Health summary={summary} />
              <Headline summary={summary} />
              <div className='grid gap-5 lg:grid-cols-2'>
                <Panel
                  id='trend-notifications'
                  title={`Notifications per ${summary.window.bucket}`}
                  hint='Read and not yet read. Click a bar for its notifications.'
                >
                  <div className='px-4 py-3'>
                    <TrendBars summary={summary} kind='notifications' />
                  </div>
                </Panel>
                <Panel
                  id='trend-email'
                  title={`Email per ${summary.window.bucket}`}
                  hint='From the mail log: sent and failed. Click a bar for its emails.'
                >
                  <div className='px-4 py-3'>
                    <TrendBars summary={summary} kind='email' />
                  </div>
                </Panel>
              </div>
              <Channels summary={summary} />
              <div className='grid gap-5 xl:grid-cols-2'>
                <Email summary={summary} />
                <People summary={summary} />
              </div>
              <Breakdown
                by={by}
                breakdown={breakdown}
                loading={by !== 'category' && breakdownQ.isLoading}
                error={by !== 'category' && breakdownQ.isError ? breakdownQ.error : null}
                onRetry={() => void breakdownQ.refetch()}
                onBy={(k) =>
                  setParams((p) => (k === 'category' ? p.delete('by') : p.set('by', k)), {
                    replace: true
                  })
                }
              />
              {summary.mutes && <Mutes summary={summary} />}
            </div>
          )}
        </div>
      </div>
      <DrillSheet params={params} setParams={setParams} summary={summary} labels={labels} />
    </DrillContext.Provider>
  )
}

function CustomWindow({
  active,
  from,
  to,
  onApply
}: {
  active: boolean
  from: string | null
  to: string | null
  onApply: (from: string, to: string) => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [open, setOpen] = useState(false)
  const [f, setF] = useState(from ?? '')
  const [t, setT] = useState(to ?? today)
  const valid = !!f && !!t && f <= t
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setF(from ?? '')
          setT(to ?? today)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-pressed={active}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
            active
              ? 'border-slate-900 bg-slate-900 text-white dark:border-nvr-cyan dark:bg-nvr-cyan dark:text-[#172940]'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
          )}
        >
          <CalendarRange className='h-3.5 w-3.5' aria-hidden />
          {active && from && to ? `${from} → ${to}` : 'Custom'}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[260px] space-y-2.5 p-3'>
        <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
          Whole days in UTC, up to a year.
        </p>
        {(
          [
            ['From', f, setF],
            ['To', t, setT]
          ] as const
        ).map(([l, v, set]) => (
          <label key={l} className='block text-[12px] text-slate-600 dark:text-muted-foreground'>
            {l}
            <input
              type='date'
              value={v}
              max={today}
              onChange={(e) => set(e.target.value)}
              className='mt-0.5 block h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12.5px] text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-background dark:text-foreground'
            />
          </label>
        ))}
        <button
          type='button'
          disabled={!valid}
          onClick={() => {
            onApply(f, t)
            setOpen(false)
          }}
          className='h-8 w-full rounded-md bg-nvr-cyan text-[12.5px] font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
        >
          Show this window
        </button>
      </PopoverContent>
    </Popover>
  )
}

function LoadingBody() {
  return (
    <div
      className='space-y-5'
      role='status'
      aria-busy='true'
      aria-label='Loading delivery analytics'
    >
      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 md:grid-cols-3 xl:grid-cols-6 dark:border-border dark:bg-border'>
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton cells
          <div key={i} className='space-y-2 bg-white px-4 py-3 dark:bg-card'>
            <Skeleton className='h-3 w-20' />
            <Skeleton className='h-6 w-16' />
            <Skeleton className='h-3 w-24' />
          </div>
        ))}
      </div>
      <div className='grid gap-5 lg:grid-cols-2'>
        <Skeleton className='h-[230px] w-full rounded-lg' />
        <Skeleton className='h-[230px] w-full rounded-lg' />
      </div>
      <Skeleton className='h-[220px] w-full rounded-lg' />
    </div>
  )
}

// ── Health ─────────────────────────────────────────────────────────────────

function Health({ summary }: { summary: DaSummary }) {
  const items = summary.health
  if (items.length === 0)
    return (
      <p
        data-da-health='clear'
        className='flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-muted-foreground'
      >
        <CircleCheck className='h-4 w-4 text-green-700 dark:text-[#9fbf8a]' aria-hidden />
        Nothing needs a look: no failed sends, floods, never-read people or ignored sources in this
        window.
      </p>
    )
  return (
    <Panel
      id='health'
      title='Needs a look'
      hint='Failures first, then noise. Each count opens its rows.'
    >
      <ul className='divide-y divide-slate-100 dark:divide-border/60'>
        {items.map((h) => (
          <li key={h.id} data-da-health={h.id} className='flex items-start gap-3 px-4 py-2.5'>
            <AlertTriangle
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                h.tone === 'bad'
                  ? 'text-red-600 dark:text-[#e08383]'
                  : 'text-amber-600 dark:text-[#d4936a]'
              )}
              aria-label={h.tone === 'bad' ? 'Failure' : 'Warning'}
            />
            <div className='min-w-0 flex-1'>
              <p className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                {h.title}
              </p>
              <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>{h.detail}</p>
            </div>
            {h.cell && (
              <Num
                cell={h.cell}
                label={h.title}
                className='shrink-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'
              />
            )}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// ── Headline ───────────────────────────────────────────────────────────────

function Stat({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className='min-w-0 bg-white px-4 py-3 dark:bg-card'>
      <p className='truncate text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
        {label}
      </p>
      <div className='mt-1 text-[21px] font-semibold leading-tight tracking-[-0.01em] text-slate-900 dark:text-foreground'>
        {children}
      </div>
      {sub && (
        <div className='mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {sub}
        </div>
      )}
    </div>
  )
}

function RateVs({
  label,
  part,
  whole,
  cell,
  periodLabel
}: {
  label: string
  part: number
  whole: number
  cell: DaCell
  periodLabel: string
}) {
  if (whole === 0) return null
  return (
    <span>
      ·{' '}
      <Num
        cell={cell}
        label={`${label} · previous period`}
        tip={`${fmtInt(part)} of ${fmtInt(whole)} in the ${periodLabel}`}
      >
        {pct(part, whole)}
      </Num>{' '}
      before
    </span>
  )
}

function Headline({ summary }: { summary: DaSummary }) {
  const h = summary.headline
  const period = periodWord(summary.window.preset)
  const acted = summary.acted_hours
  return (
    <section
      aria-label='Headline figures'
      data-da-headline=''
      className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 md:grid-cols-3 xl:grid-cols-6 dark:border-border dark:bg-border'
    >
      <Stat
        label='Notifications sent'
        sub={
          <Delta
            cur={h.sent.n}
            prev={h.sent_prev}
            label='Notifications sent'
            periodLabel={period}
          />
        }
      >
        <Num cell={h.sent} label='Notifications sent' />
      </Stat>
      <Stat
        label='Read'
        sub={
          <>
            <Num cell={h.read} label='Read notifications' /> of {fmtInt(h.sent.n)}
            <RateVs
              label='Read'
              part={h.read_prev.n}
              whole={h.sent_prev.n}
              cell={h.read_prev}
              periodLabel={period}
            />
          </>
        }
      >
        <Num cell={h.read} label='Read notifications'>
          {pct(h.read.n, h.sent.n)}
        </Num>
      </Stat>
      <Stat
        label='Time to read'
        sub={
          <>
            p90 {mins(h.ttr.p90)} · over{' '}
            <Num cell={h.timed} label='Read, with a read time' sort='ttr' />
          </>
        }
      >
        <Num
          cell={h.timed}
          label='Read, slowest first'
          sort='ttr'
          tip='Median — show these, slowest first'
        >
          {mins(h.ttr.p50)}
        </Num>
      </Stat>
      <Stat
        label={`Acted within ${acted}h`}
        sub={
          <>
            <Num cell={h.acted} label={`Acted within ${acted}h`} /> of{' '}
            <Num cell={h.eligible} label='Record notifications, window closed' /> ·{' '}
            <Num cell={h.read_ignored} label='Read, no action' /> read, no action
          </>
        }
      >
        <Num cell={h.acted} label={`Acted within ${acted}h`}>
          {pct(h.acted.n, h.eligible.n)}
        </Num>
      </Stat>
      <Stat label='Still unread' sub={<>of {fmtInt(h.sent.n)} sent in the window</>}>
        <Num cell={h.unread} label='Still unread' />
      </Stat>
      <Stat
        label='Emails sent'
        sub={
          <>
            <Num
              cell={h.email_failed}
              label='Emails failed'
              className={
                h.email_failed.n > 0 ? 'font-medium text-red-700 dark:text-[#e08383]' : undefined
              }
            />{' '}
            failed ·{' '}
            <Delta
              cur={h.email_failed.n}
              prev={h.email_failed_prev}
              label='Emails failed'
              goodWhen='down'
              periodLabel={period}
            />
          </>
        }
      >
        <Num cell={h.email_delivered} label='Emails sent' />
      </Stat>
    </section>
  )
}

// ── Channels ───────────────────────────────────────────────────────────────

function Channels({ summary }: { summary: DaSummary }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <Panel
      id='channels'
      title='Channels'
      hint='What each notification did on each channel. Open a channel for the exact statuses.'
    >
      <div className='overflow-x-auto'>
        <table className='w-full min-w-[720px] text-[12.5px] tabular-nums'>
          <thead>
            <tr className='border-b border-slate-100 text-right dark:border-border/60'>
              <th className={cn(th, 'text-left')}>Channel</th>
              <th className={th} data-tip='Every notification the channel was asked to carry'>
                Attempted
              </th>
              {CHANNEL_COLUMNS.map((c) => (
                <th key={c.key} className={th} data-tip={c.tip}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.channels.map((c) => {
              const isOpen = open === c.channel
              return (
                <ChannelRows
                  key={c.channel}
                  c={c}
                  open={isOpen}
                  onToggle={() => setOpen(isOpen ? null : c.channel)}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function ChannelRows({
  c,
  open,
  onToggle
}: {
  c: DaSummary['channels'][number]
  open: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr
        className='border-b border-slate-100 last:border-0 dark:border-border/60'
        data-da-channel={c.channel}
      >
        <td className='px-3 py-2'>
          <button
            type='button'
            aria-expanded={open}
            onClick={onToggle}
            className='inline-flex items-center gap-1 rounded-sm font-medium text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground'
          >
            {open ? (
              <ChevronDown className='h-3.5 w-3.5 text-slate-400' aria-hidden />
            ) : (
              <ChevronRight className='h-3.5 w-3.5 text-slate-400' aria-hidden />
            )}
            {c.label}
          </button>
        </td>
        <td className='px-3 py-2 text-right font-medium text-slate-900 dark:text-foreground'>
          <Num cell={c.attempted} label={`${c.label} · attempted`} />
        </td>
        {CHANNEL_COLUMNS.map((col) => {
          const cell = c.outcomes[col.key]
          return (
            <td
              key={col.key}
              className={cn(
                'px-3 py-2 text-right',
                col.key === 'failed' && cell.n > 0
                  ? 'font-medium text-red-700 dark:text-[#e08383]'
                  : 'text-slate-700 dark:text-foreground'
              )}
            >
              <Num cell={cell} label={`${c.label} · ${col.label.toLowerCase()}`} />
            </td>
          )
        })}
      </tr>
      {open && (
        <tr className='border-b border-slate-100 bg-slate-50/70 dark:border-border/60 dark:bg-muted/20'>
          <td colSpan={2 + CHANNEL_COLUMNS.length} className='px-3 py-2'>
            {c.statuses.length === 0 ? (
              <p className='pl-5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                Nothing recorded.
              </p>
            ) : (
              <ul className='grid gap-x-8 gap-y-1 pl-5 sm:grid-cols-2'>
                {c.statuses.map((s) => (
                  <li
                    key={s.status}
                    className='flex items-center justify-between gap-3 text-[12px]'
                  >
                    <span className='flex min-w-0 items-center gap-2'>
                      <OutcomeChip outcome={s.outcome}>{titleize(s.outcome)}</OutcomeChip>
                      <span className='truncate text-slate-700 dark:text-foreground'>
                        {s.label}
                      </span>
                    </span>
                    <Num cell={s.cell} label={`${c.label} · ${s.label}`} className='font-medium' />
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// ── Email ──────────────────────────────────────────────────────────────────

const NOT_SENT: DaMailOutcome[] = ['skipped', 'suppressed', 'test', 'dropped']

function Email({ summary }: { summary: DaSummary }) {
  const e = summary.email
  const nav = useNavigation()
  const reasons = e.reasons.filter((r) => r.key !== 'sent')
  const maxReason = Math.max(1, ...reasons.map((r) => r.cell.n))
  const relay = e.relay
  const mailLog = nav.consoleUrl ? nav.consoleUrl('/delivery') : '/delivery'
  return (
    <Panel
      id='email'
      title='Email'
      hint={
        <>
          Every row of the mail log, whatever sent it.{' '}
          {e.ignored_filters.length > 0 && (
            <span className='text-amber-700 dark:text-[#d4936a]'>
              The {e.ignored_filters.join(' and ')} filter
              {e.ignored_filters.length > 1 ? 's do' : ' does'} not apply to email.
            </span>
          )}
        </>
      }
      actions={
        mailLog ? (
          <a
            href={mailLog}
            onClick={(ev) => {
              if (ev.metaKey || ev.ctrlKey || ev.button !== 0) return
              ev.preventDefault()
              nav.navigate(mailLog)
            }}
            className='text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
          >
            Mail log
          </a>
        ) : null
      }
    >
      <div className='space-y-4 px-4 py-3'>
        <dl className='flex flex-wrap gap-x-6 gap-y-2'>
          {e.outcomes.map((o) => (
            <div key={o.key} className='min-w-[72px]'>
              <dt className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{o.label}</dt>
              <dd
                className={cn(
                  'text-[17px] font-semibold',
                  o.key === 'failed' && o.cell.n > 0
                    ? 'text-red-700 dark:text-[#e08383]'
                    : 'text-slate-900 dark:text-foreground'
                )}
              >
                <Num cell={o.cell} label={`Emails · ${o.label.toLowerCase()}`} />
              </dd>
            </div>
          ))}
          {e.resends && (
            <div className='min-w-[72px]'>
              <dt className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>Resends</dt>
              <dd className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
                <Num cell={e.resends} label='Resent emails' />
              </dd>
            </div>
          )}
        </dl>
        {relay && (
          <p
            className='text-[12px] text-slate-600 dark:text-muted-foreground'
            data-da-relay={relay.status}
          >
            <span
              className={cn(
                'mr-1.5 inline-block h-2 w-2 rounded-full align-middle',
                relay.status === 'failing'
                  ? 'bg-red-500'
                  : relay.status === 'ok'
                    ? 'bg-green-600 dark:bg-[#9fbf8a]'
                    : 'bg-slate-300 dark:bg-muted-foreground/50'
              )}
              aria-hidden
            />
            Relay{' '}
            {relay.status === 'failing'
              ? `failing: ${relay.failed} of the newest ${relay.attempted} attempts failed the same way.`
              : relay.status === 'ok'
                ? `delivering: ${relay.attempted - relay.failed} of the newest ${relay.attempted} attempts landed.`
                : `too quiet to judge (${relay.attempted} recent attempts).`}
          </p>
        )}
        <div>
          <h4 className='mb-1.5 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
            Why emails were not sent
          </h4>
          {reasons.length === 0 ? (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Every email in the window went out.
            </p>
          ) : (
            <ul className='space-y-1.5'>
              {reasons.map((r) => (
                <li
                  key={r.key}
                  className='grid grid-cols-[minmax(0,1fr)_56px] items-center gap-3 text-[12.5px] sm:grid-cols-[minmax(0,1fr)_minmax(60px,120px)_56px]'
                >
                  <span className='flex min-w-0 items-center gap-2'>
                    <OutcomeChip outcome={r.outcome}>
                      {titleize(r.outcome === 'deferred' ? 'held' : r.outcome)}
                    </OutcomeChip>
                    <span
                      className='truncate text-slate-800 dark:text-foreground'
                      data-tip={r.hint}
                    >
                      {r.label}
                    </span>
                  </span>
                  <span className='hidden sm:block'>
                    <ShareBar
                      value={r.cell.n}
                      max={maxReason}
                      tone={r.outcome === 'failed' ? 'bad' : 'accent'}
                    />
                  </span>
                  <Num
                    cell={r.cell}
                    label={`Emails · ${r.label}`}
                    className='text-right font-medium'
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[460px] text-[12.5px] tabular-nums'>
            <thead>
              <tr className='border-b border-slate-100 text-right dark:border-border/60'>
                <th className={cn(th, 'pl-0 text-left')}>Template</th>
                <th className={th}>Total</th>
                <th className={th}>Sent</th>
                <th className={th} data-tip='Held for the daily summary'>
                  Held
                </th>
                <th className={th} data-tip='Skipped, suppressed, test mode or dropped'>
                  Not sent
                </th>
                <th className={cn(th, 'pr-0')}>Failed</th>
              </tr>
            </thead>
            <tbody>
              {e.templates.map((t) => {
                const tc: DaCond = ['template', [t.key]]
                const notSent: DaCell = {
                  n: NOT_SENT.reduce((s, o) => s + (t.outcomes[o]?.n ?? 0), 0),
                  s: 'm',
                  w: [tc, ['outcome', NOT_SENT]]
                }
                return (
                  <tr
                    key={t.key}
                    className='border-b border-slate-100 last:border-0 dark:border-border/60'
                  >
                    <td
                      className='max-w-[200px] truncate py-1.5 pr-3 text-slate-800 dark:text-foreground'
                      data-tip={t.key}
                    >
                      {t.label === '(untemplated)' ? 'No template' : t.label}
                    </td>
                    <td className='px-3 py-1.5 text-right font-medium'>
                      <Num cell={t.total} label={`Emails · ${t.label}`} />
                    </td>
                    <td className='px-3 py-1.5 text-right'>
                      <Num cell={t.outcomes.delivered} label={`Sent · ${t.label}`} />
                    </td>
                    <td className='px-3 py-1.5 text-right'>
                      <Num cell={t.outcomes.deferred} label={`Held · ${t.label}`} />
                    </td>
                    <td className='px-3 py-1.5 text-right'>
                      <Num cell={notSent} label={`Not sent · ${t.label}`} />
                    </td>
                    <td
                      className={cn(
                        'py-1.5 pl-3 text-right',
                        t.outcomes.failed.n > 0 && 'font-medium text-red-700 dark:text-[#e08383]'
                      )}
                    >
                      <Num cell={t.outcomes.failed} label={`Failed · ${t.label}`} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {e.templates.length === 0 && (
            <p className='py-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
              No email in this window.
            </p>
          )}
        </div>
      </div>
    </Panel>
  )
}

// ── People ─────────────────────────────────────────────────────────────────

function PersonName({ id, name }: { id: string; name: string }) {
  const nav = useNavigation()
  const href = nav.userUrl ? nav.userUrl(id) : `/users/${id.toLowerCase()}`
  if (!href) return <span className='truncate'>{name}</span>
  return (
    <a
      href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.button !== 0) return
        e.preventDefault()
        nav.navigate(href)
      }}
      className='truncate text-slate-800 hover:underline dark:text-foreground'
    >
      {name}
    </a>
  )
}

function PeopleList({
  title,
  hint,
  people,
  empty,
  value
}: {
  title: string
  hint: string
  people: DaPerson[]
  empty: string
  value: (p: DaPerson) => ReactNode
}) {
  return (
    <div>
      <h4 className='text-[12px] font-semibold text-slate-800 dark:text-foreground'>{title}</h4>
      <p className='mb-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
      {people.length === 0 ? (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>{empty}</p>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border/60'>
          {people.map((p) => (
            <li key={p.id} className='flex items-center justify-between gap-3 py-1.5 text-[12.5px]'>
              <PersonName id={p.id} name={p.name} />
              <span className='shrink-0 tabular-nums text-slate-500 dark:text-muted-foreground'>
                {value(p)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function People({ summary }: { summary: DaSummary }) {
  const p = summary.people
  return (
    <Panel
      id='people'
      title='People'
      hint='Who is falling behind, who never reads, and who is being flooded.'
    >
      <div className='space-y-5 px-4 py-3'>
        <PeopleList
          title='Most unread'
          hint='Notifications from this window still in their inbox.'
          people={p.unread.slice(0, 8)}
          empty='Everyone has read what they got.'
          value={(x) => (
            <>
              <Num
                cell={x.unread}
                label={`Unread · ${x.name}`}
                className='font-medium text-slate-900 dark:text-foreground'
              />{' '}
              of <Num cell={x.sent} label={`Notifications · ${x.name}`} />
            </>
          )}
        />
        <PeopleList
          title={`Read none of them${p.never_read_count > 0 ? ` (${fmtInt(p.never_read_count)})` : ''}`}
          hint='Got five or more and opened none: their rules may need a look.'
          people={p.never_read.slice(0, 8)}
          empty='Nobody ignores everything.'
          value={(x) => (
            <Num
              cell={x.sent}
              label={`Notifications · ${x.name}`}
              className='font-medium text-slate-900 dark:text-foreground'
            />
          )}
        />
        <div>
          <h4 className='text-[12px] font-semibold text-slate-800 dark:text-foreground'>Floods</h4>
          <p className='mb-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            More than {p.flood_per_hour} notifications to one person in one hour.
          </p>
          {p.floods.length === 0 ? (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>No floods.</p>
          ) : (
            <ul className='divide-y divide-slate-100 dark:divide-border/60'>
              {p.floods.slice(0, 8).map((f) => (
                <li
                  key={`${f.id}:${f.hour}`}
                  className='flex items-center justify-between gap-3 py-1.5 text-[12.5px]'
                >
                  <span className='flex min-w-0 items-baseline gap-2'>
                    <PersonName id={f.id} name={f.name} />
                    <span className='shrink-0 text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                      {new Date(`${f.hour}:00:00.000Z`).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric'
                      })}
                    </span>
                  </span>
                  <Num
                    cell={f.cell}
                    label={`Flood · ${f.name}`}
                    className='font-medium text-amber-700 dark:text-[#d4936a]'
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  )
}

// ── Breakdown ──────────────────────────────────────────────────────────────

function Breakdown({
  by,
  breakdown,
  loading,
  error,
  onRetry,
  onBy
}: {
  by: string
  breakdown: DaBreakdown | undefined
  loading: boolean
  error: unknown
  onRetry: () => void
  onBy: (k: string) => void
}) {
  const current = BREAKDOWNS.find((b) => b.key === by) ?? BREAKDOWNS[0]
  const rows = breakdown?.by === by ? breakdown.rows : []
  const max = Math.max(1, ...rows.map((r) => r.sent.n))
  return (
    <Panel
      id='breakdown'
      title='Where the volume comes from'
      hint='Sent, read and acted per group. Low read rates are candidates to quieten or move to a summary.'
    >
      <div
        role='tablist'
        aria-label='Break down by'
        className='flex gap-1 overflow-x-auto border-b border-slate-100 px-3 pt-2 dark:border-border/60'
      >
        {BREAKDOWNS.map((b) => (
          <button
            key={b.key}
            type='button'
            role='tab'
            aria-selected={b.key === by}
            onClick={() => onBy(b.key)}
            className={cn(
              '-mb-px shrink-0 border-b-2 px-2.5 pb-2 pt-1 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
              b.key === by
                ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            )}
          >
            {b.label}
          </button>
        ))}
      </div>
      {error ? (
        <div className='p-4'>
          <QueryErrorState error={error} what='this breakdown' onRetry={onRetry} />
        </div>
      ) : loading || !breakdown ? (
        <div className='space-y-2 p-4' aria-busy='true'>
          <Skeleton className='h-6 w-full' />
          <Skeleton className='h-6 w-full' />
          <Skeleton className='h-6 w-4/5' />
        </div>
      ) : rows.length === 0 ? (
        <p className='px-4 py-6 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          No notifications in this window.
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[820px] text-[12.5px] tabular-nums' data-da-breakdown={by}>
            <thead>
              <tr className='border-b border-slate-100 text-right dark:border-border/60'>
                <th className={cn(th, 'pl-4 text-left')}>{current?.label}</th>
                <th className={th}>Sent</th>
                <th className={th}>Read</th>
                <th className={th}>Read rate</th>
                <th className={th} data-tip='Median time from send to read'>
                  Median read
                </th>
                <th className={th} data-tip='90% were read within this'>
                  p90 read
                </th>
                <th
                  className={th}
                  data-tip='Record notifications acted on within the window, of those whose window closed'
                >
                  Acted
                </th>
                <th className={th} data-tip='Opened, but no transition, comment or task followed'>
                  Read, no action
                </th>
                <th className={cn(th, 'pr-4')}>Unread</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rate = r.sent.n ? r.read.n / r.sent.n : 0
                return (
                  <tr
                    key={r.key}
                    className='border-b border-slate-100 last:border-0 dark:border-border/60'
                  >
                    <td className='py-1.5 pl-4 pr-3'>
                      <div className='flex min-w-0 flex-col gap-1'>
                        <span
                          className='max-w-[260px] truncate text-slate-800 dark:text-foreground'
                          data-tip={r.label}
                        >
                          {r.label}
                        </span>
                        <span className='w-[120px]'>
                          <ShareBar value={r.sent.n} max={max} />
                        </span>
                      </div>
                    </td>
                    <td className='px-3 py-1.5 text-right font-medium text-slate-900 dark:text-foreground'>
                      <Num cell={r.sent} label={`${r.label} · sent`} />
                    </td>
                    <td className='px-3 py-1.5 text-right'>
                      <Num cell={r.read} label={`${r.label} · read`} />
                    </td>
                    <td
                      className={cn(
                        'px-3 py-1.5 text-right',
                        r.sent.n >= 20 && rate < 0.3
                          ? 'font-medium text-amber-700 dark:text-[#d4936a]'
                          : 'text-slate-700 dark:text-foreground'
                      )}
                    >
                      {pct(r.read.n, r.sent.n)}
                    </td>
                    <td className='px-3 py-1.5 text-right'>
                      <Num
                        cell={r.timed}
                        label={`${r.label} · read, slowest first`}
                        sort='ttr'
                        tip='Show the reads behind this, slowest first'
                      >
                        {mins(r.p50)}
                      </Num>
                    </td>
                    <td className='px-3 py-1.5 text-right text-slate-500 dark:text-muted-foreground'>
                      {mins(r.p90)}
                    </td>
                    <td className='px-3 py-1.5 text-right'>
                      <span className='inline-flex items-baseline gap-1'>
                        <Num cell={r.acted} label={`${r.label} · acted`}>
                          {r.eligible.n ? pct(r.acted.n, r.eligible.n) : '–'}
                        </Num>
                        {r.eligible.n > 0 && (
                          <span className='text-[11px] text-slate-400'>
                            of <Num cell={r.eligible} label={`${r.label} · record notifications`} />
                          </span>
                        )}
                      </span>
                    </td>
                    <td className='px-3 py-1.5 text-right'>
                      <Num cell={r.read_ignored} label={`${r.label} · read, no action`} />
                    </td>
                    <td className='py-1.5 pl-3 pr-4 text-right'>
                      <Num cell={r.unread} label={`${r.label} · unread`} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {breakdown.more && (
            <p className='px-4 py-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              The 30 busiest are shown. Open any number and break it down further for the rest.
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}

// ── Mutes ──────────────────────────────────────────────────────────────────

function Mutes({ summary }: { summary: DaSummary }) {
  const m = summary.mutes
  if (!m) return null
  return (
    <Panel
      id='mutes'
      title='Muted records'
      hint={
        <>
          Records people asked to stop hearing about (all time), against what each collection sent
          in this window. <Num cell={m.total} label='All mutes' /> in total.
        </>
      }
    >
      {m.by_collection.length === 0 ? (
        <p className='px-4 py-4 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Nobody has muted a record.
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[420px] text-[12.5px] tabular-nums'>
            <thead>
              <tr className='border-b border-slate-100 text-right dark:border-border/60'>
                <th className={cn(th, 'pl-4 text-left')}>Collection</th>
                <th className={th}>Mutes</th>
                <th className={th}>Sent in window</th>
                <th className={cn(th, 'pr-4')}>Mutes per 100 sent</th>
              </tr>
            </thead>
            <tbody>
              {m.by_collection.map((c) => (
                <tr
                  key={c.key}
                  className='border-b border-slate-100 last:border-0 dark:border-border/60'
                >
                  <td className='py-1.5 pl-4 pr-3 text-slate-800 dark:text-foreground'>
                    {titleize(c.key)}
                  </td>
                  <td className='px-3 py-1.5 text-right font-medium'>
                    <Num cell={c.mutes} label={`Mutes · ${titleize(c.key)}`} />
                  </td>
                  <td className='px-3 py-1.5 text-right'>
                    <Num cell={c.sent} label={`Notifications · ${titleize(c.key)}`} />
                  </td>
                  <td className='py-1.5 pl-3 pr-4 text-right text-slate-600 dark:text-muted-foreground'>
                    {c.sent.n ? ((c.mutes.n / c.sent.n) * 100).toFixed(1) : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

/** @deprecated The old name — kept so existing hosts get the new page. */
export const NotificationAnalyticsView = DeliveryAnalyticsView
