import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, ChevronsUpDown, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { CollectionFieldPicker } from '@/components/field-picker'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, type Collection } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AlertDefinition {
  id: number
  name: string
  category: string
  collection: string
  field: string
  operator: string
  threshold: number
  unit: string
  cooldown_minutes: number
  is_active: boolean
  filters: Record<string, unknown> | null
  detection_type: 'threshold' | 'anomaly'
  sensitivity: number | null
}

interface FilterRow {
  field: string
  value: string
}

// ─── Options ──────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'budget', label: 'Budget' },
  { value: 'compliance', label: 'Compliance' },
  { value: 'sla', label: 'SLA' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'workflow', label: 'Workflow' }
]

const OPERATORS = [
  { value: 'gt', label: '> Greater than' },
  { value: 'gte', label: '≥ Greater than or equal' },
  { value: 'lt', label: '< Less than' },
  { value: 'lte', label: '≤ Less than or equal' },
  { value: 'eq', label: '= Equal' },
  { value: 'neq', label: '≠ Not equal' },
  { value: 'change_pct', label: '% Δ Percent change' }
]

const UNITS = [
  { value: 'count', label: 'Count' },
  { value: 'percent', label: 'Percent (%)' },
  { value: 'dollar', label: 'Dollar ($)' },
  { value: 'days', label: 'Days' }
]

// ─── Page ─────────────────────────────────────────────────────────────────────

