import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, FileText, Minus, Pencil, Plus, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { numericIntlOptions } from '../../lib/format-value'
import { LIVE_ASPECTS, useLiveRecordQueries } from '../../lib/live'
import { cn, formatDateTime, toLocalDateString } from '../../lib/utils'
import { RelativeTime } from '../RelativeTime'

/**
 * "What changed since you sent it back" (realtime round 8, item 12).
 *
 * A record that was sent back and has come back to the same step answers, at the top of the
 * record and in the approve strip, what changed in between: fields (old → new), lines (added,
 * changed, removed) and files, each with who and when. The server judges every part as the
 * viewer (GET /pipelines/instance/:c/:i/resubmission, services/resubmission-diff.ts); a record
 * that is not back after a send back answers null and nothing renders.
 *
 * Live: someone changing the record (a field, a line, a file, a move) re-reads it — coalesced,
 * one read per second at most, in place.
 */

export interface ResubFieldChange {
  field: string
  label: string
  old: string
  new: string
  by: string | null
  at: string
  auto?: boolean
  /** Set by servers that send dates / numbers raw so the viewer formats them (rt8 r2). */
  kind?: 'date' | 'datetime' | 'number'
  format?: string | null
  precision?: number | null
}
export interface ResubLineItem {
  id: string
  label: string
  kind: 'added' | 'changed' | 'removed'
  fields: string[]
  by: string | null
  at: string
}
export interface ResubLineGroup {
  collection: string
  field: string
  label: string
  added: number
  changed: number
  removed: number
  items: ResubLineItem[]
}
export interface ResubFileChange {
  field: string
  field_label: string
  kind: 'added' | 'removed' | 'replaced'
  name: string
  old_name?: string | null
  by: string | null
  at: string
}
export interface ResubmissionDiffData {
  sent_back: {
    by: string | null
    by_you: boolean
    at: string
    from_label: string | null
    to_label: string | null
    reason: string | null
  }
  returned: { by: string | null; at: string }
  fields: ResubFieldChange[]
  lines: ResubLineGroup[]
  files: ResubFileChange[]
  total: number
}

export function resubmissionKey(collection: string, item: string | number) {
  return ['resubmission', collection, String(item)] as const
}

/** The heading: "since you sent it back" / "since Beth Lee sent it back". Exported for tests. */
export function resubmissionTitle(d: Pick<ResubmissionDiffData, 'sent_back'>): string {
  if (d.sent_back.by_you) return 'What changed since you sent it back'
  return d.sent_back.by
    ? `What changed since ${d.sent_back.by} sent it back`
    : 'What changed since it was sent back'
}

/** "3 fields · 2 lines · 1 file" — what the strip folds to. Exported for tests. */
export function resubmissionSummary(d: Pick<ResubmissionDiffData, 'fields' | 'lines' | 'files'>) {
  const parts: string[] = []
  const n = d.fields.length
  if (n > 0) parts.push(`${n} field${n === 1 ? '' : 's'}`)
  const lines = d.lines.reduce((s, g) => s + g.added + g.changed + g.removed, 0)
  if (lines > 0) parts.push(`${lines} line${lines === 1 ? '' : 's'}`)
  const f = d.files.length
  if (f > 0) parts.push(`${f} file${f === 1 ? '' : 's'}`)
  return parts.length > 0 ? `${parts.join(' · ')} changed` : 'Nothing changed'
}

/** One line group's count sentence: "1 added, 2 changed". Exported for tests. */
export function lineGroupCounts(g: Pick<ResubLineGroup, 'added' | 'changed' | 'removed'>) {
  return [
    g.added ? `${g.added} added` : '',
    g.changed ? `${g.changed} changed` : '',
    g.removed ? `${g.removed} removed` : ''
  ]
    .filter(Boolean)
    .join(', ')
}

export function useResubmissionDiff(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  enabled = true
) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const id = item == null || item === 'new' ? null : String(item)
  const on = enabled && !!collection && !!id
  const query = useQuery({
    queryKey: resubmissionKey(collection ?? '', id ?? ''),
    queryFn: () =>
      client
        .request<{ data: ResubmissionDiffData | null }>(
          get(`/pipelines/instance/${collection}/${encodeURIComponent(id ?? '')}/resubmission`)
        )
        // Only a real answer (an older server, or a stand-in client, may answer something else).
        .then((r) => (r?.data?.sent_back ? r.data : null)),
    enabled: on,
    staleTime: 30_000,
    retry: false
  })
  // While the record is back after a send back, any change to it can change the answer; one
  // re-read per second at most. Otherwise only a move can make it one.
  const key = [...resubmissionKey(collection ?? '', id ?? '')]
  const back = query.data != null
  useLiveRecordQueries(collection, id, [key], {
    enabled: on && back,
    debounceMs: 1000,
    includeOwn: true,
    client: qc
  })
  useLiveRecordQueries(collection, id, [key], {
    enabled: on && !back,
    debounceMs: 1000,
    includeOwn: true,
    client: qc,
    aspects: [LIVE_ASPECTS.state]
  })
  return query
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?Z)?$/

