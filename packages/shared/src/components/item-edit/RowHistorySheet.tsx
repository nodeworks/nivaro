import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { get } from '../../lib/commands'
import { numericIntlOptions } from '../../lib/format-value'
import { cn, formatDate, formatDateTime, formatRelative, titleCase } from '../../lib/utils'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { applyDisplayTemplate, SYSTEM_FIELDS } from './helpers'
import type { CMSField, CMSRelation } from './types'

/**
 * Row history for an inline-grid child row.
 *
 * The revision list is machine truth (a delta of NEW values keyed by column
 * name, a full snapshot per version, an activity comment that is sometimes
 * a person's reason and sometimes an importer's stamp). This turns it into
 * what a reader wants: who did what, when, and for each field its LABEL,
 * the value it was, and the value it became — with foreign keys resolved
 * to their display labels, money formatted as money, and the importer
 * stamps rendered as provenance rather than quoted back as a "Reason".
 */

export interface RowRevisionEntry {
  id: number
  delta: Record<string, unknown> | null
  data: Record<string, unknown>
  timestamp?: string
  action?: string
  comment?: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  /** Timeline mode: which child row this version belongs to. */
  item_id?: string
}

export interface RestoreContext {
  itemId: string | null
  /** The row's newest version is a delete — a restore re-creates it. */
  rowDeleted: boolean
}

interface Client {
  request<T>(cmd: unknown): Promise<T>
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** e.g. "Line 3" — what the row is called in the grid. */
  rowTitle: string
  /** e.g. the item description — helps confirm which row this is. */
  rowSubtitle?: string | null
  revisions: RowRevisionEntry[]
  loading: boolean
  /** Full child field config (labels, interfaces, options). */
  fields: CMSField[]
  /** Layout-ordered display columns — drive change ordering. */
  displayCols: CMSField[]
  /** FK column to the parent — never a "change". */
  parentField: string
  /** The grid's own map covers DISPLAYED columns only; history also names
   *  fields with no column (category_type), so the full relation list is
   *  consulted as well. */
  m2oRelMap: Map<string, CMSRelation>
  relations: CMSRelation[]
  collection: string
  /** Labels the grid already resolved for its current rows. */
  m2oDisplays: Record<string, Record<string, string>>
  client: Client
  allowRestore: boolean
  onRestore: (snapshot: Record<string, unknown>, ctx: RestoreContext) => void
  /** 'row' (default) = one row's versions. 'timeline' = every row of the
   *  record, grouped by item_id, batched per save, newest first. */
  mode?: 'row' | 'timeline'
  /** Timeline: how to name a row ("Line 3", subtitle = description). */
  rowLabel?: (
    itemId: string,
    data: Record<string, unknown>
  ) => { title: string; subtitle?: string | null }
  /** Scroll to + highlight this version when the sheet opens (cell history). */
  focusRevisionId?: number | null
  /** Timeline: newest N versions kept by the server; older ones not loaded. */
  truncated?: boolean
  /** Timeline: put every line back to how it stood at this moment. */
  onRestoreAllTo?: (timestamp: string) => void
  restoringAll?: boolean
}

// Importer / job stamps that ride nivaro_activity.comment. They explain WHERE
// a version came from, not WHY someone changed it — same list the Notes
// thread filters (routes/comments.ts isHumanNote).
const MACHINE_COMMENTS: Record<string, string> = {
  'legacy-import': 'Imported from the legacy system',
  reforecast: 'Nightly reforecast',
  'legacy-state-sync': 'State sync from the legacy system',
  'natural-key upsert (create matched an existing record)': 'Matched an existing record on import'
}
const MACHINE_PREFIXES: Array<[string, string]> = [
  ['forecast-import:', 'Imported forecast history'],
  ['invoice-decision:', 'Invoice decision']
]

export function parseImportStamp(
  comment: string | null | undefined
): { template: string; fileId: string | null } | null {
  const t = String(comment ?? '').trim()
  if (!/^import:/i.test(t)) return null
  const rest = t.slice('import:'.length)
  const cut = rest.lastIndexOf(':')
  const template = (cut >= 0 ? rest.slice(0, cut) : rest).trim() || 'a file'
  const fileId = cut >= 0 ? rest.slice(cut + 1).trim() : ''
  return { template, fileId: fileId || null }
}

