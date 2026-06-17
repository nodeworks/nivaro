import { useCallback, useEffect, useRef, useState } from 'react'
import { useGridFlush, useOptionalNivaroClient } from '../context'
import { del, get, patch, post } from '../lib/commands'
import type { FormFieldDescriptor } from '../types'

type GridCol = {
  field: string
  label: string | null
  type: string
  interface: string | null
  note: string | null
}

function titleCase(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function InlineGridField({
  field,
  itemId
}: {
  field: FormFieldDescriptor
  itemId: string | number | null
}) {
  const client = useOptionalNivaroClient()
  const gridFlush = useGridFlush()
  const rel = field.relation
  const relCol = rel?.relatedCollection ?? ''
  const manyField = rel?.manyField ?? ''

  const [columns, setColumns] = useState<GridCol[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [stagedEdits, setStagedEdits] = useState<Map<string, Record<string, unknown>>>(new Map())
  const [stagedNew, setStagedNew] = useState<Record<string, unknown>[]>([])
  const [stagedDeletes, setStagedDeletes] = useState<Set<string>>(new Set())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const hasPending = stagedEdits.size > 0 || stagedNew.length > 0 || stagedDeletes.size > 0

  const fetchRows = useCallback(async () => {
    if (!client || !itemId || !relCol || !manyField) return
    try {
      const res = await client.request<{ data: Record<string, unknown>[] }>(
        get(`/items/${relCol}`, {
          filter: JSON.stringify({ [manyField]: { _eq: itemId } }),
          limit: 200,
          fields: '*'
        })
      )
      if (mountedRef.current) setRows(res.data ?? [])
    } catch {
      if (mountedRef.current) setRows([])
    }
  }, [client, itemId, relCol, manyField])

  useEffect(() => {
    if (!client || !relCol) return
    client
      .request<{ data: GridCol[] }>(get(`/field-config/${relCol}`))
      .then((res) => {
        if (!mountedRef.current) return
        const cols = (res.data ?? []).filter(
          (c) => !c.field.startsWith('_') && c.field !== 'id' && c.field !== manyField
        )
        setColumns(cols)
      })
      .catch(() => {})
  }, [client, relCol, manyField])

  useEffect(() => {
    void fetchRows()
  }, [fetchRows])

  const flush = useCallback(async () => {
    if (!client) return
    for (const id of stagedDeletes) {
      await client.request(del(`/items/${relCol}/${id}`))
    }
    for (const row of stagedNew) {
      await client.request(post(`/items/${relCol}`, { ...row, [manyField]: itemId }))
    }
    for (const [id, changes] of stagedEdits) {
      if (!stagedDeletes.has(id)) await client.request(patch(`/items/${relCol}/${id}`, changes))
    }
    if (mountedRef.current) {
      setStagedEdits(new Map())
      setStagedNew([])
      setStagedDeletes(new Set())
      await fetchRows()
    }
  }, [client, relCol, manyField, itemId, stagedDeletes, stagedNew, stagedEdits, fetchRows])

  const flushKey = `inline-grid:${relCol}:${manyField}`

  useEffect(() => {
    gridFlush?.register(flushKey, flush)
    return () => gridFlush?.unregister(flushKey)
  }, [gridFlush, flushKey, flush])

  function getVal(row: Record<string, unknown>, f: string, isNew: boolean, ni: number) {
    if (isNew) return stagedNew[ni]?.[f] ?? ''
    return stagedEdits.get(String(row.id))?.[f] ?? row[f] ?? ''
  }

  function setVal(
    row: Record<string, unknown>,
    f: string,
    value: unknown,
    isNew: boolean,
    ni: number
  ) {
    if (isNew) {
      setStagedNew((p) => p.map((r, i) => (i === ni ? { ...r, [f]: value } : r)))
      return
    }
    const id = String(row.id)
    setStagedEdits((p) => {
      const n = new Map(p)
      n.set(id, { ...(n.get(id) ?? {}), [f]: value })
      return n
    })
  }

  function renderCell(col: GridCol, row: Record<string, unknown>, isNew: boolean, ni: number) {
    const val = getVal(row, col.field, isNew, ni)
    const set = (v: unknown) => setVal(row, col.field, v, isNew, ni)
    const isNum = ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(col.type)
    if (col.type === 'boolean') {
      return (
        <input
          type='checkbox'
          checked={!!val}
          onChange={(e) => set(e.target.checked)}
          data-nf-grid-cell-checkbox
        />
      )
    }
    if (isNum) {
      return (
        <input
          type='number'
          value={val === null || val === undefined ? '' : String(val)}
          onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
          placeholder={col.note ?? undefined}
          data-nf-grid-cell
        />
      )
    }
    if (col.type === 'datetime' || col.interface === 'datetime') {
      return (
        <input
          type='datetime-local'
          value={val ? String(val).slice(0, 16) : ''}
          onChange={(e) => set(e.target.value ? new Date(e.target.value).toISOString() : null)}
          data-nf-grid-cell
        />
      )
    }
    return (
      <input
        type='text'
        value={val === null || val === undefined ? '' : String(val)}
        onChange={(e) => set(e.target.value || null)}
        placeholder={col.note ?? undefined}
        data-nf-grid-cell
      />
    )
  }

  if (!itemId) {
    return (
      <div data-nf-inline-grid data-nf-inline-grid-empty>
        <p data-nf-empty>Save the record first to manage related rows.</p>
      </div>
    )
  }

  const visibleRows = rows.filter((r) => !stagedDeletes.has(String(r.id)))
  const allRows = [
    ...visibleRows.map((r) => ({ ...r, ...(stagedEdits.get(String(r.id)) ?? {}) })),
    ...stagedNew
  ]
  const numericCols = columns.filter((c) =>
    ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(c.type)
  )

  return (
    <div data-nf-inline-grid>
      <span data-nf-inline-grid-label>
        {field.label ?? titleCase(field.field)}
        {field.note ? (
          <span data-nf-inline-grid-note title={field.note}>
            {' '}
            ?
          </span>
        ) : null}
      </span>

      {hasPending && (
        <div data-nf-inline-grid-pending>Unsaved changes — will save with the record</div>
      )}

      <div data-nf-inline-grid-wrap>
        <div data-nf-inline-grid-scroll>
          <table data-nf-inline-grid-table>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.field} data-nf-grid-th>
                    {col.label ?? titleCase(col.field)}
                  </th>
                ))}
                <th data-nf-grid-th-action />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={String(row.id)} data-nf-grid-row>
                  {columns.map((col) => (
                    <td key={col.field} data-nf-grid-td>
                      {renderCell(col, row, false, -1)}
                    </td>
                  ))}
                  <td data-nf-grid-td-action>
                    <button
                      type='button'
                      data-nf-grid-delete
                      aria-label='Delete row'
                      onClick={() =>
                        setStagedDeletes((p) => {
                          const n = new Set(p)
                          n.add(String(row.id))
                          return n
                        })
                      }
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
              {stagedNew.map((row, idx) => (
                <tr
                  key={(row._rowId as string | undefined) ?? `new-${idx}`}
                  data-nf-grid-row
                  data-nf-grid-row-new
                >
                  {columns.map((col) => (
                    <td key={col.field} data-nf-grid-td>
                      {renderCell(col, row, true, idx)}
                    </td>
                  ))}
                  <td data-nf-grid-td-action>
                    <button
                      type='button'
                      data-nf-grid-delete
                      aria-label='Remove new row'
                      onClick={() => setStagedNew((p) => p.filter((_, i) => i !== idx))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
              {allRows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} data-nf-grid-empty-row>
                    No rows yet
                  </td>
                </tr>
              )}
            </tbody>
            {numericCols.length > 0 && allRows.length > 0 && (
              <tfoot>
                <tr data-nf-grid-totals>
                  {columns.map((col) => {
                    const isNum = numericCols.some((c) => c.field === col.field)
                    if (!isNum) return <td key={col.field} data-nf-grid-total-cell />
                    const sum = allRows.reduce((a, r) => a + (Number(r[col.field]) || 0), 0)
                    return (
                      <td key={col.field} data-nf-grid-total-cell data-nf-grid-total-num>
                        {sum.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2
                        })}
                      </td>
                    )
                  })}
                  <td data-nf-grid-total-cell />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <div data-nf-inline-grid-footer>
          <button
            type='button'
            data-nf-grid-add
            onClick={() => setStagedNew((p) => [...p, { _rowId: crypto.randomUUID() }])}
          >
            + Add row
          </button>
        </div>
      </div>
    </div>
  )
}
