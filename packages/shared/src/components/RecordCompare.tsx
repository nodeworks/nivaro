import { useQueries, useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
import {
  type FormSection,
  formSections,
  type SectionGroupIn,
  type SectionPlacementIn
} from '../lib/form-sections'
import { cn, titleCase } from '../lib/utils'
import { Skeleton } from './ui/skeleton'

/**
 * Record compare (#2723): two or three records side by side, laid out in
 * their form's sections, differing values highlighted. Every side is read as
 * the viewer — the record through the items API (fields they cannot read are
 * absent) and its form through /collection-layouts/active for that record
 * (sections hidden from their role are gone, turned-off fields too). A field
 * one record's form does not show reads "Not on this form" on that side and
 * never counts as a difference.
 */

interface ActiveForm {
  layout: { id: number; name: string }
  groups: SectionGroupIn[]
  assignments: SectionPlacementIn[]
  ungrouped_sort: number | null
}

export interface CompareRow {
  field: string
  label: string
  /** Per record: the value, or why that side shows none. */
  cells: Array<{ absent: null | 'record' | 'form' | 'hidden'; value: unknown }>
  differs: boolean
}

export interface CompareSection {
  key: string
  label: string
  rows: CompareRow[]
}

/** Values as people read them: numbers to 2 places, blanks alike, text trimmed. */
export function compareKey(v: unknown): string {
  if (v == null || v === '') return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  const s = String(v).trim()
  const n = Number(s)
  if (s !== '' && Number.isFinite(n)) return String(Math.round(n * 100) / 100)
  return s
}

/**
 * The compare grid, pure. `forms[i]` is record i's form sections (null = it
 * has no form: every readable field shows, under `fallback`).
 */
export function buildCompare(input: {
  records: Array<Record<string, unknown> | null>
  forms: Array<FormSection[] | null>
  labels: Record<string, string | null | undefined>
  /** Field order for records without a form. */
  fallback: string[]
}): CompareSection[] {
  const { records, forms, labels } = input
  const fallbackSection: FormSection = {
    key: '__fields__',
    label: 'Fields',
    fields: input.fallback.map((field) => ({ field, label: null }))
  }
  const per = forms.map((f) => f ?? [fallbackSection])
  // Order: the first record's form, then what only another one shows.
  const order: Array<{ key: string; label: string; fields: string[] }> = []
  const byLabel = new Map<string, { key: string; label: string; fields: string[] }>()
  const seen = new Set<string>()
  const formLabel = new Map<string, string>()
  for (const list of per)
    for (const s of list) {
      for (const f of s.fields)
        if (f.label && !formLabel.has(f.field)) formLabel.set(f.field, f.label)
      const fresh = s.fields.map((f) => f.field).filter((f) => !seen.has(f))
      if (!fresh.length) continue
      for (const f of fresh) seen.add(f)
      const into = byLabel.get(s.label)
      if (into) into.fields.push(...fresh)
      else {
        const entry = { key: s.key, label: s.label, fields: fresh }
        byLabel.set(s.label, entry)
        order.push(entry)
      }
    }
  const shown = per.map((list) => new Set(list.flatMap((s) => s.fields.map((f) => f.field))))
  return order
    .map((s) => ({
      key: s.key,
      label: s.label,
      rows: s.fields.flatMap((field): CompareRow[] => {
        const cells = records.map((rec, i) => {
          const absent = !rec
            ? ('record' as const)
            : !shown[i].has(field)
              ? ('form' as const)
              : !(field in rec)
                ? ('hidden' as const)
                : null
          return { absent, value: absent || !rec ? null : rec[field] }
        })
        const present = cells.filter((c) => !c.absent)
        if (present.length === 0) return []
        const differs =
          present.length > 1 && new Set(present.map((c) => compareKey(c.value))).size > 1
        return [
          {
            field,
            label: formLabel.get(field) || labels[field] || titleCase(field),
            cells,
            differs
          }
        ]
      })
    }))
    .filter((s) => s.rows.length > 0)
}

const ABSENT_TEXT = {
  record: 'Not available',
  form: 'Not on this form',
  hidden: 'Not visible to you'
} as const

export function RecordCompareDialog({
  collection,
  ids,
  fields,
  renderValue,
  onClose
}: {
  collection: string
  ids: Array<string | number>
  /** The collection's fields in order (used for records without a form). */
  fields: Array<{ field: string; hidden?: boolean }>
  /** How a value reads (relations as labels, dates, …). */
  renderValue: (field: string, value: unknown) => ReactNode
  onClose: () => void
}) {
  const client = useNivaroClient()
  const records = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['cbv-compare', collection, String(id)],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${id}`))
          .then((r) => r.data ?? null)
          .catch(() => null),
      staleTime: 30_000
    }))
  })
  const forms = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['compare-form', collection, String(id)],
      queryFn: () =>
        client
          .request<{ data: ActiveForm | null }>(
            get('/collection-layouts/active', { collection, item: String(id) })
          )
          .then((r) => r.data ?? null)
          .catch(() => null),
      staleTime: 30_000
    }))
  })
  const config = useQuery<Array<{ field: string; label: string | null }>>({
    queryKey: ['bulk-fields-config', collection],
    queryFn: () =>
      client
        .request<{ data: Array<{ field: string; label: string | null }> }>(
          get(`/field-config/${collection}`)
        )
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    staleTime: 60_000
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loading = records.some((q) => q.isLoading) || forms.some((q) => q.isLoading)
  const recs = records.map((q) => q.data ?? null)
  const formRows = forms.map((q) => q.data ?? null)
  // Cheap (a few hundred cells at most): computed on every render.
  const labels: Record<string, string | null> = {}
  for (const f of config.data ?? []) labels[f.field] = f.label
  const sections = loading
    ? []
    : buildCompare({
        records: recs,
        forms: formRows.map((f) =>
          f
            ? formSections(f.groups ?? [], f.assignments ?? [], {
                ungroupedSort: f.ungrouped_sort
              })
            : null
        ),
        labels,
        fallback: fields.filter((f) => !f.hidden && f.field !== 'id').map((f) => f.field)
      })

  const [diffOnly, setDiffOnly] = useState(false)
  const diffCount = sections.reduce((n, s) => n + s.rows.filter((r) => r.differs).length, 0)
  const visible = diffOnly
    ? sections
        .map((s) => ({ ...s, rows: s.rows.filter((r) => r.differs) }))
        .filter((s) => s.rows.length > 0)
    : sections
  const formNames = formRows.map((f) => f?.layout?.name ?? null)
  const sameForm = new Set(formRows.map((f) => f?.layout?.id ?? null)).size === 1
  const cols = { gridTemplateColumns: `minmax(160px, 220px) repeat(${ids.length}, minmax(0, 1fr))` }

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; Escape is the keyboard path
    <div
      className='fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4 sm:p-6'
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      data-record-compare
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-label={`Compare ${ids.length} records`}
        className='nvr-pop-in flex max-h-[88vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl'
      >
        <div className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5'>
          <span className='text-[14px] font-semibold text-foreground'>
            Compare {ids.length} records
          </span>
          {!loading && (
            <span className='text-[12px] text-muted-foreground' data-compare-diff-count={diffCount}>
              {diffCount === 0
                ? 'No differences'
                : `${diffCount} field${diffCount === 1 ? '' : 's'} differ`}
              {sameForm && formNames[0] ? ` · ${formNames[0]} form` : ''}
            </span>
          )}
          <label className='ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground'>
            <input
              type='checkbox'
              checked={diffOnly}
              onChange={(e) => setDiffOnly(e.target.checked)}
              className='h-3.5 w-3.5 accent-[hsl(var(--primary))]'
            />
            Differences only
          </label>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          >
            <X className='h-4 w-4' />
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-auto'>
          <div
            className='sticky top-0 z-[1] grid border-b border-border bg-slate-50 dark:bg-background'
            style={cols}
          >
            <span className='px-3 py-2 text-[11.5px] font-medium text-muted-foreground'>Field</span>
            {ids.map((id, i) => (
              <span key={String(id)} className='min-w-0 px-3 py-2'>
                <span className='block truncate font-mono text-[12px] font-medium text-foreground'>
                  #{String(id)}
                </span>
                {!sameForm && (
                  <span className='block truncate text-[11px] text-muted-foreground'>
                    {formNames[i] ? `${formNames[i]} form` : 'No form'}
                  </span>
                )}
              </span>
            ))}
          </div>
          {loading ? (
            <div className='space-y-2 p-4' aria-busy='true'>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className='grid gap-3' style={cols}>
                  <Skeleton className='h-4 w-28' />
                  {ids.map((id) => (
                    <Skeleton key={String(id)} className='h-4 w-full' />
                  ))}
                </div>
              ))}
            </div>
          ) : recs.every((r) => r == null) ? (
            <p className='px-4 py-8 text-center text-[12.5px] text-muted-foreground'>
              These records could not be opened. They may have been deleted, or you may no longer
              have access.
            </p>
          ) : visible.length === 0 ? (
            <p className='px-4 py-8 text-center text-[12.5px] text-muted-foreground'>
              {diffOnly ? 'Every field you can see holds the same value.' : 'Nothing to compare.'}
            </p>
          ) : (
            visible.map((s) => {
              const n = s.rows.filter((r) => r.differs).length
              return (
                <section key={s.key} data-compare-section={s.key}>
                  <h3 className='flex items-baseline gap-2 border-b border-border bg-card px-3 pb-1.5 pt-4 text-[12.5px] font-semibold text-foreground'>
                    {s.label}
                    {n > 0 && (
                      <span className='text-[11.5px] font-normal text-muted-foreground'>
                        {n} differ{n === 1 ? 's' : ''}
                      </span>
                    )}
                  </h3>
                  {s.rows.map((r) => (
                    <div
                      key={r.field}
                      data-compare-row={r.field}
                      data-differs={r.differs ? '' : undefined}
                      className={cn(
                        'grid border-b border-slate-100 text-[12.5px] dark:border-border/60',
                        r.differs && 'bg-amber-50 dark:bg-amber-400/10'
                      )}
                      style={cols}
                    >
                      <span className='min-w-0 px-3 py-1.5 text-muted-foreground'>{r.label}</span>
                      {r.cells.map((c, i) => (
                        <span
                          key={i}
                          className={cn(
                            'min-w-0 break-words px-3 py-1.5 tabular-nums',
                            c.absent
                              ? 'text-[11.5px] italic text-muted-foreground'
                              : r.differs
                                ? 'font-medium text-foreground'
                                : 'text-slate-600 dark:text-slate-300'
                          )}
                        >
                          {c.absent ? (
                            ABSENT_TEXT[c.absent]
                          ) : c.value == null || c.value === '' ? (
                            <span className='text-muted-foreground'>—</span>
                          ) : (
                            renderValue(r.field, c.value)
                          )}
                        </span>
                      ))}
                    </div>
                  ))}
                </section>
              )
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
