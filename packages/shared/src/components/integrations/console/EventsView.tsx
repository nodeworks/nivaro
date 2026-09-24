import { ArrowDownLeft, ArrowUpRight, ExternalLink, RefreshCw, Search, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useDebounced } from '../../../hooks/useDebounced'
import { cn } from '../../../lib/utils'
import { Checkbox } from '../../ui/checkbox'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { useIntegrationEvents, useReplayEvent } from './api'
import { EventPathSheet } from './event-path'
import { agoText, exactTime, TONE_BORDER, TONE_FILL, TONE_SOFT, TONE_TEXT, type Tone } from './tone'
import type { EventDirection, EventProvider, EventStatus, IntegrationEvent } from './types'

export interface EventsViewProps {
  onOpenRecord?: (collection: string, id: string) => void
}

const STATUS_TONE: Record<EventStatus, Tone> = {
  ok: 'positive',
  error: 'negative',
  info: 'neutral'
}
const STATUS_WORD: Record<EventStatus, string> = { ok: 'OK', error: 'Problem', info: 'Info' }

const DIRECTION_OPTIONS: Array<[EventDirection | '', string]> = [
  ['', 'All'],
  ['out', 'Outbound'],
  ['in', 'Inbound'],
  ['poll', 'Polls & feeds']
]

const DIRECTION_ICON: Record<EventDirection, typeof RefreshCw> = {
  in: ArrowDownLeft,
  out: ArrowUpRight,
  poll: RefreshCw
}
const DIRECTION_WORD: Record<EventDirection, string> = {
  in: 'Inbound — a partner called us',
  out: 'Outbound — we pushed to a partner',
  poll: 'Poll or feed — we asked the partner'
}

/** The event's source id — the cross-record feed says `provider`, the
 *  per-record feed `source`. */
const sourceOf = (e: IntegrationEvent) => e.provider ?? e.source ?? ''
const eventKey = (e: IntegrationEvent) => `${sourceOf(e)}:${e.id}`

const STATUS_OPTIONS: Array<[EventStatus | '', string]> = [
  ['', 'All'],
  ['error', 'Problems'],
  ['ok', 'OK'],
  ['info', 'Info']
]

/** "Today" / "Yesterday" / "Monday, Sep 21" (the year only when it differs). */
export function dayHeading(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
  })
}

