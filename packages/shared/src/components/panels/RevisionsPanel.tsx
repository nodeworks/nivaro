import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  GitCompareArrows,
  MessageSquare,
  RotateCcw,
  Search,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatRelative, titleCase } from '../../lib/utils'
import { RelatedItemLabel } from '../item-edit/RelationCombobox'
import { UserAvatar } from '../UserAvatar'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'

export interface O2MFieldInfo {
  field: string
  label: string
  relatedCollection: string
  manyField: string
  parentId: string
}

interface Revision {
  id: string
  collection: string
  item: string
  action: string | null
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
  timestamp: string | null
  user_id: string | null
  user_email: string | null
  first_name: string | null
  last_name: string | null
}

// ─── Field metadata: friendly labels + system-field classification ──────────
// The panel fetches the collection's field config ONCE and every view renders
// human labels ("Requisition Amount") with the raw code available on hover.
// Fields the config doesn't know (machine columns from integrations, audit
// stamps) are "system" — folded away by default so a 23-field save reads as
// the 5 fields a person actually changed.

interface FieldMeta {
  label: string
  system: boolean
  /** On the collection's active layout — i.e. visible on the form a person
   *  edits. False = written behind the scenes (rules, computed, integrations). */
  onLayout: boolean
  /** M2O target — FK values render as the related record's display label. */
  relatedCollection?: string | null
}

const AUDIT_FIELDS = new Set([
  'id',
  'created',
  'changed',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'created_at',
  'updated_at',
  'sort'
])

type FieldMetaMap = Map<string, FieldMeta>

function useFieldMeta(collection: string, enabled: boolean): FieldMetaMap {
  const client = useNivaroClient()
  const { data } = useQuery<{
    fields: Array<{
      field: string
      label: string | null
      hidden?: boolean
      layout_assigned?: boolean
    }>
    relations: Array<{
      many_collection: string | null
      many_field: string | null
      one_collection: string | null
      junction_field: string | null
    }>
  }>({
    queryKey: ['revisions-field-meta', collection],
    enabled,
    staleTime: 300_000,
    queryFn: async () => {
      const [fields, col] = await Promise.all([
        client
          .request<{
            data: Array<{
              field: string
              label: string | null
              hidden?: boolean
              layout_assigned?: boolean
            }>
          }>(get(`/field-config/${collection}`))
          .then((r) => r.data ?? [])
          .catch(() => []),
        client
          .request<{ data: { relations?: Array<Record<string, unknown>> } }>(
            get(`/collections/${collection}`)
          )
          .then((r) => (r.data?.relations ?? []) as never[])
          .catch(() => [])
      ])
      return { fields, relations: col }
    }
  })
  return useMemo(() => {
    const map: FieldMetaMap = new Map()
    const m2oTarget = (field: string): string | null => {
      const rel = (data?.relations ?? []).find(
        (r) =>
          r.many_collection === collection && r.many_field === field && r.junction_field == null
      )
      if (!rel?.one_collection) return null
      // Legacy relations still point FK columns at directus_users — same uuid
      // space, resolved through the live users collection.
      return rel.one_collection === 'directus_users' ? 'nivaro_users' : rel.one_collection
    }
    for (const f of data?.fields ?? []) {
      if (f.field.startsWith('__')) continue
      map.set(f.field, {
        label: f.label || titleCase(f.field.replace(/_/g, ' ')),
        system: AUDIT_FIELDS.has(f.field),
        // layout_assigned is only stamped when the collection HAS an active
        // layout — absent means there's no layout to be off of.
        onLayout: f.layout_assigned !== false,
        relatedCollection: m2oTarget(f.field)
      })
    }
    return map
  }, [data, collection])
}

function metaFor(map: FieldMetaMap, field: string): FieldMeta {
  return (
    map.get(field) ?? {
      // Unknown to the form = machine column. Still labeled, still reachable.
      label: titleCase(field.replace(/[_-]/g, ' ')),
      system: true,
      onLayout: false
    }
  )
}

function FieldLabel({ map, field }: { map: FieldMetaMap; field: string }) {
  const meta = metaFor(map, field)
  return (
    <span
      className='text-[12px] font-medium text-slate-700 dark:text-slate-200'
      data-tip={field}
      title={field}
    >
      {meta.label}
    </span>
  )
}

