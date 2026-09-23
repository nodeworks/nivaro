import { AlertOctagon, AlertTriangle, ChevronRight, ExternalLink, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn, titleCase } from '../../../lib/utils'
import { useSignalAction, useSnooze } from './api'
import { SnoozeMenu } from './SnoozeMenu'
import { ageOf, agoText, exactTime, TONE_FILL, TONE_SOFT, TONE_TEXT } from './tone'
import type { ActionResult, RowView, SignalAction, SignalView } from './types'

/** Actions the server runs for many rows at once — a group can bulk these. */
const BULKABLE: ReadonlyArray<SignalAction['kind']> = ['retry_submission', 'resend', 'extension']

const actionKey = (a: SignalAction) => `${a.kind}:${a.id ?? ''}`

export interface SignalCardProps {
  signal: SignalView
  expanded: boolean
  onToggle: () => void
  onOpenRecord?: (collection: string, id: string) => void
  /** An 'explain' action — the frame decides where it leads. */
  onExplain?: (action: SignalAction, row: RowView) => void
}

export function oldestSeen(s: SignalView): string | null {
  let best: string | null = null
  for (const r of s.rows) if (!best || r.first_seen < best) best = r.first_seen
  return best
}

export function SignalCard({
  signal,
  expanded,
  onToggle,
  onOpenRecord,
  onExplain
}: SignalCardProps) {
  const critical = signal.severity === 'critical'
  const tone = critical ? 'negative' : 'warning'
  const Mark = critical ? AlertOctagon : AlertTriangle
  const oldest = oldestSeen(signal)
  const top = signal.rows[0]
  const [showSnoozed, setShowSnoozed] = useState(false)
  const bodyId = `ic-signal-body-${signal.id.replace(/[^a-z0-9]/gi, '-')}`

  return (
    <section
      data-ic-signal={signal.id}
      data-ic-severity={signal.severity}
      className='overflow-hidden rounded-lg border border-border bg-card'
    >
      <button
        type='button'
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className='flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
      >
        <span
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
            TONE_SOFT[tone]
          )}
          data-tip={critical ? 'Critical — something is failing now' : 'Worth a look'}
        >
          <Mark className={cn('h-3.5 w-3.5', TONE_TEXT[tone])} aria-hidden />
        </span>
        <span className='min-w-0 flex-1'>
          <span className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
            <span className='text-[13.5px] font-semibold text-foreground'>{signal.label}</span>
            {signal.error ? (
              <span className={cn('text-[12px] font-medium', TONE_TEXT.negative)}>
                Couldn't evaluate
              </span>
            ) : (
              <span className='text-[12px] tabular-nums text-muted-foreground'>
                <span className={cn('font-semibold', TONE_TEXT[tone])}>{signal.count}</span> open
                {oldest && (
                  <span data-tip={`Oldest first seen ${exactTime(oldest)}`}>
                    {' '}
                    · oldest {ageOf(oldest)}
                  </span>
                )}
                {signal.snoozed.length > 0 && <> · {signal.snoozed.length} snoozed</>}
              </span>
            )}
          </span>
          <span className='mt-0.5 block truncate text-[12px] text-muted-foreground'>
            {signal.error
              ? signal.error
              : top
                ? `${top.title}${top.detail ? ` — ${top.detail}` : ''}`
                : signal.description}
          </span>
        </span>
        <ChevronRight
          className={cn(
            'mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
            expanded && 'rotate-90'
          )}
          aria-hidden
        />
      </button>

      {expanded && (
        <div id={bodyId} className='border-t border-border'>
          {signal.error ? (
            <p className={cn('px-4 py-3 text-[12.5px]', TONE_TEXT.negative)}>
              Couldn't evaluate · {signal.error}
            </p>
          ) : (
            <>
              <p className='max-w-[80ch] px-4 pb-1 pt-3 text-[12px] leading-relaxed text-muted-foreground'>
                {signal.description}
              </p>
              <RowList
                signal={signal}
                rows={signal.rows}
                onOpenRecord={onOpenRecord}
                onExplain={onExplain}
              />
              {signal.count > signal.shown && (
                <p className='px-4 pb-3 text-[12px] text-muted-foreground'>
                  Showing {signal.shown} of {signal.count}. The rest appear as these are cleared.
                </p>
              )}
            </>
          )}
          {signal.snoozed.length > 0 && (
            <div className='border-t border-border'>
              <button
                type='button'
                onClick={() => setShowSnoozed((v) => !v)}
                aria-expanded={showSnoozed}
                data-ic-snoozed-fold={signal.snoozed.length}
                className='flex w-full items-center gap-1.5 px-4 py-2 text-left text-[12px] font-medium text-muted-foreground hover:text-foreground'
              >
                <ChevronRight
                  className={cn('h-3.5 w-3.5 transition-transform', showSnoozed && 'rotate-90')}
                />
                Snoozed ({signal.snoozed.length})
              </button>
              {showSnoozed && <SnoozedList signal={signal} />}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function RowList({
  signal,
  rows,
  onOpenRecord,
  onExplain
}: {
  signal: SignalView
  rows: RowView[]
  onOpenRecord?: (collection: string, id: string) => void
  onExplain?: (action: SignalAction, row: RowView) => void
}) {
  const act = useSignalAction()
  const [results, setResults] = useState<Record<string, ActionResult>>({})
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    if (!rows.some((r) => r.group)) return null
    const m = new Map<string, { key: string; label: string; rows: RowView[] }>()
    for (const r of rows) {
      const k = r.group ?? '—'
      const g = m.get(k) ?? { key: k, label: r.group_label ?? r.group ?? 'Other', rows: [] }
      g.rows.push(r)
      m.set(k, g)
    }
    return [...m.values()].sort((a, b) => b.rows.length - a.rows.length)
  }, [rows])

  const run = async (action: SignalAction, targets: RowView[]) => {
    const keys = targets.map((r) => r.key)
    setPending((p) => new Set([...p, ...keys]))
    try {
      const out = await act.mutateAsync({ signal: signal.id, row_keys: keys, action })
      setResults((prev) => {
        const next = { ...prev }
        for (const r of out) next[r.key] = r
        return next
      })
      setSelected((s) => new Set([...s].filter((k) => !keys.includes(k))))
    } catch (e) {
      const msg =
        (e as { response?: { error?: string } })?.response?.error ??
        (e instanceof Error ? e.message : 'The action failed')
      setResults((prev) => {
        const next = { ...prev }
        for (const k of keys) next[k] = { key: k, ok: false, message: msg }
        return next
      })
    } finally {
      setPending((p) => new Set([...p].filter((k) => !keys.includes(k))))
    }
  }

  const onAction = (action: SignalAction, row: RowView) => {
    if (action.kind === 'open') {
      const c = (action.payload?.collection as string) ?? row.record?.collection
      const id = (action.payload?.id as string) ?? row.record?.id
      if (c && id) onOpenRecord?.(c, String(id))
      return
    }
    if (action.kind === 'explain') {
      onExplain?.(action, row)
      return
    }
    void run(action, [row])
  }

  const renderRow = (r: RowView, selectable: boolean) => (
    <SignalRowView
      key={r.key}
      signal={signal}
      row={r}
      result={results[r.key]}
      busy={pending.has(r.key)}
      selectable={selectable}
      selected={selected.has(r.key)}
      onSelect={(on) =>
        setSelected((s) => {
          const n = new Set(s)
          if (on) n.add(r.key)
          else n.delete(r.key)
          return n
        })
      }
      onAction={(a) => onAction(a, r)}
      onOpenRecord={onOpenRecord}
    />
  )

  if (!groups) {
    return <ul className='divide-y divide-border'>{rows.map((r) => renderRow(r, false))}</ul>
  }

  return (
    <div className='pb-1'>
      {groups.map((g) => {
        const bulkable = g.rows.some((r) => r.actions.some((a) => BULKABLE.includes(a.kind)))
        const inGroup = g.rows.filter((r) => selected.has(r.key))
        const all = inGroup.length === g.rows.length
        // Actions every selected row offers — the only ones safe to bulk.
        const shared =
          inGroup.length === 0
            ? []
            : inGroup[0].actions.filter(
                (a) =>
                  BULKABLE.includes(a.kind) &&
                  // A retry's id is the row's own submission; only an
                  // extension action must match by id.
                  inGroup.every((r) =>
                    r.actions.some(
                      (b) => b.kind === a.kind && (a.kind !== 'extension' || b.id === a.id)
                    )
                  )
              )
        const sharedKinds = [
          ...new Map(
            shared.map((a) => [a.kind === 'extension' ? actionKey(a) : a.kind, a])
          ).values()
        ]
        return (
          <div key={g.key} data-ic-group={g.key} className='mt-2 first:mt-1'>
            <div className='flex min-h-9 items-center gap-2.5 bg-muted/60 px-4 py-1.5'>
              {bulkable && (
                <input
                  type='checkbox'
                  checked={all}
                  ref={(el) => {
                    if (el) el.indeterminate = inGroup.length > 0 && !all
                  }}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s)
                      for (const r of g.rows) {
                        if (e.target.checked) n.add(r.key)
                        else n.delete(r.key)
                      }
                      return n
                    })
                  }
                  aria-label={`Select every problem in ${g.label}`}
                  data-ic-group-select={g.key}
                  className='h-3.5 w-3.5 accent-[rgb(var(--nvr-cyan-rgb))]'
                />
              )}
              <span className='text-[12.5px] font-semibold text-foreground'>{g.label}</span>
              <span className='text-[12px] tabular-nums text-muted-foreground'>
                {g.rows.length}
              </span>
              <span className='ml-auto flex items-center gap-1'>
                {inGroup.length > 0 &&
                  sharedKinds.map((a) => (
                    <button
                      key={actionKey(a)}
                      type='button'
                      data-ic-bulk-action={a.kind}
                      onClick={() => {
                        // Each row carries its own id for a retry — the server
                        // resolves them per row, so one action shape is enough.
                        void run(a, inGroup)
                      }}
                      className='inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground hover:bg-muted'
                    >
                      {a.label} {inGroup.length}
                    </button>
                  ))}
                <SnoozeMenu
                  signal={signal.id}
                  signalLabel={signal.label}
                  group={{ key: g.key, label: g.label }}
                  defaultScope='group'
                />
              </span>
            </div>
            <ul className='divide-y divide-border'>{g.rows.map((r) => renderRow(r, bulkable))}</ul>
          </div>
        )
      })}
    </div>
  )
}

