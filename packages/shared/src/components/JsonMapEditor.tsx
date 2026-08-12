import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../context'
import { get, patch, post } from '../lib/commands'
import { RelationCombobox } from './item-edit/RelationCombobox'

// Generic editor for records whose value columns are JSON DICTS keyed by
// another collection's record ids (EFP cost tables: `data` = {categoryId:
// amount}, `timing` = {categoryId: monthOffset}). Pick an existing record or
// create a new one; rows come from one or more key sections (collections with
// label templates + optional '$scope' filters) plus static sentinel rows
// ('inventory', 'uncategorized'). All writes go through /items.

export interface JsonMapEditorConfig {
  collection: string
  title?: string
  /** Record picker label field (also the required name on create). */
  label_field?: string
  /** Filter for the record picker; '$scope.<field>' tokens resolve from the
   *  host-provided scope. Scope values are also seeded onto created records. */
  record_filter?: Record<string, unknown>
  /** Plain record fields edited beside the picker (small option sets). */
  fields?: Array<{ field: string; label?: string; options: string[] }>
  /** JSON-dict columns; each stored under `json_field` on the record. */
  map_columns: Array<{ json_field: string; label: string; min?: number; max?: number }>
  /** Key rows: records of other collections. Template supports one-hop dotted
   *  refs ('{{core_category.name}}'); filter supports '$scope' tokens. */
  sections: Array<{
    collection: string
    label_template: string
    filter?: Record<string, unknown>
    section_label?: string
  }>
  /** Static sentinel keys appended after the sections (bg = row tint). */
  extra_rows?: Array<{ key: string; label: string; bg?: string }>
  /** 'Left to allocate' style hint: shown when record[when_field] ===
   *  when_value; remaining = total − Σ json_field values. */
  remaining_hint?: {
    when_field: string
    when_value: string
    total: number
    json_field: string
    label?: string
  }
  /** Extra fields seeded onto created records from scope values. */
  seed_fields?: string[]
  /** Custom query run after save (recompute hooks); '$scope' tokens. */
  after_save?: { query_slug: string; params?: Record<string, unknown> }
}

function resolveScope(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$scope.')) return scope[value.slice(7)]
  if (Array.isArray(value)) return value.map((v) => resolveScope(v, scope))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveScope(v, scope)])
    )
  return value
}
function hasUndef(v: unknown): boolean {
  if (v === undefined) return true
  if (Array.isArray(v)) return v.some(hasUndef)
  if (v && typeof v === 'object') return Object.values(v).some(hasUndef)
  return false
}
function applyTemplate(tmpl: string, row: Record<string, unknown>): string {
  return tmpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p: string) => {
    let v: unknown = row
    for (const seg of p.split('.')) {
      if (v == null || typeof v !== 'object') return ''
      v = (v as Record<string, unknown>)[seg]
    }
    return v == null ? '' : String(v)
  })
}
function templateFields(tmpl: string): string[] {
  return [...tmpl.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1])
}