// ─── Value formatting ───────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' && ISO_RE.test(value)) {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString()
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** FK value → the related record's display-template label (raw id on hover). */
function RelationValue({ collection, id }: { collection: string; id: unknown }) {
  const client = useNivaroClient()
  const { data: colMeta } = useQuery({
    queryKey: ['col-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${collection}`))
        .then((r) => r.data),
    staleTime: 300_000,
    retry: false
  })
  return (
    <span title={`${collection} #${String(id)}`}>
      <RelatedItemLabel
        collection={collection}
        id={id}
        displayTemplate={colMeta?.display_template}
      />
    </span>
  )
}

/** Plain readable text for a rich-text value — never raw HTML markup. */
function richTextToText(v: unknown): string {
  return stripToWords(v).join(' ')
}

const TRUNCATE_AT = 160

function ValueCell({ value, tone }: { value: unknown; tone: 'before' | 'after' }) {
  const [expanded, setExpanded] = useState(false)
  const str = displayValue(value)
  if (str === '')
    return <span className='text-[11.5px] italic text-slate-300 dark:text-slate-600'>empty</span>
  const isLong = str.length > TRUNCATE_AT
  const shown = expanded || !isLong ? str : `${str.slice(0, TRUNCATE_AT)}…`
  return (
    <span className='break-words text-[12px] leading-relaxed text-slate-700 dark:text-slate-300'>
      {typeof value === 'object' ? <span className='font-mono text-[11px]'>{shown}</span> : shown}
      {isLong && (
        <button
          type='button'
          onClick={() => setExpanded((e) => !e)}
          className={cn(
            'ml-1 text-[10.5px] font-medium hover:underline',
            tone === 'before' ? 'text-rose-500' : 'text-emerald-600'
          )}
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </span>
  )
}

// ─── Structured JSON diffs (#73) ────────────────────────────────────────────
function parseJsonObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(v)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return null
}

function JsonKeyDiff({
  before,
  after
}: {
  before: Record<string, unknown>
  after: Record<string, unknown>
}) {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()
  const rows = keys
    .map((k) => {
      const b = k in before ? JSON.stringify(before[k]) : undefined
      const a = k in after ? JSON.stringify(after[k]) : undefined
      if (b === a) return null
      return { k, b, a }
    })
    .filter(Boolean) as Array<{ k: string; b?: string; a?: string }>
  if (rows.length === 0)
    return <span className='text-[11px] italic text-slate-400'>keys reordered only</span>
  const clip = (x?: string) => (x == null ? undefined : x.length > 80 ? `${x.slice(0, 80)}…` : x)
  return (
    <div className='space-y-0.5' data-json-diff>
      {rows.map(({ k, b, a }) => (
        <p key={k} className='text-[11.5px]'>
          <span className='font-mono text-[10.5px] text-slate-500'>{k}</span>:{' '}
          {b !== undefined && (
            <span className='text-rose-600 line-through dark:text-rose-400'>{clip(b)}</span>
          )}
          {b !== undefined && a !== undefined && ' → '}
          {a !== undefined ? (
            <span className='text-emerald-700 dark:text-emerald-400'>{clip(a)}</span>
          ) : (
            <span className='italic text-slate-400'> (removed)</span>
          )}
        </p>
      ))}
    </div>
  )
}

// ─── Single-field revert (#667) ─────────────────────────────────────────────
type FieldRevertCtl = {
  confirmField: string | null
  setConfirmField: (f: string | null) => void
  revert: (f: string) => void
  pending: boolean
}

function RevertFieldButton({ field, ctl }: { field: string; ctl: FieldRevertCtl }) {
  if (ctl.confirmField === field) {
    return (
      <span className='inline-flex items-center gap-1' data-revert-field-confirm={field}>
        <span className='text-[10.5px] text-slate-500'>Revert?</span>
        <button
          type='button'
          disabled={ctl.pending}
          onClick={() => ctl.revert(field)}
          className='rounded bg-nvr-cyan px-1.5 py-px text-[10.5px] font-semibold text-white disabled:opacity-50'
        >
          Yes
        </button>
        <button
          type='button'
          onClick={() => ctl.setConfirmField(null)}
          className='rounded border border-slate-200 px-1.5 py-px text-[10.5px] text-slate-500 dark:border-border'
        >
          Cancel
        </button>
      </span>
    )
  }
  return (
    <button
      type='button'
      onClick={() => ctl.setConfirmField(field)}
      className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-slate-400 opacity-0 transition-opacity hover:bg-nvr-cyan/10 hover:text-nvr-navy group-hover/frow:opacity-100 dark:hover:text-nvr-cyan'
      title='Set the field back to this revision’s value'
      data-revert-field={field}
    >
      <RotateCcw className='h-3 w-3' />
      Revert
    </button>
  )
}

// ─── Rich-text word diff (#45) ──────────────────────────────────────────────
function isRichText(v: unknown): boolean {
  return typeof v === 'string' && /<[a-z][^>]*>/i.test(v)
}

function stripToWords(v: unknown): string[] {
  return String(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split(/\s+/)
    .filter(Boolean)
}

type DiffSeg = { text: string; type: 'same' | 'del' | 'ins' }

/** Word-level LCS diff, capped — past the cap the tail is compared blockwise
 *  rather than blowing up the DP table. */
function diffWords(aRaw: unknown, bRaw: unknown): DiffSeg[] {
  const CAP = 600
  const a = stripToWords(aRaw).slice(0, CAP)
  const b = stripToWords(bRaw).slice(0, CAP)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const segs: DiffSeg[] = []
  const pushSeg = (type: DiffSeg['type'], word: string) => {
    const last = segs[segs.length - 1]
    if (last && last.type === type) last.text += ` ${word}`
    else segs.push({ text: word, type })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pushSeg('same', a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSeg('del', a[i])
      i++
    } else {
      pushSeg('ins', b[j])
      j++
    }
  }
  while (i < n) pushSeg('del', a[i++])
  while (j < m) pushSeg('ins', b[j++])
  return segs
}

function WordDiff({ before, after }: { before: unknown; after: unknown }) {
  const segs = diffWords(before, after)
  return (
    <p className='whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-700 dark:text-slate-300'>
      {segs.map((seg, i) =>
        seg.type === 'same' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static segment list
          <span key={i}>{seg.text} </span>
        ) : seg.type === 'del' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static segment list
          <del
            key={i}
            className='rounded bg-red-100 px-0.5 text-red-700 no-underline line-through dark:bg-red-900/40 dark:text-red-400'
          >
            {seg.text}{' '}
          </del>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static segment list
          <ins
            key={i}
            className='rounded bg-emerald-100 px-0.5 text-emerald-700 no-underline dark:bg-emerald-900/40 dark:text-emerald-400'
          >
            {seg.text}{' '}
          </ins>
        )
      )}
    </p>
  )
}

// ─── Field-change rows: the ONE renderer both views share ───────────────────
// "Changes" = only what moved, old → new. "All fields" (before/after) = the
// full snapshot pair. Both render the same row anatomy so nothing has to be
// re-learned when the toggle flips.

type FieldStatus = 'added' | 'removed' | 'changed' | 'unchanged'

const STATUS_CHIP: Record<Exclude<FieldStatus, 'unchanged'>, string> = {
  added: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  removed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  changed: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
}

interface FieldRowData {
  field: string
  status: FieldStatus
  before: unknown
  after: unknown
  system: boolean
}

function computeFieldRows(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  meta: FieldMetaMap
): FieldRowData[] {
  const fields = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
  const isEmpty = (v: unknown) => v === null || v === undefined || v === ''
  const rows = fields
    .map((field) => {
      const bEmpty = !(field in before) || isEmpty(before[field])
      const aEmpty = !(field in after) || isEmpty(after[field])
      // Empty before AND empty after says nothing — never show it.
      if (bEmpty && aEmpty) return null
      const status: FieldStatus = bEmpty
        ? 'added'
        : aEmpty
          ? 'removed'
          : stringifyValue(before[field]) !== stringifyValue(after[field])
            ? 'changed'
            : 'unchanged'
      return {
        field,
        status,
        before: before[field],
        after: after[field],
        system: metaFor(meta, field).system
      }
    })
    .filter(Boolean) as FieldRowData[]
  // Layout fields first, behind-the-scenes fields next, system fields last —
  // unchanged rows sink within each band. Alpha by label inside a band.
  const rank = (r: FieldRowData) => {
    const m = metaFor(meta, r.field)
    const band = m.system ? 8 : m.onLayout ? 0 : 4
    return band + (r.status === 'unchanged' ? 2 : 0)
  }
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) || metaFor(meta, a.field).label.localeCompare(metaFor(meta, b.field).label)
  )
}