/** One old/new value as the form would show it: a date as "Nov 23, 2026" (never the stored
 *  "2026-11-23T00:00:00.000Z"), a date-time in the viewer's zone, a number with the field's
 *  currency and precision. Values the server already worded (labels, "(empty)") pass through.
 *  Exported for tests. */
export function resubValueText(
  value: string,
  f: Pick<ResubFieldChange, 'kind' | 'format' | 'precision'>
): string {
  if (!value || value === '(empty)') return value
  if (f.kind === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return value
    return new Intl.NumberFormat(
      'en-US',
      numericIntlOptions(
        f.precision != null ? { precision: f.precision } : undefined,
        f.format ?? undefined
      )
    ).format(n)
  }
  // Dates are recognised by shape too: an older server sends them as stored text.
  if (f.kind === 'date' || DATE_ONLY_RE.test(value)) return toLocalDateString(value) || value
  if (f.kind === 'datetime' || ISO_RE.test(value)) return formatDateTime(value) || value
  return value
}

const MUTED = 'text-slate-500 dark:text-slate-400'
const STRONG = 'font-medium text-slate-700 dark:text-slate-200'

/** Who and when sit right after their change (a far-right column left a ~600 px gap on a
 *  wide record, so the eye lost which row a name belonged to). */
function Who({ by, at }: { by: string | null; at: string }) {
  return (
    <span className={cn('block whitespace-nowrap text-[11px] sm:shrink-0 sm:text-[11.5px]', MUTED)}>
      {by ? `${by} · ` : ''}
      <RelativeTime value={at} />
    </span>
  )
}

function KindIcon({ kind }: { kind: 'added' | 'changed' | 'removed' | 'replaced' }) {
  const cls = 'mt-[3px] h-3 w-3 shrink-0'
  if (kind === 'added')
    return <Plus aria-hidden className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />
  if (kind === 'removed')
    return <Minus aria-hidden className={cn(cls, 'text-red-600 dark:text-red-400')} />
  return <Pencil aria-hidden className={cn(cls, 'text-slate-400 dark:text-slate-500')} />
}

interface Row {
  key: string
  node: React.ReactNode
}

/** Every change as one row, fields first, then lines, then files. */
function rowsOf(d: ResubmissionDiffData): Row[] {
  const rows: Row[] = []
  for (const f of d.fields) {
    rows.push({
      key: `f:${f.field}`,
      node: (
        <div className='flex items-start gap-2' data-resub-field={f.field}>
          <KindIcon kind='changed' />
          <div className='min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3'>
            <p className='min-w-0 break-words'>
              <span className={STRONG}>{f.label}</span>
              {f.auto ? <span className={MUTED}> (updated automatically)</span> : null}
              <span className={MUTED}>: </span>
              {f.old !== '' && (
                <>
                  <span className='text-red-600 line-through decoration-red-300 dark:text-red-400 dark:decoration-red-500/50'>
                    {resubValueText(f.old, f)}
                  </span>
                  <span aria-hidden='true' className={MUTED}>
                    {' '}
                    →{' '}
                  </span>
                  <span className='sr-only'> changed to </span>
                </>
              )}
              <span className='text-emerald-700 dark:text-emerald-400'>
                {resubValueText(f.new, f)}
              </span>
            </p>
            <Who by={f.by} at={f.at} />
          </div>
        </div>
      )
    })
  }
  for (const g of d.lines) {
    for (const it of g.items) {
      rows.push({
        key: `l:${g.collection}:${it.kind}:${it.id || it.label}:${it.at}`,
        node: (
          <div className='flex items-start gap-2' data-resub-line={it.kind}>
            <KindIcon kind={it.kind} />
            <div className='min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3'>
              <p className='min-w-0 break-words'>
                <span className={MUTED}>{g.label}: </span>
                <span className={STRONG}>{it.label}</span>
                <span className={MUTED}>
                  {it.kind === 'added'
                    ? ' added'
                    : it.kind === 'removed'
                      ? ' removed'
                      : it.fields.length > 0
                        ? ` — ${it.fields.join(', ')} changed`
                        : ' changed'}
                </span>
              </p>
              <Who by={it.by} at={it.at} />
            </div>
          </div>
        )
      })
    }
    const listed = g.items.length
    const all = g.added + g.changed + g.removed
    if (all > listed)
      rows.push({
        key: `l:${g.collection}:more`,
        node: (
          <p className={cn('pl-5', MUTED)}>
            {g.label}: {all - listed} more ({lineGroupCounts(g)} in all)
          </p>
        )
      })
  }
  for (const f of d.files) {
    rows.push({
      key: `file:${f.field}:${f.kind}:${f.name}:${f.at}`,
      node: (
        <div className='flex items-start gap-2' data-resub-file={f.kind}>
          {f.kind === 'replaced' ? (
            <FileText aria-hidden className='mt-[3px] h-3 w-3 shrink-0 text-slate-400' />
          ) : (
            <KindIcon kind={f.kind} />
          )}
          <div className='min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3'>
            <p className='min-w-0 break-words'>
              <span className={MUTED}>{f.field_label}: </span>
              {f.kind === 'replaced' ? (
                <>
                  <span className={STRONG}>{f.name}</span>
                  <span className={MUTED}> replaced </span>
                  <span className='text-slate-500 line-through dark:text-slate-400'>
                    {f.old_name ?? 'a file'}
                  </span>
                </>
              ) : (
                <>
                  <span className={STRONG}>{f.name}</span>
                  <span className={MUTED}>{f.kind === 'added' ? ' added' : ' removed'}</span>
                </>
              )}
            </p>
            <Who by={f.by} at={f.at} />
          </div>
        </div>
      )
    })
  }
  return rows
}

