import type { Command } from '@nivaro/sdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  ChevronDown,
  CopyPlus as CopyDown,
  Loader2,
  Paperclip,
  X
} from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { buildCascadeFilter, type CascadeRule } from '../item-edit/helpers'
import { extractTemplateFields, renderDisplayTemplate } from '../pipeline/relations'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import {
  keepValuesPatch,
  overwrittenBySideEffect,
  type RehearsalReport,
  runPooled,
  type SideEffectChange
} from './requirement-side-effects'

/** Names the move a save is for (api services/requirement-writes.ts). */
const REQUIREMENTS_FOR_HEADER = 'x-nivaro-requirements-for'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransitionRequirementFieldMeta {
  field: string
  label: string
  /** nivaro_fields type of the child column; null when the column has no nivaro_fields row. */
  type: string | null
  /** M2M alias fields edit via junction writes and render a multi-select;
   *  m2o record fields render a single-select over related_collection. */
  kind?: 'm2m' | 'm2o' | 'file' | 'files'
  related_collection?: string
  junction?: string
  fk_to_child?: string
  junction_field?: string
  /** Display formatting hint for read-only context columns. */
  format?: 'currency' | 'number'
  /** m2m selection cap — 1 renders a single-select (pick replaces, closes). */
  max_values?: number
  /** This field is waived + disabled when the row's controlling field matches
   *  one of `in` — e.g. an order-id field disabled for lines bound to an
   *  integrated warehouse (the integration returns the id; the server autofills
   *  it after submit). */
  optional_when?: { field: string; in: Array<string | number>; placeholder?: string }
  /** army5 b01-N2: the line grid's own narrowing (its parent_cascades, e.g.
   *  project → category), resolved by the server against the record. */
  option_filter?: Record<string, unknown>
  /** The field's own dependency_config cascade_filters, built per row. */
  cascade_filters?: CascadeRule[]
}

export interface TransitionRequirementRow {
  id: string | number
  label: string
  complete: boolean
  values: Record<string, unknown>
  /** Read-only context values for the entry's display_fields. */
  display: Record<string, unknown>
  /** The row's values for the parents its fields' cascade_filters read. */
  cascade_values?: Record<string, unknown>
}

export interface TransitionRequirementEntry {
  type: 'child_fields'
  collection: string
  fk_field: string
  title: string
  /** Dialog width override (px or 'NN%'). */
  width?: string
  /** Child fields offered as a header input + apply-to-all-lines button. */
  apply_all?: string[]
  fields: TransitionRequirementFieldMeta[]
  /** Context columns rendered read-only per row. */
  display_fields: TransitionRequirementFieldMeta[]
  rows: TransitionRequirementRow[]
  /** Server-resolved record values to seed EMPTY line inputs from. */
  prefill_values?: Record<string, unknown>
  /** Every row is filled in, but the record says the last attempt failed —
   *  the server asks for a review before re-submitting (its re-submit passes
   *  `reviewed`, so this shows once per attempt). */
  review?: true
  review_message?: string
}

/** Record-level required fields collected on the transitioning record itself
 *  (e.g. order number + supporting warehouse) — rendered as header inputs
 *  above any child tables, saved via a single record PATCH. */
export interface TransitionRecordFieldsEntry {
  type: 'record_fields'
  /** Renders but never blocks submit (e.g. header order number kept for the
   *  copy-to-lines button). */
  optional?: boolean
  /** {recordField: childField} — renders an "apply to lines" button copying
   *  the header value into every non-waived line input for that child field. */
  copy_to_lines?: Record<string, string>
  collection: string
  item: string
  title: string
  fields: TransitionRequirementFieldMeta[]
  values: Record<string, unknown>
  display: Record<string, unknown>
}

/** Mirrors the `requirements` array from the transition endpoint's 422 payload. */
export type TransitionRequirementsPayload = Array<
  TransitionRequirementEntry | TransitionRecordFieldsEntry
>

// ─── Helpers ────────────────────────────────────────────────────────────────────

function rowKey(collection: string, id: string | number): string {
  return `${collection}::${String(id)}`
}

// Same numeric type-string set the other Input-driven PATCH consumers coerce on
// (FieldRenderer / InlineGridField) — the items PATCH endpoint does no coercion.
const NUMERIC_FIELD_TYPES = [
  'integer',
  'bigInteger',
  'float',
  'decimal',
  'numeric',
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'real',
  'money',
  'smallmoney',
  'double',
  'number'
]

// Coerce a non-empty input string by column type before it rides in a PATCH
// body. NaN falls back to the raw string so the server's own 4xx surfaces
// inline instead of us silently writing garbage.
function coerceForPatch(raw: string, type: string | null): unknown {
  if (type && NUMERIC_FIELD_TYPES.includes(type)) {
    const n = Number(raw.trim())
    if (!Number.isNaN(n)) return n
  }
  return raw
}

function toInputValue(v: unknown): string {
  return v == null ? '' : String(v)
}

// Display-column formatting (entry.display_formats server hint): currency and
// plain thousands-grouped numbers; anything non-numeric passes through raw.
export function fmtDisplay(v: unknown, format?: 'currency' | 'number'): string {
  const raw = toInputValue(v)
  if (!format || raw === '') return raw
  const n = Number(raw)
  if (Number.isNaN(n)) return raw
  if (format === 'currency') {
    // Up to 4 decimals: a 100.505 price showed as $100.51 (army6 M2).
    return n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    })
  }
  return n.toLocaleString('en-US')
}

/** A column header: a label that is still the raw column name ("line_number")
 *  reads as words ("Line Number") — army6 M2 / M30 headers. */
export function columnLabel(f: Pick<TransitionRequirementFieldMeta, 'field' | 'label'>): string {
  const label = (f.label ?? '').trim()
  if (!label) return titleCase(f.field)
  return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(label) || label === f.field ? titleCase(label) : label
}

type FieldValue = string | string[]

/** Fields whose value is a list of related ids (junction writes, #814). */
const isListKind = (f: TransitionRequirementFieldMeta) => f.kind === 'm2m' || f.kind === 'files'

function recordEntryKey(entry: TransitionRecordFieldsEntry): string {
  return rowKey(entry.collection, `record:${entry.item}`)
}

