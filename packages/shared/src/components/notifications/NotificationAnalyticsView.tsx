import { useQuery } from '@tanstack/react-query'
import { BarChart3 } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * Sender analytics (admin): where notifications come from and whether they
 * are read — per category / kind / lane / sender / collection, read rate,
 * time-to-read, a daily series, per-channel delivery outcomes, and mutes
 * (the "stop telling me about this" signal) per collection. Reads
 * GET /notifications/analytics. Needs `<NivaroProvider>`.
 */

interface Roll {
  key: string
  label?: string
  sent: number
  read: number
  read_rate: number
  median_minutes_to_read: number | null
}
interface Analytics {
  days: number
  total: number
  read: number
  read_rate: number
  median_minutes_to_read: number | null
  truncated: boolean
  by_category: Roll[]
  by_kind: Roll[]
  by_lane: Roll[]
  by_sender: Roll[]
  by_collection: Roll[]
  series: Array<{ day: string; sent: number; read: number }>
  channels: {
    inapp: Record<string, number>
    push: Record<string, number>
    email: Record<string, number>
    sms: Record<string, number>
  }
  mutes: {
    total: number
    muting_users: number
    active_users: number
    top: Array<{ collection: string; mutes: number; sent: number; mute_rate: number }>
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const mins = (m: number | null) =>
  m == null
    ? '—'
    : m < 60
      ? `${Math.round(m)}m`
      : m < 1440
        ? `${(m / 60).toFixed(1)}h`
        : `${(m / 1440).toFixed(1)}d`

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>{label}</p>
      <p className='mt-1 text-[22px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {value}
      </p>
      {hint && <p className='text-[11px] text-slate-400'>{hint}</p>}
    </div>
  )
}

