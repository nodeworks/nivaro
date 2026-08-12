import { ChangeReasonDialog, changeReasonChallenge, type ChangeReasonChallenge } from './item-edit/ChangeReasonDialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../context'
import { del, get, patch, post } from '../lib/commands'
import { JsonMapEditor, type JsonMapEditorConfig } from './JsonMapEditor'
import { RelationCombobox } from './item-edit/RelationCombobox'

// Generic editable flat grid over /items — config-driven upsert editor for
// month-columnar collections (EFP Manage Production Numbers / Manage Project
// Type Forecast). Scope pickers gate loading and seed created rows; rows come
// either from the collection itself (free-form add/delete) or one per record
// of a `row_source` collection (production numbers per region). All writes go
// through /items (RBAC, hooks, activity apply). Optional `after_save` runs a
// custom query (recompute procs).

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
]
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface RecordGridEditorConfig {
  collection: string
  title?: string
  /** Scope pickers: every field must be chosen before rows load; values filter
   *  loaded rows and seed created rows. `filter` supports '$scope.<field>'
   *  tokens off the other scope values. */
  scope?: Array<{
    field: string
    collection: string
    label?: string
    filter?: Record<string, unknown>
  }>
  /** Free-form identity pickers on each row (year / division / …) — part of
   *  what makes a row unique; rendered as comboboxes on NEW rows, read-only
   *  labels on existing ones. */
  key_columns?: Array<{ field: string; label?: string; collection: string }>
  /** One editable row per record of this collection; existing target rows are
   *  matched via fk_field. `filter` supports '$scope.<field>' tokens. */
  row_source?: {
    collection: string
    label_field: string
    fk_field: string
    filter?: Record<string, unknown>
    sort?: string
  }
  /** Plain editable numeric columns. */
  columns?: Array<{ field: string; label?: string; readonly?: boolean }>
  /** Generates january…december editable columns per set (field =
   *  '<month><suffix>'). */
  month_sets?: Array<{ suffix: string; label: string }>
  allow_add?: boolean
  allow_delete?: boolean
  /** Written on save as the sum of the FIRST month set's values. */
  computed_total_field?: string
  /** Custom query run after a successful save — params support '$scope.<f>'. */
  after_save?: { query_slug: string; params?: Record<string, unknown> }
  /** Nested map editors opened from toolbar buttons (EFP Manage Cost Tables) —
   *  receive the current scope; enabled once `require_scope` fields are set. */
  toolbar_editors?: Array<{
    button_label: string
    sheet_width?: number | string
    require_scope?: string[]
    json_map: JsonMapEditorConfig
  }>
}

function resolveScopeTokens(
  value: unknown,
  scope: Record<string, unknown>
): unknown {
  if (typeof value === 'string' && value.startsWith('$scope.')) return scope[value.slice(7)]
  if (Array.isArray(value)) return value.map((v) => resolveScopeTokens(v, scope))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveScopeTokens(v, scope)])
    )
  return value
}

function hasUnresolved(v: unknown): boolean {
  if (v === undefined) return true
  if (Array.isArray(v)) return v.some(hasUnresolved)
  if (v && typeof v === 'object') return Object.values(v).some(hasUnresolved)
  return false
}

type Draft = Record<string, Record<string, string>>