// seedPrefill: seed EMPTY line inputs from the entry's server-resolved
// prefill_values (e.g. per-line warehouses from the record's supporting
// warehouse). Only the editable `values` state seeds — the saved snapshot
// keeps the true persisted state so Submit still writes the seeded values.
function snapshotValues(
  payload: TransitionRequirementsPayload,
  seedPrefill = false
): Record<string, Record<string, FieldValue>> {
  const snapshot: Record<string, Record<string, FieldValue>> = {}
  for (const entry of payload) {
    if (entry.type === 'record_fields') {
      const fieldValues: Record<string, FieldValue> = {}
      for (const f of entry.fields) {
        const raw = entry.values[f.field]
        fieldValues[f.field] = isListKind(f)
          ? Array.isArray(raw)
            ? raw.map(String)
            : []
          : toInputValue(raw)
      }
      snapshot[recordEntryKey(entry)] = fieldValues
      continue
    }
    for (const row of entry.rows) {
      const fieldValues: Record<string, FieldValue> = {}
      for (const f of entry.fields) {
        let v: FieldValue =
          f.kind === 'm2m'
            ? Array.isArray(row.values[f.field])
              ? (row.values[f.field] as unknown[]).map(String)
              : []
            : toInputValue(row.values[f.field])
        if (seedPrefill && entry.prefill_values?.[f.field] != null) {
          const seed = entry.prefill_values[f.field]
          if (f.kind === 'm2m' && Array.isArray(v) && v.length === 0) v = [String(seed)]
          else if (f.kind !== 'm2m' && v === '') v = String(seed)
        }
        fieldValues[f.field] = v
      }
      snapshot[rowKey(entry.collection, row.id)] = fieldValues
    }
  }
  return snapshot
}

/** The server's display for a file field: a name, or [{id, name}]. */
function fileNamesOf(display: unknown): Record<string, string> {
  if (Array.isArray(display)) {
    const out: Record<string, string> = {}
    for (const d of display as Array<{ id?: unknown; name?: unknown }>) {
      if (d?.id != null) out[String(d.id)] = String(d.name ?? d.id)
    }
    return out
  }
  return typeof display === 'string' ? { __single__: display } : {}
}

