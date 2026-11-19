import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { cn, formatNumber } from '../lib/utils'
import { ErrorNotice } from './ErrorNotice'
import { SimpleSelectXs } from './ui/SimpleSelect'

/** Stamps an event carries for bookkeeping, not fields a person changed. */
const BOOKKEEPING_FIELDS = new Set(['changed', 'updated_at', 'date_updated', 'user_updated'])

/** Parts of a record an event names with a `$` token: said in words, never the token. */
const ASPECT_WORDS: Record<string, string> = {
  $state: 'step',
  $related: 'linked records',
  $comments: 'comments',
  $tasks: 'tasks',
  $files: 'files'
}

/** An event's fields split into real field names and the record parts it touched. Pure. */
export function traceFields(fields: readonly string[]): { names: string[]; aspects: string[] } {
  const names: string[] = []
  const aspects: string[] = []
  for (const f of fields) {
    if (BOOKKEEPING_FIELDS.has(f)) continue
    if (f.startsWith('$')) {
      const word = ASPECT_WORDS[f] ?? f.slice(1).replace(/_/g, ' ')
      if (!aspects.includes(word)) aspects.push(word)
    } else names.push(f)
  }
  return { names, aspects }
}

/**
 * "Why didn't my page update?" — the admin-only trace (GET /api/realtime/trace). For one
 * record, or for one person, and a time window: the live events the server sent, the writes
 * that happened (and any that were never announced), who is subscribed and who acknowledged.
 * Read-only; the server answers ids, field names and times only, never a value.
 *
 *   <LiveTraceView collection='workflows' item='123' />    a record
 *   <LiveTraceView userId='…' />                            a person
 */

interface TraceEvent {
  seq: number
  at: string
  room: string
  event: string
  action: string | null
  item: string | null
  fields: string[]
  source: string | null
  bulk: number | null
  acked_by: string[]
}
interface TraceWrite {
  kind: 'activity' | 'raw-pending' | 'row-timestamp'
  at: string
  action: string | null
  item: string | null
  by: string | null
  fields: string[]
  announced: boolean
  matched_seq: number | null
}
interface TraceSubscriber {
  user_id: string | null
  name: string
  sockets: number
  via: string[]
  apps: string[]
  acked: boolean
  acked_events: number
}
interface TraceData {
  mode: 'record' | 'person'
  window: { from: string; to: string }
  live_mode: 'on' | 'batched' | 'off' | null
  journal: { available: boolean; retention_hours: number; truncated: boolean }
  events: TraceEvent[]
  writes: TraceWrite[]
  subscribers: TraceSubscriber[]
  person: {
    user_id: string
    name: string | null
    sockets: Array<{
      id: string
      app: string | null
      transport: string | null
      connected_at: string | null
      rooms: string[]
      rooms_total: number
    }>
  } | null
  rooms: Array<{ room: string; events: number }>
  ack: { sampled_about_one_in: number; acked_events: number }
  findings: string[]
  subscription_note: string
}

const WINDOWS: Array<{ value: string; label: string; minutes: number }> = [
  { value: '15', label: 'Last 15 minutes', minutes: 15 },
  { value: '60', label: 'Last hour', minutes: 60 },
  { value: '360', label: 'Last 6 hours', minutes: 360 },
  { value: '1440', label: 'Last 24 hours', minutes: 1440 }
]

const WRITE_LABEL: Record<TraceWrite['kind'], string> = {
  activity: 'Saved through the app',
  'raw-pending': 'Waiting to be announced',
  'row-timestamp': 'Row changed, no activity entry'
}

function clock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className='whitespace-nowrap px-3 py-1 text-left text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
      {children}
    </th>
  )
}

function Block({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-border/60'>
        <h4 className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h4>
        {count != null && (
          <span className='rounded-full bg-slate-100 px-1.5 text-[10.5px] tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300'>
            {formatNumber(count)}
          </span>
        )}
      </header>
      <div className='overflow-x-auto'>{children}</div>
    </section>
  )
}