export function RecordGridEditor({ config }: { config: RecordGridEditorConfig }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [scope, setScope] = useState<Record<string, unknown>>({})
  const [draft, setDraft] = useState<Draft>({})
  const [added, setAdded] = useState<string[]>([])
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [crChallenge, setCrChallenge] = useState<ChangeReasonChallenge | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [openEditor, setOpenEditor] = useState<number | null>(null)

  const scopeReady = (config.scope ?? []).every(
    (s) => scope[s.field] !== null && scope[s.field] !== undefined && scope[s.field] !== ''
  )
  const scopeKey = JSON.stringify(scope)

  const valueFields = useMemo(() => {
    const f: string[] = []
    for (const set of config.month_sets ?? []) for (const m of MONTHS) f.push(`${m}${set.suffix}`)
    for (const c of config.columns ?? []) f.push(c.field)
    return f
  }, [config])

  const { data: rows = [], isLoading: rowsLoading } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['record-grid-rows', config.collection, scopeKey],
    queryFn: () => {
      const filter: Record<string, unknown> = {}
      for (const s of config.scope ?? []) filter[s.field] = { _eq: scope[s.field] }
      return client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${config.collection}`, {
            limit: 2000,
            ...(Object.keys(filter).length ? { filter: JSON.stringify(filter) } : {})
          })
        )
        .then((r) => r.data ?? [])
    },
    enabled: scopeReady,
    staleTime: 10_000
  })

  const { data: sourceRows = [] } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['record-grid-source', config.row_source?.collection, scopeKey],
    queryFn: () => {
      const src = config.row_source
      if (!src) return Promise.resolve([])
      const resolved = resolveScopeTokens(src.filter, scope)
      const filter = resolved && !hasUnresolved(resolved) ? resolved : undefined
      return client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${src.collection}`, {
            limit: 1000,
            ...(src.sort ? { sort: src.sort } : {}),
            ...(filter ? { filter: JSON.stringify(filter) } : {})
          })
        )
        .then((r) => r.data ?? [])
    },
    enabled: scopeReady && !!config.row_source,
    staleTime: 30_000
  })

  // Grid rows: one per source record (row_source mode) or one per existing
  // record + locally added rows (free-form mode).
  type GridRow = {
    key: string
    record: Record<string, unknown> | null
    sourceId?: unknown
    sourceLabel?: string
    isNew: boolean
  }
  const gridRows: GridRow[] = useMemo(() => {
    if (config.row_source) {
      const src = config.row_source
      return sourceRows.map((s) => {
        const record = rows.find((r) => String(r[src.fk_field]) === String(s.id)) ?? null
        return {
          key: `src-${s.id}`,
          record,
          sourceId: s.id,
          sourceLabel: String(s[src.label_field] ?? s.id),
          isNew: !record
        }
      })
    }
    return [
      ...rows
        .filter((r) => !removed.has(String(r.id)))
        .map((r) => ({ key: `rec-${r.id}`, record: r, isNew: false })),
      ...added.map((k) => ({ key: k, record: null, isNew: true }))
    ]
  }, [config.row_source, sourceRows, rows, added, removed])

  const cellValue = (row: GridRow, field: string): string => {
    const d = draft[row.key]?.[field]
    if (d !== undefined) return d
    const v = row.record?.[field]
    return v == null ? '' : String(v)
  }
  const setCell = (rowKey: string, field: string, value: string) =>
    setDraft((p) => ({ ...p, [rowKey]: { ...(p[rowKey] ?? {}), [field]: value } }))

  const dirty =
    Object.values(draft).some((r) => Object.keys(r).length > 0) || added.length > 0 || removed.size > 0

  async function save(changeReason?: string) {
    setSaving(true)
    setStatus(null)
    let createdN = 0
    let updatedN = 0
    let deletedN = 0
    try {
      for (const row of gridRows) {
        const d = draft[row.key] ?? {}
        const hasEdits = Object.keys(d).length > 0
        if (!row.record && !hasEdits) continue
        const payload: Record<string, unknown> = {}
        for (const [f, v] of Object.entries(d)) {
          if (!valueFields.includes(f) && !(config.key_columns ?? []).some((k) => k.field === f))
            continue
          payload[f] = v === '' ? null : Number.isNaN(Number(v)) ? v : Number(v)
        }
        if (config.computed_total_field && config.month_sets?.length) {
          const firstSet = config.month_sets[0]
          payload[config.computed_total_field] = MONTHS.reduce((s, m) => {
            const f = `${m}${firstSet.suffix}`
            const v = d[f] !== undefined ? Number(d[f]) || 0 : Number(row.record?.[f]) || 0
            return s + v
          }, 0)
        }
        if (row.record) {
          if (Object.keys(payload).length === 0) continue
          if (changeReason) payload._change_reason = changeReason
          await client.request(patch(`/items/${config.collection}/${row.record.id}`, payload))
          updatedN++
        } else {
          if (!hasEdits) continue
          for (const s of config.scope ?? []) payload[s.field] = scope[s.field]
          if (config.row_source) payload[config.row_source.fk_field] = row.sourceId
          await client.request(post(`/items/${config.collection}`, payload))
          createdN++
        }
      }
      for (const id of removed) {
        await client.request(del(`/items/${config.collection}/${id}`))
        deletedN++
      }
      if (config.after_save) {
        const params = resolveScopeTokens(config.after_save.params ?? {}, scope)
        await client.request(
          post(`/custom-queries/${config.after_save.query_slug}/execute`, { params })
        )
      }
      setDraft({})
      setAdded([])
      setRemoved(new Set())
      await qc.invalidateQueries({ queryKey: ['record-grid-rows', config.collection] })
      setStatus(`Saved — ${updatedN} updated, ${createdN} created${deletedN ? `, ${deletedN} deleted` : ''}`)
    } catch (err) {
      const challenge = changeReasonChallenge(err)
      if (challenge) {
        setCrChallenge(challenge)
        setStatus(null)
      } else {
        setStatus(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
    } finally {
      setSaving(false)
    }
  }

  const monthCols = (config.month_sets ?? []).flatMap((set) =>
    MONTHS.map((m, i) => ({ field: `${m}${set.suffix}`, label: `${MONTH_LABELS[i]} ${set.label}` }))
  )
  const allCols = [...monthCols, ...(config.columns ?? []).map((c) => ({ field: c.field, label: c.label ?? c.field }))]

  return (
    <div className='flex h-full flex-col gap-3 overflow-auto p-3'>
      <ChangeReasonDialog
        challenge={crChallenge}
        onCancel={() => setCrChallenge(null)}
        onSubmit={(reason) => {
          setCrChallenge(null)
          void save(reason)
        }}
      />
      <div className='flex flex-wrap items-end gap-3'>
        {(config.scope ?? []).map((s) => {
          const resolved = resolveScopeTokens(s.filter, scope)
          const extraFilter =
            resolved && !hasUnresolved(resolved) ? (resolved as Record<string, unknown>) : undefined
          return (
            <div key={s.field} className='w-52'>
              <p className='mb-1 text-[11px] font-medium text-slate-500'>
                {s.label ?? s.field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
              </p>
              <RelationCombobox
                collection={s.collection}
                value={scope[s.field] ?? null}
                onChange={(v) => {
                  setScope((p) => ({ ...p, [s.field]: v }))
                  setDraft({})
                  setAdded([])
                  setRemoved(new Set())
                }}
                extraFilter={extraFilter}
                placeholder='Select…'
              />
            </div>
          )
        })}
        <button
          type='button'
          disabled={!scopeReady || !dirty || saving}
          onClick={() => void save()}
          className='inline-flex h-9 items-center gap-1.5 rounded-md bg-[#00ceff] px-3 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50'
        >
          {saving && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
          Save changes
        </button>
        {config.allow_add && scopeReady && (
          <button
            type='button'
            onClick={() => setAdded((p) => [...p, `new-${p.length}-${Math.random().toString(36).slice(2, 8)}`])}
            className='inline-flex h-9 items-center rounded-md border border-slate-200 bg-white px-3 text-[13px] text-slate-700 hover:border-slate-400 dark:border-border dark:bg-card dark:text-slate-200'
          >
            ＋ Add row
          </button>
        )}
        {(config.toolbar_editors ?? []).map((te, i) => {
          const enabled = (te.require_scope ?? []).every(
            (f) => scope[f] !== null && scope[f] !== undefined && scope[f] !== ''
          )
          return (
            <button
              key={te.button_label}
              type='button'
              disabled={!enabled}
              title={enabled ? undefined : `Choose ${(te.require_scope ?? []).join(', ')} first`}
              onClick={() => setOpenEditor(i)}
              className='inline-flex h-9 items-center rounded-md border border-slate-200 bg-white px-3 text-[13px] text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-200'
            >
              {te.button_label}
            </button>
          )
        })}
        {status && <span className='pb-2 text-[12px] text-slate-500'>{status}</span>}
      </div>

      {openEditor !== null && config.toolbar_editors?.[openEditor] && (
        <div
          className='fixed inset-0 z-[60] flex justify-end bg-black/30'
          onClick={() => setOpenEditor(null)}
        >
          <div
            className='flex h-full flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-background'
            style={{
              width:
                typeof config.toolbar_editors[openEditor].sheet_width === 'number'
                  ? `${config.toolbar_editors[openEditor].sheet_width}px`
                  : (config.toolbar_editors[openEditor].sheet_width ?? '70%'),
              maxWidth: '96%'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className='flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-border'>
              <p className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
                {config.toolbar_editors[openEditor].button_label}
              </p>
              <button
                type='button'
                onClick={() => setOpenEditor(null)}
                className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
              >
                Close
              </button>
            </div>
            <div className='min-h-0 flex-1 overflow-auto'>
              <JsonMapEditor config={config.toolbar_editors[openEditor].json_map} scope={scope} />
            </div>
          </div>
        </div>
      )}

      {!scopeReady ? (
        <p className='text-[12px] text-slate-400'>
          Choose {(config.scope ?? []).map((s) => s.label ?? s.field).join(', ')} to load rows.
        </p>
      ) : rowsLoading ? (
        <div className='flex items-center gap-2 text-[12px] text-slate-400'>
          <Loader2 className='h-4 w-4 animate-spin' /> Loading…
        </div>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-left dark:border-border'>
                {config.row_source && <th className='py-1.5 pr-3 font-medium text-slate-500'>{config.row_source.label_field.replace(/_/g, ' ')}</th>}
                {(config.key_columns ?? []).map((k) => (
                  <th key={k.field} className='min-w-[140px] py-1.5 pr-3 font-medium text-slate-500'>
                    {k.label ?? k.field}
                  </th>
                ))}
                {allCols.map((c) => (
                  <th key={c.field} className='min-w-[86px] py-1.5 pr-2 text-right font-medium text-slate-500'>
                    {c.label}
                  </th>
                ))}
                {config.allow_delete && <th aria-label='Remove' />}
              </tr>
            </thead>
            <tbody>
              {gridRows.map((row) => (
                <tr key={row.key} className='border-b border-slate-100 dark:border-border/50'>
                  {config.row_source && (
                    <td className='whitespace-nowrap py-1 pr-3 font-medium text-slate-700 dark:text-slate-200'>
                      {row.sourceLabel}
                      {row.isNew && <span className='ml-1.5 text-[10px] text-slate-400'>(new)</span>}
                    </td>
                  )}
                  {(config.key_columns ?? []).map((k) => (
                    <td key={k.field} className='py-1 pr-3'>
                      <RelationCombobox
                        collection={k.collection}
                        value={cellValue(row, k.field) || null}
                        onChange={(v) => setCell(row.key, k.field, v == null ? '' : String(v))}
                        placeholder='Select…'
                      />
                    </td>
                  ))}
                  {allCols.map((c) => (
                    <td key={c.field} className='py-0.5 pr-2 text-right'>
                      <input
                        type='number'
                        value={cellValue(row, c.field)}
                        onChange={(e) => setCell(row.key, c.field, e.target.value)}
                        className='h-7 w-[84px] rounded border border-slate-200 bg-white px-1.5 text-right text-[12px] tabular-nums outline-none focus:border-[#00ceff] dark:border-border dark:bg-background'
                      />
                    </td>
                  ))}
                  {config.allow_delete && (
                    <td className='py-1 pl-2'>
                      <button
                        type='button'
                        onClick={() => {
                          if (row.record) setRemoved((p) => new Set(p).add(String(row.record?.id)))
                          else setAdded((p) => p.filter((k) => k !== row.key))
                          setDraft((p) => {
                            const n = { ...p }
                            delete n[row.key]
                            return n
                          })
                        }}
                        className='rounded px-1.5 text-[12px] text-slate-400 hover:text-red-600'
                      >
                        ✕
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {gridRows.length === 0 && (
                <tr>
                  <td colSpan={99} className='py-3 text-center text-[12px] text-slate-400'>
                    No rows
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className='border-t border-slate-300 font-semibold dark:border-border'>
                {config.row_source && <td className='py-1.5 pr-3'>Total</td>}
                {(config.key_columns ?? []).map((k, i) => (
                  <td key={k.field} className='py-1.5 pr-3'>
                    {!config.row_source && i === 0 ? 'Total' : ''}
                  </td>
                ))}
                {allCols.map((c) => (
                  <td key={c.field} className='py-1.5 pr-2 text-right tabular-nums'>
                    {gridRows
                      .reduce((s, r) => s + (Number(cellValue(r, c.field)) || 0), 0)
                      .toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </td>
                ))}
                {config.allow_delete && <td />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
