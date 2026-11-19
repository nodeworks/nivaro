import {
  ActionLabel,
  collectionNouns,
  ErrorNotice,
  recordPhrase,
  recordTarget,
  useActivityLabels,
  WhenText
} from '@nivaro/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'
import { SheetActivityTable, type TodayCtx, windowLock } from './TodaySheet'

/**
 * "Records changed today" → what that number is: the distinct records (the figure) and every
 * change behind them, broken down by collection, person and hour (each a filter), then one
 * record's changes, then one entry. GET /api/overview/today/records reads the figure's own
 * source over its own window, so the header repeats the tile.
 */

interface TodayRecords {
  window: { from: string; to: string }
  scope: 'all' | 'readable'
  records: number
  changes: number
  capped: boolean
  by_collection: Array<{ collection: string; records: number; changes: number }>
  by_person: Array<{ user: string; name: string | null; records: number; changes: number }>
  hourly: number[]
  rows: Array<{
    collection: string
    item: string
    changes: number
    last_at: string
    last_id: number | null
    last_action: string | null
    last_user: string | null
  }>
  total_rows: number
}

const PAGE = 50

function hourLabel(from: string, i: number) {
  const d = new Date(new Date(from).getTime() + i * 3_600_000)
  return d.toLocaleTimeString([], { hour: 'numeric' })
}

function Bars({
  hourly,
  from,
  picked,
  onPick
}: {
  hourly: number[]
  from: string
  picked: number | null
  onPick: (i: number | null) => void
}) {
  const max = Math.max(1, ...hourly)
  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: a strip of hour buttons */}
      <div
        role='group'
        aria-label='Changes per hour today'
        className='flex h-12 items-end gap-[3px]'
      >
        {hourly.map((n, i) => {
          const words = `${hourLabel(from, i)}: ${formatNumber(n)} ${n === 1 ? 'change' : 'changes'}`
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed hour buckets
              key={i}
              type='button'
              disabled={n === 0}
              aria-pressed={picked === i}
              aria-label={words}
              data-tip={n ? `${words} — show them` : words}
              onClick={() => onPick(picked === i ? null : i)}
              className={cn(
                'flex h-full flex-1 items-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                n > 0 && 'cursor-pointer hover:bg-slate-100 dark:hover:bg-white/[0.06]'
              )}
            >
              <span
                className={cn(
                  'block w-full rounded-[2px] transition-[height,background-color] duration-300 ease-out',
                  n === 0
                    ? 'h-px bg-slate-200 dark:bg-white/10'
                    : picked === i
                      ? 'bg-nvr-cyan'
                      : picked != null
                        ? 'bg-nvr-cyan/30'
                        : 'bg-nvr-cyan/70'
                )}
                style={n ? { height: `${Math.max(10, (n / max) * 100)}%` } : undefined}
              />
            </button>
          )
        })}
      </div>
      <div
        className='mt-1 flex justify-between text-[10.5px] tabular-nums text-slate-400'
        aria-hidden
      >
        <span>{hourLabel(from, 0)}</span>
        <span>now</span>
      </div>
    </div>
  )
}