function recordLabel(rec: NonNullable<RowView['record']>): string {
  if (rec.label) return rec.label
  const word = titleCase(rec.collection).replace(/s$/, '')
  return `${word} ${rec.id}`
}

function SignalRowView({
  signal,
  row,
  result,
  busy,
  selectable,
  selected,
  onSelect,
  onAction,
  onOpenRecord
}: {
  signal: SignalView
  row: RowView
  result?: ActionResult
  busy: boolean
  selectable: boolean
  selected: boolean
  onSelect: (on: boolean) => void
  onAction: (a: SignalAction) => void
  onOpenRecord?: (collection: string, id: string) => void
}) {
  const since = row.since ?? row.first_seen
  // 'open' duplicates the record link — show it as a button only when the
  // row has no record to link.
  const buttons = row.actions.filter((a) => !(a.kind === 'open' && row.record))
  return (
    <li data-ic-row={row.key} className='flex gap-3 px-4 py-2.5'>
      {selectable && (
        <input
          type='checkbox'
          checked={selected}
          onChange={(e) => onSelect(e.target.checked)}
          aria-label={`Select ${row.title}`}
          className='mt-1 h-3.5 w-3.5 shrink-0 accent-[rgb(var(--nvr-cyan-rgb))]'
          disabled={!row.actions.some((a) => BULKABLE.includes(a.kind))}
        />
      )}
      <div className='min-w-0 flex-1'>
        <p className='text-[12.5px] font-medium text-foreground'>{row.title}</p>
        {row.detail && (
          <p
            className='mt-0.5 line-clamp-2 break-words text-[12px] leading-snug text-muted-foreground'
            data-tip={row.detail.length > 140 ? row.detail.slice(0, 900) : undefined}
          >
            {row.detail}
          </p>
        )}
        {/* Under the title on narrower screens; its own column on wide ones. */}
        <RowMeta
          since={since}
          record={row.record}
          onOpenRecord={onOpenRecord}
          className='mt-1 flex-wrap gap-x-2 xl:hidden'
        />
        {result && (
          <p
            role='status'
            data-ic-result={result.ok ? 'ok' : 'failed'}
            className={cn(
              'mt-1 flex items-start gap-1.5 text-[12px] font-medium',
              TONE_TEXT[result.ok ? 'positive' : 'negative']
            )}
          >
            <span
              className={cn(
                'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
                TONE_FILL[result.ok ? 'positive' : 'negative']
              )}
            />
            {result.message}
          </p>
        )}
      </div>
      <RowMeta
        since={since}
        record={row.record}
        onOpenRecord={onOpenRecord}
        className='hidden w-[210px] shrink-0 flex-col items-start gap-0.5 pt-0.5 xl:flex'
        stacked
      />
      <div className='flex shrink-0 items-start gap-1'>
        {buttons.map((a) => (
          <button
            key={actionKey(a)}
            type='button'
            data-ic-action={a.kind}
            disabled={busy}
            onClick={() => onAction(a)}
            className='inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            {busy && a.kind !== 'explain' && <Loader2 className='h-3 w-3 animate-spin' />}
            {a.label}
          </button>
        ))}
        <SnoozeMenu
          signal={signal.id}
          signalLabel={signal.label}
          rowKey={row.key}
          group={row.group ? { key: row.group, label: row.group_label ?? row.group } : undefined}
          compact
        />
      </div>
    </li>
  )
}

