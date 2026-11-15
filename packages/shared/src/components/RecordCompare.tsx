import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../context'
import { get, getActiveLayout } from '../lib/commands'
import type { CompareFieldMeta } from '../lib/compare-value'
import {
  type FormSection,
  formSections,
  type SectionGroupIn,
  type SectionPlacementIn
} from '../lib/form-sections'
import { type LiveBatch, useLiveAvailable, useLiveRecord } from '../lib/live'
import { liveMotionAllowed, useLivePreference } from '../lib/live-preference'
import { friendlyIdOf, type RecordRefMeta, recordRefLabel } from '../lib/record-ref'
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

/**
 * The heading of one side: the record's business id ("MM26-81441"), else its
 * own words ("No workflow number · …"), else "Record 2" — never "#367714".
 * Pure (army 11 staging check).
 */
export function compareSideName(
  meta: RecordRefMeta | null,
  record: Record<string, unknown> | null,
  id: string | number,
  collection: string,
  index: number
): string {
  const friendly = friendlyIdOf(meta, record)
  if (friendly) return friendly
  if (meta && record) {
    const label = recordRefLabel(meta, record, id, collection)
    if (label && label !== String(id)) return label
  }
  return `Record ${index + 1}`
}

/**
 * Which fields moved on each side between two reads of the compared records (rt5 #16) — the
 * cells that take the quiet live fade. A side that was not loaded before (first read) or is
 * gone now marks nothing. Pure.
 */
export function changedCompareCells(
  prev: Array<Record<string, unknown> | null>,
  next: Array<Record<string, unknown> | null>
): string[][] {
  return next.map((rec, i) => {
    const was = prev[i]
    if (!rec || !was) return []
    const out: string[] = []
    for (const k of Object.keys(rec)) {
      if (k === 'id' || !(k in was)) continue
      if (compareKey(was[k]) !== compareKey(rec[k])) out.push(k)
    }
    return out
  })
}

/**
 * "Differences only" while records change underneath (rt5 #16): a row already on screen stays
 * on screen (it now reads the same — that is news too), new differences join in place. Rows
 * never vanish from under the person. Pure: `shown` = rows shown so far in this mode.
 */
export function stickyDiffRows(
  sections: CompareSection[],
  shown: ReadonlySet<string>
): CompareSection[] {
  return sections
    .map((s) => ({ ...s, rows: s.rows.filter((r) => r.differs || shown.has(r.field)) }))
    .filter((s) => s.rows.length > 0)
}

/** One compared record's live feed: its writes (anyone's, own included) re-read it as the viewer. */
function CompareLiveSide({
  collection,
  id,
  onChange
}: {
  collection: string
  id: string | number
  onChange: (id: string, batch: LiveBatch) => void
}) {
  useLiveRecord(collection, id, (batch) => onChange(String(id), batch), {
    debounceMs: 800,
    includeOwn: true
  })
  return null
}

/** The quiet fade on a compare cell whose value just changed (none with reduced motion / Calm / Off). */
function fadeCell(el: Element | null): void {
  if (!el || !(el instanceof HTMLElement) || typeof el.animate !== 'function') return
  if (!liveMotionAllowed()) return
  el.animate(
    [{ backgroundColor: 'rgba(0, 206, 255, 0.18)' }, { backgroundColor: 'rgba(0, 206, 255, 0)' }],
    { duration: 1600, easing: 'ease-out' }
  )
}

/**
 * Column heads that tell the sides apart (pure). Names come from compareSideName (business id
 * first). When two sides read the same — a collection with no business id names every record
 * "No … number" — the record id leads and the shared name drops to the second line; otherwise
 * the name stands alone.
 */
