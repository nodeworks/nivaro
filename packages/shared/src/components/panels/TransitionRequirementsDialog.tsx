import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, ChevronDown, CopyPlus as CopyDown, Loader2 } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransitionRequirementFieldMeta {
  field: string
  label: string
  /** nivaro_fields type of the child column; null when the column has no nivaro_fields row. */
  type: string | null
  /** M2M alias fields edit via junction writes and render a multi-select;
   *  m2o record fields render a single-select over related_collection. */
  kind?: 'm2m' | 'm2o'
  related_collection?: string
  junction?: string
  fk_to_child?: string
  junction_field?: string
  /** Display formatting hint for read-only context columns. */
  format?: 'currency' | 'number'
  /** m2m selection cap — 1 renders a single-select (pick replaces, closes). */
  max_values?: number
  /** This field is waived + disabled when the row's controlling field matches
   *  one of `in` — e.g. sales_order_id disabled for MDSi warehouse lines
   *  (MDSi returns the order id; the server autofills it after submit). */
  optional_when?: { field: string; in: Array<string | number>; placeholder?: string }
}

export interface TransitionRequirementRow {
  id: string | number
  label: string
  complete: boolean
  values: Record<string, unknown>
  /** Read-only context values for the entry's display_fields. */
  display: Record<string, unknown>
}

