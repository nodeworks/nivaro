import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../context'
import { del, get, patch, post } from '../lib/commands'
import { cn } from '../lib/utils'
import {
  type ChangeReasonChallenge,
  ChangeReasonDialog,
  changeReasonChallenge
} from './item-edit/ChangeReasonDialog'
import { applyDisplayTemplate } from './item-edit/helpers'
import { RelationCombobox } from './item-edit/RelationCombobox'
import { JsonMapEditor, type JsonMapEditorConfig } from './JsonMapEditor'

// Generic editable flat grid over /items — config-driven upsert editor for
// month-columnar collections (EFP Manage Production Numbers / Manage Project
// Type Forecast). Scope pickers gate loading and seed created rows; rows come
// either from the collection itself (free-form add/delete) or one per record
// of a `row_source` collection (production numbers per region). All writes go
// through /items (RBAC, hooks, activity apply). Optional `after_save` runs a
// custom query (recompute procs).

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

export interface RecordGridEditorConfig {
  collection: string
  title?: string
  /**
   * BROWSE-THEN-EDIT: the key columns become header pickers. Until every key
   * is chosen the grid shows read-only totals rolled up by the unpicked keys
   * (click a rollup to drill into it); once all keys are chosen the matching
   * row(s) edit inline and a missing row can be created. Month values render
   * formatted (thousands separators) until focused.
   */
  browse?: boolean
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

function resolveScopeTokens(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$scope.')) return scope[value.slice(7)]
  if (Array.isArray(value)) return value.map((v) => resolveScopeTokens(v, scope))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveScopeTokens(v, scope)
      ])
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
  if (config.browse) return <BrowseGrid config={config} />
  return <FlatGrid config={config} />
}