/** One value, rendered friendly: FK -> related label, rich text -> plain
 *  words, dates/booleans formatted. */
function RevValue({
  value,
  meta,
  tone
}: {
  value: unknown
  meta: FieldMeta
  tone: 'before' | 'after'
}) {
  if (value === null || value === undefined || value === '')
    return <span className='text-[11.5px] italic text-slate-300 dark:text-slate-600'>empty</span>
  if (meta.relatedCollection && (typeof value === 'string' || typeof value === 'number'))
    return (
      <span className='break-words text-[12px] leading-relaxed text-slate-700 dark:text-slate-300'>
        <RelationValue collection={meta.relatedCollection} id={value} />
      </span>
    )
  if (isRichText(value)) return <ValueCell value={richTextToText(value)} tone={tone} />
  return <ValueCell value={value} tone={tone} />
}

function FieldChangeRow({
  row,
  meta,
  fieldRevert,
  mode,
  hideStatusChips
}: {
  row: FieldRowData
  meta: FieldMetaMap
  fieldRevert?: FieldRevertCtl
  mode: 'changes' | 'all'
  /** On a CREATE revision every field is 'set' — the chips say nothing. */
  hideStatusChips?: boolean
}) {
  const richPair = row.status === 'changed' && (isRichText(row.before) || isRichText(row.after))
  const jsonPair =
    row.status === 'changed' && parseJsonObject(row.before) && parseJsonObject(row.after)
  return (
    <div
      className={cn(
        'group/frow border-b border-slate-100 px-3 py-2 last:border-0 dark:border-border/60',
        row.system && 'bg-slate-50/60 dark:bg-muted/20'
      )}
      data-field-row={row.field}
    >
      <div className='flex items-center gap-2'>
        <FieldLabel map={meta} field={row.field} />
        {row.status !== 'unchanged' && !hideStatusChips && (
          <span
            className={cn(
              'rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide',
              STATUS_CHIP[row.status]
            )}
          >
            {row.status === 'added' ? 'set' : row.status}
          </span>
        )}
        {(row.status === 'changed' || (mode === 'changes' && row.status === 'added')) &&
          fieldRevert &&
          row.field !== 'id' && (
            <span className='ml-auto shrink-0'>
              <RevertFieldButton field={row.field} ctl={fieldRevert} />
            </span>
          )}
      </div>
      <div className='mt-1'>
        {richPair ? (
          <div data-richtext-diff>
            <WordDiff before={row.before} after={row.after} />
          </div>
        ) : jsonPair ? (
          <JsonKeyDiff
            before={parseJsonObject(row.before) as Record<string, unknown>}
            after={parseJsonObject(row.after) as Record<string, unknown>}
          />
        ) : row.status === 'changed' || row.status === 'removed' ? (
          <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
            <span className='max-w-full break-words text-[12px] text-rose-600 line-through decoration-rose-300 dark:text-rose-400'>
              <RevValue value={row.before} meta={metaFor(meta, row.field)} tone='before' />
            </span>
            <ArrowRight className='h-3 w-3 shrink-0 self-center text-slate-300 dark:text-slate-600' />
            <RevValue value={row.after} meta={metaFor(meta, row.field)} tone='after' />
          </div>
        ) : (
          <RevValue value={row.after ?? row.before} meta={metaFor(meta, row.field)} tone='after' />
        )}
      </div>
    </div>
  )
}

function FieldChangeList({
  before,
  after,
  meta,
  fieldRevert,
  mode,
  hideStatusChips
}: {
  before: Record<string, unknown>
  after: Record<string, unknown>
  meta: FieldMetaMap
  fieldRevert?: FieldRevertCtl
  mode: 'changes' | 'all'
  hideStatusChips?: boolean
}) {
  const [showSystem, setShowSystem] = useState(false)
  const allRows = useMemo(() => computeFieldRows(before, after, meta), [before, after, meta])
  const scoped = mode === 'changes' ? allRows.filter((r) => r.status !== 'unchanged') : allRows
  const visible = showSystem ? scoped : scoped.filter((r) => !r.system)
  const hiddenSystem = scoped.length - visible.length
  if (scoped.length === 0)
    return (
      <p className='px-3 py-3 text-[12px] text-slate-400'>
        {mode === 'changes' ? 'No field changes recorded.' : 'No snapshot data available.'}
      </p>
    )
  const firstBehindIdx = visible.findIndex(
    (r) => !metaFor(meta, r.field).onLayout && !metaFor(meta, r.field).system
  )
  const hasLayoutRows = visible.some(
    (r) => metaFor(meta, r.field).onLayout && !metaFor(meta, r.field).system
  )
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      {visible.map((row, idx) => (
        <div key={row.field}>
          {idx === firstBehindIdx && hasLayoutRows && (
            <div className='border-b border-t border-slate-100 bg-slate-50/70 px-3 py-1.5 dark:border-border/60 dark:bg-muted/30'>
              <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                Behind the scenes
              </p>
              <p className='text-[10.5px] text-slate-400'>
                Not on the form — written automatically by rules, computed fields or integrations.
              </p>
            </div>
          )}
          <FieldChangeRow
            row={row}
            meta={meta}
            fieldRevert={fieldRevert}
            mode={mode}
            hideStatusChips={hideStatusChips}
          />
        </div>
      ))}
      {hiddenSystem > 0 && (
        <button
          type='button'
          onClick={() => setShowSystem(true)}
          className='w-full border-t border-slate-100 px-3 py-2 text-left text-[11.5px] text-slate-400 hover:text-slate-600 dark:border-border/60 dark:hover:text-slate-300'
          data-show-system
        >
          Show {hiddenSystem} system field{hiddenSystem === 1 ? '' : 's'} (ids, timestamps, machine
          columns)
        </button>
      )}
      {hiddenSystem === 0 && showSystem && scoped.some((r) => r.system) && (
        <button
          type='button'
          onClick={() => setShowSystem(false)}
          className='w-full border-t border-slate-100 px-3 py-2 text-left text-[11.5px] text-slate-400 hover:text-slate-600 dark:border-border/60'
        >
          Hide system fields
        </button>
      )}
    </div>
  )
}

