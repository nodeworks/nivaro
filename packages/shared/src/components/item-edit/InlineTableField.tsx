import { useQuery, useQueryClient } from '@tanstack/react-query'
import { GripVertical, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { useO2MStaging } from './O2MStagingContext'
import { FieldRenderer } from './FieldRenderer'
import { applyDisplayTemplate, SENTINEL_FIELDS } from './helpers'
import type { CMSField, CMSRelation } from './types'

const NON_DISPLAY_TYPES = new Set(['alias', 'o2m', 'm2m', 'm2a', 'presentation', 'group', 'divider'])

export function InlineTableField({
  relatedCollection,
  manyField,
  parentId,
  layoutId
}: {
  relatedCollection: string
  manyField: string
  parentId: string
  layoutId?: number | null
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const staging = useO2MStaging()
  const isNew = parentId === 'new'

  // { rowId, draft } — null = no row editing, 'new' = adding new row
  const [editState, setEditState] = useState<{ rowId: string; draft: Record<string, unknown> } | null>(null)
  const [saving, setSaving] = useState(false)

  // Columns ordered by layout assignment when layoutId is provided
  const { data: cols = [], isLoading: colsLoading } = useQuery<CMSField[]>({
    queryKey: ['field-config', relatedCollection, layoutId ?? null],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(
          get(`/field-config/${relatedCollection}`, layoutId ? { layout_id: String(layoutId) } : undefined)
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
    queryKey: ['layout-meta', layoutId],
    queryFn: () =>
      client
        .request<{ data: { row_order_field?: string | null } }>(get(`/collection-layouts/${layoutId}`))
        .then((r) => r.data ?? {}),
    enabled: !!layoutId,
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

  const pendingRows = isNew && staging ? staging.getPendingRows(relatedCollection, manyField) : []

  const displayCols = cols.filter(
    (c) =>
      !c.hidden &&
      !NON_DISPLAY_TYPES.has(c.type) &&
      c.field !== manyField &&
      c.field !== 'id' &&
      (!layoutId || c.layout_assigned === true) &&
      !SENTINEL_FIELDS.has(c.field)
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
        if (isNew && staging) {
          staging.queueRow(relatedCollection, manyField, { ...editState.draft })
          setEditState(null)
          return
        }
        await client.request(post(`/items/${relatedCollection}`, { ...editState.draft, [manyField]: parentId }))
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      } else {
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

  function makeDefaultRow(withDefaults: boolean): Record<string, unknown> {
    if (!withDefaults) return {}
    const row: Record<string, unknown> = {}
    for (const c of displayCols) {
      if (c.field === manyField || c.field === 'id') continue
      if (c.type === 'boolean') row[c.field] = false
      else if (['integer','bigInteger','decimal','float','money','smallmoney','tinyint','smallint','bigint','int','numeric','real','double','number'].includes(c.type)) row[c.field] = 0
      else row[c.field] = null
    }
    return row
  }

  async function addBulkRows(withDefaults: boolean) {
    const n = Math.max(1, Math.min(100, bulkCount))
    if (isNew && staging) {
      for (let i = 0; i < n; i++) staging.queueRow(relatedCollection, manyField, makeDefaultRow(withDefaults))
      return
    }
    setBulkAdding(true)
    try {
      await Promise.all(
        Array.from({ length: n }, () =>
          client.request(post(`/items/${relatedCollection}`, { ...makeDefaultRow(withDefaults), [manyField]: parentId }))
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
        <button
          type='button'
          disabled={bulkAdding}
          onClick={() => addBulkRows(true)}
          className='h-6 px-2.5 rounded border border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800 disabled:opacity-40 transition-colors'
        >
          with defaults
        </button>
        {bulkAdding && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
      </div>
    <div className='rounded-lg border border-slate-200 text-[12px]'>
      <table className='w-full table-fixed'>
        <thead className='bg-slate-50 border-b border-slate-200 [&>tr>th:first-child]:rounded-tl-lg [&>tr>th:last-child]:rounded-tr-lg'>
          <tr>
            {(rowOrderField || isNew) && <th className='w-6' />}
            {isNew && <th className='px-3 py-2 text-left font-medium text-slate-400 text-[11px] w-16'>Status</th>}
            {displayCols.map((c) => (
              <th key={c.field} className='px-3 py-2 text-left font-medium text-slate-500 text-[11px]'>
                {c.label ?? titleCase(c.field)}
              </th>
            ))}
            <th className='w-20' />
          </tr>
        </thead>
        <tbody>
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
            return (
              <tr key={id}
                draggable={!!rowOrderField && !isEditing}
                onDragStart={() => handleDragStart(ri)}
                onDragOver={(e) => handleDragOver(e, ri)}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                onClick={() => !isEditing && startEdit(row)}
                className={cn('border-b border-slate-100 transition-colors',
                  isDragging ? 'opacity-40' : '',
                  isDropTarget ? 'border-t-2 border-t-[#00ceff]' : '',
                  isEditing
                    ? 'bg-[#f0fbff] dark:bg-nvr-cyan/5 cursor-default'
                    : ri % 2 === 0
                      ? 'bg-white hover:bg-slate-50/80 cursor-pointer'
                      : 'bg-slate-50/50 hover:bg-slate-100/60 cursor-pointer'
                )}>
                {rowOrderField && (
                  <td className='w-6 px-1 align-middle' onClick={(e) => e.stopPropagation()}>
                    <GripVertical className='h-3 w-3 text-slate-300 cursor-grab' />
                  </td>
                )}
                {displayCols.map((c) => (
                  <td key={c.field} className='px-2 py-1 align-top'>
                    {isEditing ? (
                      <div onClick={(e) => e.stopPropagation()}>
                        <FieldRenderer
                          field={{ ...c, sort: c.sort ?? 0 } as Parameters<typeof FieldRenderer>[0]['field']}
                          value={editState.draft[c.field] ?? null}
                          onChange={(v) => setDraftField(c.field, v)}
                          relations={childRelations}
                          collection={relatedCollection}
                          itemId={id}
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
                    <button type='button' onClick={(e) => deleteRow(row.id, e)}
                      className='rounded p-0.5 text-slate-300 hover:text-red-500'>
                      <X className='h-3 w-3' />
                    </button>
                  )}
                </td>
              </tr>
            )
          })}

          {/* New row inline */}
          {isEditingNew && (
            <tr className='border-b border-slate-100 bg-[#f0fbff] dark:bg-nvr-cyan/5'>
              {(rowOrderField || isNew) && <td className='w-6' />}
              {isNew && <td className='px-3 py-1.5' />}
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

          {(isNew ? pendingRows : rows).length === 0 && !isEditingNew && (
            <tr>
              <td colSpan={displayCols.length + (isNew ? 2 : 1) + (rowOrderField || isNew ? 1 : 0)} className='px-3 py-4 text-center text-slate-400'>
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
                {isNew && <td />}
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
    </div>
  )
}
