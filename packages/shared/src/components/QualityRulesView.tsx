import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigation, useNivaroClient } from '../context'
import { del, get, patch, post } from '../lib/commands'
import { cn } from '../lib/utils'
import { PickList } from './imports/ServiceConfigBuilder'

/**
 * Quality rules — the admin-authored data checks (not-null, regex, range,
 * unique, formula) with run history, per collection. Shared so headless
 * frontends host the same surface the admin's Data Integrity tab does.
 * Host needs NivaroProvider; NavigationContext makes failing samples
 * clickable. All routes are the existing /data-quality set (admin-gated
 * server-side — a non-admin host will simply 403).
 */

type RuleType = 'not_null' | 'regex' | 'range' | 'unique' | 'formula'
type Severity = 'low' | 'medium' | 'high' | 'critical'

interface DqRule {
  id: number
  collection: string
  name: string
  rule_type: RuleType
  field: string | null
  config: Record<string, unknown> | null
  severity: Severity
  is_active: boolean
}

interface RuleResult {
  rule_id: number
  name: string
  severity: string
  rule_type: string
  field: string | null
  failed_count: number
  sample_ids: (string | number)[]
  error?: string
}

interface DqRun {
  id: number
  collection: string
  started_at: string
  finished_at: string | null
  total_records: number | null
  failed_records: number | null
  results: RuleResult[]
}

const RULE_TYPES: { value: RuleType; label: string }[] = [
  { value: 'not_null', label: 'Not null / not empty' },
  { value: 'regex', label: 'Regex match' },
  { value: 'range', label: 'Numeric range' },
  { value: 'unique', label: 'Unique values' },
  { value: 'formula', label: 'Formula (conditions)' }
]

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical']

const SEVERITY_TINT: Record<string, string> = {
  low: 'bg-slate-500/10 text-slate-500',
  medium: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  high: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  critical: 'bg-red-500/10 text-red-700 dark:text-red-400'
}

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] text-slate-800 dark:border-border dark:text-foreground'

interface ConditionRow {
  field: string
  op: string
  value: string
}

