import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { CollectionFieldPicker } from '@/components/field-picker'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

type RuleType = 'not_null' | 'regex' | 'range' | 'unique' | 'formula'
type Severity = 'low' | 'medium' | 'high' | 'critical'

interface FormulaCondition {
  field: string
  op: string
  value: string
}

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

interface CollectionField {
  field: string
  type: string
  hidden?: boolean
}

const RULE_TYPES: { value: RuleType; label: string }[] = [
  { value: 'not_null', label: 'Not null / not empty' },
  { value: 'regex', label: 'Regex match' },
  { value: 'range', label: 'Numeric range' },
  { value: 'unique', label: 'Unique values' },
  { value: 'formula', label: 'Formula (conditions)' }
]

const SEVERITIES: { value: Severity; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' }
]

const CONDITION_OPS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'contains', label: 'contains' },
  { value: 'null', label: 'is null' },
  { value: 'nnull', label: 'is not null' }
]

const SEVERITY_BADGE: Record<string, string> = {
  low: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
  medium: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
  high: 'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20',
  critical: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20'
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize',
        SEVERITY_BADGE[severity] ?? SEVERITY_BADGE.medium
      )}
    >
      {severity}
    </span>
  )
}

// ─── Combobox (shadcn Popover + Command) ─────────────────────────────────────

function MonCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className={cn('h-8 w-full justify-between px-2 text-[12px] font-normal', className)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Rule form ───────────────────────────────────────────────────────────────

interface RuleFormData {
  name: string
  rule_type: RuleType
  field: string
  severity: Severity
  is_active: boolean
  pattern: string
  min: string
  max: string
  conditions: FormulaCondition[]
}

function ruleToForm(rule?: DqRule): RuleFormData {
  const cfg = rule?.config ?? {}
  return {
    name: rule?.name ?? '',
    rule_type: rule?.rule_type ?? 'not_null',
    field: rule?.field ?? '',
    severity: rule?.severity ?? 'medium',
    is_active: rule?.is_active ?? true,
    pattern: typeof cfg.pattern === 'string' ? cfg.pattern : '',
    min: cfg.min != null ? String(cfg.min) : '',
    max: cfg.max != null ? String(cfg.max) : '',
    conditions: Array.isArray(cfg.conditions)
      ? (cfg.conditions as FormulaCondition[]).map((c) => ({
          field: c.field ?? '',
          op: c.op ?? 'eq',
          value: c.value != null ? String(c.value) : ''
        }))
      : []
  }
}

function buildPayload(form: RuleFormData) {
  let config: Record<string, unknown> | null = null
  if (form.rule_type === 'regex') config = { pattern: form.pattern }
  if (form.rule_type === 'range') {
    config = {}
    if (form.min !== '') config.min = Number(form.min)
    if (form.max !== '') config.max = Number(form.max)
  }
  if (form.rule_type === 'formula') {
    config = {
      conditions: form.conditions.map((c) => ({
        field: c.field,
        op: c.op,
        value: c.op === 'null' || c.op === 'nnull' ? undefined : c.value
      }))
    }
  }
  return {
    name: form.name.trim(),
    rule_type: form.rule_type,
    field: form.rule_type === 'formula' ? null : form.field || null,
    config,
    severity: form.severity,
    is_active: form.is_active
  }
}

function RuleForm({
  initial,
  collection,
  onSave,
  onCancel,
  saving
}: {
  initial?: DqRule
  collection: string
  onSave: (payload: ReturnType<typeof buildPayload>) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<RuleFormData>(() => ruleToForm(initial))

  function set<K extends keyof RuleFormData>(key: K, value: RuleFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }
  const needsField = form.rule_type !== 'formula'
  const isValid =
    form.name.trim() !== '' &&
    (!needsField || form.field !== '') &&
    (form.rule_type !== 'regex' || form.pattern.trim() !== '') &&
    (form.rule_type !== 'range' || form.min !== '' || form.max !== '') &&
    (form.rule_type !== 'formula' ||
      (form.conditions.length > 0 && form.conditions.every((c) => c.field && c.op)))

  return (
    <div className='space-y-3 border-b border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/30'>
      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500'>Name</Label>
        <Input
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder='e.g. Email format'
          className='h-8 text-[12px]'
        />
      </div>

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500'>Rule type</Label>
        <MonCombobox
          value={form.rule_type}
          onChange={(v) => v && set('rule_type', v as RuleType)}
          options={RULE_TYPES}
        />
      </div>

      {needsField && (
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Field</Label>
          <CollectionFieldPicker
            collection={collection}
            value={form.field}
            onChange={(p) => set('field', p.path.join('.'))}
            onClear={() => set('field', '')}
            placeholder='Select field…'
          />
        </div>
      )}

      {form.rule_type === 'regex' && (
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Pattern</Label>
          <Input
            value={form.pattern}
            onChange={(e) => set('pattern', e.target.value)}
            placeholder='^[^@]+@[^@]+$'
            className='h-8 font-mono text-[12px]'
          />
        </div>
      )}

      {form.rule_type === 'range' && (
        <div className='grid grid-cols-2 gap-2'>
          <div className='space-y-1'>
            <Label className='text-[11px] text-slate-500'>Min</Label>
            <Input
              type='number'
              value={form.min}
              onChange={(e) => set('min', e.target.value)}
              className='h-8 text-[12px]'
            />
          </div>
          <div className='space-y-1'>
            <Label className='text-[11px] text-slate-500'>Max</Label>
            <Input
              type='number'
              value={form.max}
              onChange={(e) => set('max', e.target.value)}
              className='h-8 text-[12px]'
            />
          </div>
        </div>
      )}

      {form.rule_type === 'formula' && (
        <div className='space-y-2'>
          <Label className='text-[11px] text-slate-500'>
            Conditions — rows matching ALL conditions fail
          </Label>
          {form.conditions.map((cond, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: condition rows keyed by position
            <div key={`cond-${idx}-${cond.field}`} className='flex items-start gap-1.5'>
              <div className='flex-1 space-y-1.5'>
                <CollectionFieldPicker
                  collection={collection}
                  value={cond.field}
                  onChange={(p) =>
                    set(
                      'conditions',
                      form.conditions.map((c, i) =>
                        i === idx ? { ...c, field: p.path.join('.') } : c
                      )
                    )
                  }
                  onClear={() =>
                    set(
                      'conditions',
                      form.conditions.map((c, i) => (i === idx ? { ...c, field: '' } : c))
                    )
                  }
                  placeholder='Field…'
                />
                <div className='flex gap-1.5'>
                  <MonCombobox
                    value={cond.op}
                    onChange={(v) =>
                      v &&
                      set(
                        'conditions',
                        form.conditions.map((c, i) => (i === idx ? { ...c, op: v } : c))
                      )
                    }
                    options={CONDITION_OPS}
                    className='w-28'
                  />
                  {cond.op !== 'null' && cond.op !== 'nnull' && (
                    <Input
                      value={cond.value}
                      onChange={(e) =>
                        set(
                          'conditions',
                          form.conditions.map((c, i) =>
                            i === idx ? { ...c, value: e.target.value } : c
                          )
                        )
                      }
                      placeholder='Value'
                      className='h-8 flex-1 text-[12px]'
                    />
                  )}
                </div>
              </div>
              <Button
                variant='ghost'
                size='icon'
                className='h-8 w-8 shrink-0'
                onClick={() =>
                  set(
                    'conditions',
                    form.conditions.filter((_, i) => i !== idx)
                  )
                }
              >
                <X className='h-3.5 w-3.5' />
              </Button>
            </div>
          ))}
          <Button
            variant='outline'
            size='sm'
            className='h-7 text-[11px]'
            onClick={() =>
              set('conditions', [...form.conditions, { field: '', op: 'eq', value: '' }])
            }
          >
            <Plus className='mr-1 h-3 w-3' />
            Add condition
          </Button>
        </div>
      )}

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500'>Severity</Label>
        <MonCombobox
          value={form.severity}
          onChange={(v) => v && set('severity', v as Severity)}
          options={SEVERITIES}
        />
      </div>

      <div className='flex items-center justify-between'>
        <span className='text-[12px] font-medium'>Active</span>
        <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} />
      </div>

      <div className='flex justify-end gap-2 pt-1'>
        <Button variant='outline' size='sm' className='h-7 text-[11px]' onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size='sm'
          className='h-7 text-[11px]'
          disabled={saving || !isValid}
          onClick={() => onSave(buildPayload(form))}
        >
          {saving ? 'Saving…' : 'Save rule'}
        </Button>
      </div>
    </div>
  )
}

// ─── Run results ─────────────────────────────────────────────────────────────

function RunResults({ run, collection }: { run: DqRun; collection: string }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  function toggle(ruleId: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(ruleId)) next.delete(ruleId)
      else next.add(ruleId)
      return next
    })
  }

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-border'>
        <p className='text-[13px] font-medium'>
          Run #{run.id} · {formatRelative(run.started_at)}
        </p>
        <p className='text-[11px] text-muted-foreground'>
          {run.total_records ?? 0} records · {run.failed_records ?? 0} failures
        </p>
      </div>
      <table className='w-full'>
        <thead>
          <tr className='border-b border-slate-200 text-left text-[11px] text-muted-foreground dark:border-border'>
            <th className='px-4 py-2 font-medium'>Rule</th>
            <th className='w-24 px-2 py-2 font-medium'>Severity</th>
            <th className='w-24 px-2 py-2 text-right font-medium'>Failed</th>
            <th className='w-10 px-2 py-2' />
          </tr>
        </thead>
        <tbody>
          {run.results.map((r) => {
            const isOpen = expanded.has(r.rule_id)
            return (
              <RunResultRow
                key={r.rule_id}
                result={r}
                collection={collection}
                isOpen={isOpen}
                onToggle={() => toggle(r.rule_id)}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function RunResultRow({
  result,
  collection,
  isOpen,
  onToggle
}: {
  result: RuleResult
  collection: string
  isOpen: boolean
  onToggle: () => void
}) {
  const canExpand = result.sample_ids.length > 0
  return (
    <>
      <tr
        className={cn(
          'border-b border-slate-100 text-[12px] dark:border-border/50',
          canExpand && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-muted/40'
        )}
        onClick={canExpand ? onToggle : undefined}
      >
        <td className='px-4 py-2.5'>
          <span className='font-medium'>{result.name}</span>
          <span className='ml-2 text-[11px] text-muted-foreground'>
            {result.rule_type}
            {result.field ? ` · ${result.field}` : ''}
          </span>
          {result.error && (
            <span className='ml-2 text-[11px] text-red-600 dark:text-red-400'>{result.error}</span>
          )}
        </td>
        <td className='px-2 py-2.5'>
          <SeverityBadge severity={result.severity} />
        </td>
        <td
          className={cn(
            'px-2 py-2.5 text-right font-medium',
            result.failed_count > 0
              ? 'text-red-600 dark:text-red-400'
              : 'text-green-600 dark:text-green-400'
          )}
        >
          {result.failed_count}
        </td>
        <td className='px-2 py-2.5 text-center'>
          {canExpand &&
            (isOpen ? (
              <ChevronDown className='inline h-3.5 w-3.5 text-muted-foreground' />
            ) : (
              <ChevronRight className='inline h-3.5 w-3.5 text-muted-foreground' />
            ))}
        </td>
      </tr>
      {isOpen && (
        <tr className='border-b border-slate-100 dark:border-border/50'>
          <td colSpan={4} className='bg-slate-50 px-4 py-2.5 dark:bg-muted/30'>
            <p className='mb-1.5 text-[11px] text-muted-foreground'>
              Sample failing records (up to 20)
            </p>
            <div className='flex flex-wrap gap-1.5'>
              {result.sample_ids.map((id) => (
                <Link
                  key={String(id)}
                  to={`/collections/${collection}/${id}`}
                  className='rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-[11px] text-nvr-navy hover:border-nvr-cyan dark:border-border dark:bg-card dark:text-nvr-cyan'
                >
                  {String(id)}
                </Link>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function DataQualityPage() {
  const qc = useQueryClient()
  const [collection, setCollection] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)

  const { data: collections = [] } = useQuery({
    queryKey: ['collections'],
    queryFn: () =>
      api.get<{ data: { collection: string }[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () =>
      api
        .get<{ data: { fields: CollectionField[] } }>(`/collections/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })
  const fields = (colMeta?.fields ?? []).filter((f) => !f.hidden)

  const { data: rules = [] } = useQuery<DqRule[]>({
    queryKey: ['dq-rules', collection],
    queryFn: () =>
      api
        .get<{ data: DqRule[] }>(`/data-quality/rules?collection=${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection
  })

  const { data: runs = [] } = useQuery<DqRun[]>({
    queryKey: ['dq-runs', collection],
    queryFn: () =>
      api
        .get<{ data: DqRun[] }>(`/data-quality/runs?collection=${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection
  })

  const createMut = useMutation({
    mutationFn: (body: object) => api.post('/data-quality/rules', { ...body, collection }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dq-rules', collection] })
      setAdding(false)
      toast.success('Rule created')
    },
    onError: () => toast.error('Failed to create rule')
  })

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: object }) =>
      api.patch(`/data-quality/rules/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dq-rules', collection] })
      setEditingId(null)
      toast.success('Rule updated')
    },
    onError: () => toast.error('Failed to update rule')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/data-quality/rules/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dq-rules', collection] })
      toast.success('Rule deleted')
    },
    onError: () => toast.error('Failed to delete rule')
  })

  const runMut = useMutation({
    mutationFn: () => api.post<{ data: DqRun }>(`/data-quality/run/${collection}`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['dq-runs', collection] })
      setSelectedRunId(res.data.data.id)
      toast.success('Inspection complete')
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Inspection failed')
  })

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null
  const activeRuleCount = rules.filter((r) => r.is_active).length

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-border'>
        <div className='flex items-center gap-2.5'>
          <ShieldCheck className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Data Quality</h1>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left: collection + rules */}
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='space-y-1 border-b border-slate-200 p-3 dark:border-border'>
            <Label className='text-[11px] text-slate-500'>Collection</Label>
            <MonCombobox
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
              className='font-mono'
            />
          </div>

          {collection && (
            <>
              <div className='flex items-center justify-between px-3 py-2.5'>
                <span className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
                  Rules ({rules.length})
                </span>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-6 w-6'
                  onClick={() => {
                    setAdding(true)
                    setEditingId(null)
                  }}
                >
                  <Plus className='h-3.5 w-3.5' />
                </Button>
              </div>

              {adding && (
                <RuleForm
                  collection={collection}
                  onSave={(payload) => createMut.mutate(payload)}
                  onCancel={() => setAdding(false)}
                  saving={createMut.isPending}
                />
              )}

              <ul>
                {rules.map((rule) =>
                  editingId === rule.id ? (
                    <li key={rule.id}>
                      <RuleForm
                        initial={rule}
                        collection={collection}
                        onSave={(payload) => updateMut.mutate({ id: rule.id, body: payload })}
                        onCancel={() => setEditingId(null)}
                        saving={updateMut.isPending}
                      />
                    </li>
                  ) : (
                    <li
                      key={rule.id}
                      className='group flex items-center gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-border/50'
                    >
                      <div className='min-w-0 flex-1'>
                        <p
                          className={cn(
                            'truncate text-[12px] font-medium',
                            !rule.is_active && 'text-muted-foreground line-through'
                          )}
                        >
                          {rule.name}
                        </p>
                        <p className='truncate font-mono text-[10px] text-muted-foreground'>
                          {rule.rule_type}
                          {rule.field ? ` · ${rule.field}` : ''}
                        </p>
                      </div>
                      <SeverityBadge severity={rule.severity} />
                      <div className='hidden shrink-0 items-center group-hover:flex'>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-6 w-6'
                          onClick={() => {
                            setEditingId(rule.id)
                            setAdding(false)
                          }}
                        >
                          <Pencil className='h-3 w-3' />
                        </Button>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-6 w-6 text-destructive'
                          onClick={() => deleteMut.mutate(rule.id)}
                        >
                          <Trash2 className='h-3 w-3' />
                        </Button>
                      </div>
                    </li>
                  )
                )}
              </ul>

              {rules.length === 0 && !adding && (
                <p className='px-3 py-6 text-center text-[12px] text-muted-foreground'>
                  No rules yet. Add one to start inspecting.
                </p>
              )}
            </>
          )}
        </aside>

        {/* Right: run + results */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {!collection ? (
            <div className='flex h-full flex-col items-center justify-center text-center'>
              <ShieldCheck className='mb-3 h-10 w-10 text-muted-foreground/40' />
              <p className='mb-1 text-sm font-medium'>Select a collection</p>
              <p className='text-xs text-muted-foreground'>
                Define quality rules, then run an inspection to find failing records.
              </p>
            </div>
          ) : (
            <div className='space-y-6 p-6'>
              <div className='flex items-center justify-between'>
                <div>
                  <p className='font-mono text-[14px] font-semibold'>{collection}</p>
                  <p className='text-[11px] text-muted-foreground'>
                    {activeRuleCount} active rule{activeRuleCount === 1 ? '' : 's'}
                  </p>
                </div>
                <Button
                  size='sm'
                  disabled={runMut.isPending || activeRuleCount === 0}
                  onClick={() => runMut.mutate()}
                >
                  <Play className='mr-1.5 h-3.5 w-3.5' />
                  {runMut.isPending ? 'Running…' : 'Run inspection'}
                </Button>
              </div>

              {selectedRun ? (
                <RunResults run={selectedRun} collection={collection} />
              ) : (
                <div className='rounded-lg border border-dashed border-slate-300 py-12 text-center dark:border-border'>
                  <p className='text-[12px] text-muted-foreground'>
                    No inspections yet — run one to see results.
                  </p>
                </div>
              )}

              {runs.length > 0 && (
                <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  <p className='border-b border-slate-200 px-4 py-3 text-[13px] font-medium dark:border-border'>
                    Run history
                  </p>
                  <ul>
                    {runs.map((run) => (
                      <li key={run.id}>
                        <button
                          type='button'
                          onClick={() => setSelectedRunId(run.id)}
                          className={cn(
                            'flex w-full items-center justify-between px-4 py-2.5 text-left text-[12px] transition-colors',
                            selectedRun?.id === run.id
                              ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/[0.07]'
                              : 'hover:bg-slate-50 dark:hover:bg-muted/40'
                          )}
                        >
                          <span className='font-medium'>Run #{run.id}</span>
                          <span className='text-muted-foreground'>
                            {formatRelative(run.started_at)}
                          </span>
                          <span
                            className={cn(
                              'font-medium',
                              (run.failed_records ?? 0) > 0
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-green-600 dark:text-green-400'
                            )}
                          >
                            {run.failed_records ?? 0} failures
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
