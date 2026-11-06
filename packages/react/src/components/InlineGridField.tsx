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

// Twin of @nivaro/shared ui/number-draft-input (army 4 a01-15): the typed text
// is kept while the person types, so "2.0" is not re-rendered as "2" before the
// "5" lands (2.05 became 25). Every change that parses commits its number;
// leaving the cell drops the draft and shows the stored value.
export function GridNumberInput({
  value,
  onValue,
  placeholder
}: {
  value: unknown
  onValue: (n: number | null) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = value === null || value === undefined ? '' : String(value)
  return (
    <input
      type='number'
      value={draft ?? shown}
      onChange={(e) => {
        const text = e.target.value
        // Text the browser cannot read yet ("-") reads as "" with badInput.
        if (text === '' && e.target.validity?.badInput) {
          setDraft('')
          return
        }
        setDraft(text)
        if (text.trim() === '') return onValue(null)
        const n = Number(text)
        if (Number.isFinite(n)) onValue(n)
      }}
      onBlur={() => setDraft(null)}
      placeholder={placeholder}
      data-nf-grid-cell
    />
  )
}

/** Per record id, its newest revision (null = none yet); unreadable ids are
 *  absent. One `GET /revisions/latest` per 500 ids. */
export async function latestRevisions(
  client: { request: <T>(cmd: never) => Promise<T> },
  collection: string,
  ids: string[]
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  const list = [...new Set(ids)].filter((id) => id && id !== 'new')
  for (let i = 0; i < list.length; i += 500) {
    try {
      const r = await client.request<{ data: Record<string, number | null> }>(
        get('/revisions/latest', {
          collection,
          items: list.slice(i, i + 500).join(',')
        }) as never
      )
      for (const [id, v] of Object.entries(r?.data ?? {}))
        out.set(id, typeof v === 'number' && Number.isFinite(v) ? v : null)
    } catch {
      /* unknown bases are fetched again before the write */
    }
  }
  return out
}

function isMidair(err: unknown): boolean {
  const r = (err as { response?: { data?: { code?: string }; code?: string } })?.response
  return (r?.data?.code ?? r?.code) === 'MIDAIR_COLLISION'
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
  // Mid-air for lines (army4 H4/M1, twin of @nivaro/shared line-midair): each
  // row's newest revision as of the read that showed it. A staged edit's
  // PATCH carries it as `_base_revision`, so someone else's newer save of the
  // same field is a 409 instead of a silent overwrite.
  const basesRef = useRef<Map<string, number | null>>(new Map())

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
      const read = res.data ?? []
      basesRef.current = await latestRevisions(
        client,
        relCol,
        read.map((r) => String(r.id))
      )
      if (mountedRef.current) setRows(read)
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
    const edits = [...stagedEdits].filter(([id]) => !stagedDeletes.has(id))
    // A base the read did not get (failed read) is fetched now, never skipped.
    const unknown = edits.map(([id]) => id).filter((id) => !((basesRef.current.get(id) ?? 0) > 0))
    if (unknown.length > 0) {
      const late = await latestRevisions(client, relCol, unknown)
      for (const [id, b] of late) basesRef.current.set(id, b)
    }
    for (const [id, changes] of edits) {
      const base = basesRef.current.get(id)
      try {
        await client.request(
          patch(
            `/items/${relCol}/${id}`,
            typeof base === 'number' && base > 0 ? { ...changes, _base_revision: base } : changes
          )
        )
      } catch (err) {
        // Someone else saved this line since it was read: show their values
        // (re-read), keep the edit staged, and let the Save fail loudly. The
        // next Save is then a choice made against their save.
        if (isMidair(err)) await fetchRows()
        throw err
      }
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
      return <GridNumberInput value={val} onValue={set} placeholder={col.note ?? undefined} />
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