// ─── Revision row ───────────────────────────────────────────────────────────

const ACTION_DOT: Record<string, string> = {
  create: 'bg-emerald-500',
  update: 'bg-nvr-cyan',
  delete: 'bg-red-500'
}

function revisionUserName(rev: Revision): string {
  if (rev.first_name || rev.last_name)
    return [rev.first_name, rev.last_name].filter(Boolean).join(' ')
  return rev.user_email ?? rev.user_id?.slice(0, 8) ?? 'System'
}

function revisionSentence(rev: Revision, humanCount: number, systemCount: number): string {
  if (rev.action === 'create') return 'created this record'
  if (rev.action === 'delete') return 'deleted this record'
  if (humanCount > 0) return `changed ${humanCount} field${humanCount === 1 ? '' : 's'}`
  if (systemCount > 0) return 'updated system fields'
  return 'saved this record'
}

function RevisionRow({
  revision,
  previousData,
  meta,
  onRollback,
  inlineTableFields,
  isLast
}: {
  revision: Revision
  previousData: Record<string, unknown> | null
  meta: FieldMetaMap
  onRollback?: () => void
  inlineTableFields?: O2MFieldInfo[]
  isLast: boolean
}) {
  const client = useNivaroClient()
  const [expanded, setExpanded] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [view, setView] = useState<'changes' | 'all'>('changes')
  const [showNotes, setShowNotes] = useState(false)
  const [o2mRestoring, setO2MRestoring] = useState<string | null>(null)
  const isUpdate = revision.action === 'update'
  const isCreate = revision.action === 'create'
  const isDelete = revision.action === 'delete'
  const sideBefore: Record<string, unknown> = isDelete
    ? (revision.data ?? {})
    : isCreate
      ? {}
      : (previousData ?? {})
  const sideAfter: Record<string, unknown> = isDelete ? {} : (revision.data ?? {})
  // Count ACTUAL value differences vs the previous snapshot — delta keys
  // overcount badly (integrations re-send every field on each save).
  const { humanDelta, systemDelta } = useMemo(() => {
    const src = revision.delta ?? {}
    let human = 0
    let system = 0
    for (const f of Object.keys(src)) {
      const prev = previousData?.[f]
      const next = (revision.data ?? {})[f]
      if (isUpdate && previousData && stringifyValue(prev) === stringifyValue(next)) continue
      if (metaFor(meta, f).system) system++
      else human++
    }
    return { humanDelta: human, systemDelta: system }
  }, [revision, previousData, meta, isUpdate])
  const canRollback = isUpdate || isCreate
  const [rolledBackAt, setRolledBackAt] = useState<string | null>(null)

  const qc = useQueryClient()
  const [confirmRevertField, setConfirmRevertField] = useState<string | null>(null)
  const revertFieldMut = useMutation({
    mutationFn: (field: string) =>
      client.request(post(`/revisions/${revision.id}/revert-field`, { field })),
    onSuccess: (_r, field) => {
      setConfirmRevertField(null)
      toast.success(`Reverted ${metaFor(meta, field).label} to this revision's value`)
      void qc.invalidateQueries({ queryKey: ['revisions', revision.collection, revision.item] })
      onRollback?.()
    },
    onError: () => toast.error('Failed to revert field')
  })
  const fieldRevert: FieldRevertCtl | undefined =
    isUpdate || isCreate
      ? {
          confirmField: confirmRevertField,
          setConfirmField: setConfirmRevertField,
          revert: (f) => revertFieldMut.mutate(f),
          pending: revertFieldMut.isPending
        }
      : undefined

  const rollbackMut = useMutation({
    mutationFn: () => client.request(post(`/revisions/${revision.id}/rollback`, {})),
    onSuccess: () => {
      setConfirmRollback(false)
      toast.success('Rolled back to this revision')
      if (inlineTableFields?.length && revision.timestamp) setRolledBackAt(revision.timestamp)
      onRollback?.()
    },
    onError: () => toast.error('Failed to rollback')
  })

  async function restoreO2MField(f: O2MFieldInfo) {
    if (!rolledBackAt) return
    setO2MRestoring(f.field)
    try {
      await client.request(
        post('/revisions/o2m-restore', {
          collection: f.relatedCollection,
          many_field: f.manyField,
          parent_id: f.parentId,
          target_timestamp: rolledBackAt
        })
      )
      toast.success(`Restored ${f.label}`)
    } catch {
      toast.error(`Failed to restore ${f.label}`)
    } finally {
      setO2MRestoring(null)
    }
  }

  const exactTime = revision.timestamp
    ? new Date(revision.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '—'

  return (
    <div className='relative pl-9' data-revision-row={revision.id}>
      {/* Timeline rail: dot per revision, line to the next one down. */}
      <span
        className={cn(
          'absolute left-[11px] top-[18px] h-2.5 w-2.5 rounded-full ring-4 ring-white dark:ring-card',
          ACTION_DOT[revision.action ?? ''] ?? 'bg-slate-300'
        )}
        aria-hidden
      />
      {!isLast && (
        <span
          className='absolute bottom-0 left-[15.5px] top-[30px] w-px bg-slate-200 dark:bg-border'
          aria-hidden
        />
      )}

      <button
        type='button'
        onClick={() => setExpanded((e) => !e)}
        className='flex w-full items-center gap-2.5 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/40'
      >
        <UserAvatar
          userId={revision.user_id}
          className='h-6 w-6'
          fallback={
            <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/10 text-[10px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
              {revisionUserName(revision)
                .split(' ')
                .map((p) => p[0])
                .filter(Boolean)
                .slice(0, 2)
                .join('')
                .toUpperCase()}
            </span>
          }
        />
        <span className='min-w-0 flex-1 truncate text-[12.5px] text-slate-700 dark:text-slate-200'>
          <span className='font-medium'>{revisionUserName(revision)}</span>{' '}
          <span className='text-slate-500 dark:text-slate-400'>
            {revisionSentence(revision, humanDelta, systemDelta)}
          </span>
        </span>
        <span
          className='shrink-0 text-[11px] tabular-nums text-slate-400'
          title={revision.timestamp ? new Date(revision.timestamp).toLocaleString() : undefined}
        >
          {exactTime}
        </span>
        {expanded ? (
          <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        )}
      </button>

      {expanded && (
        <div className='space-y-2.5 px-2 pb-4 pt-1'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div className='flex items-center overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              {(
                [
                  ['changes', 'What changed'],
                  ['all', 'Full record']
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type='button'
                  onClick={() => setView(v)}
                  className={cn(
                    'px-2.5 py-1 text-[11.5px] transition-colors',
                    view === v
                      ? 'bg-nvr-cyan/10 font-medium text-nvr-navy dark:text-nvr-cyan'
                      : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className='flex items-center gap-1.5'>
              <button
                type='button'
                onClick={() => setShowNotes((v) => !v)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition-colors',
                  showNotes
                    ? 'border-nvr-cyan/40 text-nvr-navy dark:text-nvr-cyan'
                    : 'border-slate-200 text-slate-400 hover:text-slate-600 dark:border-border dark:hover:text-slate-300'
                )}
              >
                <MessageSquare className='h-3 w-3' />
                Notes
              </button>
              {canRollback &&
                (confirmRollback ? (
                  <span className='inline-flex items-center gap-1.5'>
                    <span className='text-[11px] text-slate-500'>Restore this version?</span>
                    <Button
                      size='sm'
                      variant='destructive'
                      className='h-6 text-[11px]'
                      disabled={rollbackMut.isPending}
                      onClick={() => rollbackMut.mutate()}
                    >
                      Yes, restore
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-6 text-[11px]'
                      onClick={() => setConfirmRollback(false)}
                    >
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-6 gap-1 text-[11px]'
                    disabled={rollbackMut.isPending}
                    onClick={() => setConfirmRollback(true)}
                    title='Set the whole record back to how it looked after this save'
                  >
                    <RotateCcw className='h-3 w-3' />
                    Restore this version
                  </Button>
                ))}
            </div>
          </div>

          {showNotes && <RevisionAnnotations revisionId={revision.id} />}

          <FieldChangeList
            before={sideBefore}
            after={sideAfter}
            meta={meta}
            fieldRevert={fieldRevert}
            mode={view}
            hideStatusChips={isCreate}
          />

          {rolledBackAt && inlineTableFields && inlineTableFields.length > 0 && (
            <div className='space-y-1.5 rounded-md border border-slate-100 bg-slate-50 p-2 dark:border-border dark:bg-muted/30'>
              <p className='text-[10.5px] font-medium text-slate-500'>Also restore related rows?</p>
              {inlineTableFields.map((f) => (
                <div key={f.field} className='flex items-center justify-between gap-2'>
                  <span className='text-[11.5px] text-slate-600 dark:text-slate-300'>
                    {f.label}
                  </span>
                  <button
                    type='button'
                    disabled={o2mRestoring === f.field}
                    onClick={() => restoreO2MField(f)}
                    className='rounded border border-[#00ceff]/40 px-2 py-0.5 text-[10.5px] font-medium text-[#00ceff] hover:bg-[#00ceff]/10 disabled:opacity-40'
                  >
                    {o2mRestoring === f.field ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Time-travel tools (as-of + between-dates), one collapsible strip ───────

function TimeTravelTools({ data, meta }: { data: Revision[]; meta: FieldMetaMap }) {
  const [openTool, setOpenTool] = useState<'asof' | 'compare' | null>(null)
  const [asOf, setAsOf] = useState('')
  const [diffFrom, setDiffFrom] = useState('')
  const [diffTo, setDiffTo] = useState('')

  const asOfRevision = useMemo(() => {
    if (!asOf || !data) return null
    const cutoff = new Date(`${asOf}T23:59:59`).getTime()
    return data.find((r) => r.timestamp && new Date(r.timestamp).getTime() <= cutoff) ?? null
  }, [asOf, data])

  const betweenDiff = useMemo<
    | { error: string; fields?: undefined }
    | {
        error?: undefined
        fields: Array<{
          field: string
          from: unknown
          to: unknown
          by: { name: string; when: string | null } | null
        }>
      }
    | null
  >(() => {
    if (!diffFrom || !diffTo || !data) return null
    const fromCut = new Date(`${diffFrom}T23:59:59`).getTime()
    const toCut = new Date(`${diffTo}T23:59:59`).getTime()
    if (toCut <= fromCut) return { error: 'The second date must be after the first' }
    const at = (cut: number) =>
      data.find((r) => r.timestamp && new Date(r.timestamp).getTime() <= cut) ?? null
    const base = at(fromCut)
    const end = at(toCut)
    if (!end) return { error: 'No snapshot exists at or before the second date' }
    const baseData = base?.data ?? {}
    const endData = end.data ?? {}
    const who = new Map<string, { name: string; when: string | null }>()
    for (const r of [...data].reverse()) {
      const t = r.timestamp ? new Date(r.timestamp).getTime() : 0
      if (t <= fromCut || t > toCut || !r.delta) continue
      for (const f of Object.keys(r.delta)) {
        who.set(f, { name: revisionUserName(r), when: r.timestamp })
      }
    }
    const fields = [...new Set([...Object.keys(baseData), ...Object.keys(endData)])]
      .filter((f) => String(baseData[f] ?? '') !== String(endData[f] ?? ''))
      .map((f) => ({ field: f, from: baseData[f], to: endData[f], by: who.get(f) ?? null }))
    return { fields }
  }, [diffFrom, diffTo, data])

  const dateInputCls =
    'h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'

  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-1.5'>
        <button
          type='button'
          onClick={() => setOpenTool(openTool === 'asof' ? null : 'asof')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors',
            openTool === 'asof' || asOf
              ? 'border-nvr-cyan/40 bg-nvr-cyan/5 font-medium text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-slate-400 dark:hover:text-slate-200'
          )}
        >
          <CalendarClock className='h-3.5 w-3.5' />
          View as of a date
        </button>
        <button
          type='button'
          onClick={() => setOpenTool(openTool === 'compare' ? null : 'compare')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors',
            openTool === 'compare' || (diffFrom && diffTo)
              ? 'border-nvr-cyan/40 bg-nvr-cyan/5 font-medium text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-slate-400 dark:hover:text-slate-200'
          )}
        >
          <GitCompareArrows className='h-3.5 w-3.5' />
          Compare two dates
        </button>
      </div>

      {openTool === 'asof' && (
        <div className='rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 dark:border-border dark:bg-muted/20'>
          <div className='flex items-center gap-2'>
            <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
              Show the record exactly as it was on
            </span>
            <input
              type='date'
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className={dateInputCls}
              aria-label='View record as of date'
              data-as-of
            />
            {asOf && (
              <button
                type='button'
                onClick={() => setAsOf('')}
                className='text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              >
                Clear
              </button>
            )}
          </div>
          {asOf && !asOfRevision && (
            <p className='mt-2 text-[12px] text-slate-400'>
              No snapshot exists at or before that date — the record is newer.
            </p>
          )}
          {asOfRevision && (
            <div className='mt-2 overflow-hidden rounded-lg border border-nvr-cyan/40 bg-white dark:bg-card'>
              <div className='border-b border-slate-200 bg-[#f0fbff] px-2.5 py-1.5 dark:border-border dark:bg-nvr-cyan/10'>
                <span className='text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
                  Record as of{' '}
                  {asOfRevision.timestamp
                    ? new Date(asOfRevision.timestamp).toLocaleString()
                    : asOf}
                </span>
              </div>
              <div className='max-h-80 overflow-y-auto'>
                {Object.entries(asOfRevision.data ?? {})
                  .filter(([, v]) => v !== null && v !== undefined && v !== '')
                  .sort(([a], [b]) => metaFor(meta, a).label.localeCompare(metaFor(meta, b).label))
                  .map(([k, v]) => (
                    <div
                      key={k}
                      className='flex items-start gap-3 border-b border-slate-100 px-2.5 py-1.5 last:border-0 dark:border-border/60'
                    >
                      <span
                        className='w-[200px] shrink-0 text-[11.5px] font-medium text-slate-600 dark:text-slate-300'
                        title={k}
                      >
                        {metaFor(meta, k).label}
                      </span>
                      <span className='break-words text-[11.5px] text-slate-700 dark:text-slate-300'>
                        <RevValue value={v} meta={metaFor(meta, k)} tone='after' />
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {openTool === 'compare' && (
        <div className='rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 dark:border-border dark:bg-muted/20'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
              What changed between
            </span>
            <input
              type='date'
              value={diffFrom}
              onChange={(e) => setDiffFrom(e.target.value)}
              className={dateInputCls}
              aria-label='Compare from date'
              data-diff-from
            />
            <span className='text-[11.5px] text-slate-400'>and</span>
            <input
              type='date'
              value={diffTo}
              onChange={(e) => setDiffTo(e.target.value)}
              className={dateInputCls}
              aria-label='Compare to date'
              data-diff-to
            />
            {(diffFrom || diffTo) && (
              <button
                type='button'
                onClick={() => {
                  setDiffFrom('')
                  setDiffTo('')
                }}
                className='text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              >
                Clear
              </button>
            )}
          </div>
          {betweenDiff?.error != null && (
            <p className='mt-2 text-[12px] text-amber-600 dark:text-amber-400'>
              {betweenDiff?.error}
            </p>
          )}
          {betweenDiff?.fields != null && (
            <div
              className='mt-2 overflow-hidden rounded-lg border border-nvr-cyan/40 bg-white dark:bg-card'
              data-between-diff
            >
              <div className='border-b border-slate-200 bg-[#f0fbff] px-2.5 py-1.5 dark:border-border dark:bg-nvr-cyan/10'>
                <span className='text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
                  {betweenDiff.fields.length} field
                  {betweenDiff.fields.length === 1 ? '' : 's'} changed between {diffFrom} and{' '}
                  {diffTo}
                </span>
              </div>
              {betweenDiff.fields.length === 0 ? (
                <p className='px-2.5 py-3 text-[12px] text-slate-400'>
                  Nothing changed in that window.
                </p>
              ) : (
                <div className='max-h-80 overflow-y-auto'>
                  {betweenDiff.fields.map((f) => (
                    <div
                      key={f.field}
                      className='border-b border-slate-100 px-2.5 py-1.5 last:border-0 dark:border-border/60'
                    >
                      <div className='flex items-baseline justify-between gap-2'>
                        <span
                          className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'
                          title={f.field}
                        >
                          {metaFor(meta, f.field).label}
                        </span>
                        {f.by && (
                          <span className='shrink-0 text-[10.5px] text-slate-400'>
                            {f.by.name}
                            {f.by.when ? ` · ${new Date(f.by.when).toLocaleDateString()}` : ''}
                          </span>
                        )}
                      </div>
                      <p className='mt-0.5 flex flex-wrap items-baseline gap-x-2 break-words text-[11.5px]'>
                        <span className='text-red-500 line-through dark:text-red-400'>
                          <RevValue value={f.from} meta={metaFor(meta, f.field)} tone='before' />
                        </span>
                        <span className='text-emerald-600 dark:text-emerald-400'>
                          <RevValue value={f.to} meta={metaFor(meta, f.field)} tone='after' />
                        </span>
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── The list, grouped by day ───────────────────────────────────────────────

function dayKey(ts: string | null): string {
  if (!ts) return 'Unknown date'
  return new Date(ts).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

function RevisionsList({
  collection,
  item,
  onRollback,
  inlineTableFields
}: {
  collection: string
  item: string
  onRollback?: () => void
  inlineTableFields?: O2MFieldInfo[]
}) {
  const client = useNivaroClient()
  const meta = useFieldMeta(collection, true)
  const { data, isLoading } = useQuery({
    queryKey: ['revisions', collection, item],
    queryFn: () =>
      client
        .request<{ data: Revision[] }>(get('/revisions', { collection, item }))
        .then((r) => r.data ?? []),
    staleTime: 30_000
  })
  const count = data?.length ?? 0

  const groups = useMemo(() => {
    const out: Array<{ day: string; revisions: Revision[] }> = []
    for (const rev of data ?? []) {
      const day = dayKey(rev.timestamp)
      const last = out[out.length - 1]
      if (last && last.day === day) last.revisions.push(rev)
      else out.push({ day, revisions: [rev] })
    }
    return out
  }, [data])

  if (isLoading)
    return (
      <div className='space-y-2 pt-3'>
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className='h-11 rounded-md' />
        ))}
      </div>
    )
  if (count === 0)
    return (
      <div className='flex flex-col items-center py-16 text-center'>
        <Clock className='mb-2 h-8 w-8 text-slate-300 dark:text-slate-600' />
        <p className='text-[13px] font-medium text-slate-600 dark:text-slate-300'>No history yet</p>
        <p className='mt-1 max-w-[38ch] text-[12px] text-slate-400'>
          Every save records who changed what — the trail will appear here.
        </p>
      </div>
    )

  return (
    <div className='space-y-3 pt-3'>
      <TimeTravelTools data={data ?? []} meta={meta} />
      {(data?.length ?? 0) >= 3 && <TimeLapseBar revisions={data ?? []} meta={meta} />}
      <div>
        {groups.map((g) => (
          <div key={g.day}>
            <div className='sticky top-0 z-10 -mx-6 border-b border-slate-100 bg-white px-6 py-1.5 dark:border-border/60 dark:bg-card'>
              <span className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                {g.day}
              </span>
            </div>
            {g.revisions.map((rev) => {
              const globalIdx = (data ?? []).indexOf(rev)
              return (
                <div key={rev.id} className='nvr-fade-in'>
                  <RevisionRow
                    revision={rev}
                    previousData={data?.[globalIdx + 1]?.data ?? null}
                    meta={meta}
                    onRollback={onRollback}
                    inlineTableFields={inlineTableFields}
                    isLast={globalIdx === (data?.length ?? 1) - 1}
                  />
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Panel shell ────────────────────────────────────────────────────────────

export function RevisionsPanel({
  collection,
  item,
  onRollback,
  triggerClassName,
  inlineTableFields,
  open,
  onOpenChange
}: {
  collection: string
  item: string
  onRollback?: () => void
  triggerClassName?: string
  inlineTableFields?: O2MFieldInfo[]
  /** Controlled mode (no trigger button) — open the sheet programmatically,
   *  e.g. from a row Actions menu. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const controlled = open !== undefined
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {!controlled && (
        <SheetTrigger asChild>
          <Button variant='outline' size='sm' className={triggerClassName ?? 'gap-1.5'}>
            <Clock className='h-3.5 w-3.5' />
            History
          </Button>
        </SheetTrigger>
      )}
      <SheetContent className='w-[720px] overflow-y-auto p-0 sm:max-w-[92vw]'>
        {/* Padding lives on this wrapper, NOT the scroll container — sticky
            day headers pin at the scroller's padding edge, so padding on the
            scroller left a see-through band above the pinned header. */}
        <div className='p-6'>
          <SheetHeader>
            <SheetTitle className='flex items-center gap-2 text-base'>
              <Clock className='h-4 w-4 text-slate-400' />
              Revision history
            </SheetTitle>
            <p className='text-[12px] text-slate-400'>
              Who changed what, when — expand any entry to see the exact values, revert a single
              field, or restore the whole version.
            </p>
          </SheetHeader>
          <RevisionValueSearch collection={collection} item={item} />
          <RevisionsList
            collection={collection}
            item={item}
            onRollback={onRollback}
            inlineTableFields={inlineTableFields}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Revision value search (#98), record-scoped: "when did 42000 first appear on
 *  this record, and who wrote it". Server-side over the record's deltas. */
function RevisionValueSearch({ collection, item }: { collection: string; item: string }) {
  const client = useNivaroClient()
  const meta = useFieldMeta(collection, true)
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState('')
  const { data, isFetching } = useQuery<{
    matches: Array<{
      revision_id: number
      timestamp: string | null
      user_name: string | null
      action: string | null
      fields: Array<{ field: string; value: string }>
    }>
    truncated: boolean
  }>({
    queryKey: ['rev-value-search', collection, item, applied],
    queryFn: () =>
      client
        .request<{ data: never }>(get('/revisions/value-search', { collection, item, q: applied }))
        .then((r) => r.data),
    enabled: applied.length >= 2
  })
  return (
    <div className='mt-3'>
      <div className='relative'>
        <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setApplied(q.trim())
          }}
          placeholder='Search this record’s history for a value — who wrote it, and when'
          className='h-8 w-full rounded-md border border-slate-200 bg-background pl-8 pr-8 text-[12.5px] outline-none focus:border-nvr-cyan dark:border-border'
        />
        {applied && (
          <button
            type='button'
            onClick={() => {
              setQ('')
              setApplied('')
            }}
            className='absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600'
            aria-label='Clear search'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        )}
      </div>
      {applied && (
        <div className='mt-2 space-y-1.5 rounded-lg border border-slate-200 p-2.5 dark:border-border'>
          {isFetching ? (
            <p className='text-[11.5px] text-slate-400'>Searching…</p>
          ) : (data?.matches ?? []).length === 0 ? (
            <p className='text-[11.5px] text-slate-400'>
              “{applied}” never appears in this record’s recorded changes.
            </p>
          ) : (
            <>
              {data?.matches.map((m) => (
                <div key={m.revision_id} className='text-[11.5px]'>
                  <p className='text-slate-600 dark:text-slate-300'>
                    {m.fields.map((f) => (
                      <span key={f.field}>
                        <span className='font-medium' title={f.field}>
                          {metaFor(meta, f.field).label}
                        </span>{' '}
                        → “{f.value.length > 60 ? `${f.value.slice(0, 60)}…` : f.value}”{' '}
                      </span>
                    ))}
                  </p>
                  <p className='text-[10.5px] text-slate-400'>
                    {m.user_name ?? 'System'} ·{' '}
                    {m.timestamp ? new Date(m.timestamp).toLocaleString() : ''} · {m.action}
                  </p>
                </div>
              ))}
              {data?.truncated && (
                <p className='text-[10.5px] text-amber-600'>Showing the newest 200 matches.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── History annotations (#372): comment on a specific revision ─────────────
function RevisionAnnotations({ revisionId }: { revisionId: number | string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const { data: notes = [] } = useQuery<
    Array<{ id: string; text: string; created_at: string; user_name?: string | null }>
  >({
    queryKey: ['revision-notes', String(revisionId)],
    queryFn: () =>
      client
        .request<{
          data: Array<{ id: string; text: string; created_at: string; user_name?: string | null }>
        }>(get('/comments', { collection: 'nivaro_revisions', item: String(revisionId) }))
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 30_000
  })
  const add = useMutation({
    mutationFn: () =>
      client.request(
        post('/comments', { collection: 'nivaro_revisions', item: String(revisionId), text })
      ),
    onSuccess: () => {
      setText('')
      void qc.invalidateQueries({ queryKey: ['revision-notes', String(revisionId)] })
    },
    onError: () => toast.error('Note failed')
  })
  return (
    <div className='rounded-md border border-slate-100 bg-slate-50/60 p-2 dark:border-border/60 dark:bg-muted/30'>
      {notes.map((n) => (
        <p key={n.id} className='text-[11.5px] text-slate-600 dark:text-slate-300'>
          {n.text}{' '}
          <span className='text-[10px] text-slate-400'>
            — {n.user_name ?? 'someone'} · {new Date(n.created_at).toLocaleDateString()}
          </span>
        </p>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) add.mutate()
        }}
        className='mt-1 flex gap-1.5'
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='Annotate this revision…'
          className='h-6 flex-1 rounded border border-slate-200 bg-transparent px-1.5 text-[11.5px] outline-none dark:border-border'
        />
        {text.trim() && (
          <button
            type='submit'
            disabled={add.isPending}
            className='rounded bg-nvr-cyan px-2 text-[11px] font-semibold text-white disabled:opacity-50'
          >
            Add
          </button>
        )}
      </form>
    </div>
  )
}

// ─── Record time-lapse (#373) ───────────────────────────────────────────────
function TimeLapseBar({
  revisions,
  meta
}: {
  revisions: Array<{
    id: number | string
    action: string | null
    timestamp: string | null
    user_name?: string | null
    delta?: Record<string, unknown> | null
  }>
  meta: FieldMetaMap
}) {
  const ordered = [...revisions].reverse() // oldest → newest
  const [playing, setPlaying] = useState(false)
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    if (!playing) return
    if (idx >= ordered.length - 1) {
      setPlaying(false)
      return
    }
    const t = setTimeout(() => setIdx((i) => i + 1), 1600)
    return () => clearTimeout(t)
  }, [playing, idx, ordered.length])
  const cur = ordered[idx]
  const deltaLabels = cur?.delta
    ? Object.keys(cur.delta)
        .slice(0, 5)
        .map((f) => metaFor(meta, f).label)
    : []
  return (
    <div className='rounded-md border border-slate-200 bg-slate-50/70 p-2 dark:border-border dark:bg-muted/30'>
      <div className='flex items-center gap-2'>
        <button
          type='button'
          onClick={() => {
            if (!playing && idx >= ordered.length - 1) setIdx(0)
            setPlaying((v) => !v)
          }}
          className='rounded-md bg-nvr-cyan px-2.5 py-1 text-[11.5px] font-semibold text-white'
        >
          {playing ? 'Pause' : '▶ Time-lapse'}
        </button>
        <input
          type='range'
          min={0}
          max={Math.max(0, ordered.length - 1)}
          value={idx}
          onChange={(e) => {
            setPlaying(false)
            setIdx(Number(e.target.value))
          }}
          className='flex-1 accent-[#00ceff]'
          aria-label='History position'
        />
        <span className='shrink-0 tabular-nums text-[11px] text-slate-400'>
          {idx + 1}/{ordered.length}
        </span>
      </div>
      {cur && (
        <p className='mt-1 text-[11.5px] text-slate-600 dark:text-slate-300'>
          <span className='font-medium capitalize'>{cur.action ?? 'change'}</span>
          {cur.timestamp ? ` · ${new Date(cur.timestamp).toLocaleString()}` : ''}
          {cur.user_name ? ` · ${cur.user_name}` : ''}
          {deltaLabels.length > 0 && (
            <span className='ml-1 text-[10.5px] text-slate-400'>
              changed: {deltaLabels.join(', ')}
            </span>
          )}
        </p>
      )}
    </div>
  )
}