const dayKey = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** Light: dark chip. Dark: a brand-tinted chip — never an inverted near-white one. */
export function Segment<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  ...rest
}: {
  value: T
  options: Array<[T, string]>
  onChange: (v: T) => void
  label: string
  disabled?: boolean
} & { [data: `data-${string}`]: string | boolean | undefined }) {
  return (
    <fieldset
      aria-label={label}
      disabled={disabled}
      {...rest}
      className='m-0 inline-flex h-8 min-w-0 overflow-hidden rounded-md border border-border bg-card p-0'
    >
      {options.map(([v, text]) => {
        const on = value === v
        return (
          <button
            key={v || '_all'}
            type='button'
            aria-pressed={on}
            data-value={v || 'all'}
            onClick={() => onChange(v)}
            className={cn(
              'px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              on
                ? 'bg-[#1e293b] text-[#f2f2f2] dark:bg-nvr-cyan/20 dark:text-foreground dark:ring-1 dark:ring-inset dark:ring-nvr-cyan/40'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {text}
          </button>
        )
      })}
    </fieldset>
  )
}

function ReplayButton({ event }: { event: IntegrationEvent }) {
  const replay = useReplayEvent()
  const [armed, setArmed] = useState(false)
  const key = eventKey(event)
  const pending = replay.isPending
  return (
    <button
      type='button'
      data-ic-event-replay={key}
      data-armed={armed || undefined}
      disabled={pending}
      onBlur={() => !pending && setArmed(false)}
      onKeyDown={(e) => e.key === 'Escape' && setArmed(false)}
      onClick={(e) => {
        e.stopPropagation()
        if (!armed) {
          setArmed(true)
          return
        }
        replay.mutate(event, {
          onSuccess: (d) => {
            setArmed(false)
            toast.success('Event replayed', d.detail ? { description: d.detail } : undefined)
          },
          onError: (err) => {
            setArmed(false)
            const msg =
              (err as { response?: { error?: string } })?.response?.error ??
              (err instanceof Error ? err.message : null)
            toast.error(msg ?? 'Replay failed', { duration: 8000 })
          }
        })
      }}
      className={cn(
        'h-7 shrink-0 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70',
        armed
          ? // Tinted brand fill + foreground ink: raw brand cyan under white
            // text is ~1.9:1, and brand-coloured text on white is no better.
            'bg-nvr-cyan/15 text-foreground ring-1 ring-inset ring-nvr-cyan/50 hover:bg-nvr-cyan/25 dark:bg-nvr-cyan/20'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {pending ? 'Replaying…' : armed ? 'Replay this event?' : 'Replay'}
    </button>
  )
}

function RecordRef({
  event,
  onOpenRecord
}: {
  event: IntegrationEvent
  onOpenRecord?: EventsViewProps['onOpenRecord']
}) {
  if (!event.item_id || !event.collection) return null
  const collection = event.collection
  const label = event.item_label || `${collection.replace(/_/g, ' ')} ${event.item_id}`
  if (!onOpenRecord) {
    return <span className='font-medium text-foreground'>{label}</span>
  }
  return (
    <button
      type='button'
      data-ic-record={`${collection}:${event.item_id}`}
      onClick={(e) => {
        e.stopPropagation()
        onOpenRecord(collection, String(event.item_id))
      }}
      className='inline-flex max-w-full items-center gap-1 truncate font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
    >
      {label}
      <ExternalLink className='h-3 w-3 shrink-0 opacity-60' aria-hidden />
    </button>
  )
}

function EventRow({
  event,
  direction,
  onOpenRecord,
  onSelect
}: {
  event: IntegrationEvent
  direction: EventDirection | null
  onOpenRecord?: EventsViewProps['onOpenRecord']
  onSelect: (event: IntegrationEvent) => void
}) {
  const status = (event.status ?? 'info') as EventStatus
  const tone = STATUS_TONE[status] ?? 'neutral'
  const key = eventKey(event)
  const DirIcon = direction ? DIRECTION_ICON[direction] : null
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(event)
    }
  }
  return (
    <li
      data-ic-event={key}
      data-ic-event-status={event.status ?? ''}
      className='flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40'
    >
      {/* biome-ignore lint/a11y/useSemanticElements: the row holds a nested record button */}
      <div
        role='button'
        tabIndex={0}
        data-ic-event-open={key}
        onClick={() => onSelect(event)}
        onKeyDown={onKey}
        className='flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      >
        <span
          className='w-[64px] shrink-0 pt-px text-[12px] tabular-nums text-muted-foreground'
          data-tip={exactTime(event.created_at)}
        >
          {agoText(event.created_at)}
        </span>
        <span className='flex w-[136px] shrink-0 items-center gap-2 pt-px'>
          {DirIcon && direction ? (
            <DirIcon
              className='h-3.5 w-3.5 shrink-0 text-muted-foreground'
              role='img'
              aria-label={DIRECTION_WORD[direction]}
              data-ic-event-direction={direction}
              data-tip={DIRECTION_WORD[direction]}
            />
          ) : (
            <span className='w-3.5 shrink-0' aria-hidden />
          )}
          <span
            className={cn('h-2 w-2 shrink-0 rounded-full', TONE_FILL[tone])}
            role='img'
            aria-label={STATUS_WORD[status] ?? 'Info'}
            data-tip={STATUS_WORD[status] ?? 'Info'}
          />
          <span className='truncate text-[12.5px] text-muted-foreground' data-tip={event.label}>
            {event.label}
          </span>
        </span>
        <div className='min-w-0 flex-1'>
          <p className='flex flex-wrap items-baseline gap-x-2 text-[13px] leading-5'>
            <RecordRef event={event} onOpenRecord={onOpenRecord} />
            {event.record_count != null && event.record_count > 1 && (
              <span className='text-[12px] tabular-nums text-muted-foreground'>
                {event.record_count} records
              </span>
            )}
            {status === 'error' && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-px text-[11px] font-medium',
                  TONE_SOFT.negative,
                  TONE_TEXT.negative
                )}
              >
                Problem
              </span>
            )}
          </p>
          <p className='text-[12.5px] leading-5 text-foreground [overflow-wrap:anywhere]'>
            {event.text}
            {event.context && <span className='text-muted-foreground'> · {event.context}</span>}
          </p>
        </div>
      </div>
      {event.replayable && <ReplayButton event={event} />}
    </li>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='rounded-lg border border-border bg-card px-5 py-6'>
      <p className='text-[14px] font-semibold text-foreground'>{title}</p>
      <div className='mt-1 max-w-[70ch] text-[12.5px] text-muted-foreground'>{children}</div>
    </div>
  )
}