function provenanceOf(comment: string | null | undefined): {
  kind: 'none' | 'machine' | 'reason'
  text: string
  fileId?: string | null
} {
  const t = String(comment ?? '').trim()
  if (!t) return { kind: 'none', text: '' }
  const imp = parseImportStamp(t)
  if (imp) return { kind: 'machine', text: `Imported via ${imp.template}`, fileId: imp.fileId }
  const lower = t.toLowerCase()
  if (MACHINE_COMMENTS[lower]) return { kind: 'machine', text: MACHINE_COMMENTS[lower] }
  for (const [prefix, label] of MACHINE_PREFIXES)
    if (lower.startsWith(prefix)) return { kind: 'machine', text: label }
  return { kind: 'reason', text: t }
}

const HIDDEN_ALWAYS = new Set(['sort', 'created', 'updated', 'created_at', 'updated_at'])

const isEmpty = (v: unknown) => v === null || v === undefined || v === ''
const same = (a: unknown, b: unknown) => {
  if (isEmpty(a) && isEmpty(b)) return true
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return String(a) === String(b)
}

function parseOpts(col: CMSField | undefined): Record<string, unknown> {
  const raw = col?.options
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return raw as Record<string, unknown>
}

export function RowHistorySheet({
  open,
  onOpenChange,
  rowTitle,
  rowSubtitle,
  revisions,
  loading,
  fields,
  displayCols,
  parentField,
  m2oRelMap: gridRelMap,
  relations,
  collection,
  m2oDisplays,
  client,
  allowRestore,
  onRestore,
  mode = 'row',
  rowLabel,
  focusRevisionId = null,
  truncated = false,
  onRestoreAllTo,
  restoringAll = false
}: Props) {
  const qc = useQueryClient()
  const isTimeline = mode === 'timeline'
  const fieldByName = useMemo(() => new Map(fields.map((f) => [f.field, f])), [fields])
  const m2oRelMap = useMemo(() => {
    const m = new Map(gridRelMap)
    for (const r of relations) {
      const mf = r.many_field
      if (!mf || r.many_collection !== collection || r.junction_field || !r.one_collection) continue
      if (!m.has(mf)) m.set(mf, r)
    }
    return m
  }, [gridRelMap, relations, collection])
  const orderIndex = useMemo(() => {
    const m = new Map<string, number>()
    displayCols.forEach((c, i) => m.set(c.field, i))
    fields.forEach((f, i) => {
      if (!m.has(f.field)) m.set(f.field, displayCols.length + i)
    })
    return m
  }, [displayCols, fields])

  type Change = { field: string; before: unknown; after: unknown }
  type RowRef = { itemId: string; title: string; subtitle?: string | null; deleted: boolean }
  type Version = {
    rev: RowRevisionEntry
    kind: 'create' | 'update' | 'delete' | 'other'
    who: string
    changes: Change[]
    /** create: the fields the row started with */
    snapshot: Array<{ field: string; value: unknown }>
    provenance: ReturnType<typeof provenanceOf>
    /** Timeline: the row this version belongs to. */
    row: RowRef | null
    /** The row as it stood right BEFORE this version (delete → what was lost). */
    before: Record<string, unknown> | null
  }

  const visibleField = (k: string) =>
    !SYSTEM_FIELDS.has(k) && !HIDDEN_ALWAYS.has(k) && k !== parentField && !k.startsWith('__')

  // One row's revisions, oldest → newest so each version reads against the
  // one before it. Returns newest first.
  const buildVersions = (list: RowRevisionEntry[], row: RowRef | null): Version[] => {
    const ordered = [...list].sort((a, b) => a.id - b.id)
    const out: Version[] = []
    let prev: Record<string, unknown> | null = null
    for (const rev of ordered) {
      const who =
        [rev.first_name, rev.last_name].filter(Boolean).join(' ') || rev.user_email || 'System'
      const action = String(rev.action ?? '').toLowerCase()
      const kind: Version['kind'] =
        action === 'create'
          ? 'create'
          : action === 'update'
            ? 'update'
            : action === 'delete'
              ? 'delete'
              : 'other'
      const data = rev.data ?? {}
      const changes: Change[] = []
      const snapshot: Array<{ field: string; value: unknown }> = []
      if (kind === 'delete') {
        // What the line held when it went — read from the version before it,
        // falling back to the delete revision's own copy of the row.
        const lost = prev ?? data
        for (const [k, v] of Object.entries(lost)) {
          if (!visibleField(k) || isEmpty(v)) continue
          snapshot.push({ field: k, value: v })
        }
      } else if (kind === 'create' || !prev) {
        for (const [k, v] of Object.entries(data)) {
          if (!visibleField(k) || isEmpty(v)) continue
          snapshot.push({ field: k, value: v })
        }
      } else {
        const keys = rev.delta ? Object.keys(rev.delta) : Object.keys(data)
        for (const k of keys) {
          if (!visibleField(k)) continue
          const after = rev.delta ? rev.delta[k] : data[k]
          const before = prev[k]
          if (same(before, after)) continue
          changes.push({ field: k, before, after })
        }
      }
      const byOrder = (a: string, b: string) =>
        (orderIndex.get(a) ?? 9999) - (orderIndex.get(b) ?? 9999)
      changes.sort((a, b) => byOrder(a.field, b.field))
      snapshot.sort((a, b) => byOrder(a.field, b.field))
      out.push({
        rev,
        kind,
        who,
        changes,
        snapshot,
        provenance: provenanceOf(rev.comment),
        row,
        before: prev
      })
      if (kind !== 'delete' && Object.keys(data).length > 0) prev = data
    }
    return out.reverse() // newest first for reading
  }

  const versions = useMemo<Version[]>(() => {
    if (!isTimeline) return buildVersions(revisions, null)
    const byItem = new Map<string, RowRevisionEntry[]>()
    for (const r of revisions) {
      const k = String(r.item_id ?? '')
      const list = byItem.get(k) ?? []
      list.push(r)
      byItem.set(k, list)
    }
    const all: Version[] = []
    for (const [itemId, list] of byItem) {
      const newest = [...list].sort((a, b) => b.id - a.id)[0]
      const deleted = String(newest?.action ?? '').toLowerCase() === 'delete'
      // Name the row by its newest non-empty snapshot (a delete revision may
      // carry an empty body).
      const named = [...list]
        .sort((a, b) => b.id - a.id)
        .find((r) => Object.keys(r.data ?? {}).length > 0)
      const label = rowLabel?.(itemId, named?.data ?? newest?.data ?? {}) ?? { title: `#${itemId}` }
      all.push(
        ...buildVersions(list, { itemId, title: label.title, subtitle: label.subtitle, deleted })
      )
    }
    all.sort((a, b) => b.rev.id - a.rev.id)
    return all
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisions, orderIndex, parentField, isTimeline, rowLabel])

  // Timeline: a Save flushes lines one at a time, so one person's versions
  // landing within a few seconds of each other are ONE event to a reader —
  // "Robert saved 3 lines", not three entries.
  type Batch = { key: number; versions: Version[]; who: string; at?: string; lastAt?: string }
  const batches = useMemo<Batch[]>(() => {
    if (!isTimeline)
      return versions.map((v) => ({
        key: v.rev.id,
        versions: [v],
        who: v.who,
        at: v.rev.timestamp
      }))
    const out: Batch[] = []
    let cur: Batch | null = null
    for (const v of versions) {
      const t = v.rev.timestamp ? new Date(v.rev.timestamp).getTime() : NaN
      // Adjacent gap, not distance from the batch's newest — a flush of 20
      // lines at ~1s each is one save even though it spans 20s.
      const curT = cur?.lastAt ? new Date(cur.lastAt).getTime() : NaN
      // Same person, within seconds, and a DIFFERENT row — two versions of
      // one row back to back are two saves, never "saved 2 lines".
      const close =
        cur &&
        cur.who === v.who &&
        Number.isFinite(t) &&
        Number.isFinite(curT) &&
        Math.abs(curT - t) <= 5_000 &&
        !cur.versions.some((x) => x.row?.itemId === v.row?.itemId)
      if (close && cur) {
        cur.versions.push(v)
        cur.lastAt = v.rev.timestamp
      } else {
        cur = {
          key: v.rev.id,
          versions: [v],
          who: v.who,
          at: v.rev.timestamp,
          lastAt: v.rev.timestamp
        }
        out.push(cur)
      }
    }
    return out
  }, [versions, isTimeline])

  // Foreign keys that appear in history but not in the grid's current rows
  // (the task this line USED to have) — resolve their labels once per open.
  const missingLookups = useMemo(() => {
    const wanted = new Map<string, Set<string>>()
    const consider = (field: string, v: unknown) => {
      if (isEmpty(v) || typeof v === 'object') return
      const rel = m2oRelMap.get(field)
      if (!rel?.one_collection) return
      if (m2oDisplays[rel.one_collection]?.[String(v)]) return
      const set = wanted.get(rel.one_collection) ?? new Set<string>()
      set.add(String(v))
      wanted.set(rel.one_collection, set)
    }
    for (const v of versions) {
      for (const c of v.changes) {
        consider(c.field, c.before)
        consider(c.field, c.after)
      }
      for (const s of v.snapshot) consider(s.field, s.value)
    }
    return wanted
  }, [versions, m2oRelMap, m2oDisplays])

  const lookupKey = useMemo(
    () =>
      [...missingLookups.entries()]
        .map(([c, ids]) => `${c}:${[...ids].sort().join(',')}`)
        .sort()
        .join('|'),
    [missingLookups]
  )

  const { data: historyLabels = {} } = useQuery<Record<string, Record<string, string>>>({
    queryKey: ['row-history-labels', lookupKey],
    queryFn: async () => {
      const out: Record<string, Record<string, string>> = {}
      await Promise.all(
        [...missingLookups.entries()].map(async ([collection, ids]) => {
          const meta = await qc.fetchQuery({
            queryKey: ['collection-display-meta', collection],
            queryFn: () =>
              client
                .request<{ data: { display_template?: string | null } }>(
                  get(`/collections/${collection}`)
                )
                .then((r) => r.data),
            staleTime: 10 * 60_000
          })
          const tmpl = meta?.display_template ?? undefined
          const tmplFields = tmpl ? [...tmpl.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]) : []
          const fieldsParam = tmplFields.some((f) => f.includes('.'))
            ? ['id', ...tmplFields].join(',')
            : undefined
          const rows = await client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${collection}`, {
                filter: JSON.stringify({ id: { _in: [...ids] } }),
                limit: ids.size,
                ...(fieldsParam ? { fields: fieldsParam } : {})
              })
            )
            .then((r) => r.data ?? [])
          out[collection] = {}
          for (const row of rows) out[collection][String(row.id)] = applyDisplayTemplate(tmpl, row)
        })
      )
      return out
    },
    enabled: open && missingLookups.size > 0,
    staleTime: 5 * 60_000
  })

  const labelFor = (field: string) => {
    const col = fieldByName.get(field)
    return col?.label || titleCase(field)
  }

  const formatValue = (field: string, v: unknown): { text: string; mono?: boolean } => {
    if (isEmpty(v)) return { text: '—' }
    const col = fieldByName.get(field)
    const opts = parseOpts(col)
    const rel = m2oRelMap.get(field)
    if (rel?.one_collection) {
      const label =
        m2oDisplays[rel.one_collection]?.[String(v)] ??
        historyLabels[rel.one_collection]?.[String(v)]
      return label ? { text: label } : { text: `#${String(v)}`, mono: true }
    }
    if (typeof v === 'boolean' || col?.type === 'boolean')
      return { text: v === true || v === 1 || v === '1' || v === 'true' ? 'Yes' : 'No' }
    if (typeof v === 'object') return { text: JSON.stringify(v), mono: true }
    const type = col?.type ?? ''
    if (opts.format === 'currency' && Number.isFinite(Number(v))) {
      return {
        text: Number(v).toLocaleString('en-US', {
          ...numericIntlOptions(opts, 'currency'),
          currency: (opts.currency as string) || 'USD'
        }),
        mono: true
      }
    }
    if (/^(date|dateTime|datetime|timestamp)$/i.test(type)) {
      const s = String(v)
      return { text: /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatDate(s) : formatDateTime(s), mono: true }
    }
    if (
      typeof v === 'number' ||
      (/^(integer|decimal|float|bigInteger|money)$/i.test(type) && Number.isFinite(Number(v)))
    )
      return { text: Number(v).toLocaleString('en-US', numericIntlOptions(opts)), mono: true }
    const s = String(v)
    // Rich text arrives as HTML; show the words.
    if (/<[a-z][\s\S]*>/i.test(s)) {
      const div = typeof document !== 'undefined' ? document.createElement('div') : null
      if (div) {
        div.innerHTML = s
        return { text: (div.textContent || '').trim() || '—' }
      }
    }
    return { text: s }
  }

  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  // Timeline batches with many lines start folded — a create flush lands
  // every line of the record in one batch.
  const [openBatches, setOpenBatches] = useState<Set<number>>(new Set())
  const toggleBatch = (key: number) =>
    setOpenBatches((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const BATCH_FOLD_AT = 4

  // Cell history: land on the version that changed the cell, and light it.
  const [focused, setFocused] = useState<number | null>(null)
  useEffect(() => {
    if (!open || focusRevisionId == null || loading) {
      if (!open) setFocused(null)
      return
    }
    const owner = batches.find((b) => b.versions.some((v) => v.rev.id === focusRevisionId))
    if (owner && owner.versions.length > BATCH_FOLD_AT) {
      setOpenBatches((s) => (s.has(owner.key) ? s : new Set(s).add(owner.key)))
    }
    setFocused(focusRevisionId)
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-rev-id="${focusRevisionId}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
    const clear = window.setTimeout(() => setFocused(null), 3200)
    return () => {
      window.clearTimeout(t)
      window.clearTimeout(clear)
    }
  }, [open, focusRevisionId, loading, batches])

  const summaryOf = (v: Version): string => {
    const what = isTimeline && v.row ? v.row.title : 'this line'
    if (v.kind === 'create') return `added ${what}`
    if (v.kind === 'delete') return `deleted ${what}`
    if (v.changes.length === 0) {
      if (!v.before && isTimeline) return `saved ${what}`
      return isTimeline ? `saved ${what} without changes` : 'saved it without changes'
    }
    const on = isTimeline ? ` on ${what}` : ''
    if (v.changes.length === 1) return `changed ${labelFor(v.changes[0].field)}${on}`
    if (v.changes.length === 2)
      return `changed ${labelFor(v.changes[0].field)} and ${labelFor(v.changes[1].field)}${on}`
    return `changed ${v.changes.length} fields${on}`
  }

  const batchSummary = (b: Batch): string => {
    const added = b.versions.filter((v) => v.kind === 'create').length
    const deleted = b.versions.filter((v) => v.kind === 'delete').length
    const changed = b.versions.length - added - deleted
    const parts: string[] = []
    if (added) parts.push(`added ${added}`)
    if (changed) parts.push(`changed ${changed}`)
    if (deleted) parts.push(`deleted ${deleted}`)
    const n = b.versions.length
    return `saved ${n} ${n === 1 ? 'line' : 'lines'} · ${parts.join(', ')}`
  }

  const restoreCtx = (v: Version): RestoreContext => ({
    itemId: v.row?.itemId ?? null,
    rowDeleted: !!v.row?.deleted
  })

  /** The field-level body of one version: reason, change pairs, snapshot. */
  const renderVersionBody = (v: Version) => {
    const isOpen = expanded.has(v.rev.id)
    const snapshotLimit = 6
    const shownSnapshot = isOpen ? v.snapshot : v.snapshot.slice(0, snapshotLimit)
    const hiddenCount = v.snapshot.length - shownSnapshot.length
    return (
      <>
        {v.provenance.kind === 'machine' && (
          <p className='mt-0.5 text-[11.5px] text-muted-foreground'>
            {v.provenance.text}
            {v.provenance.fileId && (
              <>
                {' · '}
                <a
                  href={`/api/files/${v.provenance.fileId}?download=1`}
                  target='_blank'
                  rel='noreferrer'
                  className='underline decoration-dotted underline-offset-2 hover:text-foreground'
                >
                  source file
                </a>
              </>
            )}
          </p>
        )}
        {v.provenance.kind === 'reason' && (
          <p className='mt-1.5 rounded-md bg-muted px-2.5 py-1.5 text-[12px] leading-5 text-foreground'>
            <span className='text-muted-foreground'>Reason: </span>
            {v.provenance.text}
          </p>
        )}

        {v.changes.length > 0 && (
          <dl className='mt-2 grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[12px] leading-5'>
            {v.changes.map((c) => {
              const from = formatValue(c.field, c.before)
              const to = formatValue(c.field, c.after)
              return (
                <Fragment key={c.field}>
                  <dt className='truncate text-muted-foreground' title={labelFor(c.field)}>
                    {labelFor(c.field)}
                  </dt>
                  <dd className='flex min-w-0 flex-wrap items-baseline gap-x-1.5'>
                    <span
                      className={cn(
                        'break-words text-muted-foreground line-through decoration-slate-300 dark:decoration-slate-600',
                        from.mono && 'tabular-nums'
                      )}
                    >
                      {from.text}
                    </span>
                    {/* arrow travels with the new value, so a long
                        label never leaves it dangling at a line end */}
                    <span
                      className={cn(
                        'break-words font-medium text-foreground',
                        to.mono && 'tabular-nums'
                      )}
                    >
                      <span className='mr-1.5 font-normal text-slate-400' aria-hidden='true'>
                        →
                      </span>
                      {to.text}
                    </span>
                  </dd>
                </Fragment>
              )
            })}
          </dl>
        )}

        {v.snapshot.length > 0 && (
          <>
            <dl
              className={cn(
                'mt-2 grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 gap-y-1 text-[12px] leading-5',
                v.kind === 'delete' && 'text-muted-foreground'
              )}
            >
              {shownSnapshot.map((s) => {
                const val = formatValue(s.field, s.value)
                return (
                  <Fragment key={s.field}>
                    <dt className='truncate text-muted-foreground' title={labelFor(s.field)}>
                      {labelFor(s.field)}
                    </dt>
                    <dd
                      className={cn(
                        'break-words',
                        v.kind === 'delete'
                          ? 'text-muted-foreground line-through decoration-slate-300 dark:decoration-slate-600'
                          : 'text-foreground',
                        val.mono && 'tabular-nums'
                      )}
                    >
                      {val.text}
                    </dd>
                  </Fragment>
                )
              })}
            </dl>
            {(hiddenCount > 0 || isOpen) && v.snapshot.length > snapshotLimit && (
              <button
                type='button'
                onClick={() => toggle(v.rev.id)}
                className='mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground'
                aria-expanded={isOpen}
              >
                <ChevronDown
                  className={cn(
                    'h-3 w-3 transition-transform duration-150',
                    isOpen && 'rotate-180'
                  )}
                  aria-hidden='true'
                />
                {isOpen
                  ? 'Show fewer'
                  : `Show ${hiddenCount} more ${hiddenCount === 1 ? 'field' : 'fields'}`}
              </button>
            )}
          </>
        )}
      </>
    )
  }

  const canRestoreVersion = (v: Version, isLatest: boolean) => {
    if (!allowRestore) return false
    if (v.kind === 'delete') return v.snapshot.length > 0
    if (isLatest && !isTimeline) return false
    // Timeline: the newest version of a still-live row IS the row — nothing to restore.
    if (isTimeline && isLatestOfRow(v)) return false
    return Object.keys(v.rev.data ?? {}).length > 0
  }
  const newestPerRow = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of versions) {
      const k = v.row?.itemId ?? ''
      if (!m.has(k)) m.set(k, v.rev.id)
    }
    return m
  }, [versions])
  const isLatestOfRow = (v: Version) => newestPerRow.get(v.row?.itemId ?? '') === v.rev.id

  const restoreButton = (v: Version, isLatest: boolean) => {
    if (!canRestoreVersion(v, isLatest)) return null
    const deleted = v.kind === 'delete' || !!v.row?.deleted
    const snapshot =
      v.kind === 'delete'
        ? Object.fromEntries(v.snapshot.map((s) => [s.field, s.value]))
        : v.rev.data
    return (
      <button
        type='button'
        onClick={() => onRestore(snapshot, { ...restoreCtx(v), rowDeleted: deleted })}
        className='ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        data-tip={
          deleted
            ? 'Open a new line pre-filled with these values — nothing is saved until you save the line'
            : 'Load this version into the row editor — nothing is saved until you save the row'
        }
      >
        <RotateCcw className='h-3 w-3' aria-hidden='true' />
        {deleted ? 'Restore line' : 'Restore'}
      </button>
    )
  }

  const rail = (isLatest: boolean, kind: Version['kind'], last: boolean) => (
    <div className='relative flex justify-center'>
      <span
        className={cn(
          'relative z-[1] mt-[7px] h-2 w-2 rounded-full ring-2 ring-background',
          isLatest
            ? 'bg-nvr-cyan'
            : kind === 'delete'
              ? 'bg-red-400'
              : kind === 'create'
                ? 'bg-emerald-400'
                : 'bg-slate-300 dark:bg-slate-600'
        )}
      />
      {!last && <span className='absolute bottom-[-24px] top-[11px] w-px bg-border' />}
    </div>
  )

  const total = versions.length
  const headerCount = isTimeline
    ? `${total} ${total === 1 ? 'version' : 'versions'} across ${newestPerRow.size} ${newestPerRow.size === 1 ? 'line' : 'lines'}`
    : `${revisions.length} ${revisions.length === 1 ? 'version' : 'versions'}`

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='flex w-[560px] flex-col gap-0 p-0 sm:max-w-[560px]'>
        <SheetHeader className='shrink-0 border-b border-border px-6 pb-4 pt-5 text-left'>
          <SheetTitle className='text-[14px] font-semibold'>
            {isTimeline ? 'Lines timeline' : 'Row history'}
          </SheetTitle>
          <p className='mt-0.5 flex min-w-0 items-baseline gap-2 text-[12px] text-muted-foreground'>
            <span className='shrink-0 font-medium text-foreground'>{rowTitle}</span>
            {rowSubtitle && <span className='truncate'>{rowSubtitle}</span>}
            {!loading && total > 0 && (
              <span className='ml-auto shrink-0 tabular-nums'>{headerCount}</span>
            )}
          </p>
          {truncated && !loading && (
            <p className='mt-1 text-[11px] text-amber-700 dark:text-amber-400'>
              Showing the newest versions only — older history was not loaded.
            </p>
          )}
        </SheetHeader>

        <div className='min-h-0 flex-1 overflow-y-auto px-6 py-5'>
          {loading ? (
            <ol className='space-y-6' aria-busy='true' aria-label='Loading history'>
              {[0, 1, 2].map((i) => (
                <li key={i} className='grid grid-cols-[14px_1fr] gap-x-3'>
                  <span className='mt-1.5 h-2 w-2 justify-self-center rounded-full bg-[hsl(var(--nvr-skeleton))]' />
                  <div className='space-y-2'>
                    <div className='h-3 w-56 rounded bg-[hsl(var(--nvr-skeleton))]' />
                    <div className='h-3 w-40 rounded bg-[hsl(var(--nvr-skeleton))]' />
                    <div className='h-3 w-48 rounded bg-[hsl(var(--nvr-skeleton))]' />
                  </div>
                </li>
              ))}
            </ol>
          ) : versions.length === 0 ? (
            <div className='rounded-lg border border-dashed border-border px-4 py-8 text-center'>
              <p className='text-[13px] font-medium text-foreground'>No history yet</p>
              <p className='mt-1 text-[12px] text-muted-foreground'>
                {isTimeline
                  ? 'Every line added, changed or removed on this record will be listed here.'
                  : 'Every save of this line will be listed here with what changed.'}
              </p>
            </div>
          ) : (
            <ol className='relative'>
              {batches.map((b, bi) => {
                const isLatestBatch = bi === 0
                const last = bi === batches.length - 1
                const exact = b.at ? formatDateTime(b.at) : ''
                const multi = b.versions.length > 1
                const folded = multi && b.versions.length > BATCH_FOLD_AT && !openBatches.has(b.key)
                const restoreAll =
                  isTimeline && allowRestore && onRestoreAllTo && !isLatestBatch && b.at ? (
                    <button
                      type='button'
                      disabled={restoringAll}
                      onClick={() => onRestoreAllTo(b.at!)}
                      className='ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                      data-tip='Put every line back to how it stood right after this save — writes immediately'
                    >
                      <RotateCcw className='h-3 w-3' aria-hidden='true' />
                      {restoringAll ? 'Restoring…' : 'All lines to here'}
                    </button>
                  ) : null
                if (!multi) {
                  const v = b.versions[0]
                  const isLatest = isLatestBatch
                  return (
                    <li
                      key={b.key}
                      data-rev-id={v.rev.id}
                      className={cn(
                        'nvr-row-enter grid grid-cols-[14px_1fr] gap-x-3 pb-6 last:pb-0 rounded-md transition-shadow duration-500',
                        focused === v.rev.id &&
                          'ring-2 ring-nvr-cyan/60 ring-offset-4 ring-offset-background'
                      )}
                      style={{ animationDelay: `${Math.min(bi, 8) * 30}ms` }}
                    >
                      {rail(isLatest, v.kind, last)}
                      <div className='min-w-0'>
                        <div className='flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12.5px] leading-5'>
                          <span className='font-semibold text-foreground'>{v.who}</span>
                          <span className='text-muted-foreground'>{summaryOf(v)}</span>
                          {isTimeline && v.row?.subtitle && (
                            <span className='truncate text-muted-foreground'>
                              — {v.row.subtitle}
                            </span>
                          )}
                          <span className='text-muted-foreground'>·</span>
                          <span className='text-muted-foreground' data-tip={exact || undefined}>
                            {v.rev.timestamp ? formatRelative(v.rev.timestamp) : ''}
                          </span>
                          {isLatest && !isTimeline && (
                            <span className='ml-auto rounded-full bg-nvr-cyan/10 px-2 py-px text-[10.5px] font-medium text-[#0b7ea6] dark:text-nvr-cyan'>
                              Current
                            </span>
                          )}
                          {(canRestoreVersion(v, isLatest) || restoreAll) && (
                            <span className='ml-auto inline-flex items-center gap-1'>
                              {restoreButton(v, isLatest)}
                              {isTimeline && restoreAll}
                            </span>
                          )}
                        </div>
                        {renderVersionBody(v)}
                      </div>
                    </li>
                  )
                }
                return (
                  <li
                    key={b.key}
                    className='nvr-row-enter grid grid-cols-[14px_1fr] gap-x-3 pb-6 last:pb-0'
                    style={{ animationDelay: `${Math.min(bi, 8) * 30}ms` }}
                  >
                    {rail(isLatestBatch, 'other', last)}
                    <div className='min-w-0'>
                      <div className='flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12.5px] leading-5'>
                        <span className='font-semibold text-foreground'>{b.who}</span>
                        <span className='text-muted-foreground'>{batchSummary(b)}</span>
                        <span className='text-muted-foreground'>·</span>
                        <span className='text-muted-foreground' data-tip={exact || undefined}>
                          {b.at ? formatRelative(b.at) : ''}
                        </span>
                        {restoreAll}
                      </div>
                      {folded ? (
                        <button
                          type='button'
                          onClick={() => toggleBatch(b.key)}
                          className='mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground'
                          aria-expanded={false}
                        >
                          <ChevronDown className='h-3 w-3' aria-hidden='true' />
                          Show {b.versions.length} lines
                        </button>
                      ) : (
                        <ol className='mt-2 space-y-3 border-l border-border pl-3'>
                          {b.versions.map((v) => (
                            <li
                              key={v.rev.id}
                              data-rev-id={v.rev.id}
                              className={cn(
                                'rounded-md transition-shadow duration-500',
                                focused === v.rev.id &&
                                  'ring-2 ring-nvr-cyan/60 ring-offset-4 ring-offset-background'
                              )}
                            >
                              <div className='flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] leading-5'>
                                <span
                                  className={cn(
                                    'font-medium',
                                    v.kind === 'delete'
                                      ? 'text-red-600 dark:text-red-400'
                                      : v.kind === 'create'
                                        ? 'text-emerald-700 dark:text-emerald-400'
                                        : 'text-foreground'
                                  )}
                                >
                                  {v.row?.title ?? 'Line'}
                                </span>
                                <span className='text-muted-foreground'>
                                  {v.kind === 'create'
                                    ? 'added'
                                    : v.kind === 'delete'
                                      ? 'deleted'
                                      : v.changes.length === 0
                                        ? 'saved'
                                        : `${v.changes
                                            .map((c) => labelFor(c.field))
                                            .slice(0, 3)
                                            .join(
                                              ', '
                                            )}${v.changes.length > 3 ? ` +${v.changes.length - 3}` : ''}`}
                                </span>
                                {v.row?.subtitle && (
                                  <span className='truncate text-muted-foreground'>
                                    — {v.row.subtitle}
                                  </span>
                                )}
                                {restoreButton(v, false)}
                              </div>
                              {renderVersionBody(v)}
                            </li>
                          ))}
                          {b.versions.length > BATCH_FOLD_AT && (
                            <li>
                              <button
                                type='button'
                                onClick={() => toggleBatch(b.key)}
                                className='inline-flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground'
                                aria-expanded={true}
                              >
                                <ChevronDown className='h-3 w-3 rotate-180' aria-hidden='true' />
                                Show fewer
                              </button>
                            </li>
                          )}
                        </ol>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