function FlatGrid({ config }: { config: RecordGridEditorConfig }) {
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
    Object.values(draft).some((r) => Object.keys(r).length > 0) ||
    added.length > 0 ||
    removed.size > 0

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
      setStatus(
        `Saved — ${updatedN} updated, ${createdN} created${deletedN ? `, ${deletedN} deleted` : ''}`
      )
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
  const allCols = [
    ...monthCols,
    ...(config.columns ?? []).map((c) => ({ field: c.field, label: c.label ?? c.field }))
  ]

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
            onClick={() =>
              setAdded((p) => [...p, `new-${p.length}-${Math.random().toString(36).slice(2, 8)}`])
            }
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
                {config.row_source && (
                  <th className='py-1.5 pr-3 font-medium text-slate-500'>
                    {config.row_source.label_field.replace(/_/g, ' ')}
                  </th>
                )}
                {(config.key_columns ?? []).map((k) => (
                  <th
                    key={k.field}
                    className='min-w-[140px] py-1.5 pr-3 font-medium text-slate-500'
                  >
                    {k.label ?? k.field}
                  </th>
                ))}
                {allCols.map((c) => (
                  <th
                    key={c.field}
                    className='min-w-[86px] py-1.5 pr-2 text-right font-medium text-slate-500'
                  >
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
                      {row.isNew && (
                        <span className='ml-1.5 text-[10px] text-slate-400'>(new)</span>
                      )}
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

// ─── Browse-then-edit grid ────────────────────────────────────────────────────

const fmtNum = (v: number | null | undefined, opts?: { blankZero?: boolean }) => {
  if (v == null || !Number.isFinite(v)) return '—'
  if (opts?.blankZero && v === 0) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Numeric input that reads formatted (1,234,567.5) until focused. */
function NumberCell({
  value,
  original,
  onChange,
  disabled
}: {
  value: string
  original: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const [focused, setFocused] = useState(false)
  const edited = value !== original
  const num = value === '' ? null : Number(value)
  const shown = focused ? value : num == null || Number.isNaN(num) ? value : fmtNum(num)
  const delta = edited && num != null && !Number.isNaN(num) ? num - (Number(original) || 0) : 0
  return (
    <input
      type='text'
      inputMode='decimal'
      value={shown}
      disabled={disabled}
      title={
        edited
          ? `Was ${fmtNum(Number(original) || 0)} (${delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(delta))})`
          : undefined
      }
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => onChange(e.target.value.replace(/[^\d.-]/g, ''))}
      className={cn(
        'h-7 w-[92px] rounded-md border bg-white px-1.5 text-right text-[12px] tabular-nums outline-none transition-colors focus:border-nvr-cyan disabled:bg-transparent dark:bg-background',
        edited
          ? 'border-nvr-cyan bg-nvr-cyan/[0.06] dark:bg-nvr-cyan/10'
          : 'border-slate-200 dark:border-border',
        !edited && (num === 0 || num == null) && 'text-slate-400'
      )}
    />
  )
}

function BrowseGrid({ config }: { config: RecordGridEditorConfig }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const keys = config.key_columns ?? []
  const [picked, setPicked] = useState<Record<string, unknown>>({})
  const [draft, setDraft] = useState<Draft>({})
  const [added, setAdded] = useState<string[]>([])
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [crChallenge, setCrChallenge] = useState<ChangeReasonChallenge | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const allPicked =
    keys.length > 0 && keys.every((k) => picked[k.field] != null && picked[k.field] !== '')
  const valueCols = useMemo(() => {
    const monthCols = (config.month_sets ?? []).flatMap((set) =>
      MONTHS.map((m, i) => ({
        field: `${m}${set.suffix}`,
        label: `${MONTH_LABELS[i]}${set.label ? ` ${set.label}` : ''}`
      }))
    )
    const plainCols = (config.columns ?? []).map((c) => ({
      field: c.field,
      label: c.label ?? c.field
    }))
    return [...monthCols, ...plainCols]
  }, [config.month_sets, config.columns])
  const firstSet = config.month_sets?.[0]

  // Every row of the collection (small identity×month tables) — filtered client-side.
  const { data: rows = [], isLoading } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['record-grid-browse-rows', config.collection],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${config.collection}`, { limit: 5000 })
        )
        .then((r) => r.data ?? []),
    staleTime: 10_000
  })
  // Key labels (Year / Zone / Project Type) via each collection's display template.
  const { data: keyLabels = {} } = useQuery<Record<string, Map<string, string>>>({
    queryKey: ['record-grid-browse-labels', keys.map((k) => k.collection).join(',')],
    queryFn: async () => {
      const out: Record<string, Map<string, string>> = {}
      await Promise.all(
        keys.map(async (k) => {
          const meta = await client
            .request<{ data: { display_template?: string | null } }>(
              get(`/collections/${k.collection}`)
            )
            .then((r) => r.data)
            .catch(() => null)
          const items = await client
            .request<{ data: Array<Record<string, unknown>> }>(
              get(`/items/${k.collection}`, { limit: 1000 })
            )
            .then((r) => r.data ?? [])
            .catch(() => [])
          const m = new Map<string, string>()
          for (const it of items)
            m.set(String(it.id), applyDisplayTemplate(meta?.display_template, it) || String(it.id))
          out[k.field] = m
        })
      )
      return out
    },
    enabled: keys.length > 0,
    staleTime: 300_000
  })
  const labelOf = useCallback(
    (field: string, id: unknown) =>
      id == null ? '—' : (keyLabels[field]?.get(String(id)) ?? String(id)),
    [keyLabels]
  )

  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        keys.every(
          (k) =>
            picked[k.field] == null ||
            picked[k.field] === '' ||
            String(r[k.field]) === String(picked[k.field])
        )
      ),
    [rows, keys, picked]
  )
  const firstKeyField = keys[0]?.field
  const openKeys = keys.filter((k) => picked[k.field] == null || picked[k.field] === '')

  // Rollups by the unpicked keys (browse view).
  const rollups = useMemo(() => {
    if (allPicked) return []
    const m = new Map<
      string,
      { keyVals: Record<string, unknown>; sums: Record<string, number>; count: number }
    >()
    for (const r of filtered) {
      const kv: Record<string, unknown> = {}
      for (const k of openKeys) kv[k.field] = r[k.field]
      const id = openKeys.map((k) => String(r[k.field] ?? '')).join('|')
      const g = m.get(id) ?? { keyVals: kv, sums: {}, count: 0 }
      for (const c of valueCols)
        g.sums[c.field] = (g.sums[c.field] ?? 0) + (Number(r[c.field]) || 0)
      g.count++
      m.set(id, g)
    }
    return [...m.values()].sort((a, b) => {
      for (const k of openKeys) {
        const c = labelOf(k.field, a.keyVals[k.field]).localeCompare(
          labelOf(k.field, b.keyVals[k.field]),
          undefined,
          { numeric: true }
        )
        if (c) return k.field === firstKeyField ? -c : c // newest year first, others A→Z
      }
      return 0
    })
  }, [filtered, openKeys, allPicked, valueCols, labelOf, firstKeyField])

  // Edit view rows: the matching records (+ locally added), minus removed.
  type Row = { key: string; record: Record<string, unknown> | null; isNew: boolean }
  const editRows: Row[] = useMemo(() => {
    if (!allPicked) return []
    return [
      ...filtered
        .filter((r) => !removed.has(String(r.id)))
        .map((r) => ({ key: `rec-${r.id}`, record: r, isNew: false })),
      ...added.map((k) => ({ key: k, record: null, isNew: true }))
    ]
  }, [filtered, allPicked, added, removed])
  // Nothing exists for the chosen combination → offer one row to fill in.
  useEffect(() => {
    if (allPicked && filtered.length === 0 && added.length === 0 && removed.size === 0)
      setAdded([`new-${Date.now()}`])
  }, [allPicked, filtered.length, added.length, removed.size])

  const cellValue = (row: Row, field: string): string => {
    const d = draft[row.key]?.[field]
    if (d !== undefined) return d
    const v = row.record?.[field]
    return v == null ? '' : String(v)
  }
  const original = (row: Row, field: string) => {
    const v = row.record?.[field]
    return v == null ? '' : String(v)
  }
  const setCell = (rowKey: string, field: string, value: string) =>
    setDraft((p) => ({ ...p, [rowKey]: { ...(p[rowKey] ?? {}), [field]: value } }))
  const rowTotal = (row: Row) =>
    firstSet
      ? MONTHS.reduce((s, m) => s + (Number(cellValue(row, `${m}${firstSet.suffix}`)) || 0), 0)
      : null
  const dirty =
    Object.values(draft).some((r) => Object.keys(r).length > 0) ||
    removed.size > 0 ||
    added.some((k) => Object.keys(draft[k] ?? {}).length > 0)
  const reset = () => {
    setDraft({})
    setAdded([])
    setRemoved(new Set())
  }
  const drill = (keyVals: Record<string, unknown>) => {
    setPicked((p) => ({ ...p, ...keyVals }))
    reset()
  }
  const pick = (field: string, v: unknown) => {
    setPicked((p) => ({ ...p, [field]: v }))
    reset()
  }

  async function save(changeReason?: string) {
    setSaving(true)
    setStatus(null)
    let createdN = 0
    let updatedN = 0
    let deletedN = 0
    try {
      for (const row of editRows) {
        const d = draft[row.key] ?? {}
        if (Object.keys(d).length === 0) continue
        const payload: Record<string, unknown> = {}
        for (const [f, v] of Object.entries(d)) {
          if (!valueCols.some((c) => c.field === f)) continue
          payload[f] = v === '' ? null : Number.isNaN(Number(v)) ? v : Number(v)
        }
        if (config.computed_total_field && firstSet)
          payload[config.computed_total_field] = rowTotal(row)
        if (row.record) {
          if (changeReason) payload._change_reason = changeReason
          await client.request(patch(`/items/${config.collection}/${row.record.id}`, payload))
          updatedN++
        } else {
          for (const k of keys) payload[k.field] = picked[k.field]
          await client.request(post(`/items/${config.collection}`, payload))
          createdN++
        }
      }
      for (const id of removed) {
        await client.request(del(`/items/${config.collection}/${id}`))
        deletedN++
      }
      if (config.after_save) {
        const params = resolveScopeTokens(config.after_save.params ?? {}, picked)
        await client.request(
          post(`/custom-queries/${config.after_save.query_slug}/execute`, { params })
        )
      }
      reset()
      await qc.invalidateQueries({ queryKey: ['record-grid-browse-rows', config.collection] })
      setStatus(
        `Saved — ${updatedN} updated, ${createdN} created${deletedN ? `, ${deletedN} deleted` : ''}`
      )
    } catch (err) {
      const challenge = changeReasonChallenge(err)
      if (challenge) setCrChallenge(challenge)
      else setStatus(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  const grandTotal = (field: string) =>
    allPicked
      ? editRows.reduce((s, r) => s + (Number(cellValue(r, field)) || 0), 0)
      : rollups.reduce((s, g) => s + (g.sums[field] ?? 0), 0)
  const quarterEdge = (i: number) => firstSet && i < 12 && i % 3 === 0 && i > 0
  const headerCell = (label: string, i: number, extra = '') => (
    <th
      key={label + i}
      className={cn(
        'whitespace-nowrap px-2 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wide text-slate-400',
        quarterEdge(i) && 'border-l border-slate-200 dark:border-border',
        extra
      )}
    >
      {label}
    </th>
  )

  return (
    <div className='flex h-full min-h-0 flex-col' data-record-grid-browse>
      <ChangeReasonDialog
        challenge={crChallenge}
        onCancel={() => setCrChallenge(null)}
        onSubmit={(reason) => {
          setCrChallenge(null)
          void save(reason)
        }}
      />
      {/* ── Header: key pickers + actions ── */}
      <div className='flex shrink-0 flex-wrap items-end gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
        {keys.map((k) => (
          <div key={k.field} className='w-52'>
            <p className='mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400'>
              {k.label ?? k.field}
            </p>
            <RelationCombobox
              collection={k.collection}
              value={picked[k.field] ?? null}
              onChange={(v) => pick(k.field, v)}
              placeholder='All'
              optionSort={k.collection === 'funding_years' ? '-id' : undefined}
            />
          </div>
        ))}
        <span className='flex-1' />
        {status && <span className='pb-2 text-[12px] text-slate-500'>{status}</span>}
        {allPicked && config.allow_add && (
          <button
            type='button'
            onClick={() => setAdded((p) => [...p, `new-${Date.now()}`])}
            className='h-9 rounded-md border border-slate-200 bg-white px-3 text-[13px] text-slate-700 hover:border-slate-400 dark:border-border dark:bg-card dark:text-slate-200'
          >
            + Add row
          </button>
        )}
        {dirty && (
          <button
            type='button'
            onClick={reset}
            className='h-9 rounded-md px-3 text-[13px] font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted'
          >
            Discard
          </button>
        )}
        <button
          type='button'
          disabled={!allPicked || !dirty || saving}
          onClick={() => void save()}
          data-record-grid-save
          className='inline-flex h-9 items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 text-[13px] font-semibold text-[#172940] hover:bg-[#00b8e0] disabled:opacity-50'
        >
          {saving && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
          Save changes
        </button>
      </div>

      {/* ── Context line ── */}
      <div className='flex shrink-0 items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-[12px] text-slate-500 dark:border-border dark:bg-muted/40 dark:text-slate-400'>
        {allPicked ? (
          <span>
            Editing{' '}
            <strong className='text-slate-700 dark:text-slate-200'>
              {keys.map((k) => labelOf(k.field, picked[k.field])).join(' · ')}
            </strong>
            {editRows.length > 1 && ` — ${editRows.length} rows share this combination`}
          </span>
        ) : (
          <span>
            Totals across{' '}
            <strong className='text-slate-700 dark:text-slate-200'>{filtered.length}</strong> row
            {filtered.length === 1 ? '' : 's'}
            {openKeys.length > 0 && (
              <>
                , by {openKeys.map((k) => k.label ?? k.field).join(' and ')} — pick{' '}
                {openKeys.map((k) => k.label ?? k.field).join(', ')} to edit
              </>
            )}
          </span>
        )}
        {Object.keys(picked).some((f) => picked[f] != null && picked[f] !== '') && (
          <button
            type='button'
            onClick={() => {
              setPicked({})
              reset()
            }}
            className='ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-slate-500 hover:bg-slate-200/60 hover:text-slate-700 dark:hover:bg-muted'
          >
            <X className='h-3 w-3' /> Clear
          </button>
        )}
      </div>

      {/* ── Grid ── */}
      <div className='min-h-0 flex-1 overflow-auto'>
        {isLoading ? (
          <div className='flex items-center gap-2 p-4 text-[12px] text-slate-400'>
            <Loader2 className='h-4 w-4 animate-spin' /> Loading…
          </div>
        ) : (
          <table className='w-full text-[12px]'>
            <thead className='sticky top-0 z-[1] bg-white dark:bg-card'>
              <tr className='border-b border-slate-200 dark:border-border'>
                {(allPicked
                  ? [{ field: '__row', label: '' }]
                  : openKeys.map((k) => ({ field: k.field, label: k.label ?? k.field }))
                ).map((k) => (
                  <th
                    key={k.field}
                    className='sticky left-0 z-[2] bg-white px-2 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide text-slate-400 dark:bg-card'
                  >
                    {k.label}
                  </th>
                ))}
                {valueCols.map((c, i) => headerCell(c.label, i))}
                {firstSet &&
                  headerCell('Total', 99, 'border-l border-slate-200 dark:border-border')}
                {allPicked && config.allow_delete && <th aria-label='Remove' className='w-8' />}
              </tr>
            </thead>
            <tbody>
              {allPicked
                ? editRows.map((row) => (
                    <tr key={row.key} className='border-b border-slate-100 dark:border-border/50'>
                      <td className='sticky left-0 z-[1] bg-white px-3 py-1 text-slate-600 dark:bg-card dark:text-slate-300'>
                        {row.isNew ? (
                          <span className='rounded bg-nvr-cyan/10 px-1.5 py-0.5 text-[10.5px] font-medium text-nvr-navy dark:text-nvr-cyan'>
                            New row
                          </span>
                        ) : (
                          `#${row.record?.id}`
                        )}
                      </td>
                      {valueCols.map((c, i) => (
                        <td
                          key={c.field}
                          className={cn(
                            'px-1 py-0.5 text-right',
                            quarterEdge(i) && 'border-l border-slate-100 dark:border-border/50'
                          )}
                        >
                          <NumberCell
                            value={cellValue(row, c.field)}
                            original={original(row, c.field)}
                            onChange={(v) => setCell(row.key, c.field, v)}
                          />
                        </td>
                      ))}
                      {firstSet && (
                        <td className='border-l border-slate-200 px-2 py-1 text-right font-semibold tabular-nums text-slate-800 dark:border-border dark:text-slate-100'>
                          {fmtNum(rowTotal(row))}
                        </td>
                      )}
                      {config.allow_delete && (
                        <td className='py-1 pl-1'>
                          <button
                            type='button'
                            aria-label='Remove row'
                            onClick={() => {
                              if (row.record)
                                setRemoved((p) => new Set(p).add(String(row.record?.id)))
                              else setAdded((p) => p.filter((k) => k !== row.key))
                              setDraft((p) => {
                                const n = { ...p }
                                delete n[row.key]
                                return n
                              })
                            }}
                            className='rounded p-1 text-slate-400 hover:text-red-600'
                          >
                            <X className='h-3.5 w-3.5' />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                : rollups.map((g) => {
                    const id = openKeys.map((k) => String(g.keyVals[k.field] ?? '')).join('|')
                    return (
                      <tr
                        key={id}
                        className='cursor-pointer border-b border-slate-100 hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 dark:border-border/50 dark:hover:bg-muted/40'
                        onClick={() => drill(g.keyVals)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            drill(g.keyVals)
                          }
                        }}
                        tabIndex={0}
                        title='Open this combination'
                      >
                        {openKeys.map((k, i) => (
                          <td
                            key={k.field}
                            className={cn(
                              'whitespace-nowrap px-2 py-1.5 text-slate-700 dark:text-slate-200',
                              i === 0 && 'sticky left-0 z-[1] bg-white font-medium dark:bg-card'
                            )}
                          >
                            {i === 0 && (
                              <ChevronRight className='mr-1 inline h-3 w-3 text-slate-300' />
                            )}
                            {labelOf(k.field, g.keyVals[k.field])}
                            {i === openKeys.length - 1 && g.count > 1 && (
                              <span className='ml-1.5 text-[10.5px] text-slate-400'>
                                {g.count} rows
                              </span>
                            )}
                          </td>
                        ))}
                        {valueCols.map((c, i) => (
                          <td
                            key={c.field}
                            className={cn(
                              'whitespace-nowrap px-1.5 py-1.5 text-right tabular-nums',
                              quarterEdge(i) && 'border-l border-slate-100 dark:border-border/50',
                              (g.sums[c.field] ?? 0) === 0
                                ? 'text-slate-300 dark:text-slate-600'
                                : 'text-slate-700 dark:text-slate-200'
                            )}
                          >
                            {fmtNum(g.sums[c.field], { blankZero: true })}
                          </td>
                        ))}
                        {firstSet && (
                          <td className='border-l border-slate-200 px-2 py-1.5 text-right font-semibold tabular-nums text-slate-800 dark:border-border dark:text-slate-100'>
                            {fmtNum(
                              MONTHS.reduce(
                                (s, m) => s + (g.sums[`${m}${firstSet.suffix}`] ?? 0),
                                0
                              )
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
              {!allPicked && rollups.length === 0 && (
                <tr>
                  <td colSpan={99} className='py-6 text-center text-[12px] text-slate-400'>
                    No rows match
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className='sticky bottom-0 bg-white dark:bg-card'>
              <tr className='border-t-2 border-slate-300 dark:border-border'>
                <td
                  colSpan={allPicked ? 1 : Math.max(1, openKeys.length)}
                  className='sticky left-0 z-[1] bg-white px-3 py-2 text-[12px] font-semibold text-slate-800 dark:bg-card dark:text-slate-100'
                >
                  Total
                </td>
                {valueCols.map((c, i) => (
                  <td
                    key={c.field}
                    className={cn(
                      'px-2 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100',
                      quarterEdge(i) && 'border-l border-slate-200 dark:border-border'
                    )}
                  >
                    {fmtNum(grandTotal(c.field))}
                  </td>
                ))}
                {firstSet && (
                  <td className='border-l border-slate-200 px-2 py-2 text-right font-semibold tabular-nums text-slate-800 dark:border-border dark:text-slate-100'>
                    {fmtNum(MONTHS.reduce((s, m) => s + grandTotal(`${m}${firstSet.suffix}`), 0))}
                  </td>
                )}
                {allPicked && config.allow_delete && <td />}
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  )
}
