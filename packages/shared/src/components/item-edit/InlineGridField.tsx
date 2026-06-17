import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import type { CMSField } from './types'

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
  parentId
}: {
  relatedCollection: string
  manyField: string
  parentId: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Record<string, unknown>>({})
  const [addingNew, setAddingNew] = useState(false)
  const [newDraft, setNewDraft] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)

  const { data: cols = [] } = useQuery<CMSField[]>({
    queryKey: ['field-config', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(get(`/field-config/${relatedCollection}`))
        .then((r) => r.data ?? []),
    staleTime: 60_000
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
    staleTime: 30_000
  })

  const displayCols = cols.filter(
    (c) => !c.hidden && !NON_DISPLAY_TYPES.has(c.type) && c.field !== manyField && c.field !== 'id'
  )

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

  function renderEditCell(
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
          className='w-full rounded border border-slate-200 px-1.5 py-0.5 text-[12px] focus:outline-none focus:border-[#00ceff]'
        />
      )
    }
    if (col.type === 'date')
      return (
        <input
          type='date'
          value={String(v).slice(0, 10)}
          onChange={(e) => set(col.field, e.target.value || null)}
          className='w-full rounded border border-slate-200 px-1.5 py-0.5 text-[12px] focus:outline-none focus:border-[#00ceff]'
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
          className='w-full rounded border border-slate-200 px-1.5 py-0.5 text-[12px] focus:outline-none focus:border-[#00ceff]'
        />
      )
    return (
      <input
        type='text'
        value={String(v)}
        onChange={(e) => set(col.field, e.target.value)}
        className='w-full rounded border border-slate-200 px-1.5 py-0.5 text-[12px] focus:outline-none focus:border-[#00ceff]'
      />
    )
  }

  if (isLoading)
    return (
      <div className='py-3 text-center text-[12px] text-slate-400'>
        <Loader2 className='h-4 w-4 animate-spin inline' />
      </div>
    )

  return (
    <div className='rounded-lg border border-slate-200 overflow-hidden text-[12px]'>
      <table className='w-full'>
        <thead className='bg-slate-50 border-b border-slate-200'>
          <tr>
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
          {rows.map((row, ri) => {
            const id = String(row.id)
            const isEditing = editingId === id
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
                      ? renderEditCell(c, editDraft, (k, v) =>
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
          {addingNew && (
            <tr className='border-b border-slate-100 bg-nvr-cyan/5'>
              {displayCols.map((c) => (
                <td key={c.field} className='px-3 py-1.5'>
                  {renderEditCell(c, newDraft, (k, v) => setNewDraft((d) => ({ ...d, [k]: v })))}
                </td>
              ))}
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
                    onClick={() => {
                      setAddingNew(false)
                      setNewDraft({})
                    }}
                    className='rounded px-1.5 py-0.5 text-slate-400 hover:text-slate-700 text-[11px]'
                  >
                    Cancel
                  </button>
                </div>
              </td>
            </tr>
          )}
          {rows.length === 0 && !addingNew && (
            <tr>
              <td colSpan={displayCols.length + 1} className='px-3 py-4 text-center text-slate-400'>
                No rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {!addingNew && (
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