export interface TransitionRequirementEntry {
  type: 'child_fields'
  collection: string
  fk_field: string
  title: string
  fields: TransitionRequirementFieldMeta[]
  /** Context columns rendered read-only per row. */
  display_fields: TransitionRequirementFieldMeta[]
  rows: TransitionRequirementRow[]
  /** Server-resolved record values to seed EMPTY line inputs from. */
  prefill_values?: Record<string, unknown>
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
function fmtDisplay(v: unknown, format?: 'currency' | 'number'): string {
  const raw = toInputValue(v)
  if (!format || raw === '') return raw
  const n = Number(raw)
  if (Number.isNaN(n)) return raw
  if (format === 'currency') {
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  }
  return n.toLocaleString('en-US')
}

type FieldValue = string | string[]

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
      for (const f of entry.fields) fieldValues[f.field] = toInputValue(entry.values[f.field])
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

// ─── M2M multi-select cell ───────────────────────────────────────────────────
// Compact per-row multi-picker for m2m required fields (e.g. per-line
// supporting warehouses) — options from the related collection, toggled ids
// staged in the dialog's values state, written as junction rows on Submit.

function M2MPickCell({
  meta,
  selected,
  onChange
}: {
  meta: TransitionRequirementFieldMeta
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const { data: options = [] } = useQuery({
    queryKey: ['req-m2m-options', meta.related_collection],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${meta.related_collection}`, { limit: 500 })
        )
        .then((r) =>
          (r.data ?? []).map((row) => ({
            id: String(row.id),
            label: String(row.name ?? row.title ?? row.label ?? row.short_name ?? row.id)
          }))
        )
        .catch(() => [] as Array<{ id: string; label: string }>),
    enabled: !!meta.related_collection,
    staleTime: 300_000
  })
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
            <p className='px-2.5 py-2 text-[11px] text-slate-400'>No options</p>
          )}
        </DropPanel>
      )}
    </div>
  )
}

// ─── M2O single-select (record-level FK fields) ──────────────────────────────

function M2OPickCell({
  meta,
  selected,
  onChange
}: {
  meta: TransitionRequirementFieldMeta
  selected: string
  onChange: (id: string) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const { data: options = [] } = useQuery({
    queryKey: ['req-m2m-options', meta.related_collection],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${meta.related_collection}`, { limit: 500 })
        )
        .then((r) =>
          (r.data ?? []).map((row) => ({
            id: String(row.id),
            label: String(row.name ?? row.title ?? row.label ?? row.short_name ?? row.id)
          }))
        )
        .catch(() => [] as Array<{ id: string; label: string }>),
    enabled: !!meta.related_collection,
    staleTime: 300_000
  })
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
            <p className='px-2.5 py-2 text-[11px] text-slate-400'>No options</p>
          )}
        </DropPanel>
      )}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TransitionRequirementsDialog({
  payload,
  isRetry,
  onSubmitted,
  onClose
}: {
  payload: TransitionRequirementsPayload
  /** True when this payload came from a retry's second 422 (values changed underneath). */
  isRetry?: boolean
  onSubmitted: () => void
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
  const applyToAllLines = (entry: TransitionRequirementEntry, f: TransitionRequirementFieldMeta) => {
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
  // (waived inputs — e.g. MDSi order ids — are left alone).
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

  const handleSubmit = async () => {
    setSubmitting(true)
    const results = await Promise.all(
      payload.flatMap((entry) => {
        if (entry.type === 'record_fields') {
          const rk = recordEntryKey(entry)
          return [
            (async () => {
              const current = values[rk] ?? {}
              const saved = savedRef.current[rk] ?? {}
              const changed: Record<string, unknown> = {}
              for (const f of entry.fields) {
                if (current[f.field] !== saved[f.field]) {
                  changed[f.field] =
                    f.kind === 'm2o'
                      ? String(current[f.field] ?? '') || null
                      : coerceForPatch(String(current[f.field] ?? ''), f.type)
                }
              }
              if (Object.keys(changed).length === 0) return { rk, ok: true as const }
              try {
                await client.request(patch(`/items/${entry.collection}/${entry.item}`, changed))
                queryClient.invalidateQueries({
                  queryKey: ['item', entry.collection, String(entry.item)]
                })
                return { rk, ok: true as const, saved: { ...saved, ...current } }
              } catch (err) {
                const resp = (err as { response?: { error?: string } })?.response
                return { rk, ok: false as const, error: resp?.error ?? 'Failed to save' }
              }
            })()
          ]
        }
        return entry.rows.map(async (row) => {
          const rk = rowKey(entry.collection, row.id)
          const current = values[rk] ?? {}
          const saved = savedRef.current[rk] ?? {}
          const changed: Record<string, unknown> = {}
          const m2mChanges: Array<{ meta: TransitionRequirementFieldMeta; add: string[]; remove: string[] }> = []
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
            // id and THEN switching the line to MDSi must not persist the
            // typed value (the server autofills it post-submit).
            if (isWaived(rk, f)) continue
            if (current[f.field] !== saved[f.field]) {
              changed[f.field] = coerceForPatch(String(current[f.field] ?? ''), f.type)
            }
          }
          if (Object.keys(changed).length === 0 && m2mChanges.length === 0) {
            return { rk, ok: true as const }
          }
          try {
            if (Object.keys(changed).length > 0) {
              await client.request(patch(`/items/${entry.collection}/${row.id}`, changed))
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
    setSubmitting(false)
    const failures = results.filter((r) => !r.ok)
    for (const r of results) {
      if (r.ok && r.saved) savedRef.current[r.rk] = r.saved
    }
    if (failures.length > 0) {
      setRowErrors(Object.fromEntries(failures.map((f) => [f.rk, f.ok ? '' : f.error])))
      return
    }
    setRowErrors({})
    onSubmitted()
  }

  const title =
    payload.length === 1 && payload[0].title ? payload[0].title : 'Required before continuing'

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent
        className={cn(
          'max-w-2xl',
          payload.some(
            (e) =>
              e.type === 'child_fields' && (e.display_fields ?? []).length + e.fields.length > 3
          ) && 'max-w-5xl'
        )}
      >
        <DialogHeader>
          <DialogTitle className='text-[15px]'>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className='max-h-[60vh] space-y-5 overflow-y-auto'>
          {isRetry && (
            <p className='flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400'>
              <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400' />
              Values changed since your last attempt — review the highlighted rows.
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
                <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
                  <table className='w-full border-collapse text-[12px]'>
                    <thead>
                      <tr className='border-b border-slate-200 bg-slate-50/60 text-left text-[11px] font-medium text-slate-400 dark:border-border dark:bg-white/[0.02]'>
                        <th className='px-2.5 py-1.5 font-medium'>Row</th>
                        {displayFields.map((f) => (
                          <th key={f.field} className='px-2.5 py-1.5 font-medium'>
                            {f.label}
                          </th>
                        ))}
                        {entry.fields.map((f) => (
                          <th key={f.field} className='w-40 px-2.5 py-1.5 font-medium'>
                            <span className='flex items-center gap-1.5'>
                              {f.label}
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
        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type='button' onClick={handleSubmit} disabled={submitting || hasEmpty}>
            {submitting ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