export function JsonMapEditor({
  config,
  scope
}: {
  config: JsonMapEditorConfig
  scope: Record<string, unknown>
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const labelField = config.label_field ?? 'name'
  const [recordId, setRecordId] = useState<unknown>(null)
  const [newName, setNewName] = useState('')
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [fieldDraft, setFieldDraft] = useState<Record<string, string>>({})
  const [mapDraft, setMapDraft] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const scopeKey = JSON.stringify(scope)
  const recordFilterResolved = resolveScope(config.record_filter, scope)
  const recordFilter =
    recordFilterResolved && !hasUndef(recordFilterResolved)
      ? (recordFilterResolved as Record<string, unknown>)
      : undefined

  const { data: record } = useQuery<Record<string, unknown> | null>({
    queryKey: ['json-map-record', config.collection, recordId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${config.collection}/${recordId}`))
        .then((r) => r.data ?? null),
    enabled: recordId != null && !creating
  })

  // Reset drafts when switching records / to create mode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger
  useEffect(() => {
    setFieldDraft({})
    setMapDraft({})
    setNameDraft(null)
    setStatus(null)
  }, [recordId, creating])

  const sectionQueries = useQuery<Array<{ section: number; rows: Array<Record<string, unknown>> }>>({
    queryKey: ['json-map-keys', scopeKey, JSON.stringify(config.sections.map((s) => s.collection))],
    queryFn: async () => {
      const out: Array<{ section: number; rows: Array<Record<string, unknown>> }> = []
      for (let i = 0; i < config.sections.length; i++) {
        const s = config.sections[i]
        const refs = templateFields(s.label_template)
        const resolved = resolveScope(s.filter, scope)
        const filter = resolved && !hasUndef(resolved) ? resolved : undefined
        const res = await client.request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${s.collection}`, {
            limit: 1000,
            fields: ['id', ...refs].join(','),
            ...(filter ? { filter: JSON.stringify(filter) } : {})
          })
        )
        out.push({ section: i, rows: res.data ?? [] })
      }
      return out
    },
    staleTime: 30_000
  })

  type KeyRow = { key: string; label: string; section: string | null; bg?: string }
  const keyRows: KeyRow[] = useMemo(() => {
    const rows: KeyRow[] = []
    for (const sq of sectionQueries.data ?? []) {
      const s = config.sections[sq.section]
      const sectionRows = sq.rows
        .map((r) => ({
          key: String(r.id),
          label: applyTemplate(s.label_template, r) || `#${r.id}`,
          section: s.section_label ?? null
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
      rows.push(...sectionRows)
    }
    for (const e of config.extra_rows ?? [])
      rows.push({ key: e.key, label: e.label, section: null, bg: e.bg })
    return rows
  }, [sectionQueries.data, config.sections, config.extra_rows])

  const recordMaps: Record<string, Record<string, unknown>> = useMemo(() => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const mc of config.map_columns) {
      const raw = record?.[mc.json_field]
      try {
        out[mc.json_field] = typeof raw === 'string' ? JSON.parse(raw) : ((raw as Record<string, unknown>) ?? {})
      } catch {
        out[mc.json_field] = {}
      }
    }
    return out
  }, [record, config.map_columns])

  const cellValue = (jsonField: string, key: string): string => {
    const d = mapDraft[jsonField]?.[key]
    if (d !== undefined) return d
    const v = recordMaps[jsonField]?.[key]
    return v == null ? '' : String(v)
  }
  const setCell = (jsonField: string, key: string, value: string) =>
    setMapDraft((p) => ({ ...p, [jsonField]: { ...(p[jsonField] ?? {}), [key]: value } }))

  const fieldValue = (f: string): string => {
    const d = fieldDraft[f]
    if (d !== undefined) return d
    const v = record?.[f]
    return v == null ? '' : String(v)
  }

  const active = creating || recordId != null
  const dirty =
    Object.keys(fieldDraft).length > 0 ||
    Object.values(mapDraft).some((m) => Object.keys(m).length > 0) ||
    nameDraft !== null ||
    creating

  const hint = config.remaining_hint
  const remaining =
    hint && fieldValue(hint.when_field) === hint.when_value
      ? hint.total -
        keyRows.reduce((s, r) => s + (Number(cellValue(hint.json_field, r.key)) || 0), 0)
      : null

  async function save() {
    if (creating && !newName.trim()) {
      setStatus(`${labelField} is required`)
      return
    }
    setSaving(true)
    setStatus(null)
    try {
      const payload: Record<string, unknown> = {}
      for (const f of config.fields ?? []) {
        const v = fieldDraft[f.field]
        if (v !== undefined) payload[f.field] = v
        else if (creating) payload[f.field] = f.options[0]
      }
      for (const mc of config.map_columns) {
        const merged: Record<string, unknown> = { ...(creating ? {} : recordMaps[mc.json_field]) }
        for (const [k, v] of Object.entries(mapDraft[mc.json_field] ?? {})) {
          if (v === '') delete merged[k]
          else merged[k] = Number(v)
        }
        if (Object.keys(merged).length > 0 || !creating) payload[mc.json_field] = JSON.stringify(merged)
      }
      let savedId = recordId
      if (creating) {
        payload[labelField] = newName.trim()
        for (const f of config.seed_fields ?? []) payload[f] = scope[f]
        const res = await client.request<{ data: { id: unknown } }>(
          post(`/items/${config.collection}`, payload)
        )
        savedId = res.data?.id
        setCreating(false)
        setNewName('')
        setRecordId(savedId ?? null)
      } else {
        // EFP allows renaming an existing table in place.
        if (nameDraft !== null && nameDraft.trim()) payload[labelField] = nameDraft.trim()
        await client.request(patch(`/items/${config.collection}/${recordId}`, payload))
      }
      setNameDraft(null)
      if (config.after_save) {
        const params = resolveScope(config.after_save.params ?? {}, scope)
        await client.request(post(`/custom-queries/${config.after_save.query_slug}/execute`, { params }))
      }
      setFieldDraft({})
      setMapDraft({})
      await qc.invalidateQueries({ queryKey: ['json-map-record', config.collection] })
      await qc.invalidateQueries({
        predicate: (q) => JSON.stringify(q.queryKey).includes(config.collection)
      })
      setStatus('Saved')
    } catch (err) {
      setStatus(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  // Group rows by section label for display.
  const grouped = useMemo(() => {
    const out: Array<{ section: string | null; rows: KeyRow[] }> = []
    for (const r of keyRows) {
      const last = out[out.length - 1]
      if (last && last.section === r.section) last.rows.push(r)
      else out.push({ section: r.section, rows: [r] })
    }
    return out
  }, [keyRows])

  return (
    <div className='flex h-full flex-col gap-3 overflow-auto p-3'>
      <div className='flex flex-wrap items-end gap-3'>
        <div className='w-64'>
          <p className='mb-1 text-[11px] font-medium text-slate-500'>
            {config.title ?? 'Record'}
          </p>
          {creating ? (
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={`New ${labelField}…`}
              className='h-9 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[13px] outline-none focus:border-[#00ceff] dark:border-border dark:bg-background'
            />
          ) : (
            <RelationCombobox
              collection={config.collection}
              value={recordId ?? null}
              onChange={(v) => setRecordId(v)}
              extraFilter={recordFilter}
              placeholder='Select…'
            />
          )}
        </div>
        <button
          type='button'
          onClick={() => {
            setCreating((c) => !c)
            setRecordId(null)
          }}
          className='inline-flex h-9 items-center rounded-md border border-slate-200 bg-white px-3 text-[13px] text-slate-700 hover:border-slate-400 dark:border-border dark:bg-card dark:text-slate-200'
        >
          {creating ? 'Pick existing' : '＋ New'}
        </button>
        {!creating && recordId != null && (
          <div className='w-56'>
            <p className='mb-1 text-[11px] font-medium text-slate-500'>Name</p>
            <input
              value={nameDraft ?? String(record?.[labelField] ?? '')}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder='Name…'
              className='h-9 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[13px] outline-none focus:border-[#00ceff] dark:border-border dark:bg-background'
            />
          </div>
        )}
        {(config.fields ?? []).map((f) => (
          <div key={f.field}>
            <p className='mb-1 text-[11px] font-medium text-slate-500'>{f.label ?? f.field}</p>
            <div className='inline-flex gap-0.5 rounded-md border border-slate-200 p-0.5 dark:border-border'>
              {f.options.map((o) => (
                <button
                  key={o}
                  type='button'
                  onClick={() => setFieldDraft((p) => ({ ...p, [f.field]: o }))}
                  className={`rounded px-2 py-1 text-[12px] font-medium transition-colors ${
                    (fieldValue(f.field) || f.options[0]) === o
                      ? 'bg-[#00ceff1a] text-slate-800 dark:text-slate-100'
                      : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                  }`}
                >
                  {o.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button
          type='button'
          disabled={!active || !dirty || saving || (remaining !== null && remaining < 0)}
          onClick={() => void save()}
          className='inline-flex h-9 items-center gap-1.5 rounded-md bg-[#00ceff] px-3 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50'
        >
          {saving && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
          Save
        </button>
        {remaining !== null && (
          <span className={`pb-2 text-[12px] ${remaining < 0 ? 'text-red-600' : 'text-slate-500'}`}>
            {config.remaining_hint?.label ?? 'Left to allocate'}: {remaining}
          </span>
        )}
        {status && <span className='pb-2 text-[12px] text-slate-500'>{status}</span>}
      </div>

      {!active ? (
        <p className='text-[12px] text-slate-400'>Pick a record or create a new one.</p>
      ) : sectionQueries.isLoading ? (
        <div className='flex items-center gap-2 text-[12px] text-slate-400'>
          <Loader2 className='h-4 w-4 animate-spin' /> Loading…
        </div>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full max-w-3xl text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-left dark:border-border'>
                <th className='py-1.5 pr-3 font-medium text-slate-500'>Category</th>
                {config.map_columns.map((mc) => (
                  <th key={mc.json_field} className='w-36 py-1.5 pr-2 text-right font-medium text-slate-500'>
                    {mc.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map((g, gi) => (
                <FragmentRows
                  key={`${g.section ?? ''}-${gi}`}
                  header={
                    g.section ? (
                      <tr className='border-b border-slate-200 bg-slate-100/80 dark:border-border dark:bg-muted'>
                        <td
                          colSpan={1 + config.map_columns.length}
                          className='px-2 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300'
                        >
                          {g.section}
                        </td>
                      </tr>
                    ) : null
                  }
                >
                  {g.rows.map((r) => (
                    <tr
                      key={r.key}
                      className='border-b border-slate-100 dark:border-border/50'
                      style={r.bg ? { backgroundColor: r.bg } : undefined}
                    >
                      <td className='py-1 pr-3 text-slate-700 dark:text-slate-200'>{r.label}</td>
                      {config.map_columns.map((mc) => (
                        <td key={mc.json_field} className='py-0.5 pr-2 text-right'>
                          <input
                            type='number'
                            min={mc.min}
                            max={mc.max}
                            value={cellValue(mc.json_field, r.key)}
                            onChange={(e) => setCell(mc.json_field, r.key, e.target.value)}
                            className='h-7 w-[110px] rounded border border-slate-200 bg-white px-1.5 text-right text-[12px] tabular-nums outline-none focus:border-[#00ceff] dark:border-border dark:bg-background'
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </FragmentRows>
              ))}
            </tbody>
            <tfoot>
              <tr className='border-t border-slate-300 font-semibold dark:border-border'>
                <td className='py-1.5 pr-3'>Total</td>
                {config.map_columns.map((mc) => (
                  <td key={mc.json_field} className='py-1.5 pr-2 text-right tabular-nums'>
                    {keyRows
                      .reduce((s, r) => s + (Number(cellValue(mc.json_field, r.key)) || 0), 0)
                      .toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

function FragmentRows({ header, children }: { header: React.ReactNode; children?: React.ReactNode }) {
  return (
    <>
      {header}
      {children}
    </>
  )
}