function RollTable({ title, rows, keyLabel }: { title: string; rows: Roll[]; keyLabel: string }) {
  const max = Math.max(1, ...rows.map((r) => r.sent))
  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h3>
      </header>
      {rows.length === 0 ? (
        <p className='px-4 py-4 text-[12px] text-slate-400'>Nothing in this window.</p>
      ) : (
        <table className='w-full text-[12px] tabular-nums'>
          <thead>
            <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
              <th className='px-4 py-1.5 font-semibold'>{keyLabel}</th>
              <th className='px-2 py-1.5 text-right font-semibold'>Sent</th>
              <th className='px-2 py-1.5 text-right font-semibold'>Read</th>
              <th className='px-2 py-1.5 text-right font-semibold'>Time to read</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className='border-t border-slate-100 dark:border-border'>
                <td className='px-4 py-1.5'>
                  <div className='flex items-center gap-2'>
                    <span className='min-w-0 truncate text-slate-700 dark:text-foreground'>
                      {r.label ?? r.key.replace(/_/g, ' ')}
                    </span>
                    <span
                      className='h-1.5 rounded-full bg-nvr-cyan/40'
                      style={{ width: `${Math.max(4, (r.sent / max) * 80)}px` }}
                    />
                  </div>
                </td>
                <td className='px-2 py-1.5 text-right text-slate-700 dark:text-foreground'>
                  {r.sent}
                </td>
                <td className='px-2 py-1.5 text-right'>
                  <span
                    className={cn(
                      r.read_rate >= 0.6
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : r.read_rate >= 0.3
                          ? 'text-slate-700 dark:text-foreground'
                          : 'text-amber-700 dark:text-amber-400'
                    )}
                  >
                    {pct(r.read_rate)}
                  </span>
                </td>
                <td className='px-2 py-1.5 text-right text-slate-500'>
                  {mins(r.median_minutes_to_read)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ChannelCard({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, v]) => v > 0)
  const total = entries.reduce((s, [, v]) => s + v, 0)
  return (
    <div className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>{title}</p>
      {total === 0 ? (
        <p className='mt-1 text-[12px] text-slate-400'>No tracked deliveries yet.</p>
      ) : (
        <ul className='mt-1 space-y-0.5 text-[12px]'>
          {entries
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <li key={k} className='flex items-center justify-between'>
                <span className='text-slate-600 dark:text-muted-foreground'>
                  {k.replace(/_/g, ' ')}
                </span>
                <span className='tabular-nums text-slate-800 dark:text-foreground'>
                  {v}
                  <span className='ml-1 text-[10.5px] text-slate-400'>{pct(v / total)}</span>
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

export function NotificationAnalyticsView({ className }: { className?: string }) {
  const client = useNivaroClient()
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const { data, isLoading } = useQuery({
    queryKey: ['notification-analytics', days],
    queryFn: () =>
      client
        .request<{ data: Analytics }>(get('/notifications/analytics', { days }))
        .then((r) => r.data)
  })
  const series = data?.series ?? []
  const maxDay = Math.max(1, ...series.map((s) => s.sent))
  return (
    <div className={cn('flex flex-1 min-h-0 flex-col', className)} data-nvr-notification-analytics>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <BarChart3 className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Notification analytics
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Where the noise comes from and whether anyone reads it — by category, sender,
              collection and channel, plus what people have muted.
            </p>
          </div>
          <span className='flex-1' />
          <div className='inline-flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
            {([7, 30, 90] as const).map((d) => (
              <button
                key={d}
                type='button'
                onClick={() => setDays(d)}
                className={cn(
                  'rounded px-2.5 py-1 text-[12px] font-medium',
                  days === d
                    ? 'bg-slate-900 text-white dark:bg-nvr-cyan dark:text-[#172940]'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
                )}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {isLoading || !data ? (
          <p className='text-[13px] text-slate-400'>Loading…</p>
        ) : (
          <div className='space-y-5'>
            <div className='grid grid-cols-2 gap-3 md:grid-cols-4'>
              <Tile label='Sent' value={String(data.total)} hint={`last ${data.days} days`} />
              <Tile label='Read rate' value={pct(data.read_rate)} hint={`${data.read} read`} />
              <Tile
                label='Median time to read'
                value={mins(data.median_minutes_to_read)}
                hint='rows read since read tracking began'
              />
              <Tile
                label='Muted records'
                value={String(data.mutes.total)}
                hint={`${data.mutes.muting_users} of ${data.mutes.active_users} active users mute something`}
              />
            </div>
            {data.truncated && (
              <p className='text-[11.5px] text-amber-700 dark:text-amber-400'>
                Window capped at 20,000 rows — figures cover the newest 20,000.
              </p>
            )}
            <div className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
              <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                Per day · sent (bar) and read (filled)
              </p>
              <div className='mt-2 flex h-24 items-end gap-px'>
                {series.map((s) => (
                  <div
                    key={s.day}
                    className='relative flex-1'
                    data-tip={`${s.day}: ${s.sent} sent, ${s.read} read`}
                    title={`${s.day}: ${s.sent} sent, ${s.read} read`}
                  >
                    <div
                      className='w-full rounded-t-sm bg-nvr-cyan/25'
                      style={{ height: `${(s.sent / maxDay) * 96}px` }}
                    />
                    <div
                      className='absolute bottom-0 w-full rounded-t-sm bg-nvr-cyan'
                      style={{ height: `${(s.read / maxDay) * 96}px` }}
                    />
                  </div>
                ))}
                {series.length === 0 && (
                  <p className='text-[12px] text-slate-400'>No notifications in this window.</p>
                )}
              </div>
            </div>
            <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
              <RollTable title='By category' rows={data.by_category} keyLabel='Category' />
              <RollTable title='By sender' rows={data.by_sender} keyLabel='Sender' />
              <RollTable title='By lane' rows={data.by_lane} keyLabel='Lane' />
              <RollTable title='By kind' rows={data.by_kind} keyLabel='Kind' />
              <RollTable title='By collection' rows={data.by_collection} keyLabel='Collection' />
              <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                <header className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
                  <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
                    Most muted sources
                  </h3>
                  <p className='text-[11px] text-slate-400'>
                    Records people asked to stop hearing about, against what that collection sent.
                  </p>
                </header>
                {data.mutes.top.length === 0 ? (
                  <p className='px-4 py-4 text-[12px] text-slate-400'>Nobody has muted a record.</p>
                ) : (
                  <table className='w-full text-[12px] tabular-nums'>
                    <thead>
                      <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
                        <th className='px-4 py-1.5 font-semibold'>Collection</th>
                        <th className='px-2 py-1.5 text-right font-semibold'>Mutes</th>
                        <th className='px-2 py-1.5 text-right font-semibold'>Sent</th>
                        <th className='px-2 py-1.5 text-right font-semibold'>Mute rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.mutes.top.map((m) => (
                        <tr
                          key={m.collection}
                          className='border-t border-slate-100 dark:border-border'
                        >
                          <td className='px-4 py-1.5 text-slate-700 dark:text-foreground'>
                            {m.collection.replace(/_/g, ' ')}
                          </td>
                          <td className='px-2 py-1.5 text-right'>{m.mutes}</td>
                          <td className='px-2 py-1.5 text-right text-slate-500'>{m.sent}</td>
                          <td className='px-2 py-1.5 text-right text-amber-700 dark:text-amber-400'>
                            {m.sent ? pct(m.mute_rate) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            <div className='grid grid-cols-2 gap-3 md:grid-cols-4'>
              <ChannelCard title='In-app' counts={data.channels.inapp} />
              <ChannelCard title='Push' counts={data.channels.push} />
              <ChannelCard title='Email' counts={data.channels.email} />
              <ChannelCard title='SMS' counts={data.channels.sms} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
