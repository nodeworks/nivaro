import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useDrilldown, useNivaroClient } from '../context'
import { useDebounced } from '../hooks/useDebounced'
import { get } from '../lib/commands'
import { sanitizeHtml } from '../lib/sanitize-html'
import { titleCase } from '../lib/utils'
import { UserChip } from './item-edit/GroupSection'
import { richTextToPlain } from './item-edit/helpers'
import { integrityByField, useRecordIntegrity } from './panels/RecordIntegrityBanner'
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
  id?: number
  container_id?: number | null
  is_collapsed?: boolean | number | null
  visibility_mode?: string | null
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
  layout: {
    id: number
    name: string
    /** Identity band rendered above the cards (first entry = the title). */
    header_fields?: string[] | null
    /** Collapse empty values instead of rendering "—" walls. */
    hide_empty?: boolean | number | null
    sheet_width?: number | null
  }
  groups: LayoutGroup[]
  assignments: LayoutAssignment[]
}
interface FieldMeta {
  field: string
  type: string | null
  interface?: string | null
  hidden?: boolean
  label?: string | null
  layout_assigned?: boolean
  options?: unknown
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

function BoolPill({
  value,
  trueTone = 'positive'
}: {
  value: unknown
  trueTone?: 'positive' | 'danger'
}) {
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
  const { data: row, isPending } = useQuery({
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
  if (!row && (isPending || !meta))
    return (
      <span className='inline-block h-3.5 w-20 animate-pulse rounded bg-slate-100 align-middle dark:bg-[hsl(var(--nvr-skeleton))]' />
    )
  if (!row) return <span className='text-slate-400'>#{String(id)}</span>
  let label = ''
  const template = meta?.display_template
  if (template) {
    label = template
      .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => {
        const v = path
          .split('.')
          .reduce<unknown>((acc, seg) => (acc as Record<string, unknown> | null)?.[seg], row)
        return v == null ? '' : String(v)
      })
      .trim()
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
      className='text-left underline decoration-slate-300 underline-offset-2 transition-colors hover:text-[#007a99] hover:decoration-[#007a99] dark:decoration-slate-600 dark:hover:text-nvr-cyan dark:hover:decoration-nvr-cyan'
    >
      {label}
    </button>
  )
}

/** An M2M alias reads as the linked records' labels, not a table of junction
 *  rows: the junction's companion leg names the target collection, each
 *  linked id resolves through RelatedValue (display template + drill). */
function M2MValue({
  junction,
  parentFk,
  junctionField,
  parentId
}: {
  junction: string
  parentFk: string
  junctionField: string
  parentId: string
}) {
  const client = useNivaroClient()
  const { data: jMeta } = useQuery({
    queryKey: ['cbv-collection-meta', junction],
    queryFn: () =>
      client
        .request<{ data: { relations: RelationRow[] } }>(get(`/collections/${junction}`))
        .then((r) => r.data),
    staleTime: 10 * 60_000,
    retry: false
  })
  const target =
    (jMeta?.relations ?? []).find(
      (r) => r.many_collection === junction && r.many_field === junctionField && r.one_collection
    )?.one_collection ?? null
  const { data: ids } = useQuery({
    queryKey: ['rrv-m2m', junction, parentFk, parentId, junctionField],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${junction}`, {
            filter: JSON.stringify({ [parentFk]: { _eq: parentId } }),
            fields: `id,${junctionField}`,
            limit: 200
          })
        )
        .then((r) =>
          (r.data ?? [])
            .map((row) => row[junctionField])
            .filter((v) => v != null)
            .map((v) => String(typeof v === 'object' ? (v as { id?: unknown }).id : v))
        )
        .catch(() => [] as string[]),
    staleTime: 30_000,
    retry: false
  })
  if (!ids || !target)
    return (
      <span className='inline-block h-3.5 w-20 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
    )
  if (ids.length === 0) return <Empty />
  return (
    <span className='flex flex-wrap gap-x-1.5 gap-y-0.5'>
      {ids.map((id, i) => (
        <span key={id} className='inline-flex items-center'>
          <RelatedValue collection={target} id={id} />
          {i < ids.length - 1 && <span className='text-slate-300 dark:text-slate-600'>,</span>}
        </span>
      ))}
    </span>
  )
}

/** Read-only child list for an O2M alias field — curated columns from a
 *  table layout when the grid assignment pins one. */
type ColumnPreset = { name: string; columns: string[] }

function ChildTable({
  collection,
  fkField,
  parentId,
  layoutId,
  presets,
  defaultPreset
}: {
  collection: string
  fkField: string
  parentId: string
  layoutId?: number | null
  /** The grid's named column views ('Line' / 'Deployment') — same membership
   *  rule as the edit grid: a preset filters the layout's columns, never widens. */
  presets?: ColumnPreset[]
  defaultPreset?: string | null
}) {
  const client = useNivaroClient()
  const drill = useDrilldown()
  const presetList = (presets ?? []).filter((p) => p && Array.isArray(p.columns))
  const [activePreset, setActivePreset] = useState<string>(() =>
    presetList.length >= 2
      ? (presetList.find((p) => p.name === defaultPreset)?.name ?? presetList[0].name)
      : '__all__'
  )
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
  const { data: colsRes } = useQuery({
    queryKey: ['rrv-cols', collection, layoutId ?? null],
    queryFn: () =>
      client
        .request<{ data: FieldMeta[] }>(
          get(`/field-config/${collection}`, layoutId ? { layout_id: layoutId } : {})
        )
        .then((r) => ({
          // Lines carry their own number — sort by it and show it first.
          lineNo: (r.data ?? []).some((f) => f.field === 'line_number'),
          cols: (r.data ?? [])
            .filter(
              (f) =>
                !f.hidden &&
                !f.field.startsWith('__') &&
                (!f.field.includes('.') || f.interface === 'relation-path') &&
                f.field !== fkField &&
                ((layoutId ? (f as { layout_assigned?: boolean }).layout_assigned : true) ??
                  true) &&
                (f.interface === 'relation-path' ||
                  [
                    'string',
                    'text',
                    'integer',
                    'decimal',
                    'float',
                    'boolean',
                    'date',
                    'datetime',
                    'timestamp',
                    'uuid'
                  ].includes(f.type ?? ''))
            )
            .filter((f, i, arr) => arr.findIndex((x) => x.field === f.field) === i)
        })),
    staleTime: 5 * 60_000,
    retry: false
  })
  const allCols = colsRes?.cols ?? []
  const lineNoField = !!colsRes?.lineNo
  const presetSet =
    activePreset !== '__all__' ? presetList.find((p) => p.name === activePreset) : null
  const cols = useMemo(() => {
    if (!presetSet) return allCols
    const want = new Set(presetSet.columns)
    const kept = allCols.filter((c) => want.has(c.field))
    return kept.length > 0 ? kept : allCols
  }, [allCols, presetSet])
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
  const {
    data: rowsRes,
    isLoading,
    isFetching
  } = useQuery({
    queryKey: ['rrv-rows', collection, fkField, parentId, sort, lineNoField, page, conditions],
    queryFn: () =>
      client.request<{ data: Array<Record<string, unknown>>; total?: number }>(
        get(`/items/${collection}`, {
          limit: PAGE,
          page,
          ...(sort ? { sort } : lineNoField ? { sort: 'line_number' } : {}),
          conditions
        })
      ),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: false
  })
  const rows = rowsRes?.data ?? []
  const total = rowsRes?.total ?? rows.length
  const dottedCols = cols.filter((c) => c.field.includes('.'))
  const rowIds = rows.map((r) => String(r.id))
  const { data: resolved } = useQuery<{
    rows: Record<string, Record<string, { value: string; ids: string[] }>>
    targets: Record<string, string | null>
  }>({
    queryKey: [
      'rrv-resolve-paths',
      collection,
      dottedCols.map((c) => c.field).join(','),
      rowIds.join(',')
    ],
    queryFn: () =>
      client
        .request<{
          data: {
            rows: Record<string, Record<string, { value: string; ids: string[] }>>
            targets: Record<string, string | null>
          }
        }>(
          get(`/items/${collection}/resolve-paths`, {
            ids: rowIds.join(','),
            paths: dottedCols.map((c) => c.field).join(',')
          })
        )
        .then((r) => r.data ?? { rows: {}, targets: {} })
        .catch(() => ({ rows: {}, targets: {} })),
    enabled: dottedCols.length > 0 && rowIds.length > 0,
    staleTime: 30_000
  })
  // Lines carry their own number — show it first, the way the grid does.
  const hasLineNo = lineNoField && rows.some((r) => r.line_number != null)
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
          <div
            key={i}
            className='h-6 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]'
          />
        ))}
      </div>
    )
  if (rows.length === 0 && Object.keys(debFilters).length === 0)
    return <p className='py-3 text-[12px] text-slate-400'>No records</p>
  const cell = (row: Record<string, unknown>, f: FieldMeta) => {
    if (f.field.includes('.')) {
      const pv = resolved?.rows[String(row.id)]?.[f.field]
      if (!resolved)
        return (
          <span className='inline-block h-3 w-14 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
        )
      if (!pv || pv.value === '') return <Empty />
      const target = resolved.targets[f.field]
      const id = pv.ids?.[0]
      if (drill && target && id)
        return (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              drill.open({ collection: target, itemId: String(id) })
            }}
            className='text-left underline decoration-slate-300 underline-offset-2 hover:text-[#007a99] dark:decoration-slate-600 dark:hover:text-nvr-cyan'
          >
            {pv.value}
          </button>
        )
      return pv.value
    }
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
  const numeric = (f: FieldMeta) =>
    ['decimal', 'float', 'integer'].includes(f.type ?? '') &&
    !m2oOf(f.field) &&
    !f.field.includes('.')
  const sortable = (f: FieldMeta) => !m2oOf(f.field) && !f.field.includes('.')
  const filterKind = (f: FieldMeta): 'text' | 'num' | 'bool' | null => {
    if (m2oOf(f.field) || f.field.includes('.')) return null
    if (f.type === 'boolean') return 'bool'
    if (['integer', 'decimal', 'float'].includes(f.type ?? '')) return 'num'
    if (['string', 'text'].includes(f.type ?? '')) return 'text'
    return null
  }
  const anyFilterable = cols.some((f) => filterKind(f) != null)
  return (
    <div>
      {presetList.length >= 2 && (
        <div className='mb-1.5 flex flex-wrap items-center gap-1' data-read-presets>
          {[
            { name: '__all__', label: 'All' },
            ...presetList.map((p) => ({ name: p.name, label: p.name }))
          ].map((p) => (
            <button
              key={p.name}
              type='button'
              onClick={() => setActivePreset(p.name)}
              aria-pressed={activePreset === p.name}
              className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
                activePreset === p.name
                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-[#007a99] dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div
        className={`overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700 ${isFetching && !isLoading ? 'opacity-70' : ''}`}
      >
        <table className='w-full' style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr className='border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800'>
              {hasLineNo && (
                <th className='h-7 w-8 px-2 text-right text-[9.5px] font-bold uppercase tracking-wider text-slate-400'>
                  #
                </th>
              )}
              {cols.map((f) => {
                const active = sort === f.field || sort === `-${f.field}`
                return (
                  <th
                    key={f.field}
                    onClick={() => sortable(f) && toggleSort(f.field)}
                    className={`h-7 select-none whitespace-nowrap px-2.5 text-[9.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 ${numeric(f) ? 'text-right' : 'text-left'} ${sortable(f) ? 'cursor-pointer hover:text-slate-700 dark:hover:text-slate-200' : ''}`}
                  >
                    {f.label || titleCase(f.field)}
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
                {hasLineNo && <th className='px-1.5 py-1' />}
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
                          className='h-6 w-full min-w-[56px] rounded border border-slate-200 bg-white px-1.5 text-[10.5px] font-normal normal-case tracking-normal outline-none focus:border-nvr-cyan/50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100'
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
                            className='h-6 w-full min-w-[48px] rounded border border-slate-200 bg-white px-1 text-[10.5px] font-normal outline-none focus:border-nvr-cyan/50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100'
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
                <td
                  colSpan={cols.length + (hasLineNo ? 1 : 0)}
                  className='py-4 text-center text-[12px] text-slate-400'
                >
                  No matches — adjust filters
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={String(row.id)}
                onClick={
                  drill ? () => drill.open({ collection, itemId: String(row.id) }) : undefined
                }
                className={`border-b border-slate-100 last:border-0 dark:border-slate-800 ${
                  drill ? 'cursor-pointer hover:bg-nvr-cyan/5 dark:hover:bg-nvr-cyan/10' : ''
                }`}
              >
                {hasLineNo && (
                  <td className='px-2 py-1.5 text-right text-[11px] tabular-nums text-slate-400'>
                    {row.line_number == null ? '' : String(row.line_number)}
                  </td>
                )}
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
            {Math.min(page * PAGE, total).toLocaleString('en-US')} of{' '}
            {total.toLocaleString('en-US')}
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
  layoutData,
  flush,
  renderSlot,
  integrityMarks
}: {
  collection: string
  itemId: string
  layoutData: ReadViewLayout
  /** Host already pads and scrolls the body (the record form's Summary mode). */
  flush?: boolean
  /**
   * Page-slot sentinels (`__comments__`, `__tasks__`, …) the host wants to
   * keep LIVE inside the read view — Summary mode is read-only for the
   * record's fields, but notes and tasks stay editable (Rob). Return null to
   * skip a slot. A slot placed in a section renders inside that card; the
   * rest render full-width under the cards, in layout order.
   */
  renderSlot?: (key: string, assignment: LayoutAssignment) => ReactNode
  /**
   * Summary mode hides the data-integrity banner but must not hide the
   * problem: with this on, every field (or child grid) that carries a
   * finding gets an amber mark whose tip lists the messages.
   */
  integrityMarks?: boolean
}) {
  const client = useNivaroClient()
  const { data: integrity } = useRecordIntegrity(collection, itemId, !!integrityMarks)
  const integrityMap = useMemo(
    () => (integrityMarks && integrity?.enabled ? integrityByField(integrity.findings) : null),
    [integrityMarks, integrity]
  )
  const IntegrityMark = ({ field }: { field: string }) => {
    const list = integrityMap?.get(field)
    if (!list || list.length === 0) return null
    const tip = list.map((f) => f.message || f.rule).join('\n')
    return (
      <span
        data-integrity-mark={field}
        data-tip={tip}
        role='img'
        aria-label={`${list.length} data integrity issue${list.length === 1 ? '' : 's'}: ${tip}`}
        className='ml-1.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-amber-400/90 px-1 align-middle text-[9px] font-bold leading-none text-amber-950 dark:bg-amber-400 dark:text-amber-950'
      >
        {list.length > 1 ? list.length : '!'}
      </span>
    )
  }
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
  // The layout's field-config merges assignment overrides (hidden, labels,
  // interfaces) the way the edit form sees them — the raw registry does not.
  const { data: layoutFields } = useQuery({
    queryKey: ['rrv-field-config', collection, layoutData.layout.id],
    queryFn: () =>
      client
        .request<{ data: FieldMeta[] }>(
          get(`/field-config/${collection}`, { layout_id: layoutData.layout.id })
        )
        .then((r) => r.data ?? [])
        .catch(() => null),
    staleTime: 5 * 60_000,
    retry: false
  })
  const fieldByName = useMemo(
    () => new Map((layoutFields ?? meta?.fields ?? []).map((f) => [f.field, f])),
    [layoutFields, meta]
  )
  const relations = meta?.relations ?? []
  const m2oTarget = (field: string) =>
    relations.find(
      (r) => r.many_collection === collection && r.many_field === field && r.one_collection
    )?.one_collection ?? null
  const aliasChild = (field: string) =>
    relations.find((r) => r.one_collection === collection && r.one_field === field) ?? null

  // Same gate as the edit form: assignment visibility, the layout's hidden
  // override, and the field's own hidden flag.
  const visible = layoutData.assignments.filter(
    (a) =>
      (a.is_visible === undefined || !!a.is_visible) &&
      !a.field.startsWith('__') &&
      parseOverrides(a.overrides).hidden !== true &&
      !fieldByName.get(a.field)?.hidden
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
  // Non-widget sentinel slots the host chose to render (see `renderSlot`).
  const liveSlots = renderSlot
    ? layoutData.assignments
        .filter(
          (a) =>
            a.field.startsWith('__') &&
            !a.field.startsWith('__widget_') &&
            (a.is_visible === undefined || !!a.is_visible)
        )
        .sort((a, b) => a.sort - b.sort)
    : []
  const renderLiveSlots = (groupKey: string | null) => {
    if (!renderSlot) return null
    const nodes = liveSlots
      .filter((a) => (groupKey === null ? a.group_key == null : a.group_key === groupKey))
      .map((a) => ({ key: a.field, node: renderSlot(a.field, a) }))
      .filter((s) => s.node != null)
    if (nodes.length === 0) return null
    return (
      <div className='mt-3 space-y-4' data-read-live-slots>
        {nodes.map((s) => (
          <div key={s.key}>{s.node}</div>
        ))}
      </div>
    )
  }
  // A read view is for reading — a widget with nothing to show ("No
  // deployments yet") is pure chrome here (Rob: "empty slots just take up
  // space"). Widgets report content through onContentChange; unreported =
  // empty, so a slot only appears once it has something. The slot stays
  // MOUNTED (hidden) so its fetch and report keep running.
  const [widgetContent, setWidgetContent] = useState<Record<string, boolean>>({})
  const widgetHasContent = (key: string) => widgetContent[key] === true
  const renderWidgets = (groupKey: string | null) => {
    const slots = widgetSlots
      .filter((w) => w.group_key === groupKey)
      .sort((a, b) => a.sort - b.sort)
    if (slots.length === 0) return null
    const anyShown = slots.some((w) => widgetHasContent(w.field))
    return (
      <div className={anyShown ? 'mt-3 space-y-4' : 'hidden'} data-read-widgets>
        {slots.map((w) => (
          <div key={w.field} hidden={!widgetHasContent(w.field)}>
            <WidgetSlot
              widgetId={w.widget_id as number}
              inputBindings={slotBindings(w)}
              itemDraft={record ?? {}}
              itemCollection={collection}
              ready={!!record}
              label={w.label_override ?? undefined}
              defaultExpanded={w.default_expanded == null ? true : !!w.default_expanded}
              onContentChange={(has) =>
                setWidgetContent((cur) => (cur[w.field] === has ? cur : { ...cur, [w.field]: has }))
              }
            />
          </div>
        ))}
      </div>
    )
  }
  // Read mode has no wizard: a steps/tabs container is an INPUT pattern.
  // Every group renders as a card in layout order — a container expands into
  // its child steps in place, so the whole record reads top to bottom.
  const groups = [...layoutData.groups]
    .sort((a, b) => a.sort - b.sort)
    // The edit form's group gate: a new-record-only group never shows on a
    // saved record (read mode only ever renders saved records).
    .filter((g) => g.visibility_mode !== 'new_only')
  // Sections the layout collapses by default start collapsed here too — the
  // same first impression as the form; the header expands them.
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set())
  const isOpen = (g: LayoutGroup) => !g.is_collapsed || openKeys.has(g.key)
  const toggleOpen = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const sectionGroups: LayoutGroup[] = []
  for (const g of groups) {
    if (g.type === 'container') {
      for (const c of groups.filter((x) => x.container_id != null && x.container_id === g.id))
        sectionGroups.push(c)
      continue
    }
    if (g.container_id != null) continue
    sectionGroups.push(g)
  }

  const isM2M = (a: LayoutAssignment) => !!aliasChild(a.field)?.junction_field
  const isRich = (a: LayoutAssignment) => {
    const iface = String(
      (parseOverrides(a.overrides).interface as string | undefined) ??
        fieldByName.get(a.field)?.interface ??
        ''
    )
    return /rich|wysiwyg|editorjs/i.test(iface)
  }
  const renderValue = (a: LayoutAssignment) => {
    const f = fieldByName.get(a.field)
    const ov = parseOverrides(a.overrides)
    const m2m = aliasChild(a.field)
    if (m2m?.junction_field && m2m.many_collection && m2m.many_field)
      return (
        <M2MValue
          junction={m2m.many_collection}
          parentFk={m2m.many_field}
          junctionField={m2m.junction_field}
          parentId={itemId}
        />
      )
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
          trueTone={
            ((ov.options ?? {}) as { trueTone?: 'positive' | 'danger' }).trueTone ?? 'positive'
          }
        />
      )
    const ovOpts = (ov.options ?? {}) as { format?: string }
    if (isRich(a) && typeof v === 'string') {
      // Legacy EditorJS docs render as their plain words; HTML renders as HTML.
      if (/^\s*\{/.test(v))
        return <div className='whitespace-pre-wrap font-normal'>{richTextToPlain(v)}</div>
      return (
        <div
          className='rrv-prose font-normal leading-relaxed [&_a]:underline [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:text-[14px] [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_ul]:list-disc'
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(v) }}
        />
      )
    }
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
    const ovOpts = (ov.options ?? {}) as {
      layout_id?: number
      column_presets?: ColumnPreset[]
      default_preset?: string | null
    }
    const fOpts = (() => {
      const raw = fieldByName.get(a.field)?.options
      if (!raw) return {} as { column_presets?: ColumnPreset[]; default_preset?: string | null }
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as {
            column_presets?: ColumnPreset[]
            default_preset?: string | null
          }
        } catch {
          return {}
        }
      }
      return raw as { column_presets?: ColumnPreset[]; default_preset?: string | null }
    })()
    const layoutId = ovOpts.layout_id ?? null
    return (
      <ChildTable
        key={a.field}
        collection={rel.many_collection}
        fkField={rel.many_field}
        parentId={itemId}
        layoutId={layoutId}
        presets={ovOpts.column_presets ?? fOpts.column_presets}
        defaultPreset={ovOpts.default_preset ?? fOpts.default_preset ?? null}
      />
    )
  }

  // Only O2M aliases are tables; M2M aliases read as linked labels.
  const isGrid = (a: LayoutAssignment) => !!aliasChild(a.field) && !isM2M(a)

  // Sections render as cards on a two-column board (single column when
  // narrow); a card whose section holds a child-record grid spans the full
  // width so the table breathes. Inside a card the definition grid is capped
  // at compact columns, so facts cluster instead of scattering across the
  // whole sheet. An assignment override {"options":{"emphasis":true}} renders
  // its value display-sized — the one or two numbers a reader came for.
  const hideEmpty = !!layoutData.layout.hide_empty
  const headerFieldKeys = Array.isArray(layoutData.layout.header_fields)
    ? layoutData.layout.header_fields.filter((f): f is string => typeof f === 'string')
    : []
  const headerSet = new Set(headerFieldKeys)
  const isEmptyValue = (a: LayoutAssignment) => {
    if (!record || isM2M(a)) return false
    const v = record[a.field]
    return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  }
  const assignmentFor = (field: string) => visible.find((a) => a.field === field)
  // The form's label order: layout override → column override → field label.
  const labelFor = (a: LayoutAssignment) => {
    const ovLabel = parseOverrides(a.overrides).label
    if (typeof ovLabel === 'string' && ovLabel.trim()) return ovLabel
    // Alias fields carry an EMPTY label, not null — `||` so they still get a name.
    return a.label_override || fieldByName.get(a.field)?.label || titleCase(a.field)
  }

  const renderSection = (g: LayoutGroup) => {
    const items = visible
      .filter((a) => a.group_key === g.key && !headerSet.has(a.field))
      .filter((a) => !(hideEmpty && !isGrid(a) && isEmptyValue(a)))
      .sort((a, b) => a.sort - b.sort)
    const groupWidgets = widgetSlots.filter((w) => w.group_key === g.key)
    const groupLive = liveSlots.filter((a) => a.group_key === g.key)
    if (items.length === 0 && groupWidgets.length === 0 && groupLive.length === 0) return null
    const scalars = items.filter((a) => !isGrid(a))
    const grids = items.filter(isGrid)
    const shownWidgets = groupWidgets.filter((w) => widgetHasContent(w.field))
    // A section whose only content is empty widgets collapses with them —
    // the widgets stay mounted (hidden) inside so they can still report.
    const sectionHidden =
      items.length === 0 && groupLive.length === 0 && shownWidgets.length === 0
    // Width comes from what the section is CONFIGURED to hold, never from what
    // has loaded — a widget card that started half width and snapped to full
    // once its data reported was the "forecasts slot is half width until the
    // page loads" jump.
    const fullWidth = grids.length > 0 || groupWidgets.length > 0 || groupLive.length > 0
    return (
      <section
        key={g.key}
        hidden={sectionHidden}
        data-read-section={g.key}
        className={`rounded-xl border border-slate-200 bg-white dark:border-slate-700/60 dark:bg-slate-900/40 ${
          fullWidth ? 'lg:col-span-2' : ''
        }`}
      >
        <h3
          className={`flex items-center justify-between px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 ${
            isOpen(g) ? 'border-b border-slate-100 dark:border-slate-800' : ''
          }`}
        >
          {g.is_collapsed ? (
            <button
              type='button'
              onClick={() => toggleOpen(g.key)}
              aria-expanded={isOpen(g)}
              className='flex w-full items-center justify-between text-left uppercase hover:text-slate-700 dark:hover:text-slate-200'
            >
              <span>{g.label}</span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${isOpen(g) ? '' : '-rotate-90'}`}
              />
            </button>
          ) : (
            g.label
          )}
        </h3>
        {isOpen(g) && (
          <div className='px-4 py-3'>
            {scalars.length > 0 && (
              <dl
                className='grid gap-x-6 gap-y-4'
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}
              >
                {scalars.map((a) => {
                  const ov = parseOverrides(a.overrides)
                  const emphasis = !!((ov.options ?? {}) as { emphasis?: boolean }).emphasis
                  const long =
                    isRich(a) || !!fieldByName.get(a.field)?.interface?.includes('rich-text')
                  return (
                    <div
                      key={a.field}
                      className='min-w-0'
                      style={long ? { gridColumn: '1 / -1' } : undefined}
                    >
                      <dt className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                        {labelFor(a)}
                        <IntegrityMark field={a.field} />
                      </dt>
                      <dd
                        className={`mt-0.5 min-w-0 ${
                          emphasis
                            ? 'text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-white'
                            : `${isM2M(a) || long ? '' : 'truncate '}text-[13px] font-medium text-slate-800 dark:text-slate-100`
                        }`}
                      >
                        {record ? (
                          renderValue(a)
                        ) : (
                          <span className='inline-block h-3.5 w-20 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
                        )}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            )}
            {grids.map((a) => (
              <div key={a.field} className={scalars.length > 0 ? 'mt-3' : ''}>
                {integrityMap?.get(a.field)?.length ? (
                  <div className='mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300'>
                    <span className='uppercase tracking-wide'>{labelFor(a)}</span>
                    <IntegrityMark field={a.field} />
                    <span className='font-normal text-amber-700/80 dark:text-amber-300/80'>
                      — {integrityMap.get(a.field)!.length} line issue
                      {integrityMap.get(a.field)!.length === 1 ? '' : 's'}; switch to Edit to fix
                    </span>
                  </div>
                ) : null}
                {renderGridAssignment(a)}
              </div>
            ))}
            {renderWidgets(g.key)}
            {renderLiveSlots(g.key)}
          </div>
        )}
      </section>
    )
  }
  // Top-level slots (no group) sit under the cards, full width. The edit form
  // orders them in its unified group order; here they follow the cards, which
  // is where a reviewer looks for the conversation after the facts.
  const trailingSlots = renderLiveSlots(null)

  // Header band: the layout's identity fields above the cards — first one as
  // the title, the rest as compact label/value pairs. Empty ones drop out.
  const headerAssignments = headerFieldKeys
    .map((f) => assignmentFor(f))
    .filter((a): a is LayoutAssignment => !!a && !isGrid(a))
    .filter((a) => !isEmptyValue(a))
  const [titleAssignment, ...headerRest] = headerAssignments

  return (
    <div
      className={
        flush
          ? 'min-h-0 flex-1'
          : 'min-h-0 flex-1 overflow-y-auto bg-slate-50/60 px-5 py-4 dark:bg-transparent'
      }
    >
      {headerAssignments.length > 0 && (
        <div
          data-read-header
          className='mb-4 rounded-xl border border-slate-200 bg-white px-5 py-4 dark:border-slate-700/60 dark:bg-slate-900/40'
        >
          {titleAssignment && (
            <div className='min-w-0'>
              <p className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                {labelFor(titleAssignment)}
                <IntegrityMark field={titleAssignment.field} />
              </p>
              <p className='truncate text-[22px] font-semibold leading-tight tracking-[-0.015em] text-slate-900 dark:text-white'>
                {record ? renderValue(titleAssignment) : '…'}
              </p>
            </div>
          )}
          {headerRest.length > 0 && (
            <dl className='mt-3 flex flex-wrap gap-x-8 gap-y-2'>
              {headerRest.map((a) => (
                <div key={a.field} className='min-w-0'>
                  <dt className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                    {labelFor(a)}
                    <IntegrityMark field={a.field} />
                  </dt>
                  <dd className='mt-0.5 truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                    {record ? renderValue(a) : '…'}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {/* The board needs the collection's relations to know which cards hold
          child grids (full width) — until they arrive every grid card would
          render at half width and jump. Hold a skeleton board instead. */}
      {meta ? (
        <div className='grid items-start gap-4 lg:grid-cols-2'>
          {sectionGroups.map(renderSection)}
        </div>
      ) : (
        <div className='grid items-start gap-4 lg:grid-cols-2' data-read-board-pending>
          <div className='h-40 animate-pulse rounded-xl bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
          <div className='h-40 animate-pulse rounded-xl bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
          <div className='h-56 animate-pulse rounded-xl bg-slate-100 lg:col-span-2 dark:bg-[hsl(var(--nvr-skeleton))]' />
        </div>
      )}
      {trailingSlots && <div className='mt-1'>{trailingSlots}</div>}
    </div>
  )
}
