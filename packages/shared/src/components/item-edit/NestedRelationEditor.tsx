import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Pencil, X } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, formatNumber, titleCase } from '../../lib/utils'
import { FieldRenderer } from './FieldRenderer'
import { applyDisplayTemplate, EMPTY_NESTED_OPS, SENTINEL_FIELDS } from './helpers'
import type { CMSField, CMSRelation, NestedOps } from './types'

// Types not editable at this depth — grandchild rows edit scalar/M2O fields
// only. M2M sub-relations would need a third staging layer; out of scope.
const NON_DISPLAY_TYPES = new Set([
  'alias',
  'o2m',
  'm2m',
  'm2a',
  'presentation',
  'group',
  'divider'
])
const SPECIAL_GROUP_KEYS = new Set(['__apply_values__', '__create_with_defaults__'])

interface NestedRelationEditorProps {
  parentCollection: string
  relationField: string
  parentRowId: string | null
  stagedMembers?: Record<string, unknown>[]
  onStagedChange?: (members: Record<string, unknown>[]) => void
  parentDraft: Record<string, unknown>
  hint?: { sum_field: string; cap_field: string }
  readOnly?: boolean
  // Outer grid's own o2m-rows query key (['o2m-rows', relatedCollection, manyField, parentId]) —
  // invalidated alongside this editor's nested-rows key so stored-rollup columns on the outer
  // grid refresh after a grandchild write. Only meaningful when the outer row is already saved.
  outerGridInvalidateKey?: unknown[]
  // Stage ops instead of writing live — outer grid is under saveMode='pending' and this parent
  // row is already saved. Only meaningful when parentRowId != null.
  deferred?: boolean
  stagedOps?: NestedOps
  onStagedOpsChange?: (ops: NestedOps) => void
}

function fieldsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (
    (typeof a === 'string' && typeof b === 'number') ||
    (typeof a === 'number' && typeof b === 'string')
  ) {
    return String(a) === String(b)
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

function parseSaveError(err: unknown): string {
  const resp = (
    err as {
      response?: { violations?: { explanation?: string }[]; message?: string; error?: string }
    }
  )?.response
  if (resp?.violations?.length) {
    const text = resp.violations
      .map((v) => v.explanation)
      .filter(Boolean)
      .join('; ')
    if (text) return text
  }
  if (resp?.message) return resp.message
  if (resp?.error) return resp.error
  if (err instanceof Error && err.message) return err.message
  return 'Save failed'
}

export function NestedRelationEditor({
  parentCollection,
  relationField,
  parentRowId,
  stagedMembers,
  onStagedChange,
  parentDraft,
  hint,
  readOnly = false,
  outerGridInvalidateKey,
  deferred = false,
  stagedOps,
  onStagedOpsChange
}: NestedRelationEditorProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()

  // Resolve the grandchild relation off the LINE collection's own relations.
  const { data: parentRelations, isLoading: relationsLoading } = useQuery<CMSRelation[]>({
    queryKey: ['collection-meta', parentCollection],
    queryFn: () =>
      client.request<{ data: unknown }>(get(`/collections/${parentCollection}`)).then((r) => {
        const d = r.data as { relations?: CMSRelation[] }
        return d?.relations ?? []
      }),
    staleTime: 10 * 60_000
  })
  const grandRel = useMemo(
    () =>
      parentRelations?.find(
        (r) => r.one_collection === parentCollection && r.one_field === relationField
      ),
    [parentRelations, parentCollection, relationField]
  )
  const grandCollection = grandRel?.many_collection ?? null
  const fkField = grandRel?.many_field ?? null

  // Grandchild's own relations (for FieldRenderer's M2O pickers + read-only labels)
  const { data: grandRelations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['collection-meta', grandCollection],
    queryFn: () =>
      client.request<{ data: unknown }>(get(`/collections/${grandCollection}`)).then((r) => {
        const d = r.data as { relations?: CMSRelation[] }
        return d?.relations ?? []
      }),
    enabled: !!grandCollection,
    staleTime: 10 * 60_000
  })

  const { data: grandFields = [] } = useQuery<CMSField[]>({
    queryKey: ['field-config', grandCollection, null],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(get(`/field-config/${grandCollection}`))
        .then((r) => r.data ?? []),
    enabled: !!grandCollection,
    staleTime: 60_000
  })

  const displayCols = useMemo(
    () =>
      grandFields.filter(
        (c) =>
          !c.hidden &&
          !NON_DISPLAY_TYPES.has(c.type) &&
          c.field !== fkField &&
          c.field !== 'id' &&
          !SENTINEL_FIELDS.has(c.field) &&
          !SPECIAL_GROUP_KEYS.has(c.group_key ?? '')
      ),
    [grandFields, fkField]
  )

  const nestedRowsKey = ['nested-rows', grandCollection, fkField, parentRowId]
  const { data: grandRows = [], isLoading: rowsLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: nestedRowsKey,
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${grandCollection}`, {
            filter: JSON.stringify({ [fkField as string]: { _eq: parentRowId } }),
            limit: 200
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!grandCollection && !!fkField && parentRowId != null,
    staleTime: 30_000
  })

  const rows = useMemo(() => {
    if (parentRowId != null) {
      if (deferred) {
        const ops = stagedOps ?? EMPTY_NESTED_OPS
        const deletedSet = new Set(ops.deleted)
        const updatedMap = new Map(ops.updated.map((u) => [u.id, u.changes]))
        const overlaid = grandRows
          .filter((r) => !deletedSet.has(String(r.id)))
          .map((r) => {
            const changes = updatedMap.get(String(r.id))
            return { key: String(r.id), data: changes ? { ...r, ...changes } : r }
          })
        const created = ops.created.map((c, i) => ({ key: `created:${i}`, data: c }))
        return [...overlaid, ...created]
      }
      return grandRows.map((r) => ({ key: String(r.id), data: r }))
    }
    return (stagedMembers ?? []).map((m, i) => ({ key: `staged:${i}`, data: m }))
  }, [parentRowId, grandRows, stagedMembers, deferred, stagedOps])

  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  function setDraftField(k: string, v: unknown) {
    setDraft((prev) => ({ ...prev, [k]: v }))
    setRowError(null)
  }
  function startAdd() {
    if (readOnly) return
    setEditingKey('new')
    setDraft({})
    setRowError(null)
  }
  function startEdit(key: string, data: Record<string, unknown>) {
    if (readOnly) return
    setEditingKey(key)
    setDraft({ ...data })
    setRowError(null)
  }
  function cancelEdit() {
    setEditingKey(null)
    setDraft({})
    setRowError(null)
  }

  function invalidateOuterGrid() {
    qc.invalidateQueries({ queryKey: nestedRowsKey })
    if (outerGridInvalidateKey) qc.invalidateQueries({ queryKey: outerGridInvalidateKey })
  }

  async function save() {
    if (!editingKey) return
    if (parentRowId != null && grandCollection && fkField) {
      // draft starts from the full API row on edit (id, fkField, system fields, etc.) —
      // only send back the fields this editor actually renders.
      const writableKeys = new Set(displayCols.map((c) => c.field))
      const rowPayload = Object.fromEntries(
        Object.entries(draft).filter(([k]) => writableKeys.has(k))
      )
      if (deferred) {
        const ops = stagedOps ?? EMPTY_NESTED_OPS
        if (editingKey === 'new') {
          onStagedOpsChange?.({ ...ops, created: [...ops.created, rowPayload] })
        } else if (editingKey.startsWith('created:')) {
          const idx = parseInt(editingKey.slice('created:'.length), 10)
          const nextCreated = [...ops.created]
          nextCreated[idx] = rowPayload
          onStagedOpsChange?.({ ...ops, created: nextCreated })
        } else {
          const original = grandRows.find((r) => String(r.id) === editingKey)
          const changed = Object.fromEntries(
            Object.entries(rowPayload).filter(([k, v]) => !fieldsEqual(v, original?.[k]))
          )
          const nextUpdated = ops.updated.filter((u) => u.id !== editingKey)
          if (Object.keys(changed).length > 0)
            nextUpdated.push({ id: editingKey, changes: changed })
          onStagedOpsChange?.({ ...ops, updated: nextUpdated })
        }
        cancelEdit()
        return
      }
      setSaving(true)
      try {
        if (editingKey === 'new') {
          await client.request(
            post(`/items/${grandCollection}`, { ...rowPayload, [fkField]: parentRowId })
          )
        } else {
          await client.request(patch(`/items/${grandCollection}/${editingKey}`, rowPayload))
        }
        invalidateOuterGrid()
        cancelEdit()
      } catch (err) {
        setRowError(parseSaveError(err))
      } finally {
        setSaving(false)
      }
      return
    }
    const members = stagedMembers ?? []
    if (editingKey === 'new') {
      onStagedChange?.([...members, draft])
    } else if (editingKey.startsWith('staged:')) {
      const idx = parseInt(editingKey.slice('staged:'.length), 10)
      const next = [...members]
      next[idx] = draft
      onStagedChange?.(next)
    }
    cancelEdit()
  }

  async function confirmedDelete(key: string) {
    if (parentRowId != null && grandCollection) {
      if (deferred) {
        const ops = stagedOps ?? EMPTY_NESTED_OPS
        if (key.startsWith('created:')) {
          const idx = parseInt(key.slice('created:'.length), 10)
          onStagedOpsChange?.({ ...ops, created: ops.created.filter((_, i) => i !== idx) })
        } else {
          onStagedOpsChange?.({
            ...ops,
            updated: ops.updated.filter((u) => u.id !== key),
            deleted: ops.deleted.includes(key) ? ops.deleted : [...ops.deleted, key]
          })
        }
      } else {
        try {
          await client.request(del(`/items/${grandCollection}/${key}`))
          invalidateOuterGrid()
        } catch (err) {
          // Leave confirmDeleteKey set so the error renders next to the Delete? prompt.
          setRowError(parseSaveError(err))
          return
        }
      }
    } else {
      const idx = parseInt(key.slice('staged:'.length), 10)
      onStagedChange?.((stagedMembers ?? []).filter((_, i) => i !== idx))
    }
    setConfirmDeleteKey(null)
    setRowError(null)
    if (editingKey === key) cancelEdit()
  }

  // Read-only M2O label resolution for non-editing cells
  const m2oRelMap = useMemo(() => {
    const map = new Map<string, CMSRelation>()
    for (const c of displayCols) {
      const rel = grandRelations.find(
        (r) =>
          r.many_collection === grandCollection && r.many_field === c.field && !r.junction_field
      )
      if (rel?.one_collection) map.set(c.field, rel)
    }
    return map
  }, [displayCols, grandRelations, grandCollection])

  const m2oLookupIds = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const { key, data } of rows) {
      const source = editingKey === key ? draft : data
      for (const [field, rel] of m2oRelMap) {
        const v = source[field]
        if (v == null || v === '' || !rel.one_collection) continue
        if (!map.has(rel.one_collection)) map.set(rel.one_collection, new Set())
        map.get(rel.one_collection)!.add(String(v))
      }
    }
    return map
  }, [rows, editingKey, draft, m2oRelMap])

  const { data: m2oDisplays = {} } = useQuery<Record<string, Record<string, string>>>({
    queryKey: [
      'nested-m2o-display',
      grandCollection,
      ...Array.from(m2oLookupIds.entries()).flatMap(([col, ids]) => [col, ...ids])
    ],
    queryFn: async () => {
      const result: Record<string, Record<string, string>> = {}
      await Promise.all(
        [...m2oLookupIds.entries()].map(async ([oneCollection, ids]) => {
          const [metaRes, itemsRes] = await Promise.all([
            client.request<{ data: { display_template?: string | null } }>(
              get(`/collections/${oneCollection}`)
            ),
            client.request<{ data: Record<string, unknown>[] }>(
              get(`/items/${oneCollection}`, {
                filter: JSON.stringify({ id: { _in: [...ids] } }),
                limit: ids.size
              })
            )
          ])
          result[oneCollection] = {}
          for (const item of itemsRes.data ?? []) {
            result[oneCollection][String(item.id)] = applyDisplayTemplate(
              metaRes.data?.display_template,
              item
            )
          }
        })
      )
      return result
    },
    enabled: m2oLookupIds.size > 0,
    staleTime: 60_000
  })

  function formatCellValue(c: CMSField, val: unknown) {
    if (val === null || val === undefined || val === '')
      return <span className='text-slate-300'>—</span>
    const rel = m2oRelMap.get(c.field)
    if (rel?.one_collection) {
      const label = m2oDisplays[rel.one_collection]?.[String(val)]
      return <span className='block truncate'>{label ?? String(val)}</span>
    }
    if (c.type === 'boolean')
      return (
        <span className={val ? 'text-emerald-600' : 'text-slate-400'}>{val ? 'Yes' : 'No'}</span>
      )
    if (c.type === 'datetime' || c.type === 'date') {
      try {
        return <span className='block truncate'>{new Date(String(val)).toLocaleDateString()}</span>
      } catch {
        /* fall through */
      }
    }
    return <span className='block truncate'>{String(val)}</span>
  }

  const cap = hint ? Number(parentDraft[hint.cap_field]) || 0 : 0
  const sum = hint
    ? rows.reduce(
        (s, r) => {
          const source = editingKey === r.key ? draft : r.data
          return s + (Number(source[hint.sum_field]) || 0)
        },
        editingKey === 'new' ? Number(draft[hint.sum_field]) || 0 : 0
      )
    : 0
  const remaining = cap - sum

  if (relationsLoading) return null
  if (!grandCollection || !fkField) return null

  const actionColCount = readOnly ? 0 : 1
  const emptyColSpan = displayCols.length + actionColCount

  return (
    <div className='overflow-hidden rounded-md border border-slate-200'>
      <div className='flex items-center gap-2 px-2 py-1 bg-slate-50 border-b border-slate-200'>
        <span className='text-[10px] font-medium text-slate-400 uppercase tracking-wide'>
          {titleCase(relationField)}
        </span>
        <span className='rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500'>
          {rows.length}
        </span>
        {hint && (
          <span
            className={cn(
              'ml-auto text-[11px] font-medium',
              remaining < 0 ? 'text-red-600' : 'text-slate-500'
            )}
          >
            remaining: {formatNumber(remaining)}
          </span>
        )}
      </div>
      <table className='w-full table-fixed text-[12px]'>
        <thead className='bg-slate-50 border-b border-slate-200'>
          <tr>
            {displayCols.map((c) => (
              <th
                key={c.field}
                className='px-2 py-1.5 text-left font-medium text-slate-500 text-[11px]'
              >
                {c.label ?? titleCase(c.field)}
              </th>
            ))}
            {!readOnly && <th className='w-16' />}
          </tr>
        </thead>
        <tbody>
          {rowsLoading && (
            <tr>
              <td colSpan={emptyColSpan} className='px-2 py-3 text-center text-slate-400'>
                <Loader2 className='h-3.5 w-3.5 animate-spin inline' />
              </td>
            </tr>
          )}
          {!rowsLoading &&
            rows.map(({ key, data }) => {
              const isEditingRow = editingKey === key
              const isConfirmingDelete = confirmDeleteKey === key
              return (
                <Fragment key={key}>
                  <tr
                    onClick={() => !isEditingRow && !readOnly && startEdit(key, data)}
                    className={cn(
                      'border-b border-slate-100 transition-colors',
                      isEditingRow
                        ? 'bg-[#f0fbff] dark:bg-nvr-cyan/5 cursor-default'
                        : 'bg-white hover:bg-slate-50/80',
                      !isEditingRow && !readOnly ? 'cursor-pointer' : ''
                    )}
                  >
                    {displayCols.map((c) => (
                      <td key={c.field} className='px-2 py-1 align-top'>
                        {isEditingRow ? (
                          <FieldRenderer
                            field={c}
                            value={draft[c.field] ?? null}
                            onChange={(v) => setDraftField(c.field, v)}
                            relations={grandRelations}
                            collection={grandCollection}
                            itemId={parentRowId != null ? key : 'new'}
                          />
                        ) : (
                          <div className='py-0.5 overflow-hidden'>
                            {formatCellValue(c, data[c.field])}
                          </div>
                        )}
                      </td>
                    ))}
                    {!readOnly && (
                      <td className='px-1 py-1 align-middle'>
                        {isEditingRow ? (
                          <div className='flex items-stretch gap-1'>
                            <button
                              type='button'
                              disabled={saving}
                              onClick={(e) => {
                                e.stopPropagation()
                                save()
                              }}
                              className='rounded px-2 h-7 bg-[#00ceff] text-white text-[10px] font-medium hover:brightness-110 disabled:opacity-50'
                            >
                              {saving ? '…' : 'Save'}
                            </button>
                            <button
                              type='button'
                              onClick={(e) => {
                                e.stopPropagation()
                                cancelEdit()
                              }}
                              className='rounded px-1.5 h-7 text-slate-400 hover:text-slate-700 text-[10px]'
                            >
                              ✕
                            </button>
                          </div>
                        ) : isConfirmingDelete ? (
                          <div className='flex items-center justify-end gap-1'>
                            <span className='text-[10px] text-slate-400'>Delete?</span>
                            <button
                              type='button'
                              onClick={(e) => {
                                e.stopPropagation()
                                confirmedDelete(key)
                              }}
                              className='rounded px-1.5 py-0.5 text-[10px] text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400'
                            >
                              Yes
                            </button>
                            <button
                              type='button'
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirmDeleteKey(null)
                                setRowError(null)
                              }}
                              className='rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-700 border border-slate-200'
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className='flex items-center justify-end gap-0.5'>
                            <button
                              type='button'
                              onClick={(e) => {
                                e.stopPropagation()
                                startEdit(key, data)
                              }}
                              className='rounded p-0.5 text-slate-300 hover:text-[#00ceff]'
                            >
                              <Pencil className='h-3 w-3' />
                            </button>
                            <button
                              type='button'
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirmDeleteKey(key)
                                setRowError(null)
                              }}
                              className='rounded p-0.5 text-slate-300 hover:text-red-500'
                            >
                              <X className='h-3 w-3' />
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                  {(isEditingRow || isConfirmingDelete) && rowError && (
                    <tr className='border-b border-slate-100 bg-red-50/50'>
                      <td colSpan={emptyColSpan} className='px-2 py-1 text-[11px] text-red-600'>
                        {rowError}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          {editingKey === 'new' && (
            <tr className='border-b border-slate-100 bg-[#f0fbff] dark:bg-nvr-cyan/5'>
              {displayCols.map((c) => (
                <td key={c.field} className='px-2 py-1 align-top'>
                  <FieldRenderer
                    field={c}
                    value={draft[c.field] ?? null}
                    onChange={(v) => setDraftField(c.field, v)}
                    relations={grandRelations}
                    collection={grandCollection}
                    itemId='new'
                  />
                </td>
              ))}
              <td className='px-1 py-1 align-middle'>
                <div className='flex items-stretch gap-1'>
                  <button
                    type='button'
                    disabled={saving}
                    onClick={save}
                    className='rounded px-2 h-7 bg-[#00ceff] text-white text-[10px] font-medium hover:brightness-110 disabled:opacity-50'
                  >
                    {saving ? '…' : 'Add'}
                  </button>
                  <button
                    type='button'
                    onClick={cancelEdit}
                    className='rounded px-1.5 h-7 text-slate-400 hover:text-slate-700 text-[10px]'
                  >
                    ✕
                  </button>
                </div>
              </td>
            </tr>
          )}
          {editingKey === 'new' && rowError && (
            <tr className='border-b border-slate-100 bg-red-50/50'>
              <td colSpan={emptyColSpan} className='px-2 py-1 text-[11px] text-red-600'>
                {rowError}
              </td>
            </tr>
          )}
          {!rowsLoading && rows.length === 0 && editingKey !== 'new' && (
            <tr>
              <td
                colSpan={emptyColSpan}
                className='px-2 py-3 text-center text-slate-400 text-[11px]'
              >
                No rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {!readOnly && editingKey !== 'new' && (
        <div className='px-2 py-1 bg-slate-50/50 border-t border-slate-200'>
          <button
            type='button'
            onClick={startAdd}
            className='text-[11px] text-[#00ceff] font-medium hover:underline'
          >
            + Add row
          </button>
        </div>
      )}
    </div>
  )
}
