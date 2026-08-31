import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useDebounced } from '../hooks/useDebounced'
import { useNivaroClient } from '../context'
import { useDrilldown } from '../context'
import { get } from '../lib/commands'
import { titleCase } from '../lib/utils'
import { UserChip } from './item-edit/GroupSection'
import { SimpleSelectXs } from './ui/SimpleSelect'
import { type InputBinding, WidgetSlot } from './WidgetSlot'

// Read-only record presentation for drill-down sheets (display_mode='read'
// detail layouts): section groups render as definition grids, tab groups as a
// tab strip of child tables. No form inputs anywhere — editing happens on the
// full record page, not in a peek.

interface LayoutGroup {
  key: string
  label: string
  type: string | null
  sort: number
}
interface LayoutAssignment {
  field: string
  group_key: string | null
  sort: number
  label_override: string | null
  is_visible: boolean | number
  overrides?: string | Record<string, unknown> | null
  widget_id?: number | null
  input_bindings?: string | null
  default_expanded?: boolean | number | null
}
export interface ReadViewLayout {
  layout: { id: number; name: string }
  groups: LayoutGroup[]
  assignments: LayoutAssignment[]
}
interface FieldMeta {
  field: string
  type: string | null
  interface?: string | null
  hidden?: boolean
}
interface RelationRow {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field?: string | null
  junction_field?: string | null
}

const parseOverrides = (o: LayoutAssignment['overrides']): Record<string, unknown> => {
  if (!o) return {}
  if (typeof o === 'object') return o
  try {
    return JSON.parse(o) as Record<string, unknown>
  } catch {
    return {}
  }
}