/** #814 — a record-level file / files requirement: upload, list, remove. */
function FileUploadCell({
  multiple,
  ids,
  initialNames,
  onChange
}: {
  multiple: boolean
  ids: string[]
  initialNames: Record<string, string>
  onChange: (ids: string[]) => void
}) {
  const client = useNivaroClient()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameOf = (id: string) =>
    names[id] ?? initialNames[id] ?? (!multiple ? initialNames.__single__ : undefined) ?? id
  async function add(list: FileList | null) {
    if (!list?.length) return
    setUploading(true)
    setError(null)
    const added: string[] = []
    try {
      for (const f of Array.from(list).slice(0, multiple ? 20 : 1)) {
        const r = await client.upload(f)
        const id = String(r.id)
        added.push(id)
        setNames((p) => ({ ...p, [id]: f.name }))
      }
    } catch {
      setError('A file could not be uploaded')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
    if (added.length) onChange(multiple ? [...ids, ...added] : added.slice(0, 1))
  }
  return (
    <div className='space-y-1.5' data-requirement-file={multiple ? 'files' : 'file'}>
      {ids.length > 0 && (
        <ul className='space-y-1'>
          {ids.map((id) => (
            <li
              key={id}
              className='flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-[12px] text-slate-700 dark:border-border dark:text-slate-200'
            >
              <Paperclip className='h-3 w-3 shrink-0 text-slate-400' />
              <span className='min-w-0 flex-1 truncate'>{nameOf(id)}</span>
              <button
                type='button'
                aria-label={`Remove ${nameOf(id)}`}
                onClick={() => onChange(ids.filter((x) => x !== id))}
                className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
              >
                <X className='h-3 w-3' />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(multiple || ids.length === 0) && (
        <>
          <input
            ref={inputRef}
            type='file'
            multiple={multiple}
            className='hidden'
            onChange={(e) => void add(e.target.files)}
          />
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className='h-8 gap-1.5 text-[12px]'
            data-requirement-upload
          >
            {uploading ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <Paperclip className='h-3.5 w-3.5' />
            )}
            {uploading ? 'Uploading…' : multiple ? 'Add files' : 'Upload a file'}
          </Button>
        </>
      )}
      {error && <p className='text-[11px] text-red-600'>{error}</p>}
    </div>
  )
}

// ─── Portal dropdown panel ───────────────────────────────────────────────────
// The pick cells live inside the dialog's overflow-x-auto table wrapper — a
// position:absolute listbox gets clipped there. The panel portals into the
// DIALOG CONTENT element (not document.body: Radix's modal lock makes body
// content pointer-events:none, and clicks there count as outside-interactions
// that close the dialog). DialogContent is the transform ancestor, so the
// panel positions absolutely with coords computed relative to its rect —
// escaping DialogBody's overflow while staying inside the interactive tree.
// Flips upward when there's no viewport room below; repositions on scroll
// (capture catches DialogBody's scroll) and resize.

function DropPanel({
  anchor,
  panelRef,
  children
}: {
  anchor: HTMLElement
  panelRef: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
}) {
  const container = anchor.closest('[role="dialog"]') as HTMLElement | null
  const [pos, setPos] = useState<{
    top?: number
    bottom?: number
    left: number
    width: number
  } | null>(null)
  useLayoutEffect(() => {
    if (!container) return
    const update = () => {
      const r = anchor.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      const up = r.bottom + 208 > window.innerHeight && r.top > 216
      setPos(
        up
          ? { bottom: c.bottom - r.top + 4, left: r.left - c.left, width: r.width }
          : { top: r.bottom - c.top + 4, left: r.left - c.left, width: r.width }
      )
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [anchor, container])
  if (!pos || !container) return null
  return createPortal(
    <div
      ref={panelRef}
      role='listbox'
      className='absolute z-[120] max-h-48 w-56 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-border dark:bg-card'
      style={{ top: pos.top, bottom: pos.bottom, left: pos.left, minWidth: pos.width }}
    >
      {children}
    </div>,
    container
  )
}

// ─── Related-record options ──────────────────────────────────────────────────
// Labelled the way every other picker labels them: the related collection's
// display template (categories: "{{core_category.name}} - {{sub_category.name}}"),
// then the usual name-like columns. The dialog used to read name/title/label
// only, so a collection labelled through its relations listed bare ids
// ("57", "58" … "245") and nobody could tell which one they picked (army5 b09).

/** One option's label: template → name-like column → "#id". */
export function relatedOptionLabel(
  template: string | null | undefined,
  row: Record<string, unknown>
): string {
  const id = String(row.id ?? '')
  if (template) {
    const text = renderDisplayTemplate(template, row).trim()
    // A template whose parts are all empty renders only its separators.
    if (/[\p{L}\p{N}]/u.test(text)) return text
  }
  const plain = renderDisplayTemplate(null, {
    ...row,
    short_name: undefined
  }).trim()
  if (plain && plain !== id) return plain
  if (row.short_name != null && row.short_name !== '') return String(row.short_name)
  return id ? `#${id}` : ''
}

/** The options filter for one picker (army5 b01-N2): the grid's narrowing the
 *  server resolved AND the field's own cascade built from this row's values
 *  — the same compiler the form's pickers use (buildCascadeFilter). */
export function requirementOptionFilter(
  meta: Pick<TransitionRequirementFieldMeta, 'option_filter' | 'cascade_filters'>,
  rowValues?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const parts: Record<string, unknown>[] = []
  if (meta.option_filter && Object.keys(meta.option_filter).length > 0)
    parts.push(meta.option_filter)
  if (meta.cascade_filters?.length) {
    const { filter } = buildCascadeFilter({
      rules: meta.cascade_filters,
      parentValue: (p) => rowValues?.[p]
    })
    if (filter && Object.keys(filter).length > 0) parts.push(filter)
  }
  if (parts.length === 0) return undefined
  return parts.length === 1 ? parts[0] : { _and: parts }
}

function useRelatedOptions(
  collection: string | undefined,
  filter?: Record<string, unknown>
): { options: Array<{ id: string; label: string }>; loaded: boolean } {
  const client = useNivaroClient()
  // Same key + shape as RelationCombobox's read, so the cache is shared.
  const { data: colMeta, isPending: metaPending } = useQuery<{ display_template?: string }>({
    queryKey: ['col-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${collection}`))
        .then((r) => r.data ?? {}),
    enabled: !!collection,
    staleTime: 300_000,
    retry: false
  })
  const template = colMeta?.display_template ?? null
  const tmplFields = template ? extractTemplateFields(template).join(',') : undefined
  const filterKey = filter ? JSON.stringify(filter) : ''
  const { data = [], isSuccess } = useQuery({
    queryKey: ['req-related-options', collection, template ?? '', filterKey],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${collection}`, {
            limit: 500,
            picker: '1',
            ...(tmplFields ? { fields: tmplFields } : {}),
            ...(filterKey ? { filter: filterKey } : {})
          })
        )
        .then((r) =>
          (r.data ?? [])
            .map((row) => ({ id: String(row.id), label: relatedOptionLabel(template, row) }))
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
        )
        .catch(() => [] as Array<{ id: string; label: string }>),
    // The template decides `fields`: wait for it (a miss just means none).
    enabled: !!collection && !metaPending,
    staleTime: 300_000
  })
  return { options: data, loaded: isSuccess }
}

const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9_]*$/

/** The parent a picker's options are narrowed by ("project"), read from its filter. */
function filterParentName(filter: Record<string, unknown> | undefined): string | null {
  let node: unknown = filter
  let found: string | null = null
  for (let depth = 0; depth < 6 && node && typeof node === 'object'; depth++) {
    if (Array.isArray(node)) {
      node = node[0]
      continue
    }
    const entries = Object.entries(node as Record<string, unknown>)
    const logical = entries.find(([k]) => k === '_and' || k === '_or')
    const plain = entries.find(([k]) => PLAIN_KEY.test(k))
    if (plain) {
      if (plain[0] !== 'id') found = plain[0]
      node = plain[1]
    } else if (logical) node = logical[1]
    else break
  }
  return found ? found.replace(/_id$/, '').replace(/_/g, ' ').toLowerCase() : null
}

function pluralNoun(label: string): string {
  const w = label.trim().toLowerCase()
  if (!w) return 'options'
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es`
  return `${w}s`
}

/**
 * Why a requirement picker has nothing to offer (army6 M30): a project with no
 * categories showed "No options" and nobody could tell why or what to do.
 */
export function emptyOptionsText(
  meta: Pick<TransitionRequirementFieldMeta, 'label'>,
  filter: Record<string, unknown> | undefined
): string {
  const noun = pluralNoun(meta.label)
  const parent = filterParentName(filter)
  if (parent)
    return `This ${parent} has no ${noun} set up. Ask an administrator, or pick another ${parent}.`
  return `No ${noun} are set up yet. Ask an administrator.`
}

// ─── M2M multi-select cell ───────────────────────────────────────────────────
// Compact per-row multi-picker for m2m required fields (e.g. per-line
// supporting warehouses) — options from the related collection, toggled ids
// staged in the dialog's values state, written as junction rows on Submit.

function M2MPickCell({
  meta,
  selected,
  onChange,
  rowValues
}: {
  meta: TransitionRequirementFieldMeta
  selected: string[]
  onChange: (ids: string[]) => void
  /** The row's values (cascade parents) — absent for record-level fields. */
  rowValues?: Record<string, unknown>
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const optionFilter = requirementOptionFilter(meta, rowValues)
  const { options, loaded } = useRelatedOptions(meta.related_collection, optionFilter)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const summary =
    selected.length === 0
      ? `Select ${meta.label.toLowerCase()}…`
      : selected.map((id) => options.find((o) => o.id === id)?.label ?? id).join(', ')
  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-haspopup='listbox'
        aria-expanded={open}
        className={cn(
          'flex h-8 w-full min-w-[10rem] items-center justify-between gap-1 rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] dark:border-border dark:bg-card',
          selected.length === 0 && 'text-slate-400'
        )}
      >
        <span className='truncate'>{summary}</span>
        <ChevronDown className='h-3 w-3 shrink-0 text-slate-400' />
      </button>
      {open && rootRef.current && (
        <DropPanel anchor={rootRef.current} panelRef={panelRef}>
          {options.map((o) => {
            const active = selected.includes(o.id)
            const single = meta.max_values === 1
            return (
              <button
                key={o.id}
                type='button'
                role='option'
                aria-selected={active}
                onClick={() => {
                  if (single) {
                    onChange([o.id])
                    setOpen(false)
                    return
                  }
                  onChange(active ? selected.filter((v) => v !== o.id) : [...selected, o.id])
                }}
                className={cn(
                  'flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-muted/50',
                  active
                    ? 'font-semibold text-nvr-navy dark:text-nvr-cyan'
                    : 'text-slate-700 dark:text-slate-200'
                )}
              >
                <span className='truncate'>{o.label}</span>
                {active && <Check className='h-3 w-3 shrink-0' />}
              </button>
            )
          })}
          {options.length === 0 && (
            <p className='max-w-[18rem] px-2.5 py-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
              {loaded ? emptyOptionsText(meta, optionFilter) : 'Loading…'}
            </p>
          )}
        </DropPanel>
      )}
    </div>
  )
}

// ─── M2O single-select (FK fields — record-level or per child row) ──────────────────────────────

function M2OPickCell({
  meta,
  selected,
  onChange,
  rowValues
}: {
  meta: TransitionRequirementFieldMeta
  selected: string
  onChange: (id: string) => void
  /** The row's values (cascade parents) — absent for record-level fields. */
  rowValues?: Record<string, unknown>
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const optionFilter = requirementOptionFilter(meta, rowValues)
  const { options, loaded } = useRelatedOptions(meta.related_collection, optionFilter)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const summary = selected
    ? (options.find((o) => o.id === selected)?.label ?? selected)
    : `Select ${meta.label.toLowerCase()}…`
  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-haspopup='listbox'
        aria-expanded={open}
        className={cn(
          'flex h-8 w-full min-w-[10rem] items-center justify-between gap-1 rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] dark:border-border dark:bg-card',
          !selected && 'text-slate-400'
        )}
      >
        <span className='truncate'>{summary}</span>
        <ChevronDown className='h-3 w-3 shrink-0 text-slate-400' />
      </button>
      {open && rootRef.current && (
        <DropPanel anchor={rootRef.current} panelRef={panelRef}>
          {options.map((o) => {
            const active = selected === o.id
            return (
              <button
                key={o.id}
                type='button'
                role='option'
                aria-selected={active}
                onClick={() => {
                  onChange(o.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-muted/50',
                  active
                    ? 'font-semibold text-nvr-navy dark:text-nvr-cyan'
                    : 'text-slate-700 dark:text-slate-200'
                )}
              >
                <span className='truncate'>{o.label}</span>
                {active && <Check className='h-3 w-3 shrink-0' />}
              </button>
            )
          })}
          {options.length === 0 && (
            <p className='max-w-[18rem] px-2.5 py-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
              {loaded ? emptyOptionsText(meta, optionFilter) : 'Loading…'}
            </p>
          )}
        </DropPanel>
      )}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TransitionRequirementsDialog({
  payload,
  transitionId,
  isRetry,
  onSubmitted,
  executing = false,
  onClose
}: {
  payload: TransitionRequirementsPayload
  /** The move these values are for: each value's save names it, so a record
   *  locked against edits still takes the values its own move asks for, from
   *  someone who may run that move (the server checks, api requirement-writes). */
  transitionId?: string
  /** True when this payload came from a retry's second 422 (values changed underneath). */
  isRetry?: boolean
  /** Runs the transition once the rows are saved. May return the call's
   *  promise: the dialog stays busy (button disabled, spinner) until it
   *  settles, whether or not the host also passes `executing`. */
  onSubmitted: () => void | Promise<unknown>
  /** True while the PARENT is executing the transition (external submissions
   *  can take several seconds) — the dialog stays open showing progress. */
  executing?: boolean
  onClose: () => void
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, Record<string, FieldValue>>>(() =>
    snapshotValues(payload, true)
  )
  const savedRef = useRef<Record<string, Record<string, FieldValue>>>(snapshotValues(payload))
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [phase, setPhase] = useState<'save' | 'transition'>('save')
  // The header rides only these saves. Built inline, not with the SDK's
  // withHeaders: @nivaro/react takes the SDK as a peer, and a host on an older
  // SDK simply sends the save without it.
  const forMove = <T,>(command: Command<T>): Command<T> =>
    transitionId
      ? ({ ...command, _headers: { [REQUIREMENTS_FOR_HEADER]: transitionId } } as Command<T>)
      : command

  const setFieldValue = (rk: string, field: string, v: FieldValue) => {
    setValues((prev) => ({ ...prev, [rk]: { ...prev[rk], [field]: v } }))
    setRowErrors((prev) => {
      if (!(rk in prev)) return prev
      const next = { ...prev }
      delete next[rk]
      return next
    })
  }

  // Copy the first filled value in a column to every line (e.g. one sales
  // order number shared by all lines).
  const applyToAllLines = (
    entry: TransitionRequirementEntry,
    f: TransitionRequirementFieldMeta
  ) => {
    const source = entry.rows
      .map((r) => values[rowKey(entry.collection, r.id)]?.[f.field])
      .find((v) =>
        f.kind === 'm2m' ? Array.isArray(v) && v.length > 0 : typeof v === 'string' && v.trim()
      )
    if (source == null) return
    setValues((prev) => {
      const next = { ...prev }
      for (const r of entry.rows) {
        const rk = rowKey(entry.collection, r.id)
        next[rk] = { ...next[rk], [f.field]: Array.isArray(source) ? [...source] : source }
      }
      return next
    })
    setRowErrors({})
  }

  // optional_when: a field is waived for a row when its controlling field's
  // CURRENT draft value (live — reacts to in-dialog warehouse picks) matches
  // the rule. Waived fields render disabled and never block submit.
  const isWaived = (rk: string, f: TransitionRequirementFieldMeta): boolean => {
    const rule = f.optional_when
    if (!rule) return false
    const ctl = values[rk]?.[rule.field]
    const allowed = new Set(rule.in.map(String))
    const vals = Array.isArray(ctl) ? ctl : [ctl]
    return vals.some((v) => v != null && v !== '' && allowed.has(String(v)))
  }

  // Header → lines copy: fill the mapped child field on every AVAILABLE line
  // (waived inputs — e.g. integration-supplied order ids — are left alone).
  const [bulkValues, setBulkValues] = useState<Record<string, string>>({})

  const copyHeaderToLines = (headerValue: string, childField: string) => {
    if (!headerValue.trim()) return
    setValues((prev) => {
      const next = { ...prev }
      for (const entry of payload) {
        if (entry.type !== 'child_fields') continue
        const meta = entry.fields.find((f) => f.field === childField)
        if (!meta || meta.kind === 'm2m') continue
        for (const row of entry.rows) {
          const rk = rowKey(entry.collection, row.id)
          const rule = meta.optional_when
          if (rule) {
            const ctl = next[rk]?.[rule.field]
            const allowed = new Set(rule.in.map(String))
            const vals = Array.isArray(ctl) ? ctl : [ctl]
            if (vals.some((v) => v != null && v !== '' && allowed.has(String(v)))) continue
          }
          next[rk] = { ...next[rk], [childField]: headerValue }
        }
      }
      return next
    })
    setRowErrors({})
  }

  const hasEmpty = payload.some((entry) => {
    if (entry.type === 'record_fields') {
      if (entry.optional) return false
      const rk = recordEntryKey(entry)
      return entry.fields.some((f) => {
        if (isWaived(rk, f)) return false
        const v = values[rk]?.[f.field]
        if (isListKind(f)) return !Array.isArray(v) || v.length === 0
        return !(typeof v === 'string' ? v : '').trim()
      })
    }
    return entry.rows.some((row) => {
      const rk = rowKey(entry.collection, row.id)
      return entry.fields.some((f) => {
        if (isWaived(rk, f)) return false
        const v = values[rk]?.[f.field]
        if (f.kind === 'm2m') return !Array.isArray(v) || v.length === 0
        return !(typeof v === 'string' ? v : '').trim()
      })
    })
  })

  // A review_when block: the server sent every row back because the record's
  // last attempt failed — say so once, in the entry's own words if it has any.
  const reviewMessage =
    payload.find((e): e is TransitionRequirementEntry => e.type === 'child_fields' && !!e.review)
      ?.review_message ?? null

  // A pick that also replaces values a line already had (army5 b09): the
  // rows' writes are rehearsed first, and these wait on the person's choice.
  const [sideEffects, setSideEffects] = useState<Array<{
    rk: string
    rowLabel: string
    changes: Array<SideEffectChange & { label: string; format?: 'currency' | 'number' }>
  }> | null>(null)
  // "Keep current values": per row, the values its write also carries.
  const keepRef = useRef<Record<string, Record<string, unknown>>>({})

  /** The scalar values a child row's write would carry (same rules as the
   *  write below: m2m via junctions, waived fields never sent). */
  const scalarRowChanges = (
    entry: TransitionRequirementEntry,
    row: TransitionRequirementRow
  ): Record<string, unknown> => {
    const rk = rowKey(entry.collection, row.id)
    const current = values[rk] ?? {}
    const saved = savedRef.current[rk] ?? {}
    const changed: Record<string, unknown> = {}
    for (const f of entry.fields) {
      if (f.kind === 'm2m' || isWaived(rk, f)) continue
      if (current[f.field] !== saved[f.field])
        changed[f.field] =
          f.kind === 'm2o'
            ? String(current[f.field] ?? '') || null
            : coerceForPatch(String(current[f.field] ?? ''), f.type)
    }
    return changed
  }

  /** Rehearse every child row's write; the values each would replace. A
   *  rehearsal that fails says nothing (the real write reports its own). */
  const rehearseSideEffects = async () => {
    const jobs: Array<() => Promise<NonNullable<typeof sideEffects>[number] | null>> = []
    for (const entry of payload) {
      if (entry.type !== 'child_fields') continue
      const metaOf = (field: string) =>
        entry.display_fields.find((f) => f.field === field) ??
        entry.fields.find((f) => f.field === field)
      for (const row of entry.rows) {
        const sent = scalarRowChanges(entry, row)
        if (Object.keys(sent).length === 0) continue
        const rk = rowKey(entry.collection, row.id)
        jobs.push(() =>
          client
            .request<RehearsalReport>(
              forMove({
                _method: 'PATCH',
                _path: `/items/${entry.collection}/${row.id}`,
                _params: { dry_run: '1' },
                _body: sent
              } as unknown as Command<RehearsalReport>)
            )
            .then((report) => {
              const changes = overwrittenBySideEffect(report, sent, (f) => !!metaOf(f))
              if (changes.length === 0) return null
              return {
                rk,
                rowLabel: row.label,
                changes: changes.map((c) => {
                  const m = metaOf(c.field)
                  return { ...c, label: m ? columnLabel(m) : titleCase(c.field), format: m?.format }
                })
              }
            })
            .catch(() => null)
        )
      }
    }
    // Bounded (REVIEW-R5 M5): one rehearsal per line, ROW_WRITE_CONCURRENCY at a time.
    return (await runPooled(jobs)).filter((x): x is NonNullable<typeof x> => x != null)
  }

  const handleSubmit = async (decision?: 'apply' | 'keep') => {
    setSubmitting(true)
    if (!decision) {
      keepRef.current = {}
      const found = await rehearseSideEffects()
      if (found.length > 0) {
        setSideEffects(found)
        setSubmitting(false)
        return
      }
    } else {
      keepRef.current =
        decision === 'keep'
          ? Object.fromEntries((sideEffects ?? []).map((s) => [s.rk, keepValuesPatch(s.changes)]))
          : {}
      setSideEffects(null)
    }
    // Bounded like the rehearsals (REVIEW-R5 M5): ROW_WRITE_CONCURRENCY writes at a time.
    const results = await runPooled(
      payload.flatMap((entry) => {
        if (entry.type === 'record_fields') {
          const rk = recordEntryKey(entry)
          return [
            async () => {
              const current = values[rk] ?? {}
              const saved = savedRef.current[rk] ?? {}
              const changed: Record<string, unknown> = {}
              const linkChanges: Array<{
                meta: TransitionRequirementFieldMeta
                add: string[]
                remove: string[]
              }> = []
              for (const f of entry.fields) {
                if (isListKind(f)) {
                  const cur = Array.isArray(current[f.field]) ? (current[f.field] as string[]) : []
                  const was = Array.isArray(saved[f.field]) ? (saved[f.field] as string[]) : []
                  const add = cur.filter((v) => !was.includes(v))
                  const remove = was.filter((v) => !cur.includes(v))
                  if (add.length > 0 || remove.length > 0)
                    linkChanges.push({ meta: f, add, remove })
                  continue
                }
                if (current[f.field] !== saved[f.field]) {
                  changed[f.field] =
                    f.kind === 'm2o' || f.kind === 'file'
                      ? String(current[f.field] ?? '') || null
                      : coerceForPatch(String(current[f.field] ?? ''), f.type)
                }
              }
              if (Object.keys(changed).length === 0 && linkChanges.length === 0)
                return { rk, ok: true as const }
              try {
                if (Object.keys(changed).length > 0)
                  await client.request(
                    forMove(patch(`/items/${entry.collection}/${entry.item}`, changed))
                  )
                // Record-level many-to-many / files (#814): junction rows.
                for (const { meta, add, remove } of linkChanges) {
                  if (!meta.junction || !meta.fk_to_child || !meta.junction_field) continue
                  if (remove.length > 0) {
                    const existing = await client.request<{
                      data: Array<Record<string, unknown>>
                    }>(
                      get(`/items/${meta.junction}`, {
                        limit: 500,
                        filter: JSON.stringify({ [meta.fk_to_child]: { _eq: entry.item } })
                      })
                    )
                    for (const j of existing.data ?? []) {
                      if (remove.includes(String(j[meta.junction_field])))
                        await client.request(del(`/items/${meta.junction}/${j.id}`))
                    }
                  }
                  for (const relatedId of add) {
                    await client.request(
                      post(`/items/${meta.junction}`, {
                        [meta.fk_to_child]: entry.item,
                        [meta.junction_field]: relatedId
                      })
                    )
                  }
                }
                queryClient.invalidateQueries({
                  queryKey: ['item', entry.collection, String(entry.item)]
                })
                return { rk, ok: true as const, saved: { ...saved, ...current } }
              } catch (err) {
                const resp = (err as { response?: { error?: string } })?.response
                return { rk, ok: false as const, error: resp?.error ?? 'Failed to save' }
              }
            }
          ]
        }
        return entry.rows.map((row) => async () => {
          const rk = rowKey(entry.collection, row.id)
          const current = values[rk] ?? {}
          const saved = savedRef.current[rk] ?? {}
          const changed: Record<string, unknown> = {}
          const m2mChanges: Array<{
            meta: TransitionRequirementFieldMeta
            add: string[]
            remove: string[]
          }> = []
          for (const f of entry.fields) {
            if (f.kind === 'm2m') {
              const cur = Array.isArray(current[f.field]) ? (current[f.field] as string[]) : []
              const was = Array.isArray(saved[f.field]) ? (saved[f.field] as string[]) : []
              const add = cur.filter((v) => !was.includes(v))
              const remove = was.filter((v) => !cur.includes(v))
              if (add.length > 0 || remove.length > 0) m2mChanges.push({ meta: f, add, remove })
              continue
            }
            // A waived field's draft never rides the PATCH — typing an order
            // id and THEN switching the line to a waived state must not persist the
            // typed value (the server autofills it post-submit).
            if (isWaived(rk, f)) continue
            if (current[f.field] !== saved[f.field]) {
              changed[f.field] =
                f.kind === 'm2o'
                  ? String(current[f.field] ?? '') || null
                  : coerceForPatch(String(current[f.field] ?? ''), f.type)
            }
          }
          if (Object.keys(changed).length === 0 && m2mChanges.length === 0) {
            return { rk, ok: true as const }
          }
          // "Keep current values": what the pick would have replaced rides
          // along, so the server leaves it as it is.
          if (Object.keys(changed).length > 0) {
            for (const [k, v] of Object.entries(keepRef.current[rk] ?? {}))
              if (!(k in changed)) changed[k] = v
          }
          try {
            if (Object.keys(changed).length > 0) {
              await client.request(forMove(patch(`/items/${entry.collection}/${row.id}`, changed)))
            }
            // Junction writes for m2m fields — inserts for adds, targeted
            // deletes (by junction row id) for removals.
            for (const { meta, add, remove } of m2mChanges) {
              if (!meta.junction || !meta.fk_to_child || !meta.junction_field) continue
              if (remove.length > 0) {
                const existing = await client.request<{ data: Array<Record<string, unknown>> }>(
                  get(`/items/${meta.junction}`, {
                    limit: 500,
                    filter: JSON.stringify({ [meta.fk_to_child]: { _eq: row.id } })
                  })
                )
                for (const j of existing.data ?? []) {
                  if (remove.includes(String(j[meta.junction_field]))) {
                    await client.request(del(`/items/${meta.junction}/${j.id}`))
                  }
                }
              }
              for (const relatedId of add) {
                await client.request(
                  post(`/items/${meta.junction}`, {
                    [meta.fk_to_child]: row.id,
                    [meta.junction_field]: relatedId
                  })
                )
              }
            }
            queryClient.invalidateQueries({ queryKey: ['item', entry.collection, String(row.id)] })
            return { rk, ok: true as const, saved: { ...saved, ...current } }
          } catch (err) {
            const resp = (err as { response?: { error?: string } })?.response
            return { rk, ok: false as const, error: resp?.error ?? 'Failed to save' }
          }
        })
      })
    )
    const failures = results.filter((r) => !r.ok)
    for (const r of results) {
      if (r.ok && r.saved) savedRef.current[r.rk] = r.saved
    }
    if (failures.length > 0) {
      setSubmitting(false)
      setRowErrors(Object.fromEntries(failures.map((f) => [f.rk, f.ok ? '' : f.error])))
      return
    }
    setRowErrors({})
    // Stay busy through the transition itself — a second click while the
    // partner push is in flight would submit the order twice. The host
    // reports the outcome (toast / banner / a fresh 422 payload); this only
    // releases the button once that call has settled.
    setPhase('transition')
    try {
      await onSubmitted()
    } catch {
      /* the host's mutation handlers own the error */
    } finally {
      setSubmitting(false)
      setPhase('save')
    }
  }

  const title =
    payload.length === 1 && payload[0].title ? payload[0].title : 'Required before continuing'

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && !executing && onClose()}>
      <DialogContent
        className={cn(
          'max-w-2xl',
          payload.some(
            (e) =>
              e.type === 'child_fields' && (e.display_fields ?? []).length + e.fields.length > 3
          ) && 'max-w-5xl'
        )}
        style={(() => {
          const w = payload.find(
            (e): e is TransitionRequirementEntry => e.type === 'child_fields' && !!e.width
          )?.width
          return w ? { width: w, maxWidth: w } : undefined
        })()}
      >
        <DialogHeader>
          <DialogTitle className='text-[15px]'>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody
          className={cn(
            'max-h-[60vh] space-y-5 overflow-y-auto',
            (submitting || executing) && 'pointer-events-none opacity-60 transition-opacity'
          )}
        >
          {isRetry && (
            <p className='flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400'>
              <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400' />
              Values changed since your last attempt — review the highlighted rows.
            </p>
          )}
          {sideEffects && (
            <div
              data-req-side-effects
              className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300'
            >
              <p className='flex items-center gap-2 font-medium'>
                <AlertCircle className='h-3.5 w-3.5 shrink-0' />
                Your choices also change values these lines already have
              </p>
              <ul className='mt-1.5 space-y-0.5 pl-5'>
                {sideEffects.flatMap((s) =>
                  s.changes.map((c) => (
                    <li key={`${s.rk}:${c.field}`}>
                      {s.rowLabel} · {c.label}: {fmtDisplay(c.from, c.format) || '—'} →{' '}
                      <span className='font-medium'>{fmtDisplay(c.to, c.format) || '—'}</span>
                    </li>
                  ))
                )}
              </ul>
              <p className='mt-1.5 text-[11.5px] text-amber-700/90 dark:text-amber-300/80'>
                Keep the current values, or apply every change.
              </p>
            </div>
          )}
          {reviewMessage && !isRetry && (
            <p className='flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400'>
              <AlertCircle className='h-3.5 w-3.5 shrink-0' />
              {reviewMessage}
            </p>
          )}
          {payload.map((entry) => {
            if (entry.type === 'record_fields') {
              const rk = recordEntryKey(entry)
              return (
                <div key={rk} className='space-y-2'>
                  {payload.length > 1 && (
                    <h4 className='text-[12px] font-semibold text-slate-500'>{entry.title}</h4>
                  )}
                  <div className='grid grid-cols-1 gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-2 dark:border-border'>
                    {entry.fields.map((f) => {
                      const v = values[rk]?.[f.field]
                      return (
                        <div key={f.field} className='space-y-1'>
                          <label className='text-[11px] font-medium text-slate-500'>
                            {f.label}
                          </label>
                          {f.kind === 'm2o' ? (
                            <M2OPickCell
                              meta={f}
                              selected={typeof v === 'string' ? v : ''}
                              onChange={(id) => setFieldValue(rk, f.field, id)}
                            />
                          ) : f.kind === 'm2m' ? (
                            <M2MPickCell
                              meta={f}
                              selected={Array.isArray(v) ? v : []}
                              onChange={(ids) => setFieldValue(rk, f.field, ids)}
                            />
                          ) : f.kind === 'file' || f.kind === 'files' ? (
                            <FileUploadCell
                              multiple={f.kind === 'files'}
                              ids={Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []}
                              initialNames={fileNamesOf(entry.display[f.field])}
                              onChange={(ids) =>
                                setFieldValue(
                                  rk,
                                  f.field,
                                  f.kind === 'files' ? ids : (ids[0] ?? '')
                                )
                              }
                            />
                          ) : entry.copy_to_lines?.[f.field] ? (
                            <div className='flex items-center gap-1.5'>
                              <Input
                                value={typeof v === 'string' ? v : ''}
                                onChange={(e) => setFieldValue(rk, f.field, e.target.value)}
                                placeholder={f.label}
                                className='h-8 w-full text-[12px]'
                              />
                              <button
                                type='button'
                                disabled={!(typeof v === 'string' && v.trim())}
                                onClick={() =>
                                  copyHeaderToLines(
                                    typeof v === 'string' ? v : '',
                                    entry.copy_to_lines?.[f.field] as string
                                  )
                                }
                                title='Copy this value to every available line'
                                className='h-8 shrink-0 whitespace-nowrap rounded-md border border-slate-200 px-2.5 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
                              >
                                Apply to lines ↓
                              </button>
                            </div>
                          ) : (
                            <Input
                              value={typeof v === 'string' ? v : ''}
                              onChange={(e) => setFieldValue(rk, f.field, e.target.value)}
                              placeholder={f.label}
                              className='h-8 w-full text-[12px]'
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {rowErrors[rk] && (
                    <p className='flex items-center gap-1 text-[11px] text-red-600'>
                      <AlertCircle className='h-3 w-3 shrink-0' />
                      {rowErrors[rk]}
                    </p>
                  )}
                </div>
              )
            }
            const displayFields = entry.display_fields ?? []
            const colCount = 1 + displayFields.length + entry.fields.length
            return (
              <div
                key={`${entry.collection}-${entry.fk_field}-${entry.title}`}
                className='space-y-2'
              >
                {payload.length > 1 && (
                  <h4 className='text-[12px] font-semibold text-slate-500'>{entry.title}</h4>
                )}
                {(entry.apply_all ?? [])
                  .map((fName) => entry.fields.find((f) => f.field === fName))
                  .filter((f): f is NonNullable<typeof f> => !!f && f.kind !== 'm2m')
                  .map((f) => {
                    const bulkKey = `__bulk__:${entry.collection}:${f.field}`
                    const bulkVal = bulkValues[bulkKey] ?? ''
                    return (
                      <div
                        key={bulkKey}
                        className='flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 dark:border-border dark:bg-white/[0.03]'
                      >
                        <label className='shrink-0 text-[11px] font-medium text-slate-500'>
                          {f.label}
                        </label>
                        <Input
                          value={bulkVal}
                          onChange={(e) =>
                            setBulkValues((prev) => ({ ...prev, [bulkKey]: e.target.value }))
                          }
                          placeholder={`${f.label} for every line…`}
                          className='h-8 w-full max-w-xs text-[12px]'
                        />
                        <button
                          type='button'
                          disabled={!bulkVal.trim()}
                          onClick={() => copyHeaderToLines(bulkVal, f.field)}
                          className='h-8 shrink-0 whitespace-nowrap rounded-md bg-nvr-cyan px-3 text-[11px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-40'
                        >
                          Apply to all lines
                        </button>
                      </div>
                    )
                  })}
                <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
                  <table className='w-full border-collapse text-[12px]'>
                    <thead>
                      <tr className='border-b border-slate-200 bg-slate-50/60 text-left text-[11px] font-medium text-slate-400 dark:border-border dark:bg-white/[0.02]'>
                        <th className='px-2.5 py-1.5 font-medium'>Row</th>
                        {displayFields.map((f) => (
                          <th key={f.field} className='px-2.5 py-1.5 font-medium'>
                            {columnLabel(f)}
                          </th>
                        ))}
                        {entry.fields.map((f) => (
                          <th key={f.field} className='w-40 px-2.5 py-1.5 font-medium'>
                            <span className='flex items-center gap-1.5'>
                              {columnLabel(f)}
                              {entry.rows.length > 1 && (
                                <button
                                  type='button'
                                  onClick={() => applyToAllLines(entry, f)}
                                  title={`Apply the first ${f.label} to all lines`}
                                  className='rounded p-0.5 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted/50'
                                >
                                  <CopyDown className='h-3 w-3' />
                                </button>
                              )}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {entry.rows.map((row) => {
                        const rk = rowKey(entry.collection, row.id)
                        return (
                          <Fragment key={rk}>
                            <tr className='border-b border-slate-100 last:border-b-0 dark:border-border/50'>
                              <td className='max-w-[220px] px-2.5 py-1.5'>
                                <span className='flex items-center gap-1.5'>
                                  {!row.complete && (
                                    <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 animate-pulse' />
                                  )}
                                  <span
                                    className={cn(
                                      'truncate',
                                      row.complete ? 'text-slate-400' : 'font-medium text-slate-700'
                                    )}
                                    title={row.label}
                                  >
                                    {row.label}
                                  </span>
                                </span>
                              </td>
                              {displayFields.map((f) => (
                                <td
                                  key={f.field}
                                  className={cn(
                                    'max-w-[200px] truncate px-2.5 py-1.5 text-slate-500',
                                    f.format && 'text-right tabular-nums'
                                  )}
                                  title={fmtDisplay(row.display?.[f.field], f.format)}
                                >
                                  {fmtDisplay(row.display?.[f.field], f.format) || '—'}
                                </td>
                              ))}
                              {entry.fields.map((f) => (
                                <td key={f.field} className='px-2 py-1'>
                                  {f.kind === 'm2m' ? (
                                    <M2MPickCell
                                      meta={f}
                                      selected={
                                        Array.isArray(values[rk]?.[f.field])
                                          ? (values[rk]?.[f.field] as string[])
                                          : []
                                      }
                                      onChange={(ids) => setFieldValue(rk, f.field, ids)}
                                      rowValues={{ ...row.cascade_values, ...values[rk] }}
                                    />
                                  ) : isWaived(rk, f) ? (
                                    <Input
                                      value=''
                                      disabled
                                      readOnly
                                      placeholder={f.optional_when?.placeholder ?? 'Auto-assigned'}
                                      title='Assigned automatically after submission'
                                      className='h-8 w-full min-w-[9rem] bg-slate-50 text-[12px] italic dark:bg-muted/50'
                                    />
                                  ) : f.kind === 'm2o' ? (
                                    <M2OPickCell
                                      meta={f}
                                      selected={
                                        typeof values[rk]?.[f.field] === 'string'
                                          ? (values[rk]?.[f.field] as string)
                                          : ''
                                      }
                                      onChange={(id) => setFieldValue(rk, f.field, id)}
                                      rowValues={{ ...row.cascade_values, ...values[rk] }}
                                    />
                                  ) : (
                                    <Input
                                      value={
                                        typeof values[rk]?.[f.field] === 'string'
                                          ? (values[rk]?.[f.field] as string)
                                          : ''
                                      }
                                      onChange={(e) => setFieldValue(rk, f.field, e.target.value)}
                                      placeholder={f.label}
                                      className='h-8 w-full min-w-[9rem] text-[12px]'
                                    />
                                  )}
                                </td>
                              ))}
                            </tr>
                            {rowErrors[rk] && (
                              <tr>
                                <td colSpan={colCount} className='px-2.5 pb-1.5'>
                                  <p className='flex items-center gap-1 text-[11px] text-red-600'>
                                    <AlertCircle className='h-3 w-3 shrink-0' />
                                    {rowErrors[rk]}
                                  </p>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </DialogBody>
        <DialogFooter className='items-center'>
          {(submitting || executing) && (
            <span className='mr-auto flex items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400'>
              <Loader2 className='h-3.5 w-3.5 animate-spin text-nvr-cyan' />
              {submitting
                ? 'Saving line values…'
                : 'Submitting — contacting external systems, this can take a few seconds…'}
            </span>
          )}
          <Button
            type='button'
            variant='outline'
            onClick={sideEffects ? () => setSideEffects(null) : onClose}
            disabled={submitting || executing}
          >
            {sideEffects ? 'Back' : 'Cancel'}
          </Button>
          {sideEffects && (
            <Button
              type='button'
              variant='outline'
              onClick={() => void handleSubmit('keep')}
              disabled={submitting || executing}
            >
              Keep current values
            </Button>
          )}
          <Button
            type='button'
            onClick={() => void handleSubmit(sideEffects ? 'apply' : undefined)}
            disabled={submitting || executing || hasEmpty}
          >
            {submitting || executing ? (
              <span className='flex items-center gap-1.5'>
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
                {submitting && phase === 'save' ? 'Saving…' : 'Submitting…'}
              </span>
            ) : sideEffects ? (
              'Apply all changes'
            ) : (
              'Submit'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