export function AlertEditPage() {
  const { id } = useParams<{ id: string }>()
  const isNew = id === 'new'
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Form state
  const [name, setName] = useState('')
  const [category, setCategory] = useState('general')
  const [collection, setCollection] = useState('')
  const [field, setField] = useState('')
  const [colOpen, setColOpen] = useState(false)
  const [operator, setOperator] = useState('gt')
  const [threshold, setThreshold] = useState<number>(0)
  const [unit, setUnit] = useState('count')
  const [detectionType, setDetectionType] = useState<'threshold' | 'anomaly'>('threshold')
  const [sensitivity, setSensitivity] = useState<number>(2.0)
  const [cooldownMinutes, setCooldownMinutes] = useState<number>(60)
  const [isActive, setIsActive] = useState(true)
  const [filterRows, setFilterRows] = useState<FilterRow[]>([])
  const [initialized, setInitialized] = useState(false)

  // Collections list for the collection picker
  const { data: allCollections = [] } = useQuery<Collection[]>({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data)
  })
  const realCollections = allCollections.filter(
    (c) => !allCollections.some((x) => x.collection === c.group)
  )

  // Load existing definition
  const { data: existing, isLoading } = useQuery<AlertDefinition>({
    queryKey: ['alert-definition', id],
    queryFn: () =>
      api.get<{ data: AlertDefinition }>(`/alerts/definitions/${id}`).then((r) => r.data.data),
    enabled: !isNew
  })

  // Populate form when data loads
  useEffect(() => {
    if (existing && !initialized) {
      setName(existing.name)
      setCategory(existing.category)
      setCollection(existing.collection)
      setField(existing.field)
      setOperator(existing.operator)
      setThreshold(existing.threshold)
      setUnit(existing.unit)
      setCooldownMinutes(existing.cooldown_minutes)
      setIsActive(existing.is_active)
      setDetectionType(existing.detection_type === 'anomaly' ? 'anomaly' : 'threshold')
      setSensitivity(existing.sensitivity ?? 2.0)

      if (existing.filters && typeof existing.filters === 'object') {
        setFilterRows(
          Object.entries(existing.filters).map(([k, v]) => ({
            field: k,
            value: String(v)
          }))
        )
      }

      setInitialized(true)
    }
  }, [existing, initialized])

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: (body: Omit<AlertDefinition, 'id'>) => {
      if (isNew) {
        return api
          .post<{ data: AlertDefinition }>('/alerts/definitions', body)
          .then((r) => r.data.data)
      }
      return api
        .patch<{ data: AlertDefinition }>(`/alerts/definitions/${id}`, body)
        .then((r) => r.data.data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-definitions'] })
      toast.success(isNew ? 'Alert created' : 'Alert saved')
      navigate('/alerts')
    },
    onError: () => toast.error('Failed to save alert')
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    if (!collection.trim()) {
      toast.error('Collection is required')
      return
    }
    if (!field.trim()) {
      toast.error('Field is required')
      return
    }

    // Build filters object from rows
    const validRows = filterRows.filter((r) => r.field.trim())
    const filters =
      validRows.length > 0
        ? Object.fromEntries(validRows.map((r) => [r.field.trim(), r.value]))
        : null

    saveMutation.mutate({
      name: name.trim(),
      category,
      collection: collection.trim(),
      field: field.trim(),
      operator,
      threshold: Number(threshold),
      unit,
      cooldown_minutes: Number(cooldownMinutes),
      is_active: isActive,
      filters,
      detection_type: detectionType,
      sensitivity: detectionType === 'anomaly' ? Number(sensitivity) || 2.0 : null
    })
  }

  function addFilterRow() {
    setFilterRows((prev) => [...prev, { field: '', value: '' }])
  }

  function removeFilterRow(i: number) {
    setFilterRows((prev) => prev.filter((_, idx) => idx !== i))
  }

  function updateFilterRow(i: number, key: keyof FilterRow, value: string) {
    setFilterRows((prev) => prev.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)))
  }

  if (!isNew && isLoading) {
    return (
      <div className='p-6 space-y-4 max-w-2xl'>
        <Skeleton className='h-8 w-48' />
        <Skeleton className='h-96 w-full' />
      </div>
    )
  }

  return (
    <div className='p-6 max-w-2xl space-y-6'>
      {/* Header */}
      <div className='flex items-center gap-3'>
        <Button variant='ghost' size='icon' onClick={() => navigate('/alerts')} className='h-8 w-8'>
          <ArrowLeft className='h-4 w-4' />
        </Button>
        <div>
          <h1 className='text-xl font-semibold tracking-tight'>
            {isNew ? 'New Alert' : `Edit: ${existing?.name ?? ''}`}
          </h1>
          <p className='text-xs text-muted-foreground mt-0.5'>
            Configure threshold conditions and notification settings
          </p>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className='space-y-5'>
        {/* Name */}
        <div className='space-y-1.5'>
          <Label htmlFor='alert-name'>
            Name <span className='text-destructive'>*</span>
          </Label>
          <Input
            id='alert-name'
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Budget overrun alert'
            required
          />
        </div>

        {/* Category */}
        <div className='space-y-1.5'>
          <Label htmlFor='alert-category'>Category</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger id='alert-category'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Collection + Field */}
        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-1.5'>
            <Label>
              Collection <span className='text-destructive'>*</span>
            </Label>
            <Popover open={colOpen} onOpenChange={setColOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  role='combobox'
                  aria-expanded={colOpen}
                  className={cn(
                    'flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-[13px] ring-offset-background',
                    'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    !collection && 'text-muted-foreground'
                  )}
                >
                  {collection ? (
                    <span>
                      {realCollections.find((c) => c.collection === collection)?.display_name ??
                        titleCase(collection)}{' '}
                      <span className='font-mono text-[11px] text-muted-foreground'>
                        ({collection})
                      </span>
                    </span>
                  ) : (
                    'Select collection…'
                  )}
                  <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-[320px] p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search collections…' />
                  <CommandEmpty>No collection found.</CommandEmpty>
                  <CommandGroup className='max-h-60 overflow-y-auto'>
                    {realCollections.map((c) => (
                      <CommandItem
                        key={c.collection}
                        value={c.collection}
                        onSelect={(val) => {
                          setCollection(val)
                          setField('')
                          setColOpen(false)
                        }}
                      >
                        <Check
                          className={cn(
                            'mr-2 h-4 w-4',
                            collection === c.collection ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className='flex-1'>{c.display_name ?? titleCase(c.collection)}</span>
                        <span className='font-mono text-[11px] text-muted-foreground'>
                          {c.collection}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </Command>
              </PopoverContent>
            </Popover>
            <p className='text-xs text-muted-foreground'>Collection to monitor</p>
          </div>
          <div className='space-y-1.5'>
            <Label>
              Field <span className='text-destructive'>*</span>
            </Label>
            {collection ? (
              <CollectionFieldPicker
                collection={collection}
                value={field}
                onChange={(picked) => setField(picked.path.join('.'))}
                onClear={() => setField('')}
                placeholder='Select field…'
              />
            ) : (
              <div className='flex h-9 items-center rounded-md border border-dashed border-slate-200 px-3 text-[13px] text-muted-foreground'>
                Select a collection first
              </div>
            )}
            <p className='text-xs text-muted-foreground'>Numeric field to evaluate</p>
          </div>
        </div>

        {/* Detection type */}
        <div className='space-y-1.5'>
          <Label>Detection type</Label>
          <div className='inline-flex rounded-md border p-0.5'>
            <Button
              type='button'
              size='sm'
              variant={detectionType === 'threshold' ? 'default' : 'ghost'}
              className='h-7 px-3 text-xs'
              onClick={() => setDetectionType('threshold')}
            >
              Threshold
            </Button>
            <Button
              type='button'
              size='sm'
              variant={detectionType === 'anomaly' ? 'default' : 'ghost'}
              className='h-7 px-3 text-xs'
              onClick={() => setDetectionType('anomaly')}
            >
              Anomaly
            </Button>
          </div>
          <p className='text-xs text-muted-foreground'>
            {detectionType === 'threshold'
              ? 'Fire when the field value crosses a fixed threshold'
              : 'Fire when the field value deviates statistically from its recent history'}
          </p>
        </div>

        {/* Threshold mode: Operator + Threshold + Unit */}
        {detectionType === 'threshold' && (
          <div className='grid grid-cols-3 gap-4'>
            <div className='space-y-1.5'>
              <Label htmlFor='alert-operator'>Operator</Label>
              <Select value={operator} onValueChange={setOperator}>
                <SelectTrigger id='alert-operator'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPERATORS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='alert-threshold'>Threshold</Label>
              <Input
                id='alert-threshold'
                type='number'
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                step='any'
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='alert-unit'>Unit</Label>
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger id='alert-unit'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => (
                    <SelectItem key={u.value} value={u.value}>
                      {u.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {/* Anomaly mode: Sensitivity */}
        {detectionType === 'anomaly' && (
          <div className='space-y-1.5'>
            <Label htmlFor='alert-sensitivity'>Sensitivity</Label>
            <Input
              id='alert-sensitivity'
              type='number'
              min={0.5}
              step={0.1}
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
              className='w-40'
            />
            <p className='text-xs text-muted-foreground'>
              Standard deviations from the 90-day mean before a value counts as anomalous (default
              2.0 — lower is more sensitive)
            </p>
          </div>
        )}

        {/* Cooldown */}
        <div className='space-y-1.5'>
          <Label htmlFor='alert-cooldown'>Cooldown (minutes)</Label>
          <Input
            id='alert-cooldown'
            type='number'
            min={1}
            value={cooldownMinutes}
            onChange={(e) => setCooldownMinutes(Number(e.target.value))}
            className='w-40'
          />
          <p className='text-xs text-muted-foreground'>
            Minimum time between repeated alerts for the same item
          </p>
        </div>

        {/* Active */}
        <div className='flex items-center gap-3'>
          <Switch id='alert-active' checked={isActive} onCheckedChange={setIsActive} />
          <Label htmlFor='alert-active' className='cursor-pointer'>
            Active
          </Label>
          <span className='text-xs text-muted-foreground'>
            {isActive ? 'Alert will be evaluated' : 'Alert is paused'}
          </span>
        </div>

        {/* Scope filters */}
        <div className='space-y-2'>
          <div className='flex items-center justify-between'>
            <div>
              <Label>Scope Filters</Label>
              <p className='text-xs text-muted-foreground mt-0.5'>
                Optional field conditions to limit which records are evaluated
              </p>
            </div>
            <Button type='button' variant='outline' size='sm' onClick={addFilterRow}>
              <Plus className='mr-1.5 h-3.5 w-3.5' />
              Add Filter
            </Button>
          </div>

          {filterRows.length > 0 && (
            <div className='rounded-md border divide-y'>
              {filterRows.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: filter rows keyed by index intentionally
                <div key={i} className='flex items-center gap-2 px-3 py-2'>
                  {collection ? (
                    <div className='flex-1'>
                      <CollectionFieldPicker
                        collection={collection}
                        value={row.field}
                        onChange={(picked) => updateFilterRow(i, 'field', picked.path.join('.'))}
                        onClear={() => updateFilterRow(i, 'field', '')}
                        placeholder='Select field…'
                      />
                    </div>
                  ) : (
                    <Input
                      value={row.field}
                      onChange={(e) => updateFilterRow(i, 'field', e.target.value)}
                      placeholder='field name'
                      className='h-8 flex-1 text-sm font-mono'
                    />
                  )}
                  <span className='text-muted-foreground text-xs'>=</span>
                  <Input
                    value={row.value}
                    onChange={(e) => updateFilterRow(i, 'value', e.target.value)}
                    placeholder='value'
                    className='h-8 text-sm'
                  />
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    className='h-7 w-7 text-destructive hover:text-destructive flex-shrink-0'
                    onClick={() => removeFilterRow(i)}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className='flex items-center gap-2 pt-2 border-t'>
          <Button type='submit' disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : isNew ? 'Create Alert' : 'Save Changes'}
          </Button>
          <Button type='button' variant='outline' onClick={() => navigate('/alerts')}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}