const fmtDate = (v: unknown) => {
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) return String(v)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
}
const fmtMoney = (v: unknown) => {
  const n = Number(v)
  if (Number.isNaN(n)) return String(v)
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
const fmtNumber = (v: unknown) => {
  const n = Number(v)
  return Number.isNaN(n) ? String(v) : n.toLocaleString('en-US')
}

const Empty = () => <span className='text-slate-300 dark:text-slate-600'>—</span>

function BoolPill({ value, trueTone = 'positive' }: { value: unknown; trueTone?: 'positive' | 'danger' }) {
  const yes = value === true || value === 1 || value === '1' || value === 'true'
  // trueTone 'danger': for flags where "Yes" is the bad outcome (on hold,
  // past due) — a green Yes there reads as reassurance.
  const yesCls =
    trueTone === 'danger'
      ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
  return (
    <span
      className={`inline-flex h-[18px] items-center rounded-full px-1.5 text-[10.5px] font-semibold ${
        yes ? yesCls : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
      }`}
    >
      {yes ? 'Yes' : 'No'}
    </span>
  )
}

/** Label for a related record — display template else name-ish fallback. */
function RelatedValue({ collection, id }: { collection: string; id: unknown }) {
  const client = useNivaroClient()
  const drill = useDrilldown()
  const { data: meta } = useQuery({
    queryKey: ['cbv-collection-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string | null; fields: FieldMeta[] } }>(
          get(`/collections/${collection}`)
        )
        .then((r) => r.data),
    staleTime: 10 * 60_000,
    retry: false
  })
  const { data: row } = useQuery({
    queryKey: ['rrv-related', collection, String(id)],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${id}`))
        .then((r) => r.data)
        .catch(() => null),
    enabled: id != null && !!meta,
    staleTime: 60_000,
    retry: false
  })
  if (id == null) return <Empty />
  if (!row) return <span className='text-slate-400'>#{String(id)}</span>
  let label = ''
  const template = meta?.display_template
  if (template) {
    label = template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => {
      const v = path
        .split('.')
        .reduce<unknown>((acc, seg) => (acc as Record<string, unknown> | null)?.[seg], row)
      return v == null ? '' : String(v)
    }).trim()
  }
  if (!label) {
    for (const k of ['name', 'title', 'label', 'number', 'subject', 'email']) {
      if (row[k]) {
        label = String(row[k])
        break
      }
    }
  }
  if (!label) label = `#${String(id)}`
  if (!drill) return <>{label}</>
  return (
    <button
      type='button'
      onClick={() => drill.open({ collection, itemId: String(id) })}
      className='text-left underline decoration-slate-300 underline-offset-2 transition-colors hover:text-[#0284c7] hover:decoration-[#0284c7] dark:decoration-slate-600'
    >
      {label}
    </button>
  )
}

/** Read-only child list for an O2M/M2M alias field — curated columns from a
 *  table layout when the grid assignment pins one. */
function ChildTable({
  collection,
  fkField,
  parentId,
  layoutId
}: {
  collection: string
  fkField: string
  parentId: string
  layoutId?: number | null
}) {
  const client = useNivaroClient()
  const drill = useDrilldown()
  const { data: childMeta } = useQuery({
    queryKey: ['cbv-collection-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { relations: RelationRow[] } }>(get(`/collections/${collection}`))
        .then((r) => r.data),
    staleTime: 10 * 60_000,
    retry: false
  })
  const m2oOf = (field: string) =>
    (childMeta?.relations ?? []).find(
      (r) => r.many_collection === collection && r.many_field === field && r.one_collection
    )?.one_collection ?? null
  const { data: cols = [] } = useQuery({
    queryKey: ['rrv-cols', collection, layoutId ?? null],
    queryFn: () =>
      client
        .request<{ data: FieldMeta[] }>(
          get(`/field-config/${collection}`, layoutId ? { layout_id: layoutId } : {})
        )
        .then((r) =>
          (r.data ?? [])
            .filter(
              (f) =>
                !f.hidden &&
                !f.field.startsWith('__') &&
                !f.field.includes('.') &&
                f.field !== fkField &&
                ((layoutId ? (f as { layout_assigned?: boolean }).layout_assigned : true) ?? true) &&
                ['string', 'text', 'integer', 'decimal', 'float', 'boolean', 'date', 'datetime', 'timestamp', 'uuid'].includes(f.type ?? '')
            )
            .slice(0, 8)
        ),
    staleTime: 5 * 60_000,
    retry: false
  })
  // Sort / per-column filters / pagination — all server-side (same
  // conditions dialect as the collection browser).
  const [sort, setSort] = useState('')
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<Record<string, { op: string; value: string }>>({})
  const debFilters = useDebounced(filters, 350)
  const conditions = useMemo(() => {
    const conds: Array<{ path: string[]; op: string; value: unknown }> = [
      { path: [fkField], op: '_eq', value: parentId }
    ]
    for (const [field, f] of Object.entries(debFilters)) {
      if (!f?.value.trim()) continue
      const raw = f.value.trim()
      const num = Number(raw)
      const value =
        f.op === '_contains'
          ? raw
          : raw === 'true' || raw === 'false'
            ? raw === 'true'
            : Number.isNaN(num)
              ? raw
              : num
      conds.push({ path: [field], op: f.op, value })
    }
    return JSON.stringify(conds)
  }, [debFilters, fkField, parentId])
  const PAGE = 25
  const { data: rowsRes, isLoading, isFetching } = useQuery({
    queryKey: ['rrv-rows', collection, fkField, parentId, sort, page, conditions],
    queryFn: () =>
      client.request<{ data: Array<Record<string, unknown>>; total?: number }>(
        get(`/items/${collection}`, {
          limit: PAGE,
          page,
          ...(sort ? { sort } : {}),
          conditions
        })
      ),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: false
  })
  const rows = rowsRes?.data ?? []
  const total = rowsRes?.total ?? rows.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE))
  const setFilter = (field: string, op: string, value: string) => {
    setPage(1)
    setFilters((f) => {
      const next = { ...f }
      if (value) next[field] = { op, value }
      else delete next[field]
      return next
    })
  }
  const toggleSort = (field: string) => {
    setPage(1)
    setSort((cur) => (cur === field ? `-${field}` : cur === `-${field}` ? '' : field))
  }
  if (isLoading)
    return (
      <div className='space-y-1.5 py-2'>
        {[0, 1, 2].map((i) => (
          <div key={i} className='h-6 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
        ))}
      </div>
    )
  if (rows.length === 0 && Object.keys(debFilters).length === 0)
    return <p className='py-3 text-[12px] text-slate-400'>No records</p>
  const cell = (row: Record<string, unknown>, f: FieldMeta) => {
    const v = row[f.field]
    if (v == null || v === '') return <Empty />
    const target = m2oOf(f.field)
    if (target === 'nivaro_users')
      return (
        <span className='inline-block'>
          <UserChip userId={String(v)} size='compact' />
        </span>
      )
    if (target) return <RelatedValue collection={target} id={v} />
    if (f.type === 'boolean') return <BoolPill value={v} />
    if (f.type === 'decimal' || f.type === 'float') return fmtMoney(v)
    if (f.type === 'integer') return fmtNumber(v)
    if (f.type === 'date' || f.type === 'datetime' || f.type === 'timestamp') return fmtDate(v)
    const s = String(v)
    return s.length > 48 ? `${s.slice(0, 48)}…` : s
  }
  const numeric = (f: FieldMeta) => ['decimal', 'float', 'integer'].includes(f.type ?? '') && !m2oOf(f.field)
  const sortable = (f: FieldMeta) => !m2oOf(f.field)
  const filterKind = (f: FieldMeta): 'text' | 'num' | 'bool' | null => {
    if (m2oOf(f.field)) return null
    if (f.type === 'boolean') return 'bool'
    if (['integer', 'decimal', 'float'].includes(f.type ?? '')) return 'num'
    if (['string', 'text'].includes(f.type ?? '')) return 'text'
    return null
  }
  const anyFilterable = cols.some((f) => filterKind(f) != null)
  return (
    <div>
      <div className={`overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700 ${isFetching && !isLoading ? 'opacity-70' : ''}`}>
        <table className='w-full' style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr className='border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800'>
              {cols.map((f) => {
                const active = sort === f.field || sort === `-${f.field}`
                return (
                  <th
                    key={f.field}
                    onClick={() => sortable(f) && toggleSort(f.field)}
                    className={`h-7 select-none whitespace-nowrap px-2.5 text-[9.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 ${numeric(f) ? 'text-right' : 'text-left'} ${sortable(f) ? 'cursor-pointer hover:text-slate-700 dark:hover:text-slate-200' : ''}`}
                  >
                    {titleCase(f.field)}
                    {sortable(f) && (
                      <span className={active ? 'ml-0.5 text-[#00a5cc]' : 'ml-0.5 text-slate-300'}>
                        {active ? (sort.startsWith('-') ? '▼' : '▲') : '⇅'}
                      </span>
                    )}
                  </th>
                )
              })}
            </tr>
            {anyFilterable && (
              <tr className='border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800'>
                {cols.map((f) => {
                  const kind = filterKind(f)
                  const cur = filters[f.field]
                  return (
                    <th key={f.field} className='px-1.5 py-1 font-normal'>
                      {kind === 'text' && (
                        <input
                          value={cur?.value ?? ''}
                          onChange={(e) => setFilter(f.field, '_contains', e.target.value)}
                          placeholder='Filter…'
                          aria-label={`Filter ${f.field}`}
                          className='h-6 w-full min-w-[56px] rounded border border-slate-200 bg-white px-1.5 text-[10.5px] font-normal normal-case tracking-normal outline-none focus:border-[#00ceff80] dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100'
                        />
                      )}
                      {kind === 'num' && (
                        <span className='flex items-center gap-0.5'>
                          <SimpleSelectXs
                            value={cur?.op ?? '_eq'}
                            onChange={(v) => setFilter(f.field, v, cur?.value ?? '')}
                            options={[
                              { value: '_eq', label: '=' },
                              { value: '_gte', label: '≥' },
                              { value: '_lte', label: '≤' }
                            ]}
                            ariaLabel={`Filter op ${f.field}`}
                          />
                          <input
                            type='number'
                            value={cur?.value ?? ''}
                            onChange={(e) => setFilter(f.field, cur?.op ?? '_eq', e.target.value)}
                            aria-label={`Filter ${f.field}`}
                            className='h-6 w-full min-w-[48px] rounded border border-slate-200 bg-white px-1 text-[10.5px] font-normal outline-none focus:border-[#00ceff80] dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100'
                          />
                        </span>
                      )}
                      {kind === 'bool' && (
                        <SimpleSelectXs
                          value={cur?.value ?? ''}
                          onChange={(v) => setFilter(f.field, '_eq', v)}
                          options={[
                            { value: '', label: 'All' },
                            { value: 'true', label: 'Yes' },
                            { value: 'false', label: 'No' }
                          ]}
                          ariaLabel={`Filter ${f.field}`}
                          className='w-full'
                        />
                      )}
                    </th>
                  )
                })}
              </tr>
            )}
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length} className='py-4 text-center text-[12px] text-slate-400'>
                  No matches — adjust filters
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={String(row.id)}
                onClick={drill ? () => drill.open({ collection, itemId: String(row.id) }) : undefined}
                className={`border-b border-slate-100 last:border-0 dark:border-slate-800 ${
                  drill ? 'cursor-pointer hover:bg-[#00ceff0a] dark:hover:bg-[#00ceff14]' : ''
                }`}
              >
                {cols.map((f) => (
                  <td
                    key={f.field}
                    className={`whitespace-nowrap px-2.5 py-1.5 text-[12px] text-slate-700 dark:text-slate-200 ${numeric(f) ? 'text-right' : ''}`}
                  >
                    {cell(row, f)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > PAGE && (
        <div className='mt-1.5 flex items-center justify-between'>
          <p className='text-[11px] tabular-nums text-slate-400'>
            {((page - 1) * PAGE + 1).toLocaleString('en-US')}–
            {Math.min(page * PAGE, total).toLocaleString('en-US')} of {total.toLocaleString('en-US')}
          </p>
          <span className='flex items-center gap-0.5'>
            <button
              type='button'
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className='h-6 rounded px-2 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800'
            >
              ← Prev
            </button>
            <span className='min-w-[48px] text-center text-[11px] tabular-nums text-slate-500'>
              {page} / {totalPages.toLocaleString('en-US')}
            </span>
            <button
              type='button'
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className='h-6 rounded px-2 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800'
            >
              Next →
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

export function RecordReadView({
  collection,
  itemId,
  layoutData
}: {
  collection: string
  itemId: string
  layoutData: ReadViewLayout
}) {
  const client = useNivaroClient()
  const { data: meta } = useQuery({
    queryKey: ['cbv-collection-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { fields: FieldMeta[]; relations: RelationRow[] } }>(
          get(`/collections/${collection}`)
        )
        .then((r) => r.data),
    staleTime: 10 * 60_000,
    retry: false
  })
  const { data: record } = useQuery({
    queryKey: ['rrv-record', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${itemId}`))
        .then((r) => r.data),
    staleTime: 30_000,
    retry: false
  })
  const fieldByName = useMemo(
    () => new Map((meta?.fields ?? []).map((f) => [f.field, f])),
    [meta]
  )
  const relations = meta?.relations ?? []
  const m2oTarget = (field: string) =>
    relations.find((r) => r.many_collection === collection && r.many_field === field && r.one_collection)
      ?.one_collection ?? null
  const aliasChild = (field: string) =>
    relations.find((r) => r.one_collection === collection && r.one_field === field) ?? null

  const visible = layoutData.assignments.filter(
    (a) => (a.is_visible === undefined || !!a.is_visible) && !a.field.startsWith('__')
  )
  // Widget slots (statistics / query tables) render in read views too — the
  // slot itself is read-only by nature, and a drill-down without its numbers
  // is just a field list.
  const widgetSlots = layoutData.assignments.filter(
    (a) =>
      a.field.startsWith('__widget_') &&
      a.widget_id != null &&
      (a.is_visible === undefined || !!a.is_visible)
  )
  const slotBindings = (a: LayoutAssignment): InputBinding[] => {
    if (!a.input_bindings) return []
    try {
      return JSON.parse(String(a.input_bindings)) as InputBinding[]
    } catch {
      return []
    }
  }
  const renderWidgets = (groupKey: string | null) => {
    const slots = widgetSlots
      .filter((w) => w.group_key === groupKey)
      .sort((a, b) => a.sort - b.sort)
    if (slots.length === 0) return null
    return (
      <div className='mt-3 space-y-4'>
        {slots.map((w) => (
          <WidgetSlot
            key={w.field}
            widgetId={w.widget_id as number}
            inputBindings={slotBindings(w)}
            itemDraft={record ?? {}}
            itemCollection={collection}
            ready={!!record}
            label={w.label_override ?? undefined}
            defaultExpanded={w.default_expanded == null ? true : !!w.default_expanded}
          />
        ))}
      </div>
    )
  }
  const groups = [...layoutData.groups].sort((a, b) => a.sort - b.sort)
  const sectionGroups = groups.filter((g) => g.type !== 'tab')
  const tabGroups = groups.filter((g) => g.type === 'tab')
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const currentTab = activeTab ?? tabGroups[0]?.key ?? null

  const renderValue = (a: LayoutAssignment) => {
    const f = fieldByName.get(a.field)
    const ov = parseOverrides(a.overrides)
    const v = record?.[a.field]
    const target = m2oTarget(a.field)
    if (target === 'nivaro_users' && v != null)
      return (
        <span className='inline-block'>
          <UserChip userId={String(v)} size='compact' />
        </span>
      )
    if (target) return <RelatedValue collection={target} id={v} />
    if (v == null || v === '') return <Empty />
    if (f?.type === 'boolean')
      return (
        <BoolPill
          value={v}
          trueTone={((ov.options ?? {}) as { trueTone?: 'positive' | 'danger' }).trueTone ?? 'positive'}
        />
      )
    const ovOpts = (ov.options ?? {}) as { format?: string }
    if (ovOpts.format === 'currency') return <span className='tabular-nums'>{fmtMoney(v)}</span>
    if (f?.type === 'decimal' || f?.type === 'float')
      return <span className='tabular-nums'>{fmtNumber(v)}</span>
    if (f?.type === 'date' || f?.type === 'datetime' || f?.type === 'timestamp') return fmtDate(v)
    return String(v)
  }

  const renderGridAssignment = (a: LayoutAssignment) => {
    const ov = parseOverrides(a.overrides)
    const rel = aliasChild(a.field)
    if (!rel?.many_collection || !rel.many_field) return null
    const layoutId = ((ov.options ?? {}) as { layout_id?: number }).layout_id ?? null
    return (
      <ChildTable
        key={a.field}
        collection={rel.many_collection}
        fkField={rel.many_field}
        parentId={itemId}
        layoutId={layoutId}
      />
    )
  }

  const isGrid = (a: LayoutAssignment) => !!aliasChild(a.field)

  // Sections render as cards on a two-column board (single column when
  // narrow); a card whose section holds a child-record grid spans the full
  // width so the table breathes. Inside a card the definition grid is capped
  // at compact columns, so facts cluster instead of scattering across the
  // whole sheet. An assignment override {"options":{"emphasis":true}} renders
  // its value display-sized — the one or two numbers a reader came for.
  const renderSection = (g: LayoutGroup) => {
    const items = visible
      .filter((a) => a.group_key === g.key)
      .sort((a, b) => a.sort - b.sort)
    const groupWidgets = widgetSlots.filter((w) => w.group_key === g.key)
    if (items.length === 0 && groupWidgets.length === 0) return null
    const scalars = items.filter((a) => !isGrid(a))
    const grids = items.filter(isGrid)
    const fullWidth = grids.length > 0 || groupWidgets.length > 0
    return (
      <section
        key={g.key}
        className={`rounded-xl border border-slate-200 bg-white dark:border-slate-700/60 dark:bg-slate-900/40 ${
          fullWidth ? 'lg:col-span-2' : ''
        }`}
      >
        <h3 className='border-b border-slate-100 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:text-slate-400'>
          {g.label}
        </h3>
        <div className='px-4 py-3'>
          {scalars.length > 0 && (
            <dl
              className='grid gap-x-6 gap-y-4'
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}
            >
              {scalars.map((a) => {
                const ov = parseOverrides(a.overrides)
                const emphasis = !!((ov.options ?? {}) as { emphasis?: boolean }).emphasis
                const long = fieldByName.get(a.field)?.interface?.includes('rich-text')
                return (
                  <div
                    key={a.field}
                    className='min-w-0'
                    style={long ? { gridColumn: '1 / -1' } : undefined}
                  >
                    <dt className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                      {a.label_override ?? titleCase(a.field)}
                    </dt>
                    <dd
                      className={`mt-0.5 min-w-0 ${
                        emphasis
                          ? 'text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-white'
                          : 'truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'
                      }`}
                    >
                      {record ? renderValue(a) : <span className='inline-block h-3.5 w-20 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />}
                    </dd>
                  </div>
                )
              })}
            </dl>
          )}
          {grids.map((a) => (
            <div key={a.field} className={scalars.length > 0 ? 'mt-3' : ''}>
              {renderGridAssignment(a)}
            </div>
          ))}
          {renderWidgets(g.key)}
        </div>
      </section>
    )
  }

  return (
    <div className='min-h-0 flex-1 overflow-y-auto bg-slate-50/60 px-5 py-4 dark:bg-transparent'>
      <div className='grid items-start gap-4 lg:grid-cols-2'>{sectionGroups.map(renderSection)}</div>
      {tabGroups.length > 0 && (
        <div className='mt-5'>
          <div className='flex gap-1 border-b border-slate-200 dark:border-slate-700'>
            {tabGroups.map((g) => (
              <button
                key={g.key}
                type='button'
                onClick={() => setActiveTab(g.key)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                  currentTab === g.key
                    ? 'border-[#00ceff] text-slate-900 dark:text-white'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className='pt-3'>
            {tabGroups
              .filter((g) => g.key === currentTab)
              .map((g) => (
                <div key={g.key} className='space-y-3'>
                  {visible
                    .filter((a) => a.group_key === g.key)
                    .sort((a, b) => a.sort - b.sort)
                    .map((a) => (isGrid(a) ? renderGridAssignment(a) : null))}
                  {renderWidgets(g.key)}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
