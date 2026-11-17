import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Columns3,
  Download,
  GitCompareArrows,
  History,
  List,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sigma,
  Table2,
  X
} from 'lucide-react'
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import {
  type ActivityActor,
  type ActivityLabels,
  type ActivityO2m,
  activityPredicate,
  activityWhy,
  actorName,
  o2mSentence,
  o2mTotalsText
} from '../../lib/activity-sentence'
import { get, post } from '../../lib/commands'
import { type CompareFieldMeta, compareValueText } from '../../lib/compare-value'
import { useLiveRecordQueries } from '../../lib/live'
import { restoreSkippedNote } from '../../lib/restore-skipped'
import { cn, formatDateTime, titleCase, toLocalDateString } from '../../lib/utils'
import { useActivityLabels } from '../ActivityEntry'
import { AgentBadge } from '../AgentBadge'
import { RelatedItemLabel } from '../item-edit/RelationCombobox'
import { UserChip } from '../item-edit/UserChip'
import { UserAvatar } from '../UserAvatar'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import { IntegrationActivitySection } from './IntegrationActivitySection'
import {
  buildSaveRows,
  type ChangeSourceRevision,
  type DeriveInfo,
  deriveOf,
  type MatrixColumn,
  type MatrixRow,
  matrixColumns,
  matrixCsv,
  type RecalcReason,
  recalcReason,
  rowsChanging,
  type SaveAction,
  saveActionLabel,
  signedAmount
} from './revision-changes'

export interface O2MFieldInfo {
  field: string
  label: string
  relatedCollection: string
  manyField: string
  parentId: string
}

interface Revision {
  /** null for a folded-in event (transition, pipeline start, child-row write). */
  id: string | null
  activity?: number | null
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
  comment?: string | null
  /** A child row edited from this record's page, summarised for this reader (army 6 H1). */
  o2m?: ActivityO2m | null
  /** #3213 — made by an AI assistant through MCP: the badge text ("via Claude"). */
  via_agent?: string | null
  /** Migration 516 — who really did it when not simply the person (View-as, API key,
   *  assistant, import, flow, scheduled job). */
  actor?: ActivityActor | null
  group_key?: string | null
  event?: {
    kind: 'transition' | 'start'
    history_id?: number
    from_label: string | null
    to_label: string | null
    transition_label: string | null
    source: string | null
    /** The move happened on one of this record's ADDENDUMS (its own
     *  pipeline instance), folded into the record's history. */
    addendum?: { id: string; title: string | null } | null
    /** #645 — the out-of-office owner a delegate's move stood in for. */
    on_behalf_of?: { id: string; name: string | null } | null
    /** The administrator who made this move in a View-as tab of the person (its view-as-move row).
     *  The server sends it to administrator readers only ("Rob Lee as David Pry"). */
    acting_admin?: { id: string; name: string } | null
  } | null
}

/** A snapshot row (create / update / delete with a stored copy) — the rows
 *  the diff, time-travel and time-lapse tools can work from. Events have none. */
const isSnapshot = (r: Revision) =>
  r.id != null &&
  (r.action === 'create' ||
    r.action === 'update' ||
    r.action === 'delete' ||
    r.action === 'restore')
