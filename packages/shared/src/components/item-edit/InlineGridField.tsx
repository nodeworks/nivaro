import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { useAddendumO2M, useAddendumView } from './AddendumFieldContext'
import { useO2MStaging } from './O2MStagingContext'
import type { ActiveLayoutData, CMSField, FieldGroup } from './types'

const NON_DISPLAY_TYPES = new Set([
  'alias',
  'o2m',
  'm2m',
  'm2a',
  'presentation',
  'group',
  'divider'
])

export function InlineGridField({
  relatedCollection,
  manyField,
  parentId,
  layoutSlug,
  parentFieldKey
}: {
  relatedCollection: string
  manyField: string
  parentId: string
  layoutSlug?: string | null
  parentFieldKey?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const staging = useO2MStaging()
  const isNew = parentId === 'new'
  const addendumO2MEntries = useAddendumO2M()[parentFieldKey ?? ''] ?? []

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Record<string, unknown>>({})
  const [addingNew, setAddingNew] = useState(false)
  const [newDraft, setNewDraft] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const activeView = useAddendumView()

  // Layout data (for grouped edit form)
  const { data: activeLayoutData } = useQuery<ActiveLayoutData | null>({
    queryKey: ['active-layout', relatedCollection, layoutSlug ?? null],
    queryFn: () =>
      client
        .request<{ data: ActiveLayoutData | null }>(
          get('/collection-layouts/active', {
            collection: relatedCollection,
            ...(layoutSlug ? { slug: layoutSlug } : {})
          })
        )
        .then((r) => r.data)
        .catch(() => null),
    staleTime: 60_000,
    enabled: !!layoutSlug
  })

  const layoutId = layoutSlug ? (activeLayoutData?.layout?.id ?? null) : null

  const { data: cols = [] } = useQuery<CMSField[]>({
    queryKey: ['field-config', relatedCollection, layoutId],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(
          get(`/field-config/${relatedCollection}`, layoutId ? { layout_id: String(layoutId) } : undefined)
        )
        .then((r) => r.data ?? []),
    staleTime: 60_000,
    enabled: !layoutSlug || activeLayoutData !== undefined
  })

  const { data: rows = [], isLoading } = useQuery<Record<string, unknown>[]>({
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

  const pendingRows = isNew && staging ? staging.getPendingRows(relatedCollection, manyField) : []

  const displayCols = cols.filter(
    (c) => !c.hidden && !NON_DISPLAY_TYPES.has(c.type) && c.field !== manyField && c.field !== 'id'
  )

  // Groups from layout for the edit form
  const sectionGroups: FieldGroup[] = useMemo(
    () => (activeLayoutData?.groups ?? []).filter(g => g.type === 'section').sort((a, b) => a.sort - b.sort),
    [activeLayoutData]
  )

  const fieldsByGroup = useMemo(() => {
    if (!sectionGroups.length) return null
    const map = new Map<string | null, CMSField[]>()
    for (const col of displayCols) {
      const key = col.group_key ?? null
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(col)
    }
    return map
  }, [displayCols, sectionGroups])

  async function saveEdit(id: string) {
    setSaving(true)
    try {
      await client.request(patch(`/items/${relatedCollection}/${id}`, editDraft))
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      setEditingId(null)
    } catch {
      /* ignore */
    } finally {
      setSaving(false)
    }
  }

  async function saveNew() {
    if (isNew && staging) {
      staging.queueRow(relatedCollection, manyField, { ...newDraft })
      setAddingNew(false)
      setNewDraft({})
      return
    }
    setSaving(true)
    try {
      await client.request(
        post(`/items/${relatedCollection}`, { ...newDraft, [manyField]: parentId })
      )
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      setAddingNew(false)
      setNewDraft({})
    } catch {
      /* ignore */
    } finally {
      setSaving(false)
    }
  }

  async function deleteRow(id: unknown) {
    try {
      await client.request(del(`/items/${relatedCollection}/${id}`))
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    } catch {
      /* ignore */
    }
  }

  function renderCell(col: CMSField, val: unknown) {
    if (val === null || val === undefined) return <span className='text-slate-300'>—</span>
    if (col.type === 'boolean')
      return (
        <span className={val ? 'text-emerald-600' : 'text-slate-400'}>{val ? 'Yes' : 'No'}</span>
      )
    if (col.type === 'datetime' || col.type === 'date') {
      try {
        return <span>{new Date(String(val)).toLocaleDateString()}</span>
      } catch {
        /* fall */
      }
    }
    return <span className='truncate'>{String(val)}</span>
  }

  function renderEditInput(
    col: CMSField,
    draft: Record<string, unknown>,
    set: (k: string, v: unknown) => void
  ) {
    const v = draft[col.field] ?? ''
    if (col.type === 'boolean')
      return (
        <input
          type='checkbox'
          checked={Boolean(v)}
          onChange={(e) => set(col.field, e.target.checked)}
          className='h-4 w-4'
        />
      )
    if (
      col.type === 'integer' ||
      col.type === 'bigInteger' ||
      col.type === 'float' ||
      col.type === 'decimal'
    ) {
      return (
        <input
          type='number'
          value={String(v)}
          onChange={(e) => set(col.field, e.target.value === '' ? null : Number(e.target.value))}
          className='w-full rounded border border-slate-200 px-2 py-1.5 text-[12px] focus:outline-none focus:border-[#00ceff]'
        />
      )
    }
    if (col.type === 'date')
      return (
        <input
          type='date'
          value={String(v).slice(0, 10)}
          onChange={(e) => set(col.field, e.target.value || null)}
          className='w-full rounded border border-slate-200 px-2 py-1.5 text-[12px] focus:outline-none focus:border-[#00ceff]'
        />
      )
    if (col.type === 'datetime')
      return (
        <input
          type='datetime-local'
          value={String(v).slice(0, 16)}
          onChange={(e) =>
            set(col.field, e.target.value ? new Date(e.target.value).toISOString() : null)
          }
          className='w-full rounded border border-slate-200 px-2 py-1.5 text-[12px] focus:outline-none focus:border-[#00ceff]'
        />
      )
    return (
      <input
        type='text'
        value={String(v)}
        onChange={(e) => set(col.field, e.target.value)}
        className='w-full rounded border border-slate-200 px-2 py-1.5 text-[12px] focus:outline-none focus:border-[#00ceff]'
      />
    )
  }

  // Grouped edit form — renders when layout has sections
  function renderGroupedForm(
    draft: Record<string, unknown>,
    set: (k: string, v: unknown) => void,
    onSave: () => void,
    onCancel: () => void,
    label: string
  ) {
    const ungrouped = fieldsByGroup?.get(null) ?? []

    return (
      <div className='border border-slate-200 rounded-lg bg-white overflow-hidden'>
        <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2 bg-slate-50'>
          <span className='text-[11px] font-semibold text-slate-600 uppercase tracking-wide'>{label}</span>
          <div className='flex items-center gap-2'>
            <button
              type='button'
              onClick={onCancel}
              className='text-[11px] text-slate-400 hover:text-slate-600 px-2 py-0.5 rounded'
            >
              Cancel
            </button>
            <button
              type='button'
              disabled={saving}
              onClick={onSave}
              className='text-[11px] font-medium bg-[#00ceff] text-white px-2.5 py-0.5 rounded hover:brightness-110 disabled:opacity-50'
            >
              {saving ? '…' : 'Save'}
            </button>
          </div>
        </div>
        <div className='p-3 space-y-4'>
          {/* Ungrouped fields first */}
          {ungrouped.length > 0 && (
            <div className='grid grid-cols-2 gap-x-4 gap-y-2'>
              {ungrouped.map((col) => (
                <div key={col.field}>
                  <label className='block text-[11px] font-medium text-slate-500 mb-1'>
                    {col.label ?? titleCase(col.field)}
                  </label>
                  {renderEditInput(col, draft, set)}
                </div>
              ))}
            </div>
          )}
          {/* Grouped sections */}
          {sectionGroups.map((g) => {
            const gFields = fieldsByGroup?.get(g.key) ?? []
            if (!gFields.length) return null
            return (
              <div key={g.key}>
                <div className='text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2 pb-1 border-b border-slate-100'>
                  {g.label}
                </div>
                <div className='grid grid-cols-2 gap-x-4 gap-y-2'>
                  {gFields.map((col) => (
                    <div key={col.field}>
                      <label className='block text-[11px] font-medium text-slate-500 mb-1'>
                        {col.label ?? titleCase(col.field)}
                      </label>
                      {renderEditInput(col, draft, set)}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Flat inline row edit cells (no layout)
  function renderInlineEditCells(
    draft: Record<string, unknown>,
    set: (k: string, v: unknown) => void
  ) {
    return displayCols.map((c) => (
      <td key={c.field} className='px-3 py-1.5'>
        {renderEditInput(c, draft, set)}
      </td>
    ))
  }

  if (!isNew && isLoading)
    return (
      <div className='py-3 text-center text-[12px] text-slate-400'>
        <Loader2 className='h-4 w-4 animate-spin inline' />
      </div>
    )

  const displayRows = isNew ? pendingRows : rows
  const useGroupedForm = !!fieldsByGroup && sectionGroups.length > 0

  return (
    <div className='relative rounded-lg border border-slate-200 text-[12px]'>
      <table className='w-full'>
        <thead className='bg-slate-50 border-b border-slate-200'>
          <tr>
            {isNew && <th className='px-3 py-2 text-left font-medium text-slate-400 text-[11px] w-16'>Status</th>}
            {displayCols.map((c) => (
              <th
                key={c.field}
                className='px-3 py-2 text-left font-medium text-slate-500 text-[11px]'
              >
                {c.label ?? titleCase(c.field)}
              </th>
            ))}
            <th className='w-16' />
          </tr>
        </thead>
        <tbody>
          {/* Pending rows (new item, not yet saved) */}
          {isNew && pendingRows.map((row, ri) => (
            <tr key={ri} className='border-b border-slate-100 bg-amber-50/40'>
              <td className='px-3 py-1.5'>
                <span className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>Pending</span>
              </td>
              {displayCols.map((c) => (
                <td key={c.field} className='px-3 py-1.5 text-slate-600'>
                  {renderCell(c, row[c.field])}
                </td>
              ))}
              <td className='px-2 py-1.5'>
                <button
                  type='button'
                  onClick={() => staging?.removeRow(relatedCollection, manyField, ri)}
                  className='rounded p-0.5 text-slate-400 hover:text-red-500'
                >
                  <X className='h-3 w-3' />
                </button>
              </td>
            </tr>
          ))}

          {/* Saved rows */}
          {!isNew && activeView === 'original' && rows.map((row, ri) => {
            const id = String(row.id)
            const isEditing = editingId === id && !useGroupedForm
            return (
              <tr
                key={id}
                className={cn(
                  'border-b border-slate-100',
                  ri % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'
                )}
              >
                {displayCols.map((c) => (
                  <td key={c.field} className='px-3 py-1.5'>
                    {isEditing
                      ? renderEditInput(c, editDraft, (k, v) =>
                          setEditDraft((d) => ({ ...d, [k]: v }))
                        )
                      : renderCell(c, row[c.field])}
                  </td>
                ))}
                <td className='px-2 py-1.5'>
                  <div className='flex items-center gap-1 justify-end'>
                    {isEditing ? (
                      <>
                        <button
                          type='button'
                          disabled={saving}
                          onClick={() => saveEdit(id)}
                          className='rounded px-1.5 py-0.5 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'
                        >
                          {saving ? '…' : 'Save'}
                        </button>
                        <button
                          type='button'
                          onClick={() => setEditingId(null)}
                          className='rounded px-1.5 py-0.5 text-slate-400 hover:text-slate-700 text-[11px]'
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type='button'
                          onClick={() => {
                            setEditingId(id)
                            setEditDraft({ ...row })
                          }}
                          className='rounded p-0.5 text-slate-400 hover:text-slate-700'
                        >
                          <ChevronRight className='h-3.5 w-3.5' />
                        </button>
                        <button
                          type='button'
                          onClick={() => deleteRow(row.id)}
                          className='rounded p-0.5 text-slate-400 hover:text-red-500'
                        >
                          <X className='h-3 w-3' />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}

          {/* Addendum view rows */}
          {!isNew && activeView !== 'original' && (() => {
            const entry = addendumO2MEntries.find(e => e.addendumId === activeView)
            // Untouched field → current rows read-only (form stays complete)
            if (!entry) {
              if (rows.length === 0) return (
                <tr>
                  <td colSpan={displayCols.length + 1} className='px-3 py-4 text-center text-[11px] text-slate-400'>
                    No rows
                  </td>
                </tr>
              )
              return rows.map((row, ri) => (
                <tr key={ri} className='border-b border-slate-100'>
                  {displayCols.map((c) => (
                    <td key={c.field} className='px-3 py-1.5 text-[11px] text-slate-700'>
                      {renderCell(c, row[c.field])}
                    </td>
                  ))}
                  <td className='px-2 py-1.5' />
                </tr>
              ))
            }
            if (entry.rows.length === 0) return (
              <tr>
                <td colSpan={displayCols.length + 1} className='px-3 py-4 text-center text-[11px] text-amber-500'>
                  No proposed rows in this addendum
                </td>
              </tr>
            )
            return entry.rows.map((row, ri) => (
              <tr key={ri} className='border-b border-amber-100 bg-amber-50/60'>
                {displayCols.map((c) => (
                  <td key={c.field} className='px-3 py-1.5 text-[11px] text-amber-900'>
                    {renderCell(c, row[c.field])}
                  </td>
                ))}
                <td className='px-2 py-1.5 text-right'>
                  <span className='text-[10px] font-medium uppercase tracking-wide text-amber-400'>Proposed</span>
                </td>
              </tr>
            ))
          })()}

          {/* Inline add-row (no layout) */}
          {activeView === 'original' && addingNew && !useGroupedForm && (
            <tr className='border-b border-slate-100 bg-nvr-cyan/5'>
              {isNew && <td className='px-3 py-1.5' />}
              {renderInlineEditCells(newDraft, (k, v) => setNewDraft((d) => ({ ...d, [k]: v })))}
              <td className='px-2 py-1.5'>
                <div className='flex items-center gap-1 justify-end'>
                  <button
                    type='button'
                    disabled={saving}
                    onClick={saveNew}
                    className='rounded px-1.5 py-0.5 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'
                  >
                    {saving ? '…' : 'Add'}
                  </button>
                  <button
                    type='button'
                    onClick={() => { setAddingNew(false); setNewDraft({}) }}
                    className='rounded px-1.5 py-0.5 text-slate-400 hover:text-slate-700 text-[11px]'
                  >
                    Cancel
                  </button>
                </div>
              </td>
            </tr>
          )}

          {activeView === 'original' && displayRows.length === 0 && !addingNew && (
            <tr>
              <td colSpan={displayCols.length + (isNew ? 2 : 1)} className='px-3 py-4 text-center text-slate-400'>
                {isNew ? 'No pending rows' : 'No rows'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Grouped edit form — appears below table when layout has sections */}
      {editingId && useGroupedForm && (() => {
        const row = rows.find(r => String(r.id) === editingId)
        if (!row) return null
        return (
          <div className='border-t border-slate-200 p-3'>
            {renderGroupedForm(
              editDraft,
              (k, v) => setEditDraft((d) => ({ ...d, [k]: v })),
              () => saveEdit(editingId),
              () => setEditingId(null),
              'Edit Row'
            )}
          </div>
        )
      })()}

      {/* Grouped add form — appears below table when layout has sections */}
      {addingNew && useGroupedForm && (
        <div className='border-t border-slate-200 p-3'>
          {renderGroupedForm(
            newDraft,
            (k, v) => setNewDraft((d) => ({ ...d, [k]: v })),
            saveNew,
            () => { setAddingNew(false); setNewDraft({}) },
            'New Row'
          )}
        </div>
      )}

      {activeView === 'original' && !addingNew && (
        <div className='border-t border-slate-100 px-3 py-1.5'>
          <button
            type='button'
            onClick={() => setAddingNew(true)}
            className='text-[11px] font-medium text-[#00ceff] hover:underline'
          >
            + Add row
          </button>
        </div>
      )}
    </div>
  )
}