function RowMeta({
  since,
  record,
  onOpenRecord,
  className,
  stacked
}: {
  since: string
  record?: RowView['record']
  onOpenRecord?: (collection: string, id: string) => void
  className?: string
  stacked?: boolean
}) {
  return (
    <div className={cn('flex items-center text-[11.5px] text-muted-foreground', className)}>
      <span data-tip={exactTime(since)} className='tabular-nums'>
        Since {agoText(since)}
      </span>
      {record && (
        <>
          {!stacked && <span aria-hidden>·</span>}
          {onOpenRecord ? (
            <button
              type='button'
              data-ic-record={`${record.collection}:${record.id}`}
              onClick={() => onOpenRecord(record.collection, record.id)}
              className='inline-flex max-w-full items-center gap-1 truncate font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground'
            >
              {recordLabel(record)}
              <ExternalLink className='h-3 w-3 shrink-0 opacity-60' aria-hidden />
            </button>
          ) : (
            <span className='font-medium text-foreground'>{recordLabel(record)}</span>
          )}
        </>
      )}
    </div>
  )
}

function SnoozedList({ signal }: { signal: SignalView }) {
  const { remove } = useSnooze()
  return (
    <ul className='divide-y divide-border border-t border-border bg-muted/30'>
      {signal.snoozed.map((r) => {
        const s = r.snooze
        const until = s?.until_change
          ? 'until it changes'
          : s?.until
            ? `until ${new Date(s.until).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
              })}`
            : ''
        return (
          <li key={r.key} data-ic-row={r.key} data-ic-snoozed className='flex gap-3 px-4 py-2'>
            <div className='min-w-0 flex-1'>
              <p className='truncate text-[12.5px] text-foreground'>{r.title}</p>
              <p className='text-[11.5px] text-muted-foreground'>
                Snoozed {until}
                {s?.note ? ` — “${s.note}”` : ''}
              </p>
            </div>
            {s && (
              <button
                type='button'
                data-ic-unsnooze={s.id}
                disabled={remove.isPending && remove.variables === s.id}
                onClick={() => remove.mutate(s.id)}
                className='h-7 shrink-0 rounded-md px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60'
              >
                Unsnooze
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