const isEvent = (r: Revision) => !isSnapshot(r)
const rowKey = (r: Revision) =>
  r.id != null
    ? `r${r.id}`
    : `e${r.event?.history_id ?? ''}-${r.activity ?? ''}-${r.timestamp ?? ''}`

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
  /** A calendar date (no time): renders as its stored day, never shifted to local time. */
  dateOnly?: boolean
  /** Position in the field config (form order). */
  order?: number
  /** Type + options for display formatting (currency, choices, numbers). */
  cmp?: CompareFieldMeta
  /** How the field is worked out (rollup / formula / lookup); null = a plain field. */
  derive?: DeriveInfo | null
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
      type?: string | null
      interface?: string | null
      options?: unknown
      display_options?: unknown
      computed_type?: string | null
      computed_formula?: unknown
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
              type?: string | null
              interface?: string | null
              options?: unknown
              display_options?: unknown
              computed_type?: string | null
              computed_formula?: unknown
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
    for (const [i, f] of (data?.fields ?? []).entries()) {
      if (f.field.startsWith('__')) continue
      map.set(f.field, {
        order: i,
        derive: deriveOf(f.computed_type, f.computed_formula),
        cmp: {
          field: f.field,
          type: f.type ?? null,
          interface: f.interface ?? null,
          options: f.options,
          display_options: f.display_options
        },
        label: f.label || titleCase(f.field.replace(/_/g, ' ')),
        // Hidden fields are machine columns (e.g. the retired "workflow_state
        // (legacy)" a save still writes) — folded with the system fields, not
        // listed among what a person changed (army8 b01).
        system: AUDIT_FIELDS.has(f.field) || f.hidden === true,
        // layout_assigned is only stamped when the collection HAS an active
        // layout — absent means there's no layout to be off of.
        onLayout: f.layout_assigned !== false,
        relatedCollection: m2oTarget(f.field),
        dateOnly: String(f.type ?? '').toLowerCase() === 'date'
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
// A calendar date: bare yyyy-mm-dd, or exactly UTC midnight — how an MSSQL `date` column
// serializes (EFP's Date Required is registered as datetime but stored as a date), the same
// rule formatDate / format-value use.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?Z)?$/

/** Exported for tests. A calendar date (`dateOnly` = the field is typed `date`, or the value
 *  is one) renders as its stored day — `toLocaleString` showed UTC midnight as the previous
 *  day at 7:00 PM for anyone in Eastern time. */
export function displayValue(value: unknown, dateOnly = false): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' && (DATE_ONLY_RE.test(value) || (dateOnly && ISO_RE.test(value))))
    return toLocalDateString(value)
  if (typeof value === 'string' && ISO_RE.test(value)) {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return formatDateTime(d)
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

function ValueCell({
  value,
  tone,
  dateOnly
}: {
  value: unknown
  tone: 'before' | 'after'
  dateOnly?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const str = displayValue(value, dateOnly)
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
  // Currency, choices and numbers as the field is configured to show them ($2,060.00, not 2060).
  if (meta.cmp && typeof value !== 'object' && !meta.dateOnly)
    return <ValueCell value={compareValueText(value, meta.cmp)} tone={tone} />
  return <ValueCell value={value} tone={tone} dateOnly={meta.dateOnly} />
}

function FieldChangeRow({
  row,
  meta,
  fieldRevert,
  mode,
  hideStatusChips,
  between
}: {
  row: FieldRowData
  meta: FieldMetaMap
  fieldRevert?: FieldRevertCtl
  mode: 'changes' | 'all'
  /** Worked out between the two saves, not part of this edit. */
  between?: boolean
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
          row.field !== 'id' &&
          // A value worked out between saves (a rollup, a forecast status) is
          // not something to put back by hand (army11 f1 design review).
          !between && (
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

export function FieldChangeList({
  before,
  after,
  meta,
  fieldRevert,
  mode,
  hideStatusChips,
  ownFields
}: {
  before: Record<string, unknown>
  after: Record<string, unknown>
  meta: FieldMetaMap
  fieldRevert?: FieldRevertCtl
  mode: 'changes' | 'all'
  hideStatusChips?: boolean
  /** Fields THIS save wrote (the revision's delta). Other differences from the
   *  previous snapshot were recalculated in between (rollups, forecast status)
   *  and are listed apart, not credited to this person (army9 b01). */
  ownFields?: ReadonlySet<string> | null
}) {
  const [showSystem, setShowSystem] = useState(false)
  const allRows = useMemo(() => computeFieldRows(before, after, meta), [before, after, meta])
  const scoped = mode === 'changes' ? allRows.filter((r) => r.status !== 'unchanged') : allRows
  const shown = showSystem ? scoped : scoped.filter((r) => !r.system)
  const isBetween = (r: FieldRowData) =>
    !!ownFields && mode === 'changes' && !r.system && !ownFields.has(r.field)
  const between = shown.filter(isBetween)
  const visible = [...shown.filter((r) => !isBetween(r)), ...between]
  const firstBetweenIdx = between.length ? visible.length - between.length : -1
  const hiddenSystem = scoped.length - visible.length
  if (scoped.length === 0)
    return (
      <p className='px-3 py-3 text-[12px] text-slate-400'>
        {mode === 'changes' ? 'No field changes recorded.' : 'No snapshot data available.'}
      </p>
    )
  const firstBehindIdx = visible.findIndex(
    (r) => !isBetween(r) && !metaFor(meta, r.field).onLayout && !metaFor(meta, r.field).system
  )
  const hasLayoutRows = visible.some(
    (r) => !isBetween(r) && metaFor(meta, r.field).onLayout && !metaFor(meta, r.field).system
  )
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      {visible.map((row, idx) => (
        <div key={row.field}>
          {idx === firstBetweenIdx && (
            <div
              data-recalculated-between
              className='border-b border-t border-slate-100 bg-slate-50/70 px-3 py-1.5 dark:border-border/60 dark:bg-muted/30'
            >
              <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
                Recalculated since the save before
              </p>
              <p className='text-[10.5px] text-slate-500 dark:text-slate-400'>
                Not part of this edit — worked out automatically between the two saves.
              </p>
            </div>
          )}
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
            between={isBetween(row)}
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
  restore: 'bg-emerald-500',
  update: 'bg-nvr-cyan',
  delete: 'bg-red-500'
}

/** People the history names that are not on the row itself (View-as admins), read once. */
const RevisionLabelsContext = createContext<ActivityLabels | undefined>(undefined)

function revisionUserName(rev: Revision, labels?: ActivityLabels): string {
  // Migration 516: "Rob as Pat", "API key “Sync”", "Import “Vendors”", "Claude for Pat".
  if (rev.actor && rev.actor.kind !== 'person') return actorName(rev, labels)
  if (rev.first_name || rev.last_name)
    return [rev.first_name, rev.last_name].filter(Boolean).join(' ')
  return rev.user_email ?? rev.user_id?.slice(0, 8) ?? 'System'
}

function revisionSentence(rev: Revision, humanCount: number, systemCount: number): string {
  if (rev.action === 'create') return 'created this record'
  if (rev.action === 'restore') return 'restored this record from trash'
  if (rev.action === 'delete') return 'deleted this record'
  if (humanCount > 0) return `changed ${humanCount} field${humanCount === 1 ? '' : 's'}`
  if (systemCount > 0) return 'updated system fields'
  return 'saved this record'
}

/** A pipeline transition / start or a child-row write, in the same rail as
 *  the snapshots: who, what moved, the comment they left — nothing to diff. */
function EventRow({ revision, isLast }: { revision: Revision; isLast: boolean }) {
  const labels = useContext(RevisionLabelsContext)
  const ev = revision.event
  const auto = ev?.source === 'auto' || (!revision.user_id && ev?.kind === 'transition')
  const behalf = !auto && ev?.on_behalf_of?.name ? ev.on_behalf_of.name : null
  // View-as (admins only — the server sends acting_admin to administrator readers alone).
  const actingAdmin = !auto && ev?.acting_admin?.name ? ev.acting_admin.name : null
  const person = actingAdmin
    ? `${actingAdmin} as ${revisionUserName(revision, labels)}`
    : revisionUserName(revision, labels)
  const who = auto ? 'Automatic rule' : behalf ? `${person}, for ${behalf}` : person
  let sentence: React.ReactNode
  if (ev?.kind === 'transition' && ev.addendum) {
    sentence = (
      <>
        moved{' '}
        <span className='font-medium text-slate-700 dark:text-slate-200' data-revision-addendum>
          Addendum “{ev.addendum.title || 'Untitled'}”
        </span>
        :{' '}
        {ev.from_label && (
          <>
            <span className='font-medium text-slate-700 dark:text-slate-200'>{ev.from_label}</span>{' '}
            →{' '}
          </>
        )}
        <span className='font-medium text-slate-700 dark:text-slate-200'>{ev.to_label ?? '—'}</span>
        {ev.transition_label && <span className='text-slate-400'> · {ev.transition_label}</span>}
      </>
    )
  } else if (ev?.kind === 'transition') {
    sentence = (
      <>
        moved it{' '}
        {ev.from_label && (
          <>
            from{' '}
            <span className='font-medium text-slate-700 dark:text-slate-200'>
              {ev.from_label}
            </span>{' '}
          </>
        )}
        to{' '}
        <span className='font-medium text-slate-700 dark:text-slate-200'>{ev.to_label ?? '—'}</span>
        {ev.transition_label && <span className='text-slate-400'> · {ev.transition_label}</span>}
      </>
    )
  } else if (ev?.kind === 'start' && ev.to_label) {
    // #1219: a start history row names the state the record started in.
    sentence = (
      <>
        started it in{' '}
        <span className='font-medium text-slate-700 dark:text-slate-200'>{ev.to_label}</span>
      </>
    )
  } else if (ev?.kind === 'start') {
    sentence = (
      <>
        started the pipeline
        {revision.comment
          ? ` — ${revision.comment.replace(/^Started pipeline\s*[—-]?\s*/i, '')}`
          : ''}
      </>
    )
  } else if (revision.action?.startsWith('o2m-')) {
    // "changed Materials · 110140: Quantity 4 → 5" — the server's per-reader summary. The
    // stored comment is machine JSON (row ids, user uuids) and is never shown (army 6 H1).
    sentence = (
      <span data-revision-o2m>
        {revision.o2m ? (
          <>
            {o2mSentence(revision.o2m)}
            {o2mTotalsText(revision.o2m) ? (
              // Which totals on this record the row's write moved (audit: who changed the
              // requisition amount — the person who wrote the line).
              <span
                data-revision-o2m-totals
                className='ml-1 font-medium text-slate-700 dark:text-slate-200'
              >
                · {o2mTotalsText(revision.o2m)}
              </span>
            ) : null}
            {revision.o2m.elsewhere ? (
              <span
                data-revision-o2m-elsewhere
                className='ml-1.5 rounded bg-slate-100 px-1 py-px text-[10.5px] text-slate-600 dark:bg-muted dark:text-muted-foreground'
              >
                outside this record
              </span>
            ) : null}
          </>
        ) : (
          `${
            revision.action === 'o2m-create'
              ? 'added'
              : revision.action === 'o2m-delete'
                ? 'removed'
                : 'changed'
          } related rows`
        )}
      </span>
    )
  } else {
    // Any other event reads as a sentence (lib/activity-sentence), the record being this one.
    sentence = (
      <>
        {activityPredicate({ ...revision, item: null }, labels)}
        {revision.comment ? ` — ${revision.comment}` : ''}
      </>
    )
  }
  const exactTime = revision.timestamp
    ? new Date(revision.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '—'
  return (
    <div
      className='relative pl-9'
      data-revision-event={ev?.kind ?? revision.action ?? ''}
      data-revision-on-behalf={behalf ? ev?.on_behalf_of?.id : undefined}
      data-revision-acting-admin={actingAdmin ? ev?.acting_admin?.id : undefined}
    >
      <span
        className={cn(
          'absolute left-[11px] top-[18px] h-2.5 w-2.5 rounded-full ring-4 ring-white dark:ring-card',
          ev?.kind === 'transition' && ev.addendum
            ? 'bg-amber-500'
            : ev?.kind === 'transition'
              ? 'bg-violet-500'
              : ev?.kind === 'start'
                ? 'bg-violet-300'
                : 'bg-slate-300'
        )}
        aria-hidden
      />
      {!isLast && (
        <span
          className='absolute bottom-0 left-[15.5px] top-[30px] w-px bg-slate-200 dark:bg-border'
          aria-hidden
        />
      )}
      <div className='flex w-full items-start gap-2.5 rounded-md px-2 py-2.5 text-left'>
        {auto ? (
          <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-500/10 text-[10px] font-semibold text-violet-700 dark:text-violet-300'>
            ⚡
          </span>
        ) : (
          <RevisionAvatar userId={revision.user_id} name={who} />
        )}
        <span className='min-w-0 flex-1 text-[12.5px] text-slate-700 dark:text-slate-200'>
          <span className='font-medium'>{who}</span>{' '}
          <span className='text-slate-500 dark:text-slate-400'>{sentence}</span>
          {ev?.kind === 'transition' && revision.comment && (
            <span
              className='mt-0.5 block truncate text-[11.5px] italic text-slate-500 dark:text-slate-400'
              title={revision.comment}
            >
              “{revision.comment}”
            </span>
          )}
        </span>
        <span
          className='shrink-0 text-[11px] tabular-nums text-slate-400'
          title={revision.timestamp ? formatDateTime(revision.timestamp) : undefined}
        >
          {exactTime}
        </span>
      </div>
    </div>
  )
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
  const labels = useContext(RevisionLabelsContext)
  const reason = activityWhy(revision).reason
  const [expanded, setExpanded] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [view, setView] = useState<'changes' | 'all'>('changes')
  const [showNotes, setShowNotes] = useState(false)
  const [o2mRestoring, setO2MRestoring] = useState<string | null>(null)
  const isUpdate = revision.action === 'update'
  // A restore brings the whole record back — it reads like a create.
  const isCreate = revision.action === 'create' || revision.action === 'restore'
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
  const ownDeltaFields = useMemo(() => new Set(Object.keys(revision.delta ?? {})), [revision])
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
    onSuccess: (res) => {
      setConfirmRollback(false)
      toast.success('Rolled back to this revision')
      const skipped = restoreSkippedNote(res)
      if (skipped) toast.warning(skipped, { duration: 10_000 })
      if (inlineTableFields?.length && revision.timestamp) setRolledBackAt(revision.timestamp)
      onRollback?.()
    },
    onError: () => toast.error('Failed to rollback')
  })

  async function restoreO2MField(f: O2MFieldInfo) {
    if (!rolledBackAt) return
    setO2MRestoring(f.field)
    try {
      const res = await client.request(
        post('/revisions/o2m-restore', {
          collection: f.relatedCollection,
          many_field: f.manyField,
          parent_id: f.parentId,
          target_timestamp: rolledBackAt
        })
      )
      toast.success(`Restored ${f.label}`)
      const skipped = restoreSkippedNote(res)
      if (skipped) toast.warning(skipped, { duration: 10_000 })
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

      {/* The avatar opens the person's card; the rest of the row opens the entry — two
          controls side by side, never one inside the other. */}
      <div className='flex w-full items-center gap-2.5 rounded-md px-2 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-muted/40'>
        <RevisionAvatar userId={revision.user_id} name={revisionUserName(revision, labels)} />
        <button
          type='button'
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className='flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan rounded'
        >
          <span className='min-w-0 flex-1 truncate text-[12.5px] text-slate-700 dark:text-slate-200'>
            <span className='font-medium'>{revisionUserName(revision, labels)}</span>{' '}
            <span className='text-slate-500 dark:text-slate-400'>
              {revisionSentence(revision, humanDelta, systemDelta)}
            </span>
            {reason && (
              <span
                className='mt-0.5 block truncate text-[11.5px] text-slate-500 dark:text-slate-400'
                data-revision-reason
                data-tip={reason}
              >
                Reason: {reason}
              </span>
            )}
          </span>
          <AgentBadge label={revision.via_agent} />
          <span
            className='shrink-0 text-[11px] tabular-nums text-slate-400'
            title={revision.timestamp ? formatDateTime(revision.timestamp) : undefined}
          >
            {exactTime}
          </span>
          {expanded ? (
            <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          ) : (
            <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          )}
        </button>
      </div>

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

          {showNotes && <RevisionAnnotations revisionId={revision.id ?? ''} />}

          <FieldChangeList
            before={sideBefore}
            after={sideAfter}
            meta={meta}
            fieldRevert={fieldRevert}
            mode={view}
            hideStatusChips={isCreate}
            ownFields={isUpdate && revision.delta ? ownDeltaFields : null}
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
                    className='rounded border border-nvr-cyan/40 px-2 py-0.5 text-[10.5px] font-medium text-nvr-cyan hover:bg-nvr-cyan/10 disabled:opacity-40'
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

function TimeTravelTools({
  data,
  history,
  meta,
  labels
}: {
  data: Revision[]
  /** Every history row, events included. */
  history: Revision[]
  meta: FieldMetaMap
  labels?: ActivityLabels
}) {
  const [openTool, setOpenTool] = useState<'replay' | 'compare' | null>(null)
  const [diffFrom, setDiffFrom] = useState('')
  const [diffTo, setDiffTo] = useState('')

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
          onClick={() => setOpenTool(openTool === 'replay' ? null : 'replay')}
          disabled={data.length === 0}
          aria-expanded={openTool === 'replay'}
          data-history-replay-toggle
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50',
            openTool === 'replay'
              ? 'border-nvr-cyan/40 bg-nvr-cyan/5 font-medium text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-slate-400 dark:hover:text-slate-200'
          )}
        >
          <History className='h-3.5 w-3.5' />
          Replay the record
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

      {openTool === 'replay' && (
        <HistoryReplay snapshots={data} history={history} meta={meta} labels={labels} />
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
                            {f.by.when ? ` · ${toLocalDateString(f.by.when)}` : ''}
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
  // #1881 — an open history takes new changes at the top as they land
  // (someone else's write; the record form refreshes after its own save),
  // and marks the rows that arrived while it was open.
  const qc = useQueryClient()
  useLiveRecordQueries(collection, item, [['revisions', collection, item]], { client: qc })
  const seenRef = useRef<Set<string> | null>(null)
  const freshKeys = useMemo(() => {
    if (!data) return new Set<string>()
    const keys = data.map(rowKey)
    if (!seenRef.current) {
      seenRef.current = new Set(keys)
      return new Set<string>()
    }
    const seen = seenRef.current
    return new Set(keys.filter((k) => !seen.has(k)))
  }, [data])
  const count = data?.length ?? 0
  const snapshots = useMemo(() => (data ?? []).filter(isSnapshot), [data])
  // Migration 516: names for the actors rows carry (the admin behind a View-as, the person an
  // assistant acted for) — one labels read, only when some row has one.
  const actorRows = useMemo(
    () =>
      (data ?? [])
        .filter((r) => r.actor && r.actor.kind !== 'person')
        .map((r) => ({ action: r.action, user: r.user_id, actor: r.actor })),
    [data]
  )
  const actorLabels = useActivityLabels(actorRows, { enabled: actorRows.length > 0 })

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
    <RevisionLabelsContext.Provider value={actorLabels}>
      <div className='space-y-3 pt-3'>
        <TimeTravelTools data={snapshots} history={data ?? []} meta={meta} labels={actorLabels} />
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
                const isLast = globalIdx === (data?.length ?? 1) - 1
                if (isEvent(rev)) {
                  return (
                    <div
                      key={rowKey(rev)}
                      className={cn(
                        'nvr-fade-in relative',
                        freshKeys.has(rowKey(rev)) && 'rounded-md bg-nvr-cyan/[0.06]'
                      )}
                    >
                      {freshKeys.has(rowKey(rev)) && <NewMark />}
                      <EventRow revision={rev} isLast={isLast} />
                    </div>
                  )
                }
                // The previous SNAPSHOT — an event row between two saves must
                // not make the later save read as "every field changed".
                const prev = (data ?? []).slice(globalIdx + 1).find(isSnapshot)
                return (
                  <div
                    key={rowKey(rev)}
                    className={cn(
                      'nvr-fade-in relative',
                      freshKeys.has(rowKey(rev)) && 'rounded-md bg-nvr-cyan/[0.06]'
                    )}
                  >
                    {freshKeys.has(rowKey(rev)) && <NewMark />}
                    <RevisionRow
                      revision={rev}
                      previousData={prev?.data ?? null}
                      meta={meta}
                      onRollback={onRollback}
                      inlineTableFields={inlineTableFields}
                      isLast={isLast}
                    />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </RevisionLabelsContext.Provider>
  )
}

/** A history row that landed while the panel was open (#1881). */
function NewMark() {
  return (
    // Under the timeline dot, inside the row's 36px gutter.
    <span
      data-revision-new
      className='pointer-events-none absolute left-0 top-[32px] z-[1] w-9 text-center text-[8.5px] font-bold uppercase leading-3 tracking-wide text-[#0e7490] dark:text-[#67e8f9]'
    >
      New
    </span>
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
  onOpenChange,
  compact
}: {
  collection: string
  item: string
  onRollback?: () => void
  triggerClassName?: string
  /** Icon-only, borderless trigger — for the record header's tool group. */
  compact?: boolean
  inlineTableFields?: O2MFieldInfo[]
  /** Controlled mode (no trigger button) — open the sheet programmatically,
   *  e.g. from a row Actions menu. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const controlled = open !== undefined
  const [view, setView] = useState<HistoryView>(readHistoryView)
  const changeView = (v: HistoryView) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* private window: the choice lasts this visit */
    }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {!controlled && (
        <SheetTrigger asChild>
          <Button
            variant={compact ? 'ghost' : 'outline'}
            size='sm'
            title={compact ? 'History — revisions of this record' : undefined}
            aria-label='History'
            className={triggerClassName ?? (compact ? 'h-8 w-8 rounded-none p-0' : 'gap-1.5')}
          >
            <Clock className={compact ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
            {!compact && 'History'}
          </Button>
        </SheetTrigger>
      )}
      <SheetContent
        className={cn(
          'overflow-y-auto p-0 transition-[width] duration-200 ease-out sm:max-w-[92vw]',
          // The table lays the fields out as columns: it gets the room for them.
          view === 'table' ? 'w-[1320px]' : 'w-[720px]'
        )}
      >
        {/* Padding lives on this wrapper, NOT the scroll container — sticky
            day headers pin at the scroller's padding edge, so padding on the
            scroller left a see-through band above the pinned header. */}
        <div className='p-6'>
          <SheetHeader>
            <div className='flex flex-wrap items-center gap-x-4 gap-y-2 pr-8'>
              <SheetTitle className='flex items-center gap-2 text-base'>
                <Clock className='h-4 w-4 text-slate-400' />
                Revision history
              </SheetTitle>
              <HistoryViewSwitch view={view} onChange={changeView} />
            </div>
            <p className='text-[12px] text-slate-500 dark:text-slate-400'>
              {view === 'table'
                ? 'Each save is a row and each field a column — read down a column to follow it over time, totals included.'
                : 'Who changed what, when — expand any entry to see the exact values, revert a single field, or restore the whole version.'}
            </p>
          </SheetHeader>
          {view === 'table' ? (
            <RevisionChangesView collection={collection} item={item} />
          ) : (
            <>
              <RevisionValueSearch collection={collection} item={item} />
              <IntegrationActivitySection collection={collection} item={String(item)} />
              <RevisionsList
                collection={collection}
                item={item}
                onRollback={onRollback}
                inlineTableFields={inlineTableFields}
              />
            </>
          )}
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
                    {m.user_name ?? 'System'} · {m.timestamp ? formatDateTime(m.timestamp) : ''} ·{' '}
                    {m.action}
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
            — {n.user_name ?? 'someone'} · {toLocalDateString(n.created_at)}
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

// ─── People: an avatar opens the person's card ─────────────────────────────

/** The person behind a history entry: their avatar opens the same user card as a user chip
 *  (profile, message, presence). No person (an automatic move, a sync with no user) = a mark. */
function RevisionAvatar({
  userId,
  name,
  size = 'md'
}: {
  userId: string | null
  name: string
  size?: 'sm' | 'md'
}) {
  const box = size === 'sm' ? 'h-5 w-5 text-[9px]' : 'h-6 w-6 text-[10px]'
  const initials =
    name
      .split(' ')
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '·'
  const face = (
    <UserAvatar
      userId={userId}
      className={box}
      fallback={
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-full bg-nvr-cyan/10 font-semibold text-nvr-navy dark:text-nvr-cyan',
            box
          )}
        >
          {initials}
        </span>
      }
    />
  )
  if (!userId) return <span className='shrink-0'>{face}</span>
  return (
    <UserChip userId={userId}>
      <button
        type='button'
        aria-label={`${name} — open profile card`}
        data-revision-avatar
        onClick={(e) => e.stopPropagation()}
        className='shrink-0 rounded-full transition-shadow hover:ring-2 hover:ring-nvr-cyan/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
      >
        {face}
      </button>
    </UserChip>
  )
}

// ─── Timeline | Table ───────────────────────────────────────────────────────

type HistoryView = 'timeline' | 'table'
const VIEW_KEY = 'nvr:revisions-view'

function readHistoryView(): HistoryView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'timeline'
  } catch {
    return 'timeline'
  }
}

function HistoryViewSwitch({
  view,
  onChange
}: {
  view: HistoryView
  onChange: (v: HistoryView) => void
}) {
  const opts: Array<{ v: HistoryView; label: string; icon: typeof List }> = [
    { v: 'timeline', label: 'Timeline', icon: List },
    { v: 'table', label: 'Table', icon: Table2 }
  ]
  return (
    <fieldset
      aria-label='How to show the history'
      data-revision-view-switch
      className='m-0 inline-flex min-w-0 shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-0.5 dark:border-border dark:bg-muted'
    >
      {opts.map(({ v, label, icon: Icon }) => {
        const on = view === v
        return (
          <button
            key={v}
            type='button'
            aria-pressed={on}
            onClick={() => onChange(v)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
              on
                ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-card dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            )}
          >
            <Icon className='h-3.5 w-3.5' />
            {label}
          </button>
        )
      })}
    </fieldset>
  )
}

// ─── Table: rows are saves, columns are fields ─────────────────────────────

/** A cell's value as plain text (CSV, tooltips), formatted the way the field shows it. */
function cellText(value: unknown, m: FieldMeta): string {
  if (value === null || value === undefined || value === '') return ''
  if (isRichText(value)) return richTextToText(value)
  if (m.cmp && typeof value !== 'object' && !m.dateOnly) return compareValueText(value, m.cmp)
  return displayValue(value, m.dateOnly)
}

/** Why a field moved on a save without that save writing it (config-derived + who moved it). */
function reasonFor(field: string, row: MatrixRow, meta: FieldMetaMap): RecalcReason {
  const m = metaFor(meta, field)
  return recalcReason(
    field,
    row,
    m.derive ?? null,
    (collection, f) =>
      collection == null
        ? metaFor(meta, f ?? '').label
        : f
          ? titleCase(f.replace(/_/g, ' '))
          : titleCase(collection.replace(/_/g, ' ')),
    (d) => signedCell(d, m)
  )
}

function ReasonLines({ reason }: { reason: RecalcReason }) {
  return (
    // What moved it first (the audit question), then what the value is worked out from.
    <span className='mt-0.5 block text-[10.5px] font-normal leading-snug' data-recalc-reason>
      {reason.because && (
        <span className='block text-amber-800/90 dark:text-amber-200/80'>{reason.because}</span>
      )}
      <span className='block text-slate-500 dark:text-slate-400'>{reason.why}</span>
    </span>
  )
}

const isBlank = (v: unknown) => v === null || v === undefined || v === ''
/** Rich text or a long string: shown as a word diff, not two struck paragraphs. */
const isLongText = (v: unknown) => isRichText(v) || (typeof v === 'string' && v.length > 60)

/** A total's move in the field's own format: "+$2,059.00" for a currency field. */
function signedCell(delta: number, m: FieldMeta): string {
  if (!m.cmp) return signedAmount(delta)
  const text = compareValueText(Math.abs(delta), m.cmp)
  return `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${text}`
}

function ColumnPicker({
  columns,
  shown,
  onChange
}: {
  columns: MatrixColumn[]
  shown: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const changedOnly = columns.filter((c) => c.changes > 0).map((c) => c.field)
  const toggle = (f: string) => {
    const next = new Set(shown)
    if (next.has(f)) next.delete(f)
    else next.add(f)
    onChange(next)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-revision-columns
          className='inline-flex h-8 items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] text-slate-700 transition-colors hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:text-slate-200'
        >
          <Columns3 className='h-3.5 w-3.5 text-slate-400' />
          <span>
            Fields <span className='tabular-nums text-slate-400'>{shown.size}</span>
            <span className='text-slate-400'> of {columns.length}</span>
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[300px] p-0'>
        <Command>
          <CommandInput placeholder='Find a field…' className='text-[12px]' />
          <div className='flex items-center gap-1 border-b border-slate-100 px-2 py-1.5 dark:border-border/60'>
            {(
              [
                ['Changed', changedOnly],
                ['All', columns.map((c) => c.field)],
                ['None', []]
              ] as const
            ).map(([label, list]) => (
              <button
                key={label}
                type='button'
                onClick={() => onChange(new Set(list))}
                className='rounded px-2 py-0.5 text-[11.5px] text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted'
              >
                {label}
              </button>
            ))}
          </div>
          <CommandList className='max-h-[340px]'>
            <CommandEmpty>No field by that name.</CommandEmpty>
            <CommandGroup>
              {columns.map((c) => (
                <CommandItem
                  key={c.field}
                  value={`${c.label} ${c.field}`}
                  onSelect={() => toggle(c.field)}
                  className='text-[12px]'
                >
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
                      shown.has(c.field)
                        ? 'border-nvr-cyan bg-nvr-cyan text-white'
                        : 'border-slate-300 dark:border-slate-600'
                    )}
                  >
                    {shown.has(c.field) && <Check className='h-3 w-3' />}
                  </span>
                  <span className='flex-1 truncate'>{c.label}</span>
                  {c.changes > 0 && (
                    <span className='tabular-nums text-[11px] text-slate-400'>{c.changes}×</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const ACTION_CHIP: Record<SaveAction, string> = {
  created: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  changed: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300',
  deleted: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  restored: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
}

function RevisionChangesView({ collection, item }: { collection: string; item: string }) {
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
  const qc = useQueryClient()
  useLiveRecordQueries(collection, item, [['revisions', collection, item]], { client: qc })
  const actorRows = useMemo(
    () =>
      (data ?? [])
        .filter((r) => r.actor && r.actor.kind !== 'person')
        .map((r) => ({ action: r.action, user: r.user_id, actor: r.actor })),
    [data]
  )
  const labels = useActivityLabels(actorRows, { enabled: actorRows.length > 0 })
  const rows = useMemo(
    () =>
      buildSaveRows((data ?? []) as ChangeSourceRevision[], {
        name: (r) => revisionUserName(r as Revision, labels)
      }),
    [data, labels]
  )
  const columns = useMemo(() => matrixColumns(rows, (f) => metaFor(meta, f)), [rows, meta])
  // Default: every field that ever changed (written or recalculated). The person's own picks win.
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const shownFields = useMemo(
    () => picked ?? new Set(columns.filter((c) => c.changes > 0).map((c) => c.field)),
    [picked, columns]
  )
  const shownColumns = useMemo(
    () => columns.filter((c) => shownFields.has(c.field)),
    [columns, shownFields]
  )
  const [onlyMoving, setOnlyMoving] = useState(true)
  const onlyMovingId = useId()
  const shownRows = useMemo(
    () =>
      onlyMoving
        ? rowsChanging(
            rows,
            shownColumns.map((c) => c.field)
          )
        : rows,
    [rows, shownColumns, onlyMoving]
  )

  const download = () => {
    const csv = matrixCsv(
      shownRows,
      shownColumns,
      (f, v) => cellText(v, metaFor(meta, f)),
      (f, row) => reasonFor(f, row, meta)
    )
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `history-${collection}-${item}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  if (isLoading)
    return (
      <div className='space-y-2 pt-4'>
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className='h-9 rounded-md' />
        ))}
      </div>
    )

  return (
    <div className='pt-4' data-revision-table-view>
      <div className='mb-3 flex flex-wrap items-center gap-2'>
        <ColumnPicker columns={columns} shown={shownFields} onChange={setPicked} />
        <span className='inline-flex items-center gap-1.5'>
          <Checkbox
            id={onlyMovingId}
            checked={onlyMoving}
            onCheckedChange={(v) => setOnlyMoving(v === true)}
            className='h-3.5 w-3.5'
          />
          <label
            htmlFor={onlyMovingId}
            className='cursor-pointer select-none text-[12px] text-slate-600 dark:text-slate-300'
          >
            Only saves that changed these fields
          </label>
        </span>
        <span className='ml-auto inline-flex items-center gap-3 text-[11.5px] text-slate-500 dark:text-slate-400'>
          <span className='inline-flex items-center gap-1.5'>
            <span className='h-2.5 w-2.5 rounded-sm bg-amber-200 dark:bg-amber-500/40' />
            Changed
          </span>
          <span className='inline-flex items-center gap-1'>
            <Sigma className='h-3 w-3' />
            Recalculated
          </span>
          <span className='tabular-nums'>
            {shownRows.length} save{shownRows.length === 1 ? '' : 's'}
          </span>
        </span>
        <Button
          variant='outline'
          size='sm'
          className='h-8 gap-1.5 text-[12px]'
          onClick={download}
          disabled={shownRows.length === 0 || shownColumns.length === 0}
        >
          <Download className='h-3.5 w-3.5' />
          CSV
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className='rounded-lg border border-dashed border-slate-200 py-12 text-center dark:border-border'>
          <p className='text-[13px] font-medium text-slate-600 dark:text-slate-300'>No saves yet</p>
          <p className='mx-auto mt-1 max-w-[42ch] text-[12px] text-slate-400'>
            Every save records the whole record — each one will be a row here.
          </p>
        </div>
      ) : shownColumns.length === 0 ? (
        <div className='rounded-lg border border-dashed border-slate-200 py-12 text-center dark:border-border'>
          <p className='text-[13px] font-medium text-slate-600 dark:text-slate-300'>
            No fields picked
          </p>
          <p className='mx-auto mt-1 max-w-[42ch] text-[12px] text-slate-400'>
            Choose the fields to show as columns from the Fields menu.
          </p>
        </div>
      ) : (
        <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
          <div className='max-h-[calc(100vh-230px)] overflow-auto'>
            <table className='border-separate border-spacing-0 text-left text-[12px]'>
              <thead>
                <tr className='text-[11px] text-slate-500 dark:text-slate-400'>
                  <th className='sticky left-0 top-0 z-[3] w-[112px] min-w-[112px] border-b border-r border-slate-200 bg-slate-50 px-3 py-2 font-medium dark:border-border dark:bg-muted'>
                    When
                  </th>
                  <th className='sticky left-[112px] top-0 z-[3] w-[176px] min-w-[176px] border-b border-r border-slate-200 bg-slate-50 px-3 py-2 font-medium dark:border-border dark:bg-muted'>
                    Changed by
                  </th>
                  {shownColumns.map((c) => (
                    <th
                      key={c.field}
                      title={c.field}
                      className='sticky top-0 z-[2] min-w-[132px] max-w-[260px] border-b border-slate-200 bg-slate-50 px-3 py-2 font-medium dark:border-border dark:bg-muted'
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownRows.map((r) => (
                  <tr key={r.key} className='group align-top' data-save-action={r.action}>
                    <td className='sticky left-0 z-[1] border-b border-r border-slate-100 bg-white px-3 py-2 group-hover:bg-slate-50 dark:border-border/50 dark:bg-card dark:group-hover:bg-muted'>
                      {r.timestamp && (
                        <span
                          className='block tabular-nums leading-tight'
                          title={formatDateTime(r.timestamp)}
                        >
                          <span className='block text-slate-700 dark:text-slate-200'>
                            {toLocalDateString(r.timestamp)}
                          </span>
                          <span className='block text-[11px] text-slate-400'>
                            {new Date(r.timestamp).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit'
                            })}
                          </span>
                        </span>
                      )}
                    </td>
                    <td className='sticky left-[112px] z-[1] border-b border-r border-slate-100 bg-white px-3 py-2 group-hover:bg-slate-50 dark:border-border/50 dark:bg-card dark:group-hover:bg-muted'>
                      <span className='flex items-center gap-2'>
                        <RevisionAvatar userId={r.userId} name={r.who} size='sm' />
                        <span className='min-w-0'>
                          <span className='block truncate text-slate-700 dark:text-slate-200'>
                            {r.who}
                          </span>
                          {r.action !== 'changed' && (
                            <span
                              className={cn(
                                'mt-0.5 inline-block rounded px-1.5 py-px text-[10.5px] font-medium',
                                ACTION_CHIP[r.action]
                              )}
                            >
                              {saveActionLabel(r.action)}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    {shownColumns.map((c) => {
                      const m = metaFor(meta, c.field)
                      const v = r.values[c.field]
                      const own = r.changed.has(c.field)
                      const recalc = r.recalculated.has(c.field)
                      const moved = own || recalc
                      const reason = recalc ? reasonFor(c.field, r, meta) : null
                      const tip = reason
                        ? `${reason.why}${reason.because ? ` — ${reason.because}` : ''}`
                        : undefined
                      const empty = v === null || v === undefined || v === ''
                      return (
                        <td
                          key={c.field}
                          data-cell-changed={moved || undefined}
                          className={cn(
                            'max-w-[260px] border-b border-slate-100 px-3 py-2 dark:border-border/50',
                            moved
                              ? 'bg-amber-50 group-hover:bg-amber-100/70 dark:bg-amber-500/10 dark:group-hover:bg-amber-500/15'
                              : 'group-hover:bg-slate-50 dark:group-hover:bg-muted/40'
                          )}
                        >
                          <span
                            className={cn(
                              'flex items-start gap-1',
                              moved
                                ? 'font-medium text-slate-900 dark:text-slate-50'
                                : 'text-slate-500 dark:text-slate-400'
                            )}
                          >
                            {recalc && (
                              <Sigma
                                className='mt-[3px] h-3 w-3 shrink-0 text-amber-700 dark:text-amber-300'
                                aria-label='Recalculated'
                              />
                            )}
                            <span
                              className='line-clamp-3 break-words'
                              data-tip={tip ?? (empty ? undefined : cellText(v, m))}
                            >
                              {empty ? (
                                <span className='font-normal italic text-slate-300 dark:text-slate-600'>
                                  {moved ? 'cleared' : '—'}
                                </span>
                              ) : m.relatedCollection &&
                                (typeof v === 'string' || typeof v === 'number') ? (
                                <RelationValue collection={m.relatedCollection} id={v} />
                              ) : (
                                cellText(v, m)
                              )}
                            </span>
                          </span>
                          {reason ? (
                            <span className='line-clamp-4' data-tip={tip}>
                              <ReasonLines reason={reason} />
                            </span>
                          ) : null}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <p className='mt-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
          Pipeline step moves and line edits that changed no field on this record are in Timeline.
        </p>
      )}
    </div>
  )
}

// ─── Replay: the record at any save, step by step ───────────────────────────

function HistoryReplay({
  snapshots,
  history,
  meta,
  labels
}: {
  snapshots: Revision[]
  /** Every history row (line writes included) — names who moved a recalculated total. */
  history: Revision[]
  meta: FieldMetaMap
  labels?: ActivityLabels
}) {
  const ordered = useMemo(() => [...snapshots].reverse(), [snapshots]) // oldest → newest
  const saveRows = useMemo(
    () =>
      buildSaveRows(history as ChangeSourceRevision[], {
        name: (r) => revisionUserName(r as Revision, labels)
      }),
    [history, labels]
  )
  const [idx, setIdx] = useState(Math.max(0, ordered.length - 1))
  const [playing, setPlaying] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [jump, setJump] = useState('')
  const last = ordered.length - 1
  useEffect(() => {
    if (idx > last) setIdx(Math.max(0, last))
  }, [idx, last])
  useEffect(() => {
    if (!playing) return
    if (idx >= last) {
      setPlaying(false)
      return
    }
    const t = setTimeout(() => setIdx((i) => i + 1), 1800)
    return () => clearTimeout(t)
  }, [playing, idx, last])

  const cur = ordered[idx]
  const prev = idx > 0 ? ordered[idx - 1] : null
  const changed = useMemo(() => {
    if (!cur) return []
    const rows = computeFieldRows(prev?.data ?? {}, cur.data ?? {}, meta).filter(
      (r) => r.status !== 'unchanged' && !r.system && r.field !== 'id'
    )
    if (!prev) return []
    const mine = new Set(Object.keys(cur.delta ?? {}))
    const before = prev.data ?? {}
    // A field the save before never recorded (a partial create) has no "before" — not a change.
    // What the person wrote first, then what was recalculated around it.
    return rows
      .filter((r) => mine.has(r.field) || r.field in before)
      .sort((a, b) => Number(!mine.has(a.field)) - Number(!mine.has(b.field)))
  }, [cur, prev, meta])
  const own = new Set(Object.keys(cur?.delta ?? {}))
  const ownCount = changed.filter((r) => own.has(r.field)).length
  const recalcCount = changed.length - ownCount
  const curRow = saveRows.find((r) => r.key === `${cur?.id}|${cur?.timestamp ?? ''}`)
  const record = useMemo(
    () =>
      Object.entries(cur?.data ?? {})
        .filter(
          ([k, v]) =>
            k !== 'id' && v !== null && v !== undefined && v !== '' && !metaFor(meta, k).system
        )
        .sort(([a], [b]) => metaFor(meta, a).label.localeCompare(metaFor(meta, b).label)),
    [cur, meta]
  )

  const go = (i: number) => {
    setPlaying(false)
    setIdx(Math.min(last, Math.max(0, i)))
  }
  const onJump = (v: string) => {
    setJump(v)
    if (!v) return
    const cut = new Date(`${v}T23:59:59`).getTime()
    let at = -1
    ordered.forEach((r, i) => {
      if (r.timestamp && new Date(r.timestamp).getTime() <= cut) at = i
    })
    if (at >= 0) go(at)
  }
  if (!cur) return null
  const who = revisionUserName(cur, labels)
  const what =
    cur.action === 'create'
      ? 'created the record'
      : cur.action === 'delete'
        ? 'deleted the record'
        : cur.action === 'restore'
          ? 'restored the record'
          : ownCount
            ? `changed ${ownCount} field${ownCount === 1 ? '' : 's'}${recalcCount ? ` · ${recalcCount} recalculated` : ''}`
            : recalcCount
              ? `saved the record · ${recalcCount} recalculated`
              : 'saved the record'
  const jumpTooEarly =
    jump !== '' &&
    ordered[0]?.timestamp != null &&
    new Date(`${jump}T23:59:59`).getTime() < new Date(ordered[0].timestamp as string).getTime()

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-history-replay
    >
      {/* The rail: one stop per save, oldest on the left. Arrow keys step. */}
      <div className='border-b border-slate-100 px-3 pb-2 pt-3 dark:border-border/60'>
        <div
          role='slider'
          tabIndex={0}
          aria-label='Save shown'
          aria-valuemin={1}
          aria-valuemax={ordered.length}
          aria-valuenow={idx + 1}
          aria-valuetext={`${idx + 1} of ${ordered.length}${cur.timestamp ? `, ${formatDateTime(cur.timestamp)}` : ''}, ${who}`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') go(idx - 1)
            else if (e.key === 'ArrowRight') go(idx + 1)
            else if (e.key === 'Home') go(0)
            else if (e.key === 'End') go(last)
            else return
            e.preventDefault()
          }}
          className='relative h-6 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <span
            className='absolute left-2 right-2 top-1/2 h-px -translate-y-1/2 bg-slate-200 dark:bg-border'
            aria-hidden
          />
          <span
            className='absolute left-2 top-1/2 h-0.5 -translate-y-1/2 bg-nvr-cyan transition-[width] duration-300 ease-out motion-reduce:transition-none'
            style={{ width: last > 0 ? `calc((100% - 1rem) * ${idx / last})` : '0' }}
            aria-hidden
          />
          {ordered.map((r, i) => {
            const pos = last > 0 ? i / last : 0.5
            const on = i === idx
            return (
              <button
                key={rowKey(r)}
                type='button'
                tabIndex={-1}
                onClick={() => go(i)}
                aria-label={`${r.timestamp ? formatDateTime(r.timestamp) : 'Save'} — ${revisionUserName(r, labels)}`}
                data-tip={`${r.timestamp ? formatDateTime(r.timestamp) : ''} · ${revisionUserName(r, labels)}`}
                className='absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-1'
                style={{ left: `calc(0.5rem + (100% - 1rem) * ${pos})` }}
              >
                <span
                  className={cn(
                    'block rounded-full transition-all',
                    on
                      ? 'h-3 w-3 bg-nvr-cyan ring-4 ring-nvr-cyan/20'
                      : cn(
                          'h-2 w-2 hover:scale-125',
                          i < idx ? 'bg-nvr-cyan/70' : 'bg-slate-300 dark:bg-slate-600',
                          r.action === 'create' && 'bg-emerald-500'
                        )
                  )}
                />
              </button>
            )
          })}
        </div>
        <div className='mt-1 flex justify-between text-[10.5px] tabular-nums text-slate-400'>
          {/* The stops are saves, evenly spaced — the labels say so, so gaps never read as time. */}
          <span>
            Save 1{ordered[0]?.timestamp ? ` · ${toLocalDateString(ordered[0].timestamp)}` : ''}
          </span>
          <span>
            Save {ordered.length}
            {ordered[last]?.timestamp ? ` · ${toLocalDateString(ordered[last].timestamp)}` : ''}
          </span>
        </div>
      </div>

      <div className='flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-3 py-2 dark:border-border/60'>
        <Button
          variant='outline'
          size='sm'
          className='h-7 w-7 p-0'
          onClick={() => go(idx - 1)}
          disabled={idx === 0}
          aria-label='Previous save'
        >
          <ChevronLeft className='h-3.5 w-3.5' />
        </Button>
        <Button
          size='sm'
          className='h-7 gap-1.5 bg-nvr-cyan px-3 text-[12px] text-white hover:bg-nvr-cyan/90'
          onClick={() => {
            if (!playing && idx >= last) setIdx(0)
            setPlaying((v) => !v)
          }}
          disabled={ordered.length < 2}
          data-replay-play
        >
          {playing ? <Pause className='h-3.5 w-3.5' /> : <Play className='h-3.5 w-3.5' />}
          {playing ? 'Pause' : idx >= last ? 'Replay from the start' : 'Play'}
        </Button>
        <Button
          variant='outline'
          size='sm'
          className='h-7 w-7 p-0'
          onClick={() => go(idx + 1)}
          disabled={idx >= last}
          aria-label='Next save'
        >
          <ChevronRight className='h-3.5 w-3.5' />
        </Button>
        <span className='ml-1 tabular-nums text-[11.5px] text-slate-500 dark:text-slate-400'>
          Save {idx + 1} of {ordered.length}
          {idx === last ? ' · current' : ''}
        </span>
        <label className='ml-auto inline-flex items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
          <CalendarClock className='h-3.5 w-3.5' />
          Jump to
          <input
            type='date'
            value={jump}
            onChange={(e) => onJump(e.target.value)}
            className='h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'
            aria-label='Jump to the record as it was on a date'
            data-as-of
          />
        </label>
      </div>

      <div className='px-3 py-3'>
        <div className='flex items-center gap-2'>
          <RevisionAvatar userId={cur.user_id} name={who} />
          <p className='min-w-0 flex-1 text-[12.5px] text-slate-700 dark:text-slate-200'>
            <span className='font-medium'>{who}</span>{' '}
            <span className='text-slate-500 dark:text-slate-400'>{what}</span>
          </p>
          <span className='shrink-0 tabular-nums text-[11.5px] text-slate-400'>
            {cur.timestamp ? formatDateTime(cur.timestamp) : ''}
          </span>
        </div>
        {jumpTooEarly && (
          <p className='mt-2 text-[12px] text-slate-500 dark:text-slate-400'>
            The record did not exist yet on that date — showing its first save.
          </p>
        )}

        {changed.length > 0 && (
          <div className='mt-3 overflow-hidden rounded-md border border-amber-200/80 dark:border-amber-900/50'>
            {changed.map((r) => (
              <div
                key={r.field}
                className='grid grid-cols-[minmax(120px,180px)_1fr] gap-3 border-b border-amber-100 bg-amber-50/60 px-2.5 py-1.5 last:border-0 dark:border-amber-900/30 dark:bg-amber-950/20'
                data-replay-changed={r.field}
              >
                <span className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                  {metaFor(meta, r.field).label}
                  {!own.has(r.field) && cur.action === 'update' && (
                    <span className='mt-0.5 flex items-center gap-0.5 text-[10.5px] font-normal text-slate-500 dark:text-slate-400'>
                      <Sigma className='h-3 w-3 text-amber-700 dark:text-amber-300' />
                      recalculated
                    </span>
                  )}
                </span>
                <span className='min-w-0 text-[12px]'>
                  {isLongText(r.before) || isLongText(r.after) ? (
                    // A paragraph that gained a sentence reads as the words that moved.
                    <span className='block break-words leading-relaxed text-slate-700 dark:text-slate-200'>
                      <WordDiff before={r.before} after={r.after} />
                    </span>
                  ) : (
                    <span className='flex flex-wrap items-baseline gap-x-2'>
                      <span
                        className={cn(
                          'text-slate-400',
                          !isBlank(r.before) &&
                            'line-through decoration-slate-300 dark:decoration-slate-600'
                        )}
                      >
                        {isBlank(r.before) ? (
                          '—'
                        ) : (
                          <RevValue value={r.before} meta={metaFor(meta, r.field)} tone='before' />
                        )}
                      </span>
                      <ArrowRight className='h-3 w-3 shrink-0 self-center text-slate-400' />
                      <span className='font-medium text-slate-900 dark:text-slate-100'>
                        <RevValue value={r.after} meta={metaFor(meta, r.field)} tone='after' />
                      </span>
                    </span>
                  )}
                  {curRow && !own.has(r.field) && cur.action === 'update' ? (
                    <ReasonLines reason={reasonFor(r.field, curRow, meta)} />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}

        <button
          type='button'
          onClick={() => setShowAll((v) => !v)}
          className='mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100'
          aria-expanded={showAll}
        >
          {showAll ? (
            <ChevronDown className='h-3.5 w-3.5' />
          ) : (
            <ChevronRight className='h-3.5 w-3.5' />
          )}
          The whole record at this save
          <span className='font-normal text-slate-400'>({record.length} fields)</span>
        </button>
        {showAll && (
          <div className='mt-2 max-h-80 overflow-y-auto rounded-md border border-slate-200 dark:border-border'>
            {record.map(([k, v]) => (
              <div
                key={k}
                className='grid grid-cols-[minmax(120px,180px)_1fr] gap-3 border-b border-slate-100 px-2.5 py-1.5 last:border-0 dark:border-border/60'
              >
                <span className='text-[12px] text-slate-500 dark:text-slate-400' title={k}>
                  {metaFor(meta, k).label}
                </span>
                <span className='break-words text-[12px] text-slate-800 dark:text-slate-200'>
                  <RevValue value={v} meta={metaFor(meta, k)} tone='after' />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