/** The changes themselves; `limit` rows, then a "Show N more" toggle. */
export function ResubmissionChanges({
  data,
  limit = 4
}: {
  data: ResubmissionDiffData
  limit?: number
}) {
  const [all, setAll] = useState(false)
  const rows = rowsOf(data)
  if (rows.length === 0)
    return (
      <p className={cn('text-[12px]', MUTED)} data-resub-empty>
        Nothing on the record changed since it was sent back.
      </p>
    )
  const shown = all ? rows : rows.slice(0, limit)
  return (
    <div className='max-w-[880px] space-y-1.5 text-[12px] leading-snug'>
      {shown.map((r) => (
        <div key={r.key}>{r.node}</div>
      ))}
      {rows.length > limit && (
        <button
          type='button'
          onClick={() => setAll((v) => !v)}
          className='pl-5 text-[11.5px] font-medium text-nvr-cyan hover:underline'
        >
          {all ? 'Show fewer' : `Show ${rows.length - limit} more`}
        </button>
      )}
    </div>
  )
}

/** "You sent it back 6h ago · Sam Rivera resubmitted 1h ago" — who did each half, once
 *  (it read "Sent back 6h ago to Started · back from Sam Rivera 6h ago"). */
function SentBackLine({ data }: { data: ResubmissionDiffData }) {
  const s = data.sent_back
  const sender = s.by_you ? 'You' : s.by || 'Someone'
  return (
    <p className={cn('text-[11.5px]', MUTED)}>
      {sender} sent it back <RelativeTime value={s.at} />
      {' · '}
      {data.returned.by ? `${data.returned.by} resubmitted ` : 'Resubmitted '}
      <RelativeTime value={data.returned.at} />
    </p>
  )
}

/**
 * Top of the record: one quiet card while the record is back after a send back. It opens
 * folded to its summary when nothing needs reading ("Nothing changed"), open otherwise; the
 * header folds it either way.
 */
export function ResubmissionStrip({
  collection,
  itemId
}: {
  collection: string
  itemId: string | number
}) {
  const { data } = useResubmissionDiff(collection, itemId)
  const [open, setOpen] = useState<boolean | null>(null)
  if (!data) return null
  const expanded = open ?? data.total > 0
  return (
    <section
      className='nvr-expand-in rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-resubmission-strip
      aria-label={resubmissionTitle(data)}
    >
      <button
        type='button'
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className='flex w-full items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-left hover:bg-slate-50/70 dark:hover:bg-white/[0.02]'
      >
        <Undo2
          aria-hidden
          className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400'
        />
        <span className='min-w-0 flex-1'>
          <span className='block text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
            {resubmissionTitle(data)}
            <span className='font-normal text-slate-500 dark:text-slate-400'>
              {' · '}
              {resubmissionSummary(data)}
            </span>
          </span>
          <SentBackLine data={data} />
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200',
            !expanded && '-rotate-90'
          )}
        />
      </button>
      {expanded && (
        <div className='border-t border-slate-100 px-3.5 pt-2 pb-2.5 dark:border-border/60'>
          {data.sent_back.reason && (
            <p
              className='mb-2 whitespace-pre-line break-words text-[12px] text-slate-600 dark:text-slate-300'
              data-resub-reason
            >
              <span className={MUTED}>{data.sent_back.by_you ? 'You asked' : 'Asked'}: </span>“
              {data.sent_back.reason}”
            </p>
          )}
          <ResubmissionChanges data={data} limit={6} />
        </div>
      )}
    </section>
  )
}

/** The approve dialog's part: compact, under the brief's own heading. */
export function ResubmissionBrief({
  collection,
  item
}: {
  collection: string
  item: string | number
}) {
  const { data } = useResubmissionDiff(collection, item)
  if (!data) return null
  return (
    <div
      className='rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
      data-resubmission-brief
    >
      <p className='mb-1 text-[11.5px]'>
        <span className='font-medium text-slate-700 dark:text-foreground'>
          {resubmissionTitle(data)}
        </span>{' '}
        <span className={MUTED}>
          (<RelativeTime value={data.sent_back.at} />)
        </span>
      </p>
      <ResubmissionChanges data={data} limit={5} />
    </div>
  )
}
