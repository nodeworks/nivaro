import { readItems } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { cn } from '../../lib/utils'
import { SimpleSelect } from '../ui/SimpleSelect'
import type {
  AnomalyDefinition,
  AnomalyRule,
  FilterOptionSpec,
  MetricAlertRule,
  MetricDefinition
} from './types'
import { OPERATOR_OPTIONS } from './types'

// ─── Primitives ───────────────────────────────────────────────────────────────

export function AlertSheet({
  open,
  title,
  onClose,
  children,
  footer
}: {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}) {
  if (!open) return null
  return (
    <div
      className='fixed inset-0 z-50 flex justify-end bg-black/30'
      data-alerts-sheet=''
      onClick={onClose}
    >
      <div
        className='flex h-full w-full max-w-[480px] flex-col border-l border-slate-200 bg-white shadow-xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <header className='flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-border'>
          <h3 className='text-[14px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h3>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
          >
            <X className='h-4 w-4' />
          </button>
        </header>
        <div className='min-h-0 flex-1 overflow-y-auto px-4 py-4'>{children}</div>
        <footer className='flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-border'>
          {footer}
        </footer>
      </div>
    </div>
  )
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className='mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400'>{children}</p>
  )
}

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-card dark:text-slate-100'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputCls, props.className)} />
}

export function SelectInput({
  value,
  onChange,
  options,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ label: string; value: string }>
  className?: string
}) {
  return (
    <SimpleSelect
      value={value}
      onChange={onChange}
      options={options}
      className={cn(inputCls, 'justify-between', className)}
    />
  )
}

export function ToggleSwitch({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-nvr-cyan' : 'bg-slate-300 dark:bg-slate-600',
        disabled && 'opacity-50'
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[15px]' : 'translate-x-[2px]'
        )}
      />
    </button>
  )
}