/** Create/edit form for one rule. Config shape mirrors the server exactly. */
function RuleForm({
  rule,
  fields,
  onSave,
  onCancel,
  saving
}: {
  rule: DqRule | null
  fields: Array<{ field: string }>
  onSave: (body: Record<string, unknown>) => void
  onCancel: () => void
  saving: boolean
}) {
  const cfg = rule?.config ?? {}
  const [name, setName] = useState(rule?.name ?? '')
  const [ruleType, setRuleType] = useState<RuleType>(rule?.rule_type ?? 'not_null')
  const [field, setField] = useState(rule?.field ?? '')
  const [severity, setSeverity] = useState<Severity>(rule?.severity ?? 'medium')
  const [pattern, setPattern] = useState(String((cfg as { pattern?: string }).pattern ?? ''))
  const [min, setMin] = useState(String((cfg as { min?: number }).min ?? ''))
  const [max, setMax] = useState(String((cfg as { max?: number }).max ?? ''))
  const [conditions, setConditions] = useState<ConditionRow[]>(
    Array.isArray((cfg as { conditions?: ConditionRow[] }).conditions)
      ? ((cfg as { conditions?: ConditionRow[] }).conditions as ConditionRow[])
      : [{ field: '', op: 'eq', value: '' }]
  )

  const needsField = ruleType !== 'formula'
  const canSave =
    name.trim().length > 0 &&
    (!needsField || field.length > 0) &&
    (ruleType !== 'regex' || pattern.trim().length > 0)

  const save = () => {
    let config: Record<string, unknown> | null = null
    if (ruleType === 'regex') config = { pattern }
    if (ruleType === 'range') {
      config = {}
      if (min.trim() !== '') config.min = Number(min)
      if (max.trim() !== '') config.max = Number(max)
    }
    if (ruleType === 'formula') {
      config = { conditions: conditions.filter((c) => c.field) }
    }
    onSave({
      name: name.trim(),
      rule_type: ruleType,
      field: needsField ? field : null,
      severity,
      config
    })
  }

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder='Rule name' className={inputCls} />
        <PickList
          value={ruleType}
          onChange={(v) => setRuleType(v as RuleType)}
          options={RULE_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          placeholder='Rule type'
        />
        {needsField && (
          <PickList
            value={field}
            onChange={setField}
            options={fields.map((f) => ({ value: f.field, label: f.field }))}
            placeholder='Field…'
          />
        )}
        <PickList
          value={severity}
          onChange={(v) => setSeverity(v as Severity)}
          options={SEVERITIES.map((sv) => ({ value: sv, label: sv }))}
          placeholder='Severity'
        />
        {ruleType === 'regex' && (
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder='Regex pattern (e.g. ^[A-Z]{2}\d+$)'
            className={cn(inputCls, 'col-span-full font-mono')}
          />
        )}
        {ruleType === 'range' && (
          <>
            <input value={min} onChange={(e) => setMin(e.target.value)} type='number' placeholder='Min (optional)' className={inputCls} />
            <input value={max} onChange={(e) => setMax(e.target.value)} type='number' placeholder='Max (optional)' className={inputCls} />
          </>
        )}
      </div>
      {ruleType === 'formula' && (
        <div className='mt-2 space-y-1.5'>
          <p className='text-[11px] text-slate-400'>
            A record FAILS when every condition matches (flag rows where amount &gt; 0 AND status is
            null, say).
          </p>
          {conditions.map((c, i) => (
            <div key={i} className='flex items-center gap-1.5'>
              <div className='w-[180px]'>
                <PickList
                  value={c.field}
                  onChange={(v) => setConditions((prev) => prev.map((x, j) => (j === i ? { ...x, field: v } : x)))}
                  options={fields.map((f) => ({ value: f.field, label: f.field }))}
                  placeholder='Field…'
                />
              </div>
              <div className='w-[120px]'>
                <PickList
                  value={c.op}
                  onChange={(v) => setConditions((prev) => prev.map((x, j) => (j === i ? { ...x, op: v } : x)))}
                  options={[
                    { value: 'eq', label: '=' },
                    { value: 'neq', label: '≠' },
                    { value: 'gt', label: '>' },
                    { value: 'gte', label: '≥' },
                    { value: 'lt', label: '<' },
                    { value: 'lte', label: '≤' },
                    { value: 'contains', label: 'contains' },
                    { value: 'null', label: 'is null' },
                    { value: 'nnull', label: 'is not null' }
                  ]}
                  placeholder='Op'
                />
              </div>
              {c.op !== 'null' && c.op !== 'nnull' && (
                <input
                  value={c.value}
                  onChange={(e) => setConditions((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  placeholder='Value'
                  className={cn(inputCls, 'flex-1')}
                />
              )}
              <button
                type='button'
                onClick={() => setConditions((prev) => prev.filter((_, j) => j !== i))}
                className='shrink-0 text-[13px] text-slate-300 hover:text-red-500'
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type='button'
            onClick={() => setConditions((prev) => [...prev, { field: '', op: 'eq', value: '' }])}
            className='text-[11.5px] text-slate-500 underline decoration-dotted underline-offset-2'
          >
            ＋ Add condition
          </button>
        </div>
      )}
      <div className='mt-2.5 flex items-center gap-2'>
        <button
          type='button'
          disabled={!canSave || saving}
          onClick={save}
          className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white disabled:opacity-50'
        >
          {saving ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
        </button>
        <button type='button' onClick={onCancel} className='text-[12px] text-slate-400 hover:text-slate-600'>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function QualityRulesView({ className }: { className?: string }) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const qc = useQueryClient()
  const [collection, setCollection] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)

  const { data: collections = [] } = useQuery<Array<{ collection: string }>>({
    queryKey: ['dqv-collections'],
    queryFn: () =>
      client.request<{ data: Array<{ collection: string }> }>(get('/collections')).then((r) => r.data ?? []),
    staleTime: 60_000
  })
  const { data: colMeta } = useQuery<{ fields: Array<{ field: string; hidden?: boolean }> }>({
    queryKey: ['dqv-collection-meta', collection],
    queryFn: () => client.request<{ data: never }>(get(`/collections/${collection}`)).then((r) => r.data),
    enabled: !!collection,
    staleTime: 30_000
  })
  const fields = (colMeta?.fields ?? []).filter((f) => !f.hidden)

  const { data: rules = [] } = useQuery<DqRule[]>({
    queryKey: ['dqv-rules', collection],
    queryFn: () =>
      client
        .request<{ data: DqRule[] }>(get('/data-quality/rules', { collection }))
        .then((r) => r.data ?? []),
    enabled: !!collection
  })
  const { data: runs = [] } = useQuery<DqRun[]>({
    queryKey: ['dqv-runs', collection],
    queryFn: () =>
      client
        .request<{ data: DqRun[] }>(get('/data-quality/runs', { collection }))
        .then((r) => r.data ?? []),
    enabled: !!collection
  })

  const invalidateRules = () => void qc.invalidateQueries({ queryKey: ['dqv-rules', collection] })
  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      client.request(post('/data-quality/rules', { ...body, collection })),
    onSuccess: () => {
      setAdding(false)
      invalidateRules()
    }
  })
  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      client.request(patch(`/data-quality/rules/${id}`, body)),
    onSuccess: () => {
      setEditingId(null)
      invalidateRules()
    }
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => client.request(del(`/data-quality/rules/${id}`)),
    onSuccess: invalidateRules
  })
  const runMut = useMutation({
    mutationFn: () =>
      client.request<{ data: DqRun }>(post(`/data-quality/run/${collection}`, {})),
    onSuccess: (r) => {
      setSelectedRunId(r.data.id)
      void qc.invalidateQueries({ queryKey: ['dqv-runs', collection] })
    }
  })

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6', className)}>
      <div className='flex flex-wrap items-end gap-3'>
        <div className='w-[280px]'>
          <p className='mb-1 text-[11.5px] font-medium text-slate-600 dark:text-muted-foreground'>Collection</p>
          <PickList
            value={collection}
            onChange={(v) => {
              setCollection(v)
              setAdding(false)
              setEditingId(null)
              setSelectedRunId(null)
            }}
            options={collections
              .filter((c) => !c.collection.startsWith('nivaro_'))
              .map((c) => ({ value: c.collection, label: c.collection }))}
            placeholder='Select collection…'
          />
        </div>
        {collection && (
          <button
            type='button'
            disabled={runMut.isPending || rules.filter((r) => r.is_active).length === 0}
            onClick={() => runMut.mutate()}
            className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white disabled:opacity-50'
          >
            {runMut.isPending ? 'Inspecting…' : 'Run inspection'}
          </button>
        )}
        {runMut.isError && (
          <span className='text-[12px] text-red-600 dark:text-red-400'>Inspection failed.</span>
        )}
      </div>

      {!collection && (
        <p className='text-[12.5px] text-slate-400'>
          Pick a collection to manage its quality rules — not-null, regex, range, unique, and
          formula checks with run history.
        </p>
      )}

      {collection && (
        <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
          {/* rules */}
          <div className='space-y-2'>
            <div className='flex items-center justify-between'>
              <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                Rules ({rules.length})
              </p>
              <button
                type='button'
                onClick={() => {
                  setAdding(true)
                  setEditingId(null)
                }}
                className='text-[12px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-700'
              >
                ＋ Add rule
              </button>
            </div>
            {adding && (
              <RuleForm
                rule={null}
                fields={fields}
                saving={createMut.isPending}
                onSave={(body) => createMut.mutate(body)}
                onCancel={() => setAdding(false)}
              />
            )}
            {rules.map((r) =>
              editingId === r.id ? (
                <RuleForm
                  key={r.id}
                  rule={r}
                  fields={fields}
                  saving={updateMut.isPending}
                  onSave={(body) => updateMut.mutate({ id: r.id, body })}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div
                  key={r.id}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card',
                    !r.is_active && 'opacity-60'
                  )}
                >
                  <div className='min-w-0 flex-1'>
                    <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                      {r.name}
                      <span className={cn('ml-2 rounded px-1.5 py-px text-[10px] font-medium uppercase', SEVERITY_TINT[r.severity])}>
                        {r.severity}
                      </span>
                    </p>
                    <p className='text-[11px] text-slate-400'>
                      {RULE_TYPES.find((t) => t.value === r.rule_type)?.label ?? r.rule_type}
                      {r.field && <span className='font-mono'> · {r.field}</span>}
                    </p>
                  </div>
                  <button
                    type='button'
                    onClick={() => updateMut.mutate({ id: r.id, body: { is_active: !r.is_active } })}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                      r.is_active
                        ? 'border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400'
                        : 'border-slate-200 text-slate-400 dark:border-border'
                    )}
                  >
                    {r.is_active ? 'Active' : 'Off'}
                  </button>
                  <button
                    type='button'
                    onClick={() => {
                      setEditingId(r.id)
                      setAdding(false)
                    }}
                    className='text-[12px] text-slate-400 hover:text-slate-600'
                  >
                    Edit
                  </button>
                  <button
                    type='button'
                    onClick={() => {
                      if (window.confirm(`Delete rule "${r.name}"?`)) deleteMut.mutate(r.id)
                    }}
                    className='text-[13px] text-slate-300 hover:text-red-500'
                  >
                    ✕
                  </button>
                </div>
              )
            )}
            {rules.length === 0 && !adding && (
              <p className='text-[12px] text-slate-400'>No rules yet for this collection.</p>
            )}
          </div>

          {/* runs */}
          <div className='space-y-2'>
            <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
              Run history
            </p>
            {runs.length === 0 && <p className='text-[12px] text-slate-400'>No inspections yet.</p>}
            {runs.length > 0 && (
              <div className='flex flex-wrap gap-1.5'>
                {runs.slice(0, 12).map((run) => (
                  <button
                    key={run.id}
                    type='button'
                    onClick={() => setSelectedRunId(run.id)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                      (selectedRun?.id ?? null) === run.id
                        ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                        : 'border-slate-200 text-slate-500 dark:border-border dark:text-muted-foreground'
                    )}
                  >
                    {new Date(run.started_at).toLocaleString()}
                    {(run.failed_records ?? 0) > 0 && (
                      <span className='ml-1 font-medium text-red-600 dark:text-red-400'>
                        {run.failed_records}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {selectedRun && (
              <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
                <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                  {selectedRun.total_records ?? '?'} records checked ·{' '}
                  <span className={cn((selectedRun.failed_records ?? 0) > 0 && 'font-medium text-red-600 dark:text-red-400')}>
                    {selectedRun.failed_records ?? 0} failing
                  </span>
                </p>
                <div className='mt-2 space-y-1.5'>
                  {(selectedRun.results ?? []).map((res) => (
                    <div key={res.rule_id} className='rounded-md border border-slate-100 px-2.5 py-1.5 dark:border-border'>
                      <p className='text-[12px] text-slate-700 dark:text-foreground'>
                        {res.name}
                        <span className={cn('ml-2 rounded px-1.5 py-px text-[10px] font-medium uppercase', SEVERITY_TINT[res.severity] ?? '')}>
                          {res.severity}
                        </span>
                        <span
                          className={cn(
                            'ml-2 text-[11.5px]',
                            res.failed_count > 0 ? 'font-medium text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
                          )}
                        >
                          {res.error ? `error: ${res.error}` : res.failed_count > 0 ? `${res.failed_count} failing` : 'pass'}
                        </span>
                      </p>
                      {res.sample_ids?.length > 0 && (
                        <p className='mt-0.5 flex flex-wrap gap-1 text-[11px]'>
                          {res.sample_ids.slice(0, 10).map((id) => (
                            <button
                              key={String(id)}
                              type='button'
                              onClick={() => {
                                const url = nav.itemUrl?.({ collection: selectedRun.collection, itemId: String(id) })
                                if (url) nav.navigate(url)
                              }}
                              className='rounded bg-slate-500/10 px-1.5 py-px font-mono text-slate-600 underline decoration-dotted underline-offset-2 hover:text-slate-800 dark:text-muted-foreground'
                            >
                              {String(id)}
                            </button>
                          ))}
                          {res.failed_count > 10 && (
                            <span className='text-slate-400'>+{res.failed_count - 10} more</span>
                          )}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
