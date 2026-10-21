import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Download, Play, Square } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Realtime console → Verification: the tools that prove the realtime claims.
 *   #2477 delivery SLO (synthetic probe + sampled client acknowledgements, per server)
 *   #2463 socket drills (latency / drops / forced disconnects, time-boxed)
 *   #2760 leak audit (sampled events checked against what each recipient may read)
 *   #2478 socket replay (capture here, replay on staging with the script)
 */

const BAD = 'text-red-700 dark:text-red-300'
const WARN = 'text-amber-700 dark:text-amber-300'
const MUTED = 'text-slate-500 dark:text-muted-foreground'
const MONO = 'font-mono text-[11.5px]'

const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString())

function Section({
  title,
  lede,
  action,
  children
}: {
  title: string
  lede: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className='space-y-3'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>{title}</h2>
          <p className={cn('mt-0.5 max-w-[75ch] text-[12.5px]', MUTED)}>{lede}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Cell({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <div className={cn('text-[11px] font-medium', MUTED)}>{label}</div>
      <div
        className={cn(
          'mt-0.5 text-[13px] font-semibold tabular-nums text-slate-900 dark:text-foreground',
          tone
        )}
      >
        {value}
      </div>
    </div>
  )
}

function Grid({ children }: { children: ReactNode }) {
  return (
    <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6 dark:border-border dark:bg-border'>
      {children}
    </div>
  )
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <table className='w-full text-left text-[12px] tabular-nums'>
        <thead>
          <tr className='border-b border-slate-200 text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
            {head.map((h) => (
              <th key={h} className='px-3 py-2 font-medium'>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className='divide-y divide-slate-100 dark:divide-border/60'>{children}</tbody>
      </table>
    </div>
  )
}

const inputCls =
  'h-8 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] tabular-nums text-slate-900 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-foreground'
const primaryBtn =
  'inline-flex items-center gap-1.5 rounded-md bg-nvr-cyan px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-[#00b8e0] disabled:pointer-events-none disabled:opacity-40'
const secondaryBtn =
  'inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-[12.5px] font-medium text-slate-700 hover:bg-muted disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:text-foreground'

export function VerifyTab() {
  return (
    <div className='space-y-10'>
      <DeliverySloSection />
      <DrillsSection />
      <LeakAuditSection />
      <ReplaySection />
    </div>
  )
}

// ─── #2477 Delivery SLO ──────────────────────────────────────────────────────

interface Figures {
  samples: number
  missed: number
  p95_ms: number | null
  good_pct: number | null
}
interface DeliverySlo {
  target_ms: number
  good_pct_target: number
  window_days: number
  overall: Figures & { meets: boolean | null }
  by_source: { probe: Figures; client: Figures }
  by_node: Array<Figures & { node: string; source: 'probe' | 'client' }>
  burn: { h1: number | null; h6: number | null; h24: number | null }
  ack_every: number
}

function burnTone(v: number | null, fast: boolean) {
  if (v == null) return undefined
  if (v >= (fast ? 14 : 6)) return BAD
  if (v >= (fast ? 6 : 2)) return WARN
  return undefined
}

function DeliverySloSection() {
  const { data, isLoading, isError } = useQuery<DeliverySlo | null>({
    queryKey: ['realtime-verify', 'delivery-slo'],
    queryFn: () => api.get('/realtime/delivery-slo').then((r) => r.data.data),
    refetchInterval: 60_000
  })
  const lede = data
    ? `${data.good_pct_target}% of socket deliveries within ${n(data.target_ms)} ms, over ${data.window_days} days. Change the target with the other service levels on the Health page.`
    : 'How long events take from the server to the browser, from the delivery probe and from real clients.'
  return (
    <Section title='Delivery service level' lede={lede}>
      {isLoading ? (
        <Skeleton className='h-16 w-full' />
      ) : isError ? (
        <p className={cn('text-[12.5px]', BAD)}>The delivery figures could not be read.</p>
      ) : !data ? (
        <p className={cn('text-[12.5px]', MUTED)}>
          Redis is not available, so there are no delivery figures.
        </p>
      ) : data.overall.samples === 0 ? (
        <p className={cn('text-[12.5px]', MUTED)}>
          No deliveries measured yet. Add a Realtime delivery monitor (Monitors) to run the probe
          every 5 minutes; open tabs add their own measurements as events reach them.
        </p>
      ) : (
        <>
          <Grid>
            <Cell
              label='Within target'
              value={data.overall.good_pct == null ? '—' : `${data.overall.good_pct}%`}
              tone={data.overall.meets === false ? BAD : undefined}
            />
            <Cell
              label='p95'
              value={
                data.overall.p95_ms == null ? 'Too many missed' : `${n(data.overall.p95_ms)} ms`
              }
              tone={
                data.overall.p95_ms == null || data.overall.p95_ms > data.target_ms
                  ? BAD
                  : undefined
              }
            />
            <Cell
              label='Burn, last hour'
              value={`${data.burn.h1 ?? '—'}×`}
              tone={burnTone(data.burn.h1, true)}
            />
            <Cell
              label='Burn, 6 hours'
              value={`${data.burn.h6 ?? '—'}×`}
              tone={burnTone(data.burn.h6, false)}
            />
            <Cell label='Probe deliveries' value={n(data.by_source.probe.samples)} />
            <Cell
              label='Real clients'
              value={data.ack_every ? n(data.by_source.client.samples) : 'Off'}
            />
          </Grid>
          <Table head={['Server', 'Source', 'Measured', 'p95', 'Within target', 'Missed']}>
            {data.by_node.map((r) => (
              <tr key={`${r.source}|${r.node}`} data-delivery-node={r.node}>
                <td className={cn('px-3 py-2 text-slate-800 dark:text-foreground', MONO)}>
                  {r.node}
                </td>
                <td className='px-3 py-2'>
                  {r.source === 'probe' ? 'Delivery probe' : 'Real clients'}
                </td>
                <td className='px-3 py-2'>{n(r.samples)}</td>
                <td
                  className={cn(
                    'px-3 py-2',
                    r.p95_ms == null || r.p95_ms > data.target_ms ? BAD : undefined
                  )}
                >
                  {r.p95_ms == null ? '—' : `${n(r.p95_ms)} ms`}
                </td>
                <td className='px-3 py-2'>{r.good_pct == null ? '—' : `${r.good_pct}%`}</td>
                <td className={cn('px-3 py-2', r.missed ? BAD : undefined)}>{n(r.missed)}</td>
              </tr>
            ))}
          </Table>
          <p className={cn('text-[12px]', MUTED)}>
            {data.ack_every
              ? `Real clients answer ${data.ack_every === 1 ? 'every event' : `one event in ${n(data.ack_every)}`} with the time it reached them, on the server's clock.`
              : 'Real-client measurements are off on this server (REALTIME_ACK_EVERY=0).'}{' '}
            A burn of 14× in the last hour, or 6× over 6 hours, raises an issue.
          </p>
        </>
      )}
    </Section>
  )
}

// ─── #2463 Socket drills ─────────────────────────────────────────────────────

type TargetKind = 'room' | 'user' | 'share'
interface DrillRun {
  spec: {
    id: string
    target: { kind: TargetKind; room?: string; user_id?: string; share_pct?: number }
    fault: {
      latency_ms: number
      drop_pct: number
      disconnect: 'none' | 'once' | 'every'
      disconnect_every_s: number
    }
    seconds: number
    started_at: number
    ends_at: number
    started_by_name: string | null
  }
  state: 'running' | 'observing' | 'done'
  totals: {
    sockets: number
    users: number
    packets: number
    delayed: number
    dropped: number
    disconnects: number
    reconnected: number
    disconnected_users: number
    catchup_requests: number
    catchup_replayed: number
    catchup_full: number
  }
  nodes: unknown[]
}

function faultText(f: DrillRun['spec']['fault']): string {
  return (
    [
      f.latency_ms ? `${n(f.latency_ms)} ms late` : null,
      f.drop_pct ? `${f.drop_pct}% dropped` : null,
      f.disconnect === 'once'
        ? 'disconnected once'
        : f.disconnect === 'every'
          ? `disconnected every ${f.disconnect_every_s} s`
          : null
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  )
}

function RoomPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const { data: rooms = [], isLoading } = useQuery<Array<{ room: string; size: number }>>({
    queryKey: ['realtime-stats', 'rooms'],
    queryFn: () => api.get('/realtime/stats').then((r) => r.data.data.rooms ?? []),
    enabled: open,
    staleTime: 10_000
  })
  const custom = typed.trim()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-drill-room
          className={cn(
            inputCls,
            'inline-flex w-[260px] items-center justify-between gap-2 text-left'
          )}
        >
          <span className={cn('truncate', value ? MONO : 'text-slate-400')}>
            {value || 'Choose a room'}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[320px] p-0'>
        <Command>
          <CommandInput
            placeholder='Search rooms or type one'
            value={typed}
            onValueChange={setTyped}
          />
          <CommandList>
            <CommandEmpty>{isLoading ? 'Loading rooms…' : 'No open room matches.'}</CommandEmpty>
            {custom && !rooms.some((r) => r.room === custom) && (
              <CommandGroup>
                <CommandItem
                  value={`use:${custom}`}
                  onSelect={() => {
                    onChange(custom)
                    setOpen(false)
                  }}
                >
                  Use <span className={cn('ml-1', MONO)}>{custom}</span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading='Open on this server'>
              {rooms.map((r) => (
                <CommandItem
                  key={r.room}
                  value={r.room}
                  onSelect={() => {
                    onChange(r.room)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-1.5 h-3.5 w-3.5',
                      value === r.room ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className={cn('flex-1 truncate', MONO)}>{r.room}</span>
                  <span className={cn('ml-2 text-[11px]', MUTED)}>{r.size}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function PersonPicker({
  value,
  onChange
}: {
  value: { id: string; name: string } | null
  onChange: (v: { id: string; name: string } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const { data: found = [], isFetching } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['realtime-verify', 'people', search],
    queryFn: () =>
      api
        .get<{
          data: Array<{ id: string; first_name?: string; last_name?: string; email: string }>
        }>('/users', { params: { search, limit: 8 } })
        .then((r) =>
          r.data.data.map((u) => ({
            id: u.id,
            name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email
          }))
        ),
    enabled: open && search.trim().length >= 2,
    staleTime: 30_000
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-drill-person
          className={cn(
            inputCls,
            'inline-flex w-[260px] items-center justify-between gap-2 text-left'
          )}
        >
          <span className={cn('truncate', !value && 'text-slate-400')}>
            {value?.name ?? 'Choose a person'}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[300px] p-0'>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder='Search by name or email'
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>
              {search.trim().length < 2
                ? 'Type two letters to search.'
                : isFetching
                  ? 'Searching…'
                  : 'Nobody matches.'}
            </CommandEmpty>
            <CommandGroup>
              {found.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    onChange(p)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-1.5 h-3.5 w-3.5',
                      value?.id === p.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {p.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-1'>
      <span className='text-[12px] font-medium text-slate-700 dark:text-foreground'>{label}</span>
      {children}
    </div>
  )
}

function DrillsSection() {
  const qc = useQueryClient()
  const [kind, setKind] = useState<TargetKind>('user')
  const [room, setRoom] = useState('')
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null)
  const [share, setShare] = useState('10')
  const [latency, setLatency] = useState('0')
  const [drop, setDrop] = useState('0')
  const [disconnect, setDisconnect] = useState<'none' | 'once' | 'every'>('once')
  const [every, setEvery] = useState('30')
  const [seconds, setSeconds] = useState('60')
  const { data, isLoading } = useQuery<{ refusal: string | null; runs: DrillRun[] }>({
    queryKey: ['realtime-verify', 'chaos'],
    queryFn: () => api.get('/realtime/chaos').then((r) => r.data.data),
    refetchInterval: (q) => (q.state.data?.runs.some((r) => r.state !== 'done') ? 3000 : 30_000)
  })
  const running = data?.runs.find((r) => r.state === 'running') ?? null
  const start = useMutation({
    mutationFn: () =>
      api.post('/realtime/chaos', {
        target:
          kind === 'room'
            ? { kind, room }
            : kind === 'user'
              ? { kind, user_id: person?.id }
              : { kind, share_pct: Number(share) },
        fault: {
          latency_ms: Number(latency) || 0,
          drop_pct: Number(drop) || 0,
          disconnect,
          disconnect_every_s: Number(every) || 30
        },
        seconds: Number(seconds) || 60
      }),
    onSuccess: () => {
      toast.success('Drill started')
      void qc.invalidateQueries({ queryKey: ['realtime-verify', 'chaos'] })
    },
    onError: (e) => toast.error(errText(e, 'The drill could not start'))
  })
  const stop = useMutation({
    mutationFn: (id: string) => api.post(`/realtime/chaos/${id}/stop`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['realtime-verify', 'chaos'] }),
    onError: (e) => toast.error(errText(e, 'The drill could not be stopped'))
  })
  const targetReady =
    kind === 'room'
      ? !!room
      : kind === 'user'
        ? !!person
        : Number(share) > 0 && Number(share) <= 100
  const faultReady = Number(latency) > 0 || Number(drop) > 0 || disconnect !== 'none'
  return (
    <Section
      title='Connection drills'
      lede='Slow down, drop or cut the live connection for one room, one person or a share of everyone, for a fixed time. Watch the targeted tabs show the reconnect banner, keep unsent changes and catch up; the counts below come from every server.'
    >
      {data?.refusal && <p className={cn('text-[12.5px]', WARN)}>{data.refusal}.</p>}
      <div
        className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
        data-drill-form
      >
        <div className='flex flex-wrap items-end gap-4'>
          <Field label='Who'>
            <SimpleSelect
              value={kind}
              onChange={(v) => setKind(v as TargetKind)}
              ariaLabel='Who the drill reaches'
              className='h-8 w-[180px] text-[12.5px]'
              options={[
                { value: 'user', label: 'One person' },
                { value: 'room', label: 'Everyone in a room' },
                { value: 'share', label: 'A share of everyone' }
              ]}
            />
          </Field>
          {kind === 'room' && (
            <Field label='Room'>
              <RoomPicker value={room} onChange={setRoom} />
            </Field>
          )}
          {kind === 'user' && (
            <Field label='Person'>
              <PersonPicker value={person} onChange={setPerson} />
            </Field>
          )}
          {kind === 'share' && (
            <Field label='Share of everyone (%)'>
              <input
                value={share}
                onChange={(e) => setShare(e.target.value)}
                className={cn(inputCls, 'w-24')}
                inputMode='decimal'
                aria-label='Share percent'
              />
            </Field>
          )}
          <Field label='For (seconds)'>
            <input
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
              className={cn(inputCls, 'w-24')}
              inputMode='numeric'
              aria-label='Duration in seconds'
            />
          </Field>
        </div>
        <div className='flex flex-wrap items-end gap-4 border-t border-slate-100 pt-4 dark:border-border/60'>
          <Field label='Delay events (ms)'>
            <input
              value={latency}
              onChange={(e) => setLatency(e.target.value)}
              className={cn(inputCls, 'w-28')}
              inputMode='numeric'
              aria-label='Latency in milliseconds'
            />
          </Field>
          <Field label='Drop events (%)'>
            <input
              value={drop}
              onChange={(e) => setDrop(e.target.value)}
              className={cn(inputCls, 'w-24')}
              inputMode='decimal'
              aria-label='Drop percent'
            />
          </Field>
          <Field label='Cut the connection'>
            <SimpleSelect
              value={disconnect}
              onChange={(v) => setDisconnect(v as 'none' | 'once' | 'every')}
              ariaLabel='Cut the connection'
              className='h-8 w-[150px] text-[12.5px]'
              options={[
                { value: 'none', label: 'Never' },
                { value: 'once', label: 'Once, at the start' },
                { value: 'every', label: 'Repeatedly' }
              ]}
            />
          </Field>
          {disconnect === 'every' && (
            <Field label='Every (seconds)'>
              <input
                value={every}
                onChange={(e) => setEvery(e.target.value)}
                className={cn(inputCls, 'w-24')}
                inputMode='numeric'
                aria-label='Disconnect every seconds'
              />
            </Field>
          )}
          <div className='ml-auto flex items-center gap-2'>
            {running ? (
              <button
                type='button'
                className={secondaryBtn}
                onClick={() => stop.mutate(running.spec.id)}
                disabled={stop.isPending}
              >
                <Square className='h-3.5 w-3.5' /> Stop the drill
              </button>
            ) : (
              <button
                type='button'
                data-drill-start
                className={primaryBtn}
                disabled={!!data?.refusal || !targetReady || !faultReady || start.isPending}
                onClick={() => start.mutate()}
              >
                <Play className='h-3.5 w-3.5' /> Start drill
              </button>
            )}
          </div>
        </div>
      </div>
      {isLoading ? (
        <Skeleton className='h-20 w-full' />
      ) : !data?.runs.length ? (
        <p className={cn('text-[12.5px]', MUTED)}>No drills yet.</p>
      ) : (
        <Table
          head={[
            'Started',
            'Reached',
            'Faults',
            'Dropped',
            'Delayed',
            'Cut',
            'Came back',
            'Caught up',
            ''
          ]}
        >
          {data.runs.map((r) => {
            const t = r.spec.target
            const who =
              t.kind === 'room' ? (
                <span className={MONO}>{t.room}</span>
              ) : t.kind === 'user' ? (
                'One person'
              ) : (
                `${t.share_pct}% of everyone`
              )
            return (
              <tr key={r.spec.id} data-drill-run={r.state}>
                <td className='px-3 py-2 align-top'>
                  <div className='text-slate-800 dark:text-foreground'>
                    {new Date(r.spec.started_at).toLocaleString()}
                  </div>
                  <div className={cn('text-[11px]', MUTED)}>
                    {r.spec.started_by_name ?? 'Someone'} · {r.spec.seconds} s
                  </div>
                </td>
                <td className='px-3 py-2 align-top'>
                  <div>{who}</div>
                  <div className={cn('text-[11px]', MUTED)}>
                    {n(r.totals.sockets)} connections · {n(r.totals.users)} people
                  </div>
                </td>
                <td className='px-3 py-2 align-top'>{faultText(r.spec.fault)}</td>
                <td className='px-3 py-2 align-top'>{n(r.totals.dropped)}</td>
                <td className='px-3 py-2 align-top'>{n(r.totals.delayed)}</td>
                <td className='px-3 py-2 align-top'>{n(r.totals.disconnects)}</td>
                <td
                  className={cn(
                    'px-3 py-2 align-top',
                    r.state === 'done' && r.totals.disconnected_users > r.totals.reconnected
                      ? WARN
                      : undefined
                  )}
                >
                  {r.totals.disconnected_users
                    ? `${n(r.totals.reconnected)} of ${n(r.totals.disconnected_users)}`
                    : '—'}
                </td>
                <td className='px-3 py-2 align-top'>
                  {r.totals.catchup_requests || r.totals.catchup_replayed || r.totals.catchup_full
                    ? `${n(r.totals.catchup_replayed)} replayed · ${n(r.totals.catchup_full)} reloaded`
                    : '—'}
                </td>
                <td
                  className={cn(
                    'px-3 py-2 align-top text-[11.5px]',
                    r.state === 'running' ? 'text-[#0e7490] dark:text-[#67e8f9]' : MUTED
                  )}
                >
                  {r.state === 'running'
                    ? 'Running'
                    : r.state === 'observing'
                      ? 'Watching reconnects'
                      : 'Done'}
                </td>
              </tr>
            )
          })}
        </Table>
      )}
    </Section>
  )
}

// ─── #2760 Leak audit ────────────────────────────────────────────────────────

interface LeakFinding {
  at: string
  event: string
  room: string | null
  collection: string
  kind: 'collection' | 'record' | 'field'
  items?: string[]
  fields?: string[]
  user_id: string
  user_name: string | null
}
interface LeakView {
  env_rate: number
  timed: { rate: number; until: number } | null
  total_findings: number | null
  process: {
    sampled: number
    checked: number
    findings: number
    skipped: number
    pending: number
    rate: number
  }
  findings: LeakFinding[]
}

const pctLabel = (r: number) => `${Math.round(r * 1000) / 10}%`

function LeakAuditSection() {
  const qc = useQueryClient()
  const [rate, setRate] = useState('0.01')
  const [minutes, setMinutes] = useState('60')
  const { data, isLoading } = useQuery<LeakView>({
    queryKey: ['realtime-verify', 'leak'],
    queryFn: () => api.get('/realtime/leak-audit').then((r) => r.data.data),
    refetchInterval: 15_000
  })
  const set = useMutation({
    mutationFn: (body: { rate: number; minutes: number }) => api.post('/realtime/leak-audit', body),
    onSuccess: (_r, body) => {
      toast.success(body.rate > 0 ? 'Leak audit started' : 'Leak audit stopped')
      void qc.invalidateQueries({ queryKey: ['realtime-verify', 'leak'] })
    },
    onError: (e) => toast.error(errText(e, 'Could not change the audit'))
  })
  const timedOn = !!data?.timed && data.timed.until > Date.now()
  const status = !data
    ? null
    : timedOn
      ? `Checking ${pctLabel(data.timed!.rate)} of events until ${new Date(data.timed!.until).toLocaleTimeString()}.`
      : data.env_rate > 0
        ? `Always checking ${pctLabel(data.env_rate)} of events (REALTIME_LEAK_AUDIT_RATE).`
        : 'Off.'
  return (
    <Section
      title='Leak audit'
      lede='Checks a sample of the events sent to each connection against what that person could open themselves: the collection, each record (row rules and user scopes) and each field name. Findings are logged and raised as issues; nothing is ever held back.'
      action={
        <div className='flex flex-wrap items-center gap-2' data-leak-controls>
          {timedOn ? (
            <button
              type='button'
              className={secondaryBtn}
              onClick={() => set.mutate({ rate: 0, minutes: 1 })}
              disabled={set.isPending}
            >
              <Square className='h-3.5 w-3.5' /> Stop
            </button>
          ) : (
            <>
              <SimpleSelect
                value={rate}
                onChange={setRate}
                ariaLabel='Share of events to check'
                className='h-8 w-[130px] text-[12.5px]'
                options={[
                  { value: '0.001', label: '0.1% of events' },
                  { value: '0.01', label: '1% of events' },
                  { value: '0.05', label: '5% of events' },
                  { value: '0.2', label: '20% of events' }
                ]}
              />
              <SimpleSelect
                value={minutes}
                onChange={setMinutes}
                ariaLabel='How long'
                className='h-8 w-[120px] text-[12.5px]'
                options={[
                  { value: '15', label: 'for 15 min' },
                  { value: '60', label: 'for 1 hour' },
                  { value: '240', label: 'for 4 hours' },
                  { value: '1440', label: 'for a day' }
                ]}
              />
              <button
                type='button'
                className={primaryBtn}
                onClick={() => set.mutate({ rate: Number(rate), minutes: Number(minutes) })}
                disabled={set.isPending}
              >
                <Play className='h-3.5 w-3.5' /> Start audit
              </button>
            </>
          )}
        </div>
      }
    >
      {isLoading ? (
        <Skeleton className='h-16 w-full' />
      ) : !data ? null : (
        <>
          <p className='text-[12.5px] text-slate-700 dark:text-foreground' data-leak-status>
            {status}{' '}
            <span className={MUTED}>
              This server: {n(data.process.checked)} checked, {n(data.process.skipped)} skipped
              under load, {n(data.total_findings)} findings in all.
            </span>
          </p>
          {data.findings.length === 0 ? (
            <p className={cn('text-[12.5px]', MUTED)}>
              No findings. Every checked event matched what its recipient may read.
            </p>
          ) : (
            <Table head={['When', 'Event', 'Room', 'Could not read', 'Person']}>
              {data.findings.map((f, i) => (
                <tr key={`${f.at}-${i}`} data-leak-finding={f.kind}>
                  <td className='whitespace-nowrap px-3 py-2'>{new Date(f.at).toLocaleString()}</td>
                  <td className={cn('px-3 py-2', MONO)}>{f.event}</td>
                  <td
                    className={cn('max-w-[220px] truncate px-3 py-2', MONO)}
                    data-tip={f.room ?? undefined}
                  >
                    {f.room ?? 'direct'}
                  </td>
                  <td className='px-3 py-2'>
                    <span className={BAD}>
                      {f.kind === 'collection'
                        ? 'The collection'
                        : f.kind === 'record'
                          ? 'Records'
                          : 'Fields'}
                    </span>{' '}
                    <span className={MONO}>
                      {f.collection}
                      {f.kind === 'record' && f.items?.length ? ` ${f.items.join(', ')}` : ''}
                      {f.kind === 'field' && f.fields?.length ? `.${f.fields.join(', ')}` : ''}
                    </span>
                  </td>
                  <td className='px-3 py-2'>
                    {f.user_name ?? <span className={MONO}>{f.user_id}</span>}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </Section>
  )
}

// ─── #2478 Socket replay ─────────────────────────────────────────────────────

function ReplaySection() {
  const [minutes, setMinutes] = useState('15')
  const { data } = useQuery<{
    refusal: string | null
    runs: Array<{
      id: string
      speed: number
      planned: number
      emitted: number
      state: string
      created_at: string
    }>
  }>({
    queryKey: ['realtime-verify', 'replay'],
    queryFn: () => api.get('/realtime/replay/runs').then((r) => r.data.data),
    refetchInterval: 15_000
  })
  const capture = useMutation({
    mutationFn: () =>
      api.get('/realtime/replay/capture', { params: { minutes } }).then((r) => r.data.data),
    onSuccess: (c: { events: unknown[] }) => {
      const blob = new Blob([JSON.stringify(c)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `socket-capture-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`Captured ${c.events.length.toLocaleString()} events`)
    },
    onError: (e) => toast.error(errText(e, 'The capture failed'))
  })
  return (
    <Section
      title='Replay live traffic on staging'
      lede='Capture the last minutes of record events here (ids only, no values) with the rooms people sit in, then replay them against staging at 1×, 2× or 5× with simulated connections. The report covers delivery time, API CPU and Redis load.'
      action={
        <div className='flex items-center gap-2'>
          <SimpleSelect
            value={minutes}
            onChange={setMinutes}
            ariaLabel='Capture window'
            className='h-8 w-[130px] text-[12.5px]'
            options={[
              { value: '5', label: 'Last 5 min' },
              { value: '10', label: 'Last 10 min' },
              { value: '15', label: 'Last 15 min' }
            ]}
          />
          <button
            type='button'
            className={secondaryBtn}
            onClick={() => capture.mutate()}
            disabled={capture.isPending}
            data-replay-capture
          >
            <Download className='h-3.5 w-3.5' /> Download capture
          </button>
        </div>
      }
    >
      <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
        <p className='text-[12px] text-slate-700 dark:text-foreground'>Then, from a checkout:</p>
        <pre className='mt-1.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11.5px] text-slate-800 dark:text-slate-200'>
          pnpm --filter @nivaro/api run realtime:replay -- --capture socket-capture.json --target
          https://staging.example.com --token $TOKEN --speed 2
        </pre>
        <p className={cn('mt-1.5 text-[11.5px]', MUTED)}>
          The script refuses production hosts, this server and anything in
          TRAFFIC_REPLAY_SHARED_HOSTS. The target must run with REALTIME_REPLAY=on.
        </p>
      </div>
      <p
        className={cn(
          'text-[12.5px]',
          data?.refusal ? MUTED : 'text-slate-700 dark:text-foreground'
        )}
      >
        {data?.refusal ? `${data.refusal}.` : 'This server accepts replays.'}
      </p>
      {!!data?.runs.length && (
        <Table head={['Prepared', 'Speed', 'Events', 'State']}>
          {data.runs.map((r) => (
            <tr key={r.id}>
              <td className='px-3 py-2'>{new Date(r.created_at).toLocaleString()}</td>
              <td className='px-3 py-2'>×{r.speed}</td>
              <td className='px-3 py-2'>
                {n(r.emitted)} of {n(r.planned)}
              </td>
              <td className='px-3 py-2 capitalize'>{r.state}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  )
}