export function LiveTraceView({
  collection,
  item,
  userId,
  className
}: {
  collection?: string
  item?: string | number
  userId?: string
  className?: string
}) {
  const client = useNivaroClient()
  const [minutes, setMinutes] = useState('60')
  const record = !!collection && item != null && String(item) !== ''
  const key = [
    'nvr-live-trace',
    collection ?? null,
    item == null ? null : String(item),
    userId ?? null,
    minutes
  ]
  const q = useQuery({
    queryKey: key,
    queryFn: () => {
      const to = new Date()
      const from = new Date(to.getTime() - Number(minutes) * 60_000)
      const p = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
      if (record) {
        p.set('collection', String(collection))
        p.set('item', String(item))
      } else if (userId) p.set('user', userId)
      return client
        .request<{ data: TraceData }>(get(`/realtime/trace?${p.toString()}`))
        .then((r) => r.data)
    },
    enabled: record || !!userId,
    staleTime: 0,
    retry: false
  })
  const d = q.data
  const byWriteTime = useMemo(
    () => [...(d?.writes ?? [])].sort((a, b) => b.at.localeCompare(a.at)),
    [d?.writes]
  )
  const events = useMemo(() => [...(d?.events ?? [])].sort((a, b) => b.seq - a.seq), [d?.events])

  return (
    <div className={cn('space-y-3', className)} data-live-trace>
      <div className='flex flex-wrap items-center gap-2'>
        <SimpleSelectXs
          value={minutes}
          onChange={setMinutes}
          ariaLabel='Time window'
          options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
        />
        <button
          type='button'
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          className='inline-flex h-6 items-center gap-1 rounded border border-slate-200 bg-white px-2 text-[11px] text-slate-600 hover:bg-muted disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
        >
          {q.isFetching ? (
            <Loader2 className='h-3 w-3 animate-spin' />
          ) : (
            <RefreshCw className='h-3 w-3' />
          )}
          Run again
        </button>
        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
          Read-only. Shows ids, field names and times, never values.
        </span>
      </div>

      {q.isError && (
        <ErrorNotice error={q.error} what='the trace' onRetry={() => void q.refetch()} />
      )}
      {q.isLoading && (
        <div className='flex items-center gap-2 text-[12px] text-slate-500' aria-busy='true'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' /> Tracing…
        </div>
      )}

      {d && (
        <>
          <section
            data-live-trace-findings
            className='rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-slate-900/40'
          >
            <h4 className='mb-1.5 text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
              What this says
            </h4>
            {d.findings.length === 0 ? (
              <p className='flex items-center gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-400'>
                <CheckCircle2 className='h-3.5 w-3.5' /> Every write in this window has a live event
                and nothing is waiting.
              </p>
            ) : (
              <ul className='space-y-1'>
                {d.findings.map((f) => (
                  <li
                    key={f}
                    className='flex gap-1.5 text-[12px] text-slate-700 dark:text-slate-200'
                  >
                    <TriangleAlert className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400' />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {d.mode === 'record' ? (
            <>
              <Block title='Writes' count={byWriteTime.length}>
                {byWriteTime.length === 0 ? (
                  <p className='px-3 py-3 text-[12px] text-slate-500'>No writes in this window.</p>
                ) : (
                  <table className='w-full text-[12px]' data-live-trace-writes>
                    <thead>
                      <tr>
                        <Th>Time</Th>
                        <Th>How</Th>
                        <Th>Action</Th>
                        <Th>Live event</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {byWriteTime.map((w) => (
                        <tr
                          key={`${w.kind}-${w.at}-${w.matched_seq ?? ''}-${w.by ?? ''}`}
                          className='border-t border-slate-100 dark:border-border/60'
                        >
                          <td className='px-3 py-1 tabular-nums'>{clock(w.at)}</td>
                          <td className='px-3 py-1'>
                            {WRITE_LABEL[w.kind]}
                            {w.kind === 'raw-pending' && w.by ? ` (${w.by})` : ''}
                          </td>
                          <td className='px-3 py-1'>{w.action ?? '—'}</td>
                          <td className='px-3 py-1'>
                            {w.kind === 'raw-pending' ? (
                              <span className='text-amber-700 dark:text-amber-400'>
                                not sent yet
                              </span>
                            ) : w.announced ? (
                              <span className='text-emerald-700 dark:text-emerald-400'>
                                sent (#{w.matched_seq})
                              </span>
                            ) : (
                              <span className='font-medium text-red-700 dark:text-red-400'>
                                never announced
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Block>

              <Block title='Who is subscribed now' count={d.subscribers.length}>
                {d.subscribers.length === 0 ? (
                  <p className='px-3 py-3 text-[12px] text-slate-500'>
                    Nobody is in this record's live room right now.
                  </p>
                ) : (
                  <table className='w-full text-[12px]' data-live-trace-subscribers>
                    <thead>
                      <tr>
                        <Th>Person</Th>
                        <Th>Connections</Th>
                        <Th>Listening to</Th>
                        <Th>Acknowledged</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.subscribers.map((s) => (
                        <tr
                          key={s.user_id ?? s.name}
                          className='border-t border-slate-100 dark:border-border/60'
                        >
                          <td className='px-3 py-1'>{s.name}</td>
                          <td className='px-3 py-1 tabular-nums'>
                            {s.sockets}
                            {s.apps.length ? ` (${s.apps.join(', ')})` : ''}
                          </td>
                          <td className='px-3 py-1'>
                            {s.via
                              .map((v) => (v === 'record' ? 'this record' : 'the whole list'))
                              .join(' + ')}
                          </td>
                          <td className='px-3 py-1'>
                            {s.acked ? (
                              <span className='inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400'>
                                <CheckCircle2 className='h-3 w-3' /> {formatNumber(s.acked_events)}{' '}
                                event
                                {s.acked_events === 1 ? '' : 's'}
                              </span>
                            ) : (
                              // Plain text, not a dashed-circle glyph (it read as "still checking").
                              <span className='text-slate-500 dark:text-slate-400'>
                                Not acknowledged
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Block>
            </>
          ) : (
            <>
              <Block title='Live connections' count={d.person?.sockets.length ?? 0}>
                {!d.person || d.person.sockets.length === 0 ? (
                  <p className='px-3 py-3 text-[12px] text-slate-500'>
                    No live connection from this person right now.
                  </p>
                ) : (
                  <table className='w-full text-[12px]' data-live-trace-sockets>
                    <thead>
                      <tr>
                        <Th>Connection</Th>
                        <Th>App</Th>
                        <Th>Transport</Th>
                        <Th>Since</Th>
                        <Th>Rooms</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.person.sockets.map((s) => (
                        <tr key={s.id} className='border-t border-slate-100 dark:border-border/60'>
                          <td className='px-3 py-1 font-mono'>{s.id}</td>
                          <td className='px-3 py-1'>{s.app ?? '—'}</td>
                          <td className='px-3 py-1'>{s.transport ?? '—'}</td>
                          <td className='px-3 py-1 tabular-nums'>
                            {s.connected_at ? clock(s.connected_at) : '—'}
                          </td>
                          <td className='px-3 py-1'>{s.rooms_total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Block>
              <Block title='Events sent to their rooms' count={d.rooms.length}>
                {d.rooms.length === 0 ? (
                  <p className='px-3 py-3 text-[12px] text-slate-500'>
                    Nothing was emitted to the rooms they are in during this window.
                  </p>
                ) : (
                  <table className='w-full text-[12px]'>
                    <thead>
                      <tr>
                        <Th>Room</Th>
                        <Th>Events</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.rooms.slice(0, 40).map((r) => (
                        <tr
                          key={r.room}
                          className='border-t border-slate-100 dark:border-border/60'
                        >
                          <td className='px-3 py-1 font-mono'>{r.room}</td>
                          <td className='px-3 py-1 tabular-nums'>{formatNumber(r.events)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Block>
            </>
          )}

          <Block title='Live events sent' count={events.length}>
            {!d.journal.available ? (
              <p className='px-3 py-3 text-[12px] text-slate-500'>
                The event journal is not on this instance.
              </p>
            ) : events.length === 0 ? (
              <p className='px-3 py-3 text-[12px] text-slate-500'>
                No event in this window (the journal keeps {d.journal.retention_hours} hours).
              </p>
            ) : (
              <table className='w-full text-[12px]' data-live-trace-events>
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>Time</Th>
                    <Th>Action</Th>
                    <Th>Fields</Th>
                    <Th>Acknowledged by</Th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(0, 100).map((e) => {
                    const { names, aspects } = traceFields(e.fields)
                    const fieldsText = [...names, ...aspects].join(', ')
                    const acked = e.acked_by.length > 0
                    return (
                      <tr
                        key={e.seq}
                        className={cn(
                          'border-t border-slate-100 dark:border-border/60',
                          acked && 'bg-emerald-50/70 dark:bg-emerald-500/[0.07]'
                        )}
                      >
                        <td className='px-3 py-1 tabular-nums text-slate-500'>{e.seq}</td>
                        <td className='whitespace-nowrap px-3 py-1 tabular-nums'>{clock(e.at)}</td>
                        <td className='px-3 py-1'>
                          {e.action ?? e.event}
                          {e.item === '*'
                            ? ` (${e.bulk != null ? formatNumber(e.bulk) : 'many'} records)`
                            : ''}
                          {e.source ? ` · ${e.source}` : ''}
                        </td>
                        <td className='max-w-[200px] truncate px-3 py-1' title={fieldsText}>
                          {names.join(', ')}
                          {aspects.length > 0 && (
                            <span className='italic text-slate-500 dark:text-slate-400'>
                              {names.length ? ', ' : ''}
                              {aspects.join(', ')}
                            </span>
                          )}
                          {!fieldsText && '—'}
                        </td>
                        <td className='whitespace-nowrap px-3 py-1'>
                          {acked ? (
                            <span className='font-medium text-emerald-800 dark:text-emerald-300'>
                              {e.acked_by.length} {e.acked_by.length === 1 ? 'person' : 'people'}
                            </span>
                          ) : (
                            <span className='text-slate-400 dark:text-slate-500'>—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Block>
          <p className='text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400'>
            This shows who is connected right now, not earlier.{' '}
            {d.ack.sampled_about_one_in
              ? `The server checks delivery on about 1 in ${d.ack.sampled_about_one_in} events`
              : 'The server is not checking delivery here'}
            {d.ack.sampled_about_one_in
              ? ` (${d.ack.acked_events} confirmed in this window). A dash under Acknowledged by means the event was not checked, or nobody confirmed it.`
              : '.'}
          </p>
        </>
      )}
    </div>
  )
}
