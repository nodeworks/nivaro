import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
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
  onRestore: (snapshot: Record<string, unknown>) => void
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

function provenanceOf(comment: string | null | undefined): {
  kind: 'none' | 'machine' | 'reason'
  text: string
} {
  const t = String(comment ?? '').trim()
  if (!t) return { kind: 'none', text: '' }
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
  onRestore
}: Props) {
  const qc = useQueryClient()
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

  // Oldest → newest so each version can be read against the one before it.
  const ordered = useMemo(
    () => [...revisions].sort((a, b) => a.id - b.id),
    [revisions]
  )

  type Change = { field: string; before: unknown; after: unknown }
  type Version = {
    rev: RowRevisionEntry
    kind: 'create' | 'update' | 'delete' | 'other'
    who: string
    changes: Change[]
    /** create: the fields the row started with */
    snapshot: Array<{ field: string; value: unknown }>
    provenance: ReturnType<typeof provenanceOf>
  }

  const visibleField = (k: string) =>
    !SYSTEM_FIELDS.has(k) && !HIDDEN_ALWAYS.has(k) && k !== parentField && !k.startsWith('__')

  const versions = useMemo<Version[]>(() => {
    const out: Version[] = []
    let prev: Record<string, unknown> | null = null
    for (const rev of ordered) {
      const who =
        [rev.first_name, rev.last_name].filter(Boolean).join(' ') || rev.user_email || 'System'
      const action = String(rev.action ?? '').toLowerCase()
      const kind: Version['kind'] =
        action === 'create' ? 'create' : action === 'update' ? 'update' : action === 'delete' ? 'delete' : 'other'
      const data = rev.data ?? {}
      const changes: Change[] = []
      const snapshot: Array<{ field: string; value: unknown }> = []
      if (kind === 'create' || !prev) {
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
      out.push({ rev, kind, who, changes, snapshot, provenance: provenanceOf(rev.comment) })
      if (Object.keys(data).length > 0) prev = data
    }
    return out.reverse() // newest first for reading
  }, [ordered, orderIndex, parentField])

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
                .request<{ data: { display_template?: string | null } }>(get(`/collections/${collection}`))
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
    if (typeof v === 'number' || (/^(integer|decimal|float|bigInteger|money)$/i.test(type) && Number.isFinite(Number(v))))
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

  const summaryOf = (v: Version): string => {
    if (v.kind === 'create') return 'created this line'
    if (v.kind === 'delete') return 'deleted this line'
    if (v.changes.length === 0) return 'saved it without changes'
    if (v.changes.length === 1) return `changed ${labelFor(v.changes[0].field)}`
    if (v.changes.length === 2)
      return `changed ${labelFor(v.changes[0].field)} and ${labelFor(v.changes[1].field)}`
    return `changed ${v.changes.length} fields`
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='flex w-[560px] flex-col gap-0 p-0 sm:max-w-[560px]'>
        <SheetHeader className='shrink-0 border-b border-border px-6 pb-4 pt-5 text-left'>
          <SheetTitle className='text-[14px] font-semibold'>Row history</SheetTitle>
          <p className='mt-0.5 flex min-w-0 items-baseline gap-2 text-[12px] text-muted-foreground'>
            <span className='shrink-0 font-medium text-foreground'>{rowTitle}</span>
            {rowSubtitle && <span className='truncate'>{rowSubtitle}</span>}
            {!loading && revisions.length > 0 && (
              <span className='ml-auto shrink-0 tabular-nums'>
                {revisions.length} {revisions.length === 1 ? 'version' : 'versions'}
              </span>
            )}
          </p>
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
                Every save of this line will be listed here with what changed.
              </p>
            </div>
          ) : (
            <ol className='relative'>
              {versions.map((v, i) => {
                const isLatest = i === 0
                const isOpen = expanded.has(v.rev.id)
                const snapshotLimit = 6
                const shownSnapshot = isOpen ? v.snapshot : v.snapshot.slice(0, snapshotLimit)
                const hiddenCount = v.snapshot.length - shownSnapshot.length
                const exact = v.rev.timestamp ? formatDateTime(v.rev.timestamp) : ''
                return (
                  <li
                    key={v.rev.id}
                    className='nvr-row-enter grid grid-cols-[14px_1fr] gap-x-3 pb-6 last:pb-0'
                    style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                  >
                    {/* rail */}
                    <div className='relative flex justify-center'>
                      <span
                        className={cn(
                          'relative z-[1] mt-[7px] h-2 w-2 rounded-full ring-2 ring-background',
                          isLatest
                            ? 'bg-nvr-cyan'
                            : v.kind === 'delete'
                              ? 'bg-red-400'
                              : 'bg-slate-300 dark:bg-slate-600'
                        )}
                      />
                      {i < versions.length - 1 && (
                        <span className='absolute bottom-[-24px] top-[11px] w-px bg-border' />
                      )}
                    </div>

                    <div className='min-w-0'>
                      <div className='flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12.5px] leading-5'>
                        <span className='font-semibold text-foreground'>{v.who}</span>
                        <span className='text-muted-foreground'>{summaryOf(v)}</span>
                        <span className='text-muted-foreground'>·</span>
                        <span className='text-muted-foreground' data-tip={exact || undefined}>
                          {v.rev.timestamp ? formatRelative(v.rev.timestamp) : ''}
                        </span>
                        {isLatest && (
                          <span className='ml-auto rounded-full bg-nvr-cyan/10 px-2 py-px text-[10.5px] font-medium text-[#0b7ea6] dark:text-nvr-cyan'>
                            Current
                          </span>
                        )}
                        {!isLatest && allowRestore && v.kind !== 'delete' && Object.keys(v.rev.data ?? {}).length > 0 && (
                          <button
                            type='button'
                            onClick={() => onRestore(v.rev.data)}
                            className='ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                            data-tip='Load this version into the row editor — nothing is saved until you save the row'
                          >
                            <RotateCcw className='h-3 w-3' aria-hidden='true' />
                            Restore
                          </button>
                        )}
                      </div>

                      {v.provenance.kind === 'machine' && (
                        <p className='mt-0.5 text-[11.5px] text-muted-foreground'>{v.provenance.text}</p>
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
                                  <span className={cn('break-words font-medium text-foreground', to.mono && 'tabular-nums')}>
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
                          <dl className='mt-2 grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 gap-y-1 text-[12px] leading-5'>
                            {shownSnapshot.map((s) => {
                              const val = formatValue(s.field, s.value)
                              return (
                                <Fragment key={s.field}>
                                  <dt className='truncate text-muted-foreground' title={labelFor(s.field)}>
                                    {labelFor(s.field)}
                                  </dt>
                                  <dd className={cn('break-words text-foreground', val.mono && 'tabular-nums')}>
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
                                className={cn('h-3 w-3 transition-transform duration-150', isOpen && 'rotate-180')}
                                aria-hidden='true'
                              />
                              {isOpen ? 'Show fewer' : `Show ${hiddenCount} more ${hiddenCount === 1 ? 'field' : 'fields'}`}
                            </button>
                          )}
                        </>
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