export function compareSideHeads(
  names: string[],
  ids: Array<string | number>
): Array<{ primary: string; secondary: string | null }> {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  return names.map((n, i) =>
    (counts.get(n) ?? 0) > 1
      ? { primary: `#${ids[i]}`, secondary: n }
      : { primary: n, secondary: null }
  )
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
  /** How a value reads (relations as labels, choices, money, dates …); `meta` is the
   *  field's config row (type, interface, options) when it has loaded. */
  renderValue: (field: string, value: unknown, meta?: CompareFieldMeta) => ReactNode
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
          .request<{ data: ActiveForm | null }>(getActiveLayout({ collection, item: String(id) }))
          .then((r) => r.data ?? null)
          .catch(() => null),
      staleTime: 30_000
    }))
  })
  const config = useQuery<Array<CompareFieldMeta & { field: string; label: string | null }>>({
    queryKey: ['bulk-fields-config', collection],
    queryFn: () =>
      client
        .request<{ data: Array<CompareFieldMeta & { field: string; label: string | null }> }>(
          get(`/field-config/${collection}`)
        )
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    staleTime: 60_000
  })
  // Each side is named by its business id ("MM26-81441"), never its row id (army 11).
  const collectionMeta = useQuery<RecordRefMeta | null>({
    queryKey: ['cbv-collection-meta', collection],
    queryFn: () =>
      client
        .request<{ data: RecordRefMeta }>(get(`/collections/${collection}`))
        .then((r) => r.data ?? null)
        .catch(() => null),
    staleTime: 10 * 60_000
  })

  // Focus moves into the dialog on open and back to the opener on close, so
  // keyboard and screen-reader users land in it rather than on the page behind.
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

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
  const metaByField = new Map<string, CompareFieldMeta>()
  for (const f of config.data ?? []) {
    labels[f.field] = f.label
    metaByField.set(f.field, f)
  }
  const heads = compareSideHeads(
    ids.map((id, i) => compareSideName(collectionMeta.data ?? null, recs[i], id, collection, i)),
    ids
  )
  const sideName = (i: number) => heads[i].primary
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
  // rt5 #16: with "Differences only" on, a row once shown stays while the records change.
  const shownRef = useRef<Set<string>>(new Set())
  const visible = diffOnly ? stickyDiffRows(sections, shownRef.current) : sections
  if (diffOnly) for (const s of visible) for (const r of s.rows) shownRef.current.add(r.field)
  else shownRef.current = new Set()

  // rt5 #16 — live: a write to either record re-reads it as the viewer (a burst is one read),
  // and the cells that moved take a short fade. Nothing reorders, nothing scrolls.
  const qc = useQueryClient()
  // "Live" only says so when changes really arrive (a socket, and live updates not Off).
  const liveAvailable = useLiveAvailable()
  const livePref = useLivePreference()
  const live = liveAvailable && !livePref.off
  const onLive = (id: string, batch: LiveBatch) => {
    if (batch.aspectsOnly && !batch.changedFields?.includes('$state')) return
    void qc.invalidateQueries({ queryKey: ['cbv-compare', collection, id] })
    // A step move can change which form the record gets.
    if (batch.changedFields === null || batch.changedFields.includes('$state'))
      void qc.invalidateQueries({ queryKey: ['compare-form', collection, id] })
  }
  const bodyRef = useRef<HTMLDivElement>(null)
  const prevRecs = useRef<Array<Record<string, unknown> | null> | null>(null)
  const [liveNote, setLiveNote] = useState('')
  const readStamp = records.map((q) => q.dataUpdatedAt).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a side's read changes (readStamp), never on a plain re-render
  useEffect(() => {
    if (loading || !readStamp) return
    const prev = prevRecs.current
    prevRecs.current = recs
    if (!prev) return
    const moved = changedCompareCells(prev, recs)
    const rows = new Map<string, Element>()
    for (const el of bodyRef.current?.querySelectorAll('[data-compare-row]') ?? [])
      rows.set(el.getAttribute('data-compare-row') ?? '', el)
    moved.forEach((fields, i) => {
      for (const f of fields)
        fadeCell(rows.get(f)?.querySelector(`[data-compare-cell="${i}"]`) ?? null)
    })
    const sides = moved.map((m, i) => (m.length ? sideName(i) : null)).filter(Boolean)
    if (sides.length) setLiveNote(`${sides.join(' and ')} changed just now`)
  }, [loading, readStamp])
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
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-label={`Compare ${ids.length} records`}
        tabIndex={-1}
        className='nvr-pop-in flex outline-none max-h-[88vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl'
      >
        <div className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5'>
          <span className='text-[14px] font-semibold text-foreground'>
            Compare {ids.length} records
          </span>
          {!loading && (
            <span className='text-[12px] text-muted-foreground' data-compare-diff-count={diffCount}>
              {diffCount === 0
                ? 'No differences'
                : diffCount === 1
                  ? '1 field differs'
                  : `${diffCount} fields differ`}
              {sameForm && formNames[0] ? ` · ${formNames[0]} form` : ''}
            </span>
          )}
          {live && !loading && (
            <span
              className='inline-flex items-center gap-1 text-[11.5px] text-muted-foreground'
              data-tip='Changes to these records show here as they are saved'
              data-compare-live
            >
              <span
                className='h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400'
                aria-hidden
              />
              Live
            </span>
          )}
          <span className='sr-only' role='status' aria-live='polite'>
            {liveNote}
          </span>
          {ids.map((id) => (
            <CompareLiveSide key={String(id)} collection={collection} id={id} onChange={onLive} />
          ))}
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
        <div ref={bodyRef} className='relative min-h-0 flex-1 overflow-auto'>
          <div
            className='sticky top-0 z-[1] grid border-b border-border bg-slate-50 dark:bg-background'
            style={cols}
          >
            <span className='px-3 py-2 text-[11.5px] font-medium text-muted-foreground'>Field</span>
            {ids.map((id, i) => (
              <span key={String(id)} className='min-w-0 px-3 py-2'>
                <span
                  className='block truncate text-[12px] font-semibold text-foreground'
                  data-compare-side
                >
                  {sideName(i)}
                </span>
                {heads[i].secondary && (
                  <span className='block truncate text-[11px] text-muted-foreground'>
                    {heads[i].secondary}
                  </span>
                )}
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
                          key={String(ids[i])}
                          data-compare-cell={i}
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
                            renderValue(r.field, c.value, metaByField.get(r.field))
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