/** Multi-select over a spec: options fetched from spec.collection, else free CSV entry. */
export function ScopeMultiSelect({
  spec,
  values,
  onChange
}: {
  spec: FilterOptionSpec
  values: Array<string | number>
  onChange: (v: Array<string | number>) => void
}) {
  const client = useNivaroClient()
  const valueField = spec.value_field ?? 'id'
  const labelField = spec.label_field ?? spec.value_field ?? 'name'
  const { data: options = [] } = useQuery({
    queryKey: ['nvr-ma-scope-opts', spec.collection, valueField, labelField, spec.sort ?? ''],
    enabled: !!spec.collection,
    queryFn: async () => {
      const fields = [...new Set(['id', valueField, labelField])]
      const res = (await client.request(
        readItems(spec.collection as string, {
          fields,
          sort: spec.sort ? [spec.sort] : undefined,
          limit: 200
        })
      )) as { data: Array<Record<string, unknown>> }
      return (res.data ?? []).map((r) => ({
        value: r[valueField] as string | number,
        label: String(r[labelField] ?? r[valueField])
      }))
    }
  })
  const [q, setQ] = useState('')
  const [openList, setOpenList] = useState(false)
  const selected = new Set(values.map(String))
  const filtered = useMemo(() => {
    const qn = q.trim().toLowerCase()
    const base = qn ? options.filter((o) => o.label.toLowerCase().includes(qn)) : options
    return base.slice(0, 30)
  }, [options, q])

  if (!spec.collection) {
    return (
      <TextInput
        value={values.join(', ')}
        placeholder='Comma-separated values'
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          )
        }
      />
    )
  }

  return (
    <div>
      {values.length > 0 && (
        <div className='mb-1.5 flex flex-wrap gap-1'>
          {values.map((v) => {
            const opt = options.find((o) => String(o.value) === String(v))
            return (
              <span
                key={String(v)}
                className='inline-flex items-center gap-1 rounded-full border border-nvr-cyan bg-[#00ceff1a] py-0.5 pl-2 pr-1 text-[11px] font-medium text-nvr-navy dark:text-nvr-cyan'
              >
                {opt?.label ?? String(v)}
                <button
                  type='button'
                  aria-label='Remove'
                  onClick={() => onChange(values.filter((x) => String(x) !== String(v)))}
                  className='rounded-full px-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}
      <TextInput
        value={q}
        placeholder={`All ${spec.label ?? spec.key}`}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpenList(true)}
        onBlur={() => setOpenList(false)}
      />
      {(openList || q.trim().length > 0) && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          className='mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200 dark:border-border'
        >
          {filtered.map((o) => {
            const on = selected.has(String(o.value))
            return (
              <button
                key={String(o.value)}
                type='button'
                onClick={() =>
                  onChange(
                    on ? values.filter((x) => String(x) !== String(o.value)) : [...values, o.value]
                  )
                }
                className={cn(
                  'flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-muted',
                  on
                    ? 'font-medium text-nvr-navy dark:text-nvr-cyan'
                    : 'text-slate-600 dark:text-slate-300'
                )}
              >
                <span className='truncate'>{o.label}</span>
                <span className='pl-2 text-[11px] text-slate-400'>{on ? 'Remove' : 'Add'}</span>
              </button>
            )
          })}
          {filtered.length === 0 && (
            <p className='px-2.5 py-2 text-[11.5px] text-slate-400'>No matches.</p>
          )}
        </div>
      )}
    </div>
  )
}

const btnPrimary =
  'inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50'
const btnGhost =
  'inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'

// ─── Alert rule drawer ────────────────────────────────────────────────────────

const unitSuffix = (unit?: string) =>
  unit === 'percent' ? '%' : unit === 'dollar' ? '$' : unit === 'days' ? 'days' : ''

export function AlertRuleDrawer({
  open,
  definitions,
  editRule,
  preselectedDefinitionId,
  scopeSeeds,
  onClose,
  onSave,
  saving
}: {
  open: boolean
  definitions: MetricDefinition[]
  editRule: MetricAlertRule | null
  preselectedDefinitionId?: number | null
  /** Pre-seeded filter values (e.g. from the user's scope restrictions), keyed by filter key. */
  scopeSeeds?: Record<string, Array<string | number>>
  onClose: () => void
  onSave: (values: Record<string, unknown>) => void
  saving: boolean
}) {
  const [name, setName] = useState('')
  const [definitionId, setDefinitionId] = useState<number | ''>('')
  const [operator, setOperator] = useState('gte')
  const [threshold, setThreshold] = useState('')
  const [frequency, setFrequency] = useState('daily')
  const [isShared, setIsShared] = useState(false)
  const [status, setStatus] = useState('active')
  const [filters, setFilters] = useState<Record<string, Array<string | number>>>({})

  useEffect(() => {
    if (!open) return
    if (editRule) {
      setName(editRule.name)
      setDefinitionId(editRule.definition_id)
      setOperator(editRule.operator)
      setThreshold(String(editRule.threshold_value ?? ''))
      setFrequency(String(editRule.check_frequency ?? 'daily'))
      setIsShared(!!editRule.is_shared)
      setStatus(editRule.status ?? 'active')
      setFilters(editRule.filters ?? {})
    } else {
      const def = preselectedDefinitionId
        ? definitions.find((d) => d.id === preselectedDefinitionId)
        : null
      setName('')
      setDefinitionId(def?.id ?? '')
      setOperator(def?.default_operator ?? 'gte')
      setThreshold(def?.default_threshold != null ? String(def.default_threshold) : '')
      setFrequency('daily')
      setIsShared(false)
      setStatus('active')
      // Seed the scope from the user's restricted visibility (EFP
      // mergeEffectiveFilters behavior) for the filters this metric supports.
      const seeded: Record<string, Array<string | number>> = {}
      for (const spec of def?.supported_filters ?? []) {
        const seed = scopeSeeds?.[spec.key]
        if (seed?.length) seeded[spec.key] = seed
      }
      setFilters(seeded)
    }
  }, [open, editRule, preselectedDefinitionId, definitions, scopeSeeds])

  const selectedDef = definitions.find((d) => d.id === definitionId)

  // When the metric changes on a NEW rule, adopt its defaults
  const onDefChange = (idStr: string) => {
    const id = Number(idStr)
    setDefinitionId(id)
    if (!editRule) {
      const def = definitions.find((d) => d.id === id)
      if (def) {
        setOperator(def.default_operator ?? 'gte')
        if (def.default_threshold != null) setThreshold(String(def.default_threshold))
      }
    }
  }

  const valid = name.trim() && definitionId !== '' && threshold.trim() !== '' && !Number.isNaN(Number(threshold))

  return (
    <AlertSheet
      open={open}
      title={editRule ? 'Edit Alert Rule' : 'Create Alert Rule'}
      onClose={onClose}
      footer={
        <>
          <button type='button' className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button
            type='button'
            className={btnPrimary}
            disabled={!valid || saving}
            onClick={() =>
              onSave({
                name: name.trim(),
                definition_id: definitionId,
                operator,
                threshold_value: Number(threshold),
                check_frequency: frequency,
                is_shared: isShared,
                status,
                filters: Object.fromEntries(
                  Object.entries(filters).filter(([, v]) => v.length > 0)
                )
              })
            }
          >
            {saving ? 'Saving…' : editRule ? 'Save Changes' : 'Create Rule'}
          </button>
        </>
      }
    >
      <div className='space-y-4'>
        <div>
          <FieldLabel>Alert Metric</FieldLabel>
          <SelectInput
            value={definitionId === '' ? '' : String(definitionId)}
            onChange={onDefChange}
            options={[
              { label: 'Choose a metric to monitor…', value: '' },
              ...definitions.map((d) => ({ label: d.name, value: String(d.id) }))
            ]}
          />
          {selectedDef?.description && (
            <p className='mt-1 text-[11.5px] text-slate-400'>{selectedDef.description}</p>
          )}
        </div>

        <div>
          <FieldLabel>Rule Name</FieldLabel>
          <TextInput
            value={name}
            maxLength={200}
            placeholder='e.g. Budget > 90% in NDO'
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className='flex gap-3'>
          <div className='w-[190px] shrink-0'>
            <FieldLabel>Condition</FieldLabel>
            <SelectInput value={operator} onChange={setOperator} options={OPERATOR_OPTIONS} />
          </div>
          <div className='flex-1'>
            <FieldLabel>
              Threshold{selectedDef ? ` (${unitSuffix(selectedDef.unit) || selectedDef.unit})` : ''}
            </FieldLabel>
            <TextInput
              type='number'
              value={threshold}
              placeholder='0'
              onChange={(e) => setThreshold(e.target.value)}
            />
          </div>
        </div>

        <div>
          <FieldLabel>Check Frequency</FieldLabel>
          <SelectInput
            value={frequency}
            onChange={setFrequency}
            options={[
              { label: 'Hourly', value: 'hourly' },
              { label: 'Daily', value: 'daily' },
              { label: 'Weekly', value: 'weekly' }
            ]}
          />
        </div>

        {(selectedDef?.supported_filters?.length ?? 0) > 0 && (
          <div className='space-y-3 border-t border-slate-100 pt-3 dark:border-border/60'>
            <p className='text-[11px] font-medium uppercase tracking-wide text-slate-400'>
              Scope (leave blank for all)
            </p>
            {selectedDef!.supported_filters!.map((spec) => (
              <div key={spec.key}>
                <FieldLabel>{spec.label ?? spec.key}</FieldLabel>
                <ScopeMultiSelect
                  spec={spec}
                  values={filters[spec.key] ?? []}
                  onChange={(v) => setFilters((f) => ({ ...f, [spec.key]: v }))}
                />
              </div>
            ))}
          </div>
        )}

        <div className='flex items-center justify-between rounded-md border border-slate-200 px-3 py-2.5 dark:border-border'>
          <div>
            <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
              Share with team
            </p>
            <p className='text-[11px] text-slate-400'>Allow others to subscribe to this rule</p>
          </div>
          <ToggleSwitch checked={isShared} onChange={setIsShared} />
        </div>

        {editRule && (
          <div>
            <FieldLabel>Status</FieldLabel>
            <SelectInput
              value={status}
              onChange={setStatus}
              options={[
                { label: 'Active', value: 'active' },
                { label: 'Paused', value: 'paused' },
                { label: 'Archived', value: 'archived' }
              ]}
            />
          </div>
        )}
      </div>
    </AlertSheet>
  )
}

// ─── Record/workflow notification subscription editor ─────────────────────────

export interface NotifSubEditable {
  id: number
  label: string | null
  collection: string | null
  event_type: string
  digest_frequency: string | null
  is_active: boolean
  filter_field?: string | null
  filter_value?: string | null
  filters?: Array<{ field: string; op?: string; value?: unknown }> | null
  queue_id?: string | null
}

export function NotifSubEditDrawer({
  open,
  sub,
  onClose,
  onSave,
  saving
}: {
  open: boolean
  sub: NotifSubEditable | null
  onClose: () => void
  /** PATCH payload — label / filter_field / filter_value / filters /
   *  digest_frequency / is_active (event_type + collection are create-time). */
  onSave: (patch: Record<string, unknown>) => void
  saving: boolean
}) {
  const [label, setLabel] = useState('')
  const [filterField, setFilterField] = useState('')
  const [filterValue, setFilterValue] = useState('')
  const [filtersText, setFiltersText] = useState('')
  const [filtersError, setFiltersError] = useState(false)
  const [digest, setDigest] = useState('instant')
  const [active, setActive] = useState(true)

  useEffect(() => {
    if (!open || !sub) return
    setLabel(sub.label ?? '')
    setFilterField(sub.filter_field ?? '')
    setFilterValue(sub.filter_value ?? '')
    setFiltersText(sub.filters?.length ? JSON.stringify(sub.filters, null, 2) : '')
    setFiltersError(false)
    setDigest(sub.digest_frequency ?? 'instant')
    setActive(sub.is_active !== false)
  }, [open, sub])

  if (!sub) return null
  const isQueue = !!sub.queue_id

  const save = () => {
    let filters: unknown = null
    if (filtersText.trim()) {
      try {
        const parsed = JSON.parse(filtersText)
        if (!Array.isArray(parsed)) throw new Error('not an array')
        filters = parsed
      } catch {
        setFiltersError(true)
        return
      }
    }
    onSave({
      label: label.trim() || null,
      ...(isQueue
        ? {}
        : {
            filter_field: filterField.trim() || null,
            filter_value: filterValue.trim() || null,
            filters
          }),
      digest_frequency: digest,
      is_active: active
    })
  }

  return (
    <AlertSheet
      open={open}
      title='Edit Notification Subscription'
      onClose={onClose}
      footer={
        <>
          <button type='button' className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type='button' className={btnPrimary} disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </>
      }
    >
      <div className='space-y-4'>
        <div className='rounded-md border border-slate-200 px-3 py-2 text-[12px] text-slate-500 dark:border-border dark:text-slate-400'>
          <p>
            <span className='font-medium text-slate-700 dark:text-slate-200'>
              {isQueue ? 'Queue digest' : (sub.collection ?? '—').replace(/_/g, ' ')}
            </span>{' '}
            · event: <span className='capitalize'>{sub.event_type.replace(/_/g, ' ')}</span>
          </p>
          <p className='mt-0.5 text-[11px]'>
            Collection and event type are fixed at creation — remove and re-subscribe to change
            them.
          </p>
        </div>

        <div>
          <FieldLabel>Label</FieldLabel>
          <TextInput
            value={label}
            placeholder='Optional display name'
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        {!isQueue && (
          <>
            <div className='flex gap-3'>
              <div className='flex-1'>
                <FieldLabel>
                  {sub.event_type === 'workflow_transition' ? 'State filter field' : 'Filter field'}
                </FieldLabel>
                <TextInput
                  value={filterField}
                  placeholder={
                    sub.event_type === 'workflow_transition' ? 'to_state' : 'e.g. status'
                  }
                  onChange={(e) => setFilterField(e.target.value)}
                />
              </div>
              <div className='flex-1'>
                <FieldLabel>Filter value</FieldLabel>
                <TextInput
                  value={filterValue}
                  placeholder={
                    sub.event_type === 'workflow_transition' ? 'state key (blank = all)' : 'value'
                  }
                  onChange={(e) => setFilterValue(e.target.value)}
                />
              </div>
            </div>
            <div>
              <FieldLabel>Advanced filters (JSON)</FieldLabel>
              <textarea
                value={filtersText}
                onChange={(e) => {
                  setFiltersText(e.target.value)
                  setFiltersError(false)
                }}
                rows={5}
                spellCheck={false}
                placeholder={'[{"field": "division", "op": "in", "value": [1, 2]}]'}
                className={`w-full rounded-md border bg-white p-2 font-mono text-[11px] leading-relaxed text-slate-700 outline-none focus:border-nvr-cyan dark:bg-card dark:text-slate-300 ${
                  filtersError ? 'border-red-400' : 'border-slate-200 dark:border-border'
                }`}
              />
              <p className='mt-1 text-[11px] text-slate-400'>
                AND-evaluated against the record — field = column, dotted M2O path, or M2M alias;
                ops: eq, in, intersects, null, nnull.{' '}
                {filtersError && <span className='text-red-500'>Invalid JSON array.</span>}
              </p>
            </div>
          </>
        )}

        <div>
          <FieldLabel>Digest</FieldLabel>
          <SelectInput
            value={digest}
            onChange={setDigest}
            options={[
              ...(isQueue ? [] : [{ label: 'Instant', value: 'instant' }]),
              { label: 'Daily', value: 'daily' },
              { label: 'Weekly', value: 'weekly' }
            ]}
          />
        </div>

        <div className='flex items-center justify-between rounded-md border border-slate-200 px-3 py-2.5 dark:border-border'>
          <div>
            <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>Active</p>
            <p className='text-[11px] text-slate-400'>Pause instead of deleting to keep the setup</p>
          </div>
          <ToggleSwitch checked={active} onChange={setActive} />
        </div>
      </div>
    </AlertSheet>
  )
}

// ─── Anomaly rule drawer ──────────────────────────────────────────────────────

export function AnomalyRuleDrawer({
  open,
  definitions,
  editRule,
  onClose,
  onSave,
  saving
}: {
  open: boolean
  definitions: AnomalyDefinition[]
  editRule: AnomalyRule | null
  onClose: () => void
  onSave: (values: Record<string, unknown>) => void
  saving: boolean
}) {
  const [name, setName] = useState('')
  const [definitionId, setDefinitionId] = useState<number | ''>('')
  const [sensitivity, setSensitivity] = useState('medium')
  const [frequency, setFrequency] = useState('daily')
  const [status, setStatus] = useState('active')
  const [inApp, setInApp] = useState(true)
  const [email, setEmail] = useState(false)
  const [scopes, setScopes] = useState<Record<string, Array<string | number>>>({})

  useEffect(() => {
    if (!open) return
    if (editRule) {
      setName(editRule.name)
      setDefinitionId(editRule.definition_id)
      setSensitivity(editRule.sensitivity ?? 'medium')
      setFrequency(editRule.check_frequency ?? 'daily')
      setStatus(editRule.status ?? 'active')
      setInApp(editRule.delivery_in_app !== false)
      setEmail(!!editRule.delivery_email)
      setScopes(editRule.scopes ?? {})
    } else {
      setName('')
      setDefinitionId('')
      setSensitivity('medium')
      setFrequency('daily')
      setStatus('active')
      setInApp(true)
      setEmail(false)
      setScopes({})
    }
  }, [open, editRule])

  const selectedDef = definitions.find((d) => d.id === definitionId)
  const hint = selectedDef?.sensitivity_hints?.[sensitivity] ?? null
  const valid = name.trim() && definitionId !== ''

  return (
    <AlertSheet
      open={open}
      title={editRule ? 'Edit Anomaly Rule' : 'New Anomaly Rule'}
      onClose={onClose}
      footer={
        <>
          <button type='button' className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button
            type='button'
            className={btnPrimary}
            disabled={!valid || saving}
            onClick={() =>
              onSave({
                name: name.trim(),
                definition_id: definitionId,
                sensitivity,
                check_frequency: frequency,
                status,
                delivery_in_app: inApp,
                delivery_email: email,
                scopes: Object.fromEntries(Object.entries(scopes).filter(([, v]) => v.length > 0))
              })
            }
          >
            {saving ? 'Saving…' : editRule ? 'Save Changes' : 'Create Rule'}
          </button>
        </>
      }
    >
      <div className='space-y-4'>
        <div>
          <FieldLabel>Rule Name</FieldLabel>
          <TextInput
            value={name}
            placeholder='e.g. High-value vendor outliers'
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <FieldLabel>Anomaly Type</FieldLabel>
          <SelectInput
            value={definitionId === '' ? '' : String(definitionId)}
            onChange={(v) => setDefinitionId(Number(v))}
            options={[
              { label: 'Select type…', value: '' },
              ...definitions.map((d) => ({ label: d.name, value: String(d.id) }))
            ]}
          />
          {selectedDef?.description && (
            <p className='mt-1 text-[11.5px] text-slate-400'>{selectedDef.description}</p>
          )}
        </div>

        <div>
          <FieldLabel>Sensitivity</FieldLabel>
          <SelectInput
            value={sensitivity}
            onChange={setSensitivity}
            options={[
              { label: 'Low — only extreme anomalies', value: 'low' },
              { label: 'Medium — standard detection (recommended)', value: 'medium' },
              { label: 'High — sensitive, more alerts', value: 'high' }
            ]}
          />
          {hint && <p className='mt-1 text-[11.5px] text-slate-400'>{hint}</p>}
        </div>

        {(selectedDef?.scope_options?.length ?? 0) > 0 && (
          <div className='space-y-3 border-t border-slate-100 pt-3 dark:border-border/60'>
            <p className='text-[11px] font-medium uppercase tracking-wide text-slate-400'>
              Scope (leave blank for all)
            </p>
            {selectedDef!.scope_options!.map((spec) => (
              <div key={spec.key}>
                <FieldLabel>{spec.label ?? spec.key}</FieldLabel>
                <ScopeMultiSelect
                  spec={spec}
                  values={scopes[spec.key] ?? []}
                  onChange={(v) => setScopes((s) => ({ ...s, [spec.key]: v }))}
                />
              </div>
            ))}
          </div>
        )}

        <div className='border-t border-slate-100 pt-3 dark:border-border/60'>
          <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
            Schedule &amp; Delivery
          </p>
          <div className='space-y-3'>
            <div>
              <FieldLabel>Check Frequency</FieldLabel>
              <SelectInput
                value={frequency}
                onChange={setFrequency}
                options={[
                  { label: 'Daily', value: 'daily' },
                  { label: 'Weekly', value: 'weekly' }
                ]}
              />
            </div>
            <div>
              <FieldLabel>Status</FieldLabel>
              <SelectInput
                value={status}
                onChange={setStatus}
                options={[
                  { label: 'Active', value: 'active' },
                  { label: 'Paused', value: 'paused' }
                ]}
              />
            </div>
            <div className='flex items-center gap-6 pt-1'>
              <label className='flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
                <ToggleSwitch checked={inApp} onChange={setInApp} /> In-app notification
              </label>
              <label className='flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
                <ToggleSwitch checked={email} onChange={setEmail} /> Email notification
              </label>
            </div>
          </div>
        </div>
      </div>
    </AlertSheet>
  )
}