function Breakdown({
  title,
  rows,
  picked,
  onPick
}: {
  title: string
  rows: Array<{ key: string; name: string; records: number; changes: number }>
  picked: string | undefined
  onPick: (key: string | undefined) => void
}) {
  const max = Math.max(1, ...rows.map((r) => r.changes))
  return (
    <div className='min-w-0'>
      <h3 className='mb-1.5 text-[11.5px] font-medium text-slate-500 dark:text-slate-400'>
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className='text-[12px] text-slate-400'>None.</p>
      ) : (
        <ul className='space-y-0.5'>
          {rows.slice(0, 6).map((r) => (
            <li key={r.key}>
              <button
                type='button'
                aria-pressed={picked === r.key}
                onClick={() => onPick(picked === r.key ? undefined : r.key)}
                className={cn(
                  'relative flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-left text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                  picked === r.key
                    ? 'bg-nvr-cyan/10 font-medium text-slate-900 dark:text-slate-50'
                    : 'hover:bg-slate-100 dark:hover:bg-white/[0.05]'
                )}
              >
                <span
                  className='absolute inset-y-1 left-0 rounded-r bg-slate-200/70 transition-[width] duration-500 ease-out dark:bg-white/[0.06]'
                  style={{ width: `${(r.changes / max) * 100}%` }}
                  aria-hidden
                />
                <span className='relative min-w-0 flex-1 truncate'>{r.name}</span>
                <span className='relative shrink-0 tabular-nums text-slate-500 dark:text-slate-400'>
                  {formatNumber(r.records)}
                  <span className='text-slate-400'> · {formatNumber(r.changes)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function RecordsRoot({ ctx }: { ctx: TodayCtx }) {
  const navigate = useNavigate()
  const d = ctx.drill
  const tab = ctx.isAdmin ? (d.tab ?? 'records') : 'records'
  const [offset, setOffset] = useState(0)
  const [hour, setHour] = useState<number | null>(null)
  const q = useQuery({
    queryKey: ['overview', 'today', 'records', ctx.window, d.col, d.who, offset],
    queryFn: () =>
      api
        .get<{ data: TodayRecords }>('/overview/today/records', {
          params: {
            day_start: ctx.window.from,
            until: ctx.window.to,
            collection: d.col,
            person: d.who,
            offset,
            limit: PAGE
          }
        })
        .then((r) => r.data.data),
    placeholderData: keepPreviousData,
    staleTime: 30_000
  })
  const data = q.data
  const refs = useMemo(
    () =>
      [
        ...(data?.rows ?? []).map((r) => ({
          action: r.last_action ?? 'update',
          collection: r.collection,
          item: r.item,
          user: r.last_user
        })),
        ...(data?.by_collection ?? []).map((c) => ({ action: 'read', collection: c.collection }))
      ] as Array<{ action: string; collection: string; item?: string; user?: string | null }>,
    [data]
  )
  const labels = useActivityLabels(refs)

  if (q.isLoading)
    return (
      <div className='space-y-3 p-4' aria-busy>
        <div className='h-24 animate-pulse rounded-lg bg-white dark:bg-card' />
        <div className='h-64 animate-pulse rounded-lg bg-white dark:bg-card' />
      </div>
    )
  if (q.error || !data)
    return (
      <div className='p-4'>
        <ErrorNotice
          error={q.error}
          what='today’s record changes'
          onRetry={() => void q.refetch()}
        />
      </div>
    )

  const hourLock =
    hour != null
      ? {
          from: new Date(new Date(data.window.from).getTime() + hour * 3_600_000).toISOString(),
          to: new Date(
            Math.min(
              new Date(data.window.from).getTime() + (hour + 1) * 3_600_000 - 1,
              new Date(data.window.to).getTime()
            )
          ).toISOString()
        }
      : {}
  const narrowed = d.col || d.who

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3 p-4'>
      <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-baseline gap-x-4 gap-y-1'>
          <p className='text-[20px] font-semibold tabular-nums tracking-tight text-slate-900 dark:text-slate-50'>
            {formatNumber(data.records)}
            <span className='ml-1.5 text-[13px] font-normal text-slate-500 dark:text-slate-400'>
              {data.records === 1 ? 'record' : 'records'}
            </span>
          </p>
          <p className='text-[13px] tabular-nums text-slate-600 dark:text-slate-300'>
            {formatNumber(data.changes)} {data.changes === 1 ? 'change' : 'changes'} since{' '}
            {new Date(data.window.from).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit'
            })}
          </p>
          {data.scope === 'readable' && (
            <p className='text-[12px] text-slate-500'>
              Records you can read{data.capped ? ' (the newest 20,000 changes)' : ''}.
            </p>
          )}
        </div>
        <div className='mt-3 grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]'>
          <div className='min-w-0'>
            <h3 className='mb-1.5 text-[11.5px] font-medium text-slate-500 dark:text-slate-400'>
              By hour
            </h3>
            <Bars
              hourly={data.hourly}
              from={data.window.from}
              picked={hour}
              onPick={(i) => {
                setHour(i)
                if (i != null && ctx.isAdmin) ctx.go({ ...d, tab: 'changes' }, { replace: true })
              }}
            />
          </div>
          <Breakdown
            title='By collection · records · changes'
            rows={data.by_collection.map((c) => ({
              key: c.collection,
              name: collectionNouns(c.collection, labels).plural,
              records: c.records,
              changes: c.changes
            }))}
            picked={d.col}
            onPick={(col) => {
              setOffset(0)
              ctx.go({ ...d, col }, { replace: true })
            }}
          />
          <Breakdown
            title='By person · records · changes'
            rows={data.by_person.map((p) => ({
              key: p.user,
              name: p.name ?? 'A removed account',
              records: p.records,
              changes: p.changes
            }))}
            picked={d.who}
            onPick={(who) => {
              setOffset(0)
              ctx.go({ ...d, who }, { replace: true })
            }}
          />
        </div>
      </section>

      <div className='flex flex-wrap items-center gap-2'>
        {ctx.isAdmin && (
          <div
            role='tablist'
            aria-label='Show'
            className='inline-flex items-center gap-0.5 rounded-md bg-slate-200/60 p-0.5 dark:bg-white/[0.06]'
          >
            {(['records', 'changes'] as const).map((t) => (
              <button
                key={t}
                type='button'
                role='tab'
                aria-selected={tab === t}
                onClick={() => ctx.go({ ...d, tab: t }, { replace: true })}
                className={cn(
                  'h-7 rounded-[5px] px-3 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                  tab === t
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-white/10 dark:text-slate-50'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
                )}
              >
                {t === 'records'
                  ? `Records (${formatNumber(narrowed ? data.total_rows : data.records)})`
                  : `Every change (${formatNumber(data.changes)})`}
              </button>
            ))}
          </div>
        )}
        {(d.col || d.who || hour != null) && (
          <div className='flex flex-wrap items-center gap-1.5'>
            {d.col && (
              <FilterPill
                label={collectionNouns(d.col, labels).plural}
                onClear={() => ctx.go({ ...d, col: undefined }, { replace: true })}
              />
            )}
            {d.who && (
              <FilterPill
                label={data.by_person.find((p) => p.user === d.who)?.name ?? 'One person'}
                onClear={() => ctx.go({ ...d, who: undefined }, { replace: true })}
              />
            )}
            {hour != null && tab === 'changes' && (
              <FilterPill
                label={`${hourLabel(data.window.from, hour)} hour`}
                onClear={() => setHour(null)}
              />
            )}
          </div>
        )}
      </div>

      {tab === 'changes' ? (
        <SheetActivityTable
          key={`${d.col}|${d.who}|${hour}`}
          ctx={ctx}
          locked={windowLock(ctx, {
            records_only: true,
            ...(d.col ? { collections: [d.col] } : {}),
            ...(d.who ? { users: [d.who] } : {}),
            ...hourLock
          })}
          storageKey='overview-today-changes'
        />
      ) : (
        <section className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          {data.rows.length === 0 ? (
            <p className='px-4 py-10 text-center text-[12.5px] text-slate-500'>
              No records changed in this window.
            </p>
          ) : (
            <ul
              className={cn(
                'divide-y divide-slate-100 dark:divide-border',
                q.isPlaceholderData && 'opacity-60'
              )}
            >
              {data.rows.map((r) => {
                const phrase =
                  recordPhrase(r.collection, r.item, labels) ?? `${r.collection} ${r.item}`
                const who = r.last_user
                  ? (labels?.users?.[r.last_user] ?? labels?.users?.[r.last_user.toLowerCase()])
                  : null
                // A link (junction) row has no page of its own: it opens the record it is on.
                const open = recordTarget(r.collection, r.item, labels) ?? {
                  collection: r.collection,
                  item: r.item
                }
                return (
                  <li key={`${r.collection}:${r.item}`}>
                    <button
                      type='button'
                      onClick={() =>
                        ctx.isAdmin
                          ? ctx.go({ ...d, rec: { collection: r.collection, item: r.item } })
                          : navigate(
                              `/collections/${open.collection}/${encodeURIComponent(open.item)}`
                            )
                      }
                      className='group flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-white/[0.03] dark:focus-visible:bg-white/[0.03]'
                      data-today-record={`${r.collection}:${r.item}`}
                    >
                      <span className='min-w-0 flex-1'>
                        <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-slate-50'>
                          {phrase}
                        </span>
                        <span className='flex flex-wrap items-center gap-x-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
                          <span>{collectionNouns(r.collection, labels).plural}</span>
                          {r.last_action && <ActionLabel action={r.last_action} />}
                          {who && <span>by {who}</span>}
                          <WhenText at={r.last_at} />
                        </span>
                      </span>
                      <span
                        className='shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11.5px] tabular-nums text-slate-600 dark:bg-white/[0.06] dark:text-slate-300'
                        data-tip={`${formatNumber(r.changes)} ${r.changes === 1 ? 'change' : 'changes'} today`}
                      >
                        {formatNumber(r.changes)}×
                      </span>
                      <ChevronRight
                        className='h-4 w-4 shrink-0 text-slate-300 group-hover:text-slate-500'
                        aria-hidden
                      />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {data.total_rows > PAGE && (
            <div className='flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[12px] text-slate-600 dark:border-border dark:text-slate-300'>
              <span className='tabular-nums'>
                {formatNumber(offset + 1)}–{formatNumber(offset + data.rows.length)} of{' '}
                {formatNumber(data.total_rows)}
              </span>
              <div className='flex gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-7'
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}
                >
                  Previous
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-7'
                  disabled={offset + PAGE >= data.total_rows}
                  onClick={() => setOffset(offset + PAGE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function FilterPill({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className='nvr-pop-in inline-flex h-7 items-center gap-1 rounded-full border border-nvr-cyan/40 bg-nvr-cyan/10 pl-2.5 pr-1 text-[12px] font-medium text-slate-800 dark:bg-nvr-cyan/15 dark:text-slate-100'>
      {label}
      <button
        type='button'
        aria-label={`Clear ${label}`}
        onClick={onClear}
        className='flex h-5 w-5 items-center justify-center rounded-full text-slate-500 hover:bg-nvr-cyan/20 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
      >
        <X className='h-3 w-3' aria-hidden />
      </button>
    </span>
  )
}

export { FilterPill }