/**
 * Events: what the partners reported, newest first, across every record — a
 * chronology, not a problem list (that is Firefight). Each source is an
 * extension's notes source with a `list` function; a source that can replay
 * offers Replay on its rows.
 */
export function EventsView({ onOpenRecord }: EventsViewProps) {
  const [direction, setDirection] = useState<EventDirection | ''>('')
  const [provider, setProvider] = useState('')
  const [status, setStatus] = useState<EventStatus | ''>('')
  const [partner, setPartner] = useState('')
  const [caller, setCaller] = useState('')
  const [recordText, setRecordText] = useState('')
  const [includePeople, setIncludePeople] = useState(false)
  const [selected, setSelected] = useState<{
    source: string
    id: string
    event: IntegrationEvent
  } | null>(null)
  const record = useDebounced(recordText.trim(), 350)
  const peopleId = useId()

  // The source list only arrives with the feed; keep the last one so a
  // direction change can narrow to a single source server-side.
  const [knownProviders, setKnownProviders] = useState<EventProvider[]>([])
  const listableAll = knownProviders.filter((p) => p.can_list)
  const inDirection = direction ? listableAll.filter((p) => p.direction === direction) : listableAll
  // One source in the chosen direction → the server narrows (exact paging);
  // several → the feed is filtered here by each event's direction.
  const serverProvider =
    provider || (direction && inDirection.length === 1 ? inDirection[0].id : '')

  const q = useIntegrationEvents({
    provider: serverProvider,
    status,
    partner: partner || undefined,
    caller: direction === 'in' && caller ? caller : undefined,
    record: record || undefined,
    includePeople: direction === 'in' && includePeople
  })
  const [manual, setManual] = useState(false)
  // Re-render every 30s so "updated 2m ago" and row ages stay true.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const pageProviders = q.data?.pages[0]?.providers
  useEffect(() => {
    if (pageProviders) setKnownProviders(pageProviders)
  }, [pageProviders])
  const providers = pageProviders ?? knownProviders
  const listable = providers.filter((p) => p.can_list)
  const providerDirection = useMemo(() => {
    const m = new Map<string, EventDirection>()
    for (const p of providers) if (p.direction) m.set(p.id, p.direction)
    return m
  }, [providers])
  const directionOf = (e: IntegrationEvent): EventDirection | null =>
    e.direction ?? providerDirection.get(sourceOf(e)) ?? null
  const resolvedRecord = q.data?.pages[0]?.record ?? null

  const loaded = useMemo(() => {
    const seen = new Set<string>()
    const out: IntegrationEvent[] = []
    for (const page of q.data?.pages ?? []) {
      for (const e of page.entries) {
        const k = eventKey(e)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(e)
      }
    }
    return out
  }, [q.data])

  // biome-ignore lint/correctness/useExhaustiveDependencies: directionOf reads providerDirection
  const entries = useMemo(
    () => (direction && !provider ? loaded.filter((e) => directionOf(e) === direction) : loaded),
    [loaded, direction, provider, providerDirection]
  )

  // Filter options come from what is loaded — the partners and callers the
  // feed has actually seen — plus the current pick so it never vanishes.
  const partnerOptions = useMemo(() => {
    const names = new Set<string>()
    for (const e of loaded) if (e.partner) names.add(e.partner)
    if (partner) names.add(partner)
    return [
      { value: '', label: 'All partners' },
      ...[...names].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }))
    ]
  }, [loaded, partner])
  const callerOptions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const e of loaded) if (e.caller && !byId.has(e.caller)) byId.set(e.caller, e.label)
    if (caller && !byId.has(caller)) byId.set(caller, 'Selected caller')
    return [
      { value: '', label: 'All callers' },
      ...[...byId.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label }))
    ]
  }, [loaded, caller])

  const days = useMemo(() => {
    const groups: Array<{ key: string; label: string; items: IntegrationEvent[] }> = []
    for (const e of entries) {
      const k = dayKey(e.created_at)
      const last = groups[groups.length - 1]
      if (last && last.key === k) last.items.push(e)
      else groups.push({ key: k, label: dayHeading(e.created_at), items: [e] })
    }
    return groups
  }, [entries])

  const filtered =
    direction !== '' ||
    provider !== '' ||
    status !== '' ||
    partner !== '' ||
    caller !== '' ||
    record !== '' ||
    includePeople
  const updatedAt = q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null
  const refreshing = q.isRefetching && manual && !q.isFetchingNextPage

  useEffect(() => {
    if (!q.isRefetching) setManual(false)
  }, [q.isRefetching])

  const clearAll = () => {
    setDirection('')
    setProvider('')
    setStatus('')
    setPartner('')
    setCaller('')
    setRecordText('')
    setIncludePeople(false)
  }

  const changeDirection = (d: EventDirection | '') => {
    setDirection(d)
    const p = listable.find((x) => x.id === provider)
    if (d && p && p.direction !== d) setProvider('')
    if (d !== 'in') {
      setCaller('')
      setIncludePeople(false)
    }
  }

  const sourceOptions = [
    { value: '', label: direction ? 'Every source' : 'All sources' },
    ...(direction ? listable.filter((p) => p.direction === direction) : listable).map((p) => ({
      value: p.id,
      label: p.label
    }))
  ]

  const toolbar = (
    <div className='space-y-2'>
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
        <p className='min-w-0 text-[13px] text-muted-foreground' data-ic-events-summary>
          What each partner reported, newest first, across every record. Open an event to see
          everything it set off.
        </p>
        <button
          type='button'
          data-ic-events-refresh
          disabled={q.isFetching}
          onClick={() => {
            setManual(true)
            void q.refetch()
          }}
          data-tip={updatedAt ? `Updated ${exactTime(updatedAt)}` : undefined}
          className='inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          {updatedAt ? `Updated ${agoText(updatedAt)}` : 'Refresh'}
        </button>
      </div>
      {/* One group, so a narrow window wraps the controls together. */}
      <div className='flex flex-wrap items-center gap-2'>
        <Segment
          value={direction}
          options={DIRECTION_OPTIONS}
          onChange={changeDirection}
          label='Direction'
          data-ic-events-direction
        />
        <div data-ic-events-source>
          <SimpleSelect
            value={provider}
            onChange={setProvider}
            options={sourceOptions}
            ariaLabel='Source'
            className='h-8 w-[170px] border-border bg-card text-[12.5px]'
          />
        </div>
        <div data-ic-events-partner>
          <SimpleSelect
            value={partner}
            onChange={setPartner}
            options={partnerOptions}
            ariaLabel='Partner'
            className='h-8 w-[150px] border-border bg-card text-[12.5px]'
          />
        </div>
        {direction === 'in' && (
          <div data-ic-events-caller>
            <SimpleSelect
              value={caller}
              onChange={setCaller}
              options={callerOptions}
              ariaLabel='Caller'
              className='h-8 w-[170px] border-border bg-card text-[12.5px]'
            />
          </div>
        )}
        <Segment
          value={status}
          options={STATUS_OPTIONS}
          onChange={setStatus}
          label='Status'
          data-ic-events-status
        />
        <label className='relative inline-flex h-8 items-center'>
          <span className='sr-only'>Find events that touched a record</span>
          <Search
            className='pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground'
            aria-hidden
          />
          <input
            type='search'
            data-ic-event-record-search
            value={recordText}
            onChange={(e) => setRecordText(e.target.value)}
            placeholder='Record, e.g. CM26-79811'
            className='h-8 w-[210px] rounded-md border border-border bg-card pl-8 pr-2 text-[12.5px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          />
        </label>
        {direction === 'in' && (
          <div
            className='inline-flex h-8 items-center gap-2 text-[12.5px] text-foreground'
            data-ic-events-people
            data-tip="Also list calls made with people's own tokens, not only integration accounts"
          >
            <Checkbox
              id={peopleId}
              checked={includePeople}
              onCheckedChange={(v) => setIncludePeople(v === true)}
            />
            <label htmlFor={peopleId} className='cursor-pointer'>
              Include people's tokens
            </label>
          </div>
        )}
      </div>
      {record && !q.isPlaceholderData && !q.isLoading && !q.isError && (
        <p
          className='flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground'
          data-ic-events-record={
            resolvedRecord ? `${resolvedRecord.collection}:${resolvedRecord.item}` : 'none'
          }
        >
          {resolvedRecord ? (
            <>
              Events that touched <span className='font-medium text-foreground'>{record}</span>
              <span className='text-[12px]'>
                ({resolvedRecord.collection.replace(/_/g, ' ')} {resolvedRecord.item})
              </span>
            </>
          ) : (
            <>No record matches “{record}”</>
          )}
          <button
            type='button'
            data-ic-events-record-clear
            onClick={() => setRecordText('')}
            className='inline-flex h-6 items-center gap-1 rounded px-1.5 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            <X className='h-3 w-3' aria-hidden />
            Clear
          </button>
        </p>
      )}
    </div>
  )

  let body: ReactNode
  if (q.isLoading) {
    body = (
      <div className='overflow-hidden rounded-lg border border-border bg-card' aria-busy>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className='flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0'
          >
            <div className='h-3 w-12 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
            <div className='h-3 w-24 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
            <div className='h-3 flex-1 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
          </div>
        ))}
      </div>
    )
  } else if (q.isError) {
    const msg =
      (q.error as { response?: { error?: string } })?.response?.error ??
      (q.error instanceof Error ? q.error.message : null)
    body = (
      <p
        className={cn(
          'rounded-lg border px-4 py-3 text-[12.5px]',
          TONE_BORDER.negative,
          TONE_SOFT.negative,
          TONE_TEXT.negative
        )}
      >
        Couldn't load integration events{msg ? ` · ${msg}` : ''}.
      </p>
    )
  } else if (listable.length === 0) {
    body = (
      <Panel title='No integration reports events yet'>
        An extension adds a source with{' '}
        <code className='font-mono text-[12px] text-foreground'>ctx.notes.registerSource</code> and
        a <code className='font-mono text-[12px] text-foreground'>list</code> function; its events
        then appear here, newest first, with Replay where the source can re-apply one.
      </Panel>
    )
  } else if (entries.length === 0) {
    body = filtered ? (
      <Panel title='Nothing matches'>
        {record && !resolvedRecord
          ? `No record matches “${record}”. `
          : 'No events match these filters. '}
        <button
          type='button'
          data-ic-events-clear
          onClick={clearAll}
          className='font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
        >
          Clear the filters
        </button>
      </Panel>
    ) : (
      <Panel title='No events yet'>
        The sources are connected but have not reported anything. Events appear here as partners
        send them.
      </Panel>
    )
  } else {
    body = (
      <div
        className={cn('space-y-5 transition-opacity', q.isPlaceholderData && 'opacity-60')}
        aria-busy={q.isPlaceholderData || undefined}
      >
        {days.map((d) => (
          <section key={d.key} data-ic-events-day={d.key} aria-label={d.label}>
            <h3 className='mb-2 flex items-baseline gap-2 text-[12.5px] font-semibold text-foreground'>
              {d.label}
              <span className='text-[12px] font-normal tabular-nums text-muted-foreground'>
                {d.items.length} event{d.items.length === 1 ? '' : 's'}
              </span>
            </h3>
            <ul className='divide-y divide-border overflow-hidden rounded-lg border border-border bg-card'>
              {d.items.map((e) => (
                <EventRow
                  key={eventKey(e)}
                  event={e}
                  direction={directionOf(e)}
                  onOpenRecord={onOpenRecord}
                  onSelect={(ev) =>
                    setSelected({ source: sourceOf(ev), id: String(ev.id), event: ev })
                  }
                />
              ))}
            </ul>
          </section>
        ))}
        <div className='flex items-center gap-3'>
          {q.hasNextPage ? (
            <button
              type='button'
              data-ic-events-older
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
              className='inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
              {q.isFetchingNextPage ? 'Loading older…' : 'Show older'}
            </button>
          ) : (
            <p className='text-[12px] text-muted-foreground' data-ic-events-end>
              That is as far back as the sources keep.
            </p>
          )}
          <span className='text-[12px] tabular-nums text-muted-foreground'>
            {entries.length} shown
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className='space-y-4' data-ic-events>
      {toolbar}
      {body}
      <EventPathSheet
        target={selected ? { source: selected.source, id: selected.id } : null}
        event={selected?.event}
        onClose={() => setSelected(null)}
        onOpenRecord={onOpenRecord}
      />
    </div>
  )
}
