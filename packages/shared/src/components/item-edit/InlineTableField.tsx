import { useQuery, useQueryClient } from '@tanstack/react-query'
import { GripVertical, History, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, formatRelative, titleCase } from '../../lib/utils'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle
} from '../ui/sheet'
import { useO2MStaging } from './O2MStagingContext'
import { FieldRenderer } from './FieldRenderer'
import { applyDisplayTemplate, SENTINEL_FIELDS } from './helpers'
import type { CMSField, CMSRelation } from './types'

interface RowRevision {
  id: number
  delta: Record<string, unknown> | null
  data: Record<string, unknown>
  timestamp?: string
  action?: string
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
}

const NON_DISPLAY_TYPES = new Set(['alias', 'o2m', 'm2m', 'm2a', 'presentation', 'group', 'divider'])

export function InlineTableField({
  relatedCollection,
  manyField,
  parentId,
  layoutId,
  showRowRevisions,
  saveMode = 'immediate'
}: {
  relatedCollection: string
  manyField: string
  parentId: string
  layoutId?: number | null
  showRowRevisions?: boolean
  saveMode?: 'immediate' | 'pending'
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const staging = useO2MStaging()
  const isNew = parentId === 'new'

  // Row revision history sheet — holds the saved row whose history is open
  const [historyRow, setHistoryRow] = useState<Record<string, unknown> | null>(null)
  const { data: rowRevisions = [], isLoading: revLoading } = useQuery<RowRevision[]>({
    queryKey: ['o2m-row-revisions', relatedCollection, historyRow?.id],
    queryFn: () =>
      client
        .request<{ data: RowRevision[] }>(
          get('/revisions', { collection: relatedCollection, item: String(historyRow?.id) })
        )
        .then((r) => r.data ?? []),
    enabled: !!historyRow?.id,
    staleTime: 15_000
  })

  // { rowId, draft } — null = no row editing, 'new' = adding new row
  const [editState, setEditState] = useState<{ rowId: string; draft: Record<string, unknown> } | null>(null)
  const [saving, setSaving] = useState(false)

  // Auto-detect table-type layout for the related collection when no explicit layoutId is given.
  // This lets Apply Values / Create-with-Defaults zones work without manually linking a layout_id
  // to the O2M field options.
  const { data: autoTableLayout } = useQuery<{ id: number; layout_type: string } | null>({
    queryKey: ['auto-table-layout', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; layout_type: string }> }>(
          get(`/collection-layouts`, { collection: relatedCollection })
        )
        .then((r) => (r.data ?? []).find((l) => l.layout_type === 'table') ?? null),
    enabled: !layoutId,
    staleTime: 5 * 60_000
  })

  const effectiveLayoutId: number | null = layoutId ?? autoTableLayout?.id ?? null

  // Columns ordered by layout assignment when effectiveLayoutId is available
  const { data: cols = [], isLoading: colsLoading } = useQuery<CMSField[]>({
    queryKey: ['field-config', relatedCollection, effectiveLayoutId],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(
          get(`/field-config/${relatedCollection}`, effectiveLayoutId ? { layout_id: String(effectiveLayoutId) } : undefined)
        )
        .then((r) => r.data ?? []),
    staleTime: 60_000
  })

  // Relations for FieldRenderer M2O pickers
  const { data: childRelations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/collections/${relatedCollection}`))
        .then((r) => {
          const d = r.data as { relations?: CMSRelation[] }
          return d?.relations ?? []
        }),
    staleTime: 10 * 60_000
  })

  // Fetch layout metadata to get row_order_field
  const { data: layoutMeta } = useQuery<{ row_order_field?: string | null }>({
    queryKey: ['layout-meta', effectiveLayoutId],
    queryFn: () =>
      client
        .request<{ data: { row_order_field?: string | null } }>(get(`/collection-layouts/${effectiveLayoutId}`))
        .then((r) => r.data ?? {}),
    enabled: !!effectiveLayoutId,
    staleTime: 5 * 60_000
  })

  const rowOrderField = layoutMeta?.row_order_field ?? null

  const { data: rawRows = [], isLoading: rowsLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ['o2m-rows', relatedCollection, manyField, parentId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: 200
          })
        )
        .then((r) => r.data ?? []),
    enabled: !isNew,
    staleTime: 30_000
  })

  const rows = useMemo(() => {
    if (!rowOrderField) return rawRows
    return [...rawRows].sort((a, b) => Number(a[rowOrderField] ?? 0) - Number(b[rowOrderField] ?? 0))
  }, [rawRows, rowOrderField])

  const isPendingMode = saveMode === 'pending'
  const pendingRows = (isNew || isPendingMode) && staging ? staging.getPendingRows(relatedCollection, manyField) : []
  const pendingEdits = isPendingMode && staging ? staging.getPendingEdits(relatedCollection, manyField) : new Map<string, Record<string, unknown>>()
  const pendingDeletes = isPendingMode && staging ? staging.getPendingDeletes(relatedCollection, manyField) : new Set<string>()

  const SPECIAL_GROUP_KEYS = new Set(['__apply_values__', '__create_with_defaults__'])
  const displayCols = cols.filter(
    (c) =>
      !c.hidden &&
      !NON_DISPLAY_TYPES.has(c.type) &&
      c.field !== manyField &&
      c.field !== 'id' &&
      (!effectiveLayoutId || c.layout_assigned === true) &&
      !SENTINEL_FIELDS.has(c.field) &&
      !SPECIAL_GROUP_KEYS.has(c.group_key ?? '')
  )

  // Fields configured for the apply values form (group_key === '__apply_values__')
  const applyValuesCols = useMemo(() =>
    cols.filter(c => c.group_key === '__apply_values__' && !NON_DISPLAY_TYPES.has(c.type ?? '') && !SENTINEL_FIELDS.has(c.field)),
    [cols]
  )

  // Fields configured for the create-with-defaults form (group_key === '__create_with_defaults__')
  // Falls back to displayCols if none configured
  const defaultsCols = useMemo(
    () => cols.filter(c => c.group_key === '__create_with_defaults__' && !NON_DISPLAY_TYPES.has(c.type ?? '') && !SENTINEL_FIELDS.has(c.field)),
    [cols]
  )

  // Map field → M2O relation for display value lookup
  const m2oRelMap = useMemo(() => {
    const map = new Map<string, CMSRelation>()
    for (const c of displayCols) {
      const rel = childRelations.find(
        (r) => r.many_collection === relatedCollection && r.many_field === c.field && !r.junction_field
      )
      if (rel?.one_collection) map.set(c.field, rel)
    }
    return map
  }, [displayCols, childRelations, relatedCollection])

  // Collect unique FK ids per one_collection from all rows
  const m2oLookupIds = useMemo(() => {
    const result = new Map<string, string[]>()
    const allRows = [...rows, ...pendingRows]
    for (const [field, rel] of m2oRelMap) {
      if (!rel.one_collection) continue
      const ids = [...new Set(allRows.map((r) => r[field]).filter((v) => v != null).map(String))].sort()
      if (ids.length) result.set(rel.one_collection, ids)
    }
    return result
  }, [rows, pendingRows, m2oRelMap])

  const m2oQueryKey = useMemo(
    () => ['m2o-display', relatedCollection, ...Array.from(m2oLookupIds.entries()).flat(2)],
    [relatedCollection, m2oLookupIds]
  )

  // Batch-fetch display values: { oneCollection: { id: displayString } }
  const { data: m2oDisplays = {}, isFetching: m2oFetching } = useQuery<Record<string, Record<string, string>>>({
    queryKey: m2oQueryKey,
    queryFn: async () => {
      const result: Record<string, Record<string, string>> = {}
      for (const [oneCollection, ids] of m2oLookupIds) {
        const [colMeta, data] = await Promise.all([
          client
            .request<{ data: { display_template?: string | null } }>(get(`/collections/${oneCollection}`))
            .then((r) => r.data),
          client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${oneCollection}`, {
                filter: JSON.stringify({ id: { _in: ids } }),
                limit: ids.length
              })
            )
            .then((r) => r.data ?? [])
        ])
        const tmpl = colMeta?.display_template ?? undefined
        result[oneCollection] = {}
        for (const item of data) {
          result[oneCollection][String(item.id)] = applyDisplayTemplate(tmpl, item)
        }
      }
      return result
    },
    enabled: m2oLookupIds.size > 0,
    staleTime: 60_000
  })

  function startEdit(row: Record<string, unknown>) {
    const id = String(row.id)
    if (editState?.rowId === id) return
    setEditState({ rowId: id, draft: { ...row } })
  }

  function startPendingEdit(row: Record<string, unknown>, ri: number) {
    const rowId = `pending:${ri}`
    if (editState?.rowId === rowId) return
    setEditState({ rowId, draft: { ...row } })
  }

  function startNew() {
    setEditState({ rowId: 'new', draft: {} })
  }

  function cancelEdit() {
    setEditState(null)
  }

  function setDraftField(k: string, v: unknown) {
    setEditState((s) => s ? { ...s, draft: { ...s.draft, [k]: v } } : s)
  }

  async function saveEdit() {
    if (!editState) return
    setSaving(true)
    try {
      if (editState.rowId.startsWith('pending:')) {
        const ri = parseInt(editState.rowId.split(':')[1], 10)
        staging?.updateRow(relatedCollection, manyField, ri, editState.draft)
        setEditState(null)
        setSaving(false)
        return
      }
      if (editState.rowId === 'new') {
        if ((isNew || isPendingMode) && staging) {
          staging.queueRow(relatedCollection, manyField, { ...editState.draft })
          setEditState(null)
          return
        }
        await client.request(post(`/items/${relatedCollection}`, { ...editState.draft, [manyField]: parentId }))
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      } else {
        if (isPendingMode && staging) {
          staging.queueEdit(relatedCollection, manyField, editState.rowId, editState.draft)
          setEditState(null)
          return
        }
        await client.request(patch(`/items/${relatedCollection}/${editState.rowId}`, editState.draft))
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      }
      setEditState(null)
    } catch {
      /* ignore */
    } finally {
      setSaving(false)
    }
  }

  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const [bulkCount, setBulkCount] = useState(1)
  const [bulkAdding, setBulkAdding] = useState(false)
  const [defaultsOpen, setDefaultsOpen] = useState(false)
  const [defaultValues, setDefaultValues] = useState<Record<string, unknown>>({})
  const [applyOpen, setApplyOpen] = useState(false)
  const [applyValues, setApplyValues] = useState<Record<string, unknown>>({})
  const [applying, setApplying] = useState(false)

  function setDefaultField(k: string, v: unknown) {
    setDefaultValues(prev => ({ ...prev, [k]: v }))
  }

  async function applyValuesToAllRows() {
    const hasValues = Object.keys(applyValues).some(k => applyValues[k] !== null && applyValues[k] !== undefined)
    if (!hasValues) return
    setApplying(true)
    try {
      if (rows.length) {
        await Promise.all(
          rows.map(row =>
            client.request(patch(`/items/${relatedCollection}/${row.id}`, applyValues))
          )
        )
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      }
      if (pendingRows.length && staging) {
        pendingRows.forEach((row, i) =>
          staging.updateRow(relatedCollection, manyField, i, { ...row, ...applyValues })
        )
      }
      setApplyOpen(false)
      setApplyValues({})
    } catch { /* ignore */ }
    finally { setApplying(false) }
  }

  async function addBulkRows(useDefaults: boolean) {
    const n = Math.max(1, Math.min(100, bulkCount))
    const rowData = useDefaults ? { ...defaultValues } : {}
    if (isNew && staging) {
      for (let i = 0; i < n; i++) staging.queueRow(relatedCollection, manyField, { ...rowData })
      return
    }
    setBulkAdding(true)
    try {
      await Promise.all(
        Array.from({ length: n }, () =>
          client.request(post(`/items/${relatedCollection}`, { ...rowData, [manyField]: parentId }))
        )
      )
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    } catch { /* ignore */ }
    finally { setBulkAdding(false) }
  }

  function handleDragStart(ri: number) { setDragIdx(ri) }
  function handleDragOver(e: React.DragEvent, ri: number) { e.preventDefault(); setDropIdx(ri) }
  function handleDragEnd() { setDragIdx(null); setDropIdx(null) }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    if (dragIdx === null || dropIdx === null || dragIdx === dropIdx) {
      handleDragEnd()
      return
    }
    const reordered = [...rows]
    const [moved] = reordered.splice(dragIdx, 1)
    reordered.splice(dropIdx, 0, moved)
    const changed = reordered
      .map((row, i) => ({ row, newOrder: i }))
      .filter(({ row, newOrder }) => Number(row[rowOrderField!] ?? 0) !== newOrder)
    await Promise.all(changed.map(({ row, newOrder }) =>
      client.request(patch(`/items/${relatedCollection}/${row.id}`, { [rowOrderField!]: newOrder }))
    ))
    qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    handleDragEnd()
  }

  async function deleteRow(id: unknown, e: React.MouseEvent) {
    e.stopPropagation()
    if (isPendingMode && staging) {
      staging.queueDelete(relatedCollection, manyField, String(id))
      if (editState?.rowId === String(id)) setEditState(null)
      return
    }
    try {
      await client.request(del(`/items/${relatedCollection}/${id}`))
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      if (editState?.rowId === String(id)) setEditState(null)
    } catch {
      /* ignore */
    }
  }

  function renderCell(col: CMSField, val: unknown) {
    if (val === null || val === undefined) return <span className='text-slate-300'>—</span>
    const m2oRel = m2oRelMap.get(col.field)
    if (m2oRel?.one_collection) {
      const display = m2oDisplays[m2oRel.one_collection]?.[String(val)]
      if (!display && m2oFetching) return <Loader2 className='h-3 w-3 animate-spin text-slate-300' />
      return <span className='block truncate'>{display ?? String(val)}</span>
    }
    if (col.type === 'boolean')
      return <span className={val ? 'text-emerald-600' : 'text-slate-400'}>{val ? 'Yes' : 'No'}</span>
    if (col.type === 'datetime' || col.type === 'date') {
      try { return <span className='block truncate'>{new Date(String(val)).toLocaleDateString()}</span> } catch { /* fall */ }
    }
    const NUMERIC_TYPES = ['integer', 'bigInteger', 'decimal', 'float', 'money', 'smallmoney', 'tinyint', 'smallint', 'bigint', 'int', 'numeric', 'real', 'double', 'number']
    if (NUMERIC_TYPES.includes(col.type ?? '')) {
      const num = Number(val)
      if (!Number.isNaN(num)) {
        try {
          const opts = col.options ? (typeof col.options === 'string' ? JSON.parse(col.options) : col.options) as Record<string, unknown> : {}
          const fmt = opts.format as string | undefined
          if (fmt === 'int') {
            return <span className='block truncate tabular-nums'>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(num)}</span>
          }
          if (fmt === 'decimal') {
            const prec = typeof opts.precision === 'number' ? opts.precision : 2
            return <span className='block truncate tabular-nums'>{new Intl.NumberFormat(undefined, { minimumFractionDigits: prec, maximumFractionDigits: prec }).format(num)}</span>
          }
          if (fmt === 'currency') {
            const curr = (opts.currency as string) || 'USD'
            return <span className='block truncate tabular-nums'>{new Intl.NumberFormat(undefined, { style: 'currency', currency: curr }).format(num)}</span>
          }
        } catch { /* fall through to default */ }
      }
    }
    return <span className='block truncate'>{String(val)}</span>
  }

  if (colsLoading || (!isNew && rowsLoading))
    return <div className='py-3 text-center text-[12px] text-slate-400'><Loader2 className='h-4 w-4 animate-spin inline' /></div>

  const isEditingNew = editState?.rowId === 'new'

  return (
    <div className='space-y-1.5'>
      <div className='flex items-center gap-2 text-[11px]'>
        <span className='text-slate-400'>Add</span>
        <input
          type='number'
          min={1}
          max={100}
          value={bulkCount}
          onChange={e => setBulkCount(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
          className='w-14 h-6 rounded border border-slate-200 px-2 text-[11px] text-slate-700 text-center focus:outline-none focus:ring-1 focus:ring-[#00ceff]'
        />
        <button
          type='button'
          disabled={bulkAdding}
          onClick={() => addBulkRows(false)}
          className='h-6 px-2.5 rounded border border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800 disabled:opacity-40 transition-colors'
        >
          blank {bulkCount === 1 ? 'row' : 'rows'}
        </button>
        {defaultsCols.length > 0 && (
          <button
            type='button'
            onClick={() => setDefaultsOpen(v => !v)}
            className={cn(
              'h-6 px-2.5 rounded border transition-colors',
              defaultsOpen
                ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
                : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800'
            )}
          >
            with defaults…
          </button>
        )}
        {applyValuesCols.length > 0 && (
          <button
            type='button'
            onClick={() => setApplyOpen(v => !v)}
            className={cn(
              'h-6 px-2.5 rounded border transition-colors',
              applyOpen
                ? 'border-amber-400 bg-amber-50 text-amber-700'
                : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800'
            )}
          >
            apply values…
          </button>
        )}
        {bulkAdding && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
      </div>

      {applyOpen && applyValuesCols.length > 0 && (
        <div className='rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2'>
          <p className='text-[11px] font-medium text-amber-700'>Apply values to all {rows.length + pendingRows.length} rows</p>
          <div className='flex flex-wrap gap-2 items-end'>
            {applyValuesCols.map(c => (
              <div key={c.field} className='min-w-[160px]'>
                <p className='text-[10px] text-slate-500 mb-0.5'>{c.label ?? titleCase(c.field)}</p>
                <FieldRenderer
                  field={c}
                  value={applyValues[c.field] ?? null}
                  onChange={v => setApplyValues(prev => ({ ...prev, [c.field]: v }))}
                  relations={childRelations}
                  collection={relatedCollection}
                  itemId='new'
                />
              </div>
            ))}
            <button
              type='button'
              disabled={applying || !(rows.length + pendingRows.length)}
              onClick={applyValuesToAllRows}
              className='h-9 rounded px-3 bg-amber-500 text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50 whitespace-nowrap'
            >
              {applying ? 'Applying…' : `Apply to all ${rows.length + pendingRows.length} rows`}
            </button>
          </div>
        </div>
      )}

    <div className='rounded-lg border border-slate-200 text-[12px]'>
      <table className='w-full table-fixed'>
        <thead className='bg-slate-50 border-b border-slate-200 [&>tr>th:first-child]:rounded-tl-lg [&>tr>th:last-child]:rounded-tr-lg'>
          <tr>
            {(rowOrderField || isNew) && <th className='w-6' />}
            {(isNew || isPendingMode) && <th className='px-3 py-2 text-left font-medium text-slate-400 text-[11px] w-20'>Status</th>}
            {displayCols.map((c) => (
              <th key={c.field} className='px-3 py-2 text-left font-medium text-slate-500 text-[11px]'>
                {c.label ?? titleCase(c.field)}
              </th>
            ))}
            <th className='w-20' />
          </tr>
        </thead>
        <tbody>
          {/* Defaults row */}
          {defaultsOpen && (
            <tr className='border-b border-[#00ceff]/20 bg-[#00ceff]/5'>
              {(rowOrderField || isNew) && <td className='w-6' />}
              {(isNew || isPendingMode) && <td className='px-3 py-1 align-middle w-20'>
                <span className='text-[10px] font-medium text-[#009abe]'>Defaults</span>
              </td>}
              {defaultsCols.map(c => (
                <td key={c.field} className='px-2 py-1 align-top'>
                  <FieldRenderer
                    field={c}
                    value={defaultValues[c.field] ?? null}
                    onChange={v => setDefaultField(c.field, v)}
                    relations={childRelations}
                    collection={relatedCollection}
                    itemId='new'
                  />
                </td>
              ))}
              <td className='px-1 py-1 align-top'>
                <button
                  type='button'
                  disabled={bulkAdding}
                  onClick={() => addBulkRows(true)}
                  className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50 whitespace-nowrap'
                >
                  {bulkAdding ? '…' : `Add ${bulkCount}`}
                </button>
              </td>
            </tr>
          )}

          {/* Pending rows for new parent */}
          {isNew && pendingRows.map((row, ri) => {
            const pendingRowId = `pending:${ri}`
            const isEditing = editState?.rowId === pendingRowId
            const isPDragging = dragIdx === ri
            const isPDropTarget = dropIdx === ri && dragIdx !== ri
            return (
              <tr key={ri}
                draggable={!isEditing}
                onDragStart={() => handleDragStart(ri)}
                onDragOver={(e) => handleDragOver(e, ri)}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragIdx !== null && dropIdx !== null && dragIdx !== dropIdx) {
                    staging?.reorderRows(relatedCollection, manyField, dragIdx, dropIdx)
                  }
                  handleDragEnd()
                }}
                onDragEnd={handleDragEnd}
                onClick={() => !isEditing && startPendingEdit(row, ri)}
                className={cn('border-b border-slate-100 transition-colors',
                  isPDragging ? 'opacity-40' : '',
                  isPDropTarget ? 'border-t-2 border-t-[#00ceff]' : '',
                  isEditing
                    ? 'bg-[#f0fbff] dark:bg-nvr-cyan/5 cursor-default'
                    : 'bg-amber-50/40 hover:bg-amber-50/70 cursor-pointer'
                )}>
                <td className='w-6 px-1 align-middle' onClick={(e) => e.stopPropagation()}>
                  <GripVertical className='h-3 w-3 text-slate-300 cursor-grab' />
                </td>
                <td className='px-3 py-1 align-middle w-16'>
                  {!isEditing && (
                    <span className='inline-flex text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5'>Pending</span>
                  )}
                </td>
                {displayCols.map((c) => (
                  <td key={c.field} className='px-2 py-1 align-top'>
                    {isEditing ? (
                      <div onClick={(e) => e.stopPropagation()}>
                        <FieldRenderer
                          field={{ ...c, sort: c.sort ?? 0 } as Parameters<typeof FieldRenderer>[0]['field']}
                          value={editState!.draft[c.field] ?? null}
                          onChange={(v) => setDraftField(c.field, v)}
                          relations={childRelations}
                          collection={relatedCollection}
                          itemId='new'
                        />
                      </div>
                    ) : (
                      <div className='py-0.5 overflow-hidden'>{renderCell(c, row[c.field])}</div>
                    )}
                  </td>
                ))}
                <td className='px-1 py-1 align-middle'>
                  {isEditing ? (
                    <div className='flex items-stretch gap-1' onClick={(e) => e.stopPropagation()}>
                      <button type='button' disabled={saving} onClick={saveEdit}
                        className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'>
                        {saving ? '…' : 'Save'}
                      </button>
                      <button type='button' onClick={cancelEdit}
                        className='rounded px-1.5 h-9 text-slate-400 hover:text-slate-700 text-[11px]'>
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button type='button'
                      onClick={(e) => { e.stopPropagation(); staging?.removeRow(relatedCollection, manyField, ri) }}
                      className='rounded p-0.5 text-slate-400 hover:text-red-500'>
                      <X className='h-3 w-3' />
                    </button>
                  )}
                </td>
              </tr>
            )
          })}

          {/* Saved rows */}
          {!isNew && rows.map((row, ri) => {
            const id = String(row.id)
            const isEditing = editState?.rowId === id
            const isDragging = dragIdx === ri
            const isDropTarget = dropIdx === ri && dragIdx !== ri
            const isPendingEdit = pendingEdits.has(id)
            const isPendingDelete = pendingDeletes.has(id)
            // Merge pending edit changes into display values
            const displayRow = isPendingEdit ? { ...row, ...pendingEdits.get(id) } : row
            return (
              <tr key={id}
                draggable={!!rowOrderField && !isEditing && !isPendingDelete}
                onDragStart={() => handleDragStart(ri)}
                onDragOver={(e) => handleDragOver(e, ri)}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                onClick={() => !isEditing && !isPendingDelete && startEdit(row)}
                className={cn('border-b border-slate-100 transition-colors',
                  isDragging ? 'opacity-40' : '',
                  isDropTarget ? 'border-t-2 border-t-[#00ceff]' : '',
                  isPendingDelete ? 'opacity-50 bg-red-50/40 cursor-default line-through' : '',
                  !isPendingDelete && isEditing ? 'bg-[#f0fbff] dark:bg-nvr-cyan/5 cursor-default' : '',
                  !isPendingDelete && !isEditing
                    ? ri % 2 === 0
                      ? 'bg-white hover:bg-slate-50/80 cursor-pointer'
                      : 'bg-slate-50/50 hover:bg-slate-100/60 cursor-pointer'
                    : ''
                )}>
                {rowOrderField && (
                  <td className='w-6 px-1 align-middle' onClick={(e) => e.stopPropagation()}>
                    <GripVertical className='h-3 w-3 text-slate-300 cursor-grab' />
                  </td>
                )}
                {isPendingMode && (
                  <td className='px-3 py-1 align-middle w-20'>
                    {isPendingDelete
                      ? <span className='inline-flex text-[10px] font-medium text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5'>Delete</span>
                      : isPendingEdit
                        ? <span className='inline-flex text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5'>Edited</span>
                        : null
                    }
                  </td>
                )}
                {displayCols.map((c) => (
                  <td key={c.field} className='px-2 py-1 align-top'>
                    {isEditing && !isPendingDelete ? (
                      <div onClick={(e) => e.stopPropagation()}>
                        <FieldRenderer
                          field={{ ...c, sort: c.sort ?? 0 } as Parameters<typeof FieldRenderer>[0]['field']}
                          value={editState!.draft[c.field] ?? null}
                          onChange={(v) => setDraftField(c.field, v)}
                          relations={childRelations}
                          collection={relatedCollection}
                          itemId={id}
                        />
                      </div>
                    ) : (
                      <div className='py-0.5 overflow-hidden'>{renderCell(c, displayRow[c.field])}</div>
                    )}
                  </td>
                ))}
                <td className='px-1 py-1 align-middle'>
                  {isEditing && !isPendingDelete ? (
                    <div className='flex items-stretch gap-1' onClick={(e) => e.stopPropagation()}>
                      <button type='button' disabled={saving} onClick={saveEdit}
                        className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'>
                        {saving ? '…' : isPendingMode ? 'Queue' : 'Save'}
                      </button>
                      <button type='button' onClick={cancelEdit}
                        className='rounded px-1.5 h-9 text-slate-400 hover:text-slate-700 text-[11px]'>
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className='flex items-center justify-end gap-0.5'>
                      {isPendingDelete ? (
                        <button type='button' title='Undo delete'
                          onClick={(e) => { e.stopPropagation(); staging?.cancelPendingDelete(relatedCollection, manyField, id) }}
                          className='rounded px-1.5 py-0.5 text-[10px] text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400'>
                          Undo
                        </button>
                      ) : (
                        <>
                          {isPendingEdit && (
                            <button type='button' title='Undo edit'
                              onClick={(e) => { e.stopPropagation(); staging?.cancelPendingEdit(relatedCollection, manyField, id) }}
                              className='rounded p-0.5 text-amber-400 hover:text-amber-600 text-[10px]'>
                              ↩
                            </button>
                          )}
                          {showRowRevisions && (
                            <button type='button' title='Row history'
                              onClick={(e) => { e.stopPropagation(); setHistoryRow(row) }}
                              className='rounded p-0.5 text-slate-300 hover:text-[#00ceff]'>
                              <History className='h-3 w-3' />
                            </button>
                          )}
                          <button type='button' onClick={(e) => deleteRow(row.id, e)}
                            className='rounded p-0.5 text-slate-300 hover:text-red-500'>
                            <X className='h-3 w-3' />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            )
          })}

          {/* New row inline */}
          {isEditingNew && (
            <tr className='border-b border-slate-100 bg-[#f0fbff] dark:bg-nvr-cyan/5'>
              {(rowOrderField || isNew) && <td className='w-6' />}
              {(isNew || isPendingMode) && <td className='px-3 py-1.5' />}
              {displayCols.map((c) => (
                <td key={c.field} className='px-2 py-1 align-top'>
                  <div onClick={(e) => e.stopPropagation()}>
                    <FieldRenderer
                      field={{ ...c, sort: c.sort ?? 0 } as Parameters<typeof FieldRenderer>[0]['field']}
                      value={editState!.draft[c.field] ?? null}
                      onChange={(v) => setDraftField(c.field, v)}
                      relations={childRelations}
                      collection={relatedCollection}
                      itemId='new'
                    />
                  </div>
                </td>
              ))}
              <td className='px-1 py-1 align-middle'>
                <div className='flex items-stretch gap-1'>
                  <button type='button' disabled={saving} onClick={saveEdit}
                    className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'>
                    {saving ? '…' : 'Add'}
                  </button>
                  <button type='button' onClick={cancelEdit}
                    className='rounded px-1.5 h-9 text-slate-400 hover:text-slate-700 text-[11px]'>
                    ✕
                  </button>
                </div>
              </td>
            </tr>
          )}

          {(isNew || isPendingMode ? pendingRows : rows).length === 0 && (!isPendingMode || rows.length === 0) && !isEditingNew && (
            <tr>
              <td colSpan={displayCols.length + ((isNew || isPendingMode) ? 2 : 1) + (rowOrderField || isNew ? 1 : 0)} className='px-3 py-14 text-center text-slate-400'>
                {isNew ? 'No pending rows' : 'No rows yet'}
              </td>
            </tr>
          )}
        </tbody>
        {(() => {
          const aggCols = displayCols.filter(c => {
            const opts = c.options ? (typeof c.options === 'string' ? (() => { try { return JSON.parse(c.options as string) } catch { return {} } })() : c.options) as Record<string, unknown> : {}
            return !!opts.aggregate
          })
          if (aggCols.length === 0) return null
          const allRows = [...(rows ?? []), ...pendingRows]
          return (
            <tfoot>
              <tr className='border-t border-slate-200 bg-slate-50 text-[11px] font-medium text-slate-600'>
                {(rowOrderField || isNew) && <td />}
                {(isNew || isPendingMode) && <td />}
                {displayCols.map(c => {
                  const opts = c.options ? (typeof c.options === 'string' ? (() => { try { return JSON.parse(c.options as string) } catch { return {} } })() : c.options) as Record<string, unknown> : {}
                  const agg = opts.aggregate as string | undefined
                  if (!agg) return <td key={c.field} className='px-3 py-1.5' />
                  const nums = allRows.map(r => Number(r[c.field])).filter(n => !Number.isNaN(n))
                  let result: number | null = null
                  if (agg === 'count') result = allRows.length
                  else if (nums.length > 0) {
                    if (agg === 'sum') result = nums.reduce((a, b) => a + b, 0)
                    else if (agg === 'avg') result = nums.reduce((a, b) => a + b, 0) / nums.length
                    else if (agg === 'min') result = Math.min(...nums)
                    else if (agg === 'max') result = Math.max(...nums)
                  }
                  const fmt = opts.format as string | undefined
                  let display = result === null ? '—' : (() => {
                    try {
                      if (fmt === 'currency') return new Intl.NumberFormat(undefined, { style: 'currency', currency: (opts.currency as string) || 'USD' }).format(result)
                      if (fmt === 'decimal') { const p = typeof opts.precision === 'number' ? opts.precision : 2; return new Intl.NumberFormat(undefined, { minimumFractionDigits: p, maximumFractionDigits: p }).format(result) }
                      if (fmt === 'int' || agg === 'count') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(result)
                      return agg === 'avg' ? result.toFixed(2) : String(result)
                    } catch { return String(result) }
                  })()
                  return (
                    <td key={c.field} className='px-3 py-1.5'>
                      <span className='text-slate-400 text-[10px] font-mono mr-1'>{agg.toUpperCase()}</span>
                      <span className='tabular-nums'>{display}</span>
                    </td>
                  )
                })}
                <td />
              </tr>
            </tfoot>
          )
        })()}
      </table>

      {!isEditingNew && (
        <div className='border-t border-slate-100 px-3 py-1.5'>
          <button type='button' onClick={startNew}
            className='text-[11px] font-medium text-[#00ceff] hover:underline'>
            + Add row
          </button>
        </div>
      )}
    </div>

    <Sheet open={!!historyRow} onOpenChange={(o) => !o && setHistoryRow(null)}>
      <SheetContent className='w-[420px] sm:max-w-[420px] overflow-y-auto'>
        <SheetHeader>
          <SheetTitle className='text-[14px]'>Row history</SheetTitle>
        </SheetHeader>
        <div className='mt-4 space-y-3'>
          {revLoading ? (
            <div className='py-6 text-center'><Loader2 className='h-4 w-4 animate-spin inline text-slate-400' /></div>
          ) : rowRevisions.length === 0 ? (
            <p className='py-6 text-center text-[12px] text-slate-400'>No history for this row</p>
          ) : (
            rowRevisions.map((rev) => {
              const who = [rev.first_name, rev.last_name].filter(Boolean).join(' ') || rev.user_email || 'System'
              const changes = rev.delta ?? rev.data ?? {}
              return (
                <div key={rev.id} className='rounded-lg border border-slate-200 p-3'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='text-[11px] font-medium text-slate-600'>{who}</span>
                    <span className='text-[10px] text-slate-400'>{rev.timestamp ? formatRelative(rev.timestamp) : ''}</span>
                  </div>
                  {rev.action && <span className='mt-0.5 inline-block text-[10px] font-medium uppercase tracking-wide text-slate-400'>{rev.action}</span>}
                  <div className='mt-2 space-y-1'>
                    {Object.entries(changes).map(([k, v]) => (
                      <div key={k} className='flex items-start gap-2 text-[11px]'>
                        <span className='shrink-0 font-medium text-slate-500'>{titleCase(k)}:</span>
                        <span className='break-words text-slate-700'>
                          {v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
    </div>
  )
}
