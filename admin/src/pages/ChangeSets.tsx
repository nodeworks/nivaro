import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  ClipboardList,
  Loader2,
  Play,
  Plus,
  Search,
  Trash2,
  XCircle
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Schema change sets (#653) — build a batch of typed schema operations,
 * preview per-op validation + impact, then apply with a typed confirm.
 */

type OpType = 'add_collection' | 'add_column' | 'drop_column' | 'rename_column'

const COLUMN_TYPES = [
  'string',
  'text',
  'integer',
  'bigInteger',
  'boolean',
  'decimal',
  'float',
  'date',
  'datetime',
  'uuid'
] as const

interface OpDraft {
  key: number
  op: OpType
  collection: string
  field: string
  new_name: string
  type: string
  nullable: boolean
}

interface ImpactSurface {
  surface: string
  hits: Array<{ surface: string; ref: string; detail?: string }>
}

interface PlanEntry {
  op: Record<string, unknown>
  status: 'ok' | 'warning' | 'blocked'
  messages: string[]
  impact: { total: number; surfaces: ImpactSurface[] } | null
}

interface PlanResult {
  operations: PlanEntry[]
  blocked: number
  warnings: number
  can_apply: boolean
}

interface ApplyResult {
  applied: number
  failed: number
  not_attempted: number
  results: Array<{ op: Record<string, unknown>; status: string; error?: string }>
}

const OP_LABELS: Record<OpType, string> = {
  add_collection: 'Add collection',
  add_column: 'Add column',
  drop_column: 'Drop column',
  rename_column: 'Rename column'
}

function describeOp(op: Record<string, unknown>): string {
  const kind = String(op.op)
  const c = String(op.collection ?? '')
  switch (kind) {
    case 'add_collection':
      return `Add collection ${c}`
    case 'add_column':
      return `Add ${String(op.type)} column ${c}.${String(op.field)}`
    case 'drop_column':
      return `Drop column ${c}.${String(op.field)}`
    case 'rename_column':
      return `Rename ${c}.${String(op.field)} → ${String(op.new_name)}`
    default:
      return kind
  }
}

function CollectionCombobox({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || 'Collection…'}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === opt ? 'opacity-100' : 'opacity-0')}
                  />
                  {opt}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

let nextKey = 1

export function ChangeSetsPage() {
  const [ops, setOps] = useState<OpDraft[]>([])
  const [confirmText, setConfirmText] = useState('')

  const { data: collections = [] } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string }> }>('/collections?tables_only=true')
        .then((r) => r.data.data)
  })
  const collectionNames = collections
    .map((c) => c.collection)
    .filter((c) => !c.startsWith('nivaro_'))

  function toPayload() {
    return ops.map((o): Record<string, unknown> => {
      if (o.op === 'add_collection') return { op: o.op, collection: o.collection }
      if (o.op === 'add_column') {
        return {
          op: o.op,
          collection: o.collection,
          field: o.field,
          type: o.type,
          options: { nullable: o.nullable }
        }
      }
      if (o.op === 'rename_column') {
        return { op: o.op, collection: o.collection, field: o.field, new_name: o.new_name }
      }
      return { op: o.op, collection: o.collection, field: o.field }
    })
  }

  const planMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: PlanResult }>('/change-sets/plan', { operations: toPayload() })
        .then((r) => r.data.data),
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Preview failed')
    }
  })

  const applyMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: ApplyResult }>('/change-sets/apply', { operations: toPayload() })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      if (data.failed > 0) toast.error(`Stopped after failure — ${data.applied} applied`)
      else toast.success(`${data.applied} operation(s) applied`)
      setConfirmText('')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Apply failed')
    }
  })

  const addOp = (op: OpType) => {
    setOps((prev) => [
      ...prev,
      {
        key: nextKey++,
        op,
        collection: '',
        field: '',
        new_name: '',
        type: 'string',
        nullable: true
      }
    ])
    planMut.reset()
    applyMut.reset()
  }
  const patchOp = (key: number, patch: Partial<OpDraft>) => {
    setOps((prev) => prev.map((o) => (o.key === key ? { ...o, ...patch } : o)))
    planMut.reset()
    applyMut.reset()
  }
  const removeOp = (key: number) => {
    setOps((prev) => prev.filter((o) => o.key !== key))
    planMut.reset()
    applyMut.reset()
  }

  const incomplete = ops.some(
    (o) =>
      !o.collection ||
      (o.op !== 'add_collection' && !o.field) ||
      (o.op === 'rename_column' && !o.new_name)
  )
  const plan = planMut.data ?? null
  const applied = applyMut.data ?? null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <ClipboardList className='h-4.5 w-4.5 text-nvr-cyan' />
          <div>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Schema Change Sets
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Batch schema edits, reviewed before applying. Operations run in order and stop at the
              first failure — nothing is rolled back, so preview first.
            </p>
          </div>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 flex-col gap-6 overflow-y-auto p-8'>
        {/* Builder */}
        <section className='w-full max-w-3xl rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
          <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
            Operations
          </h2>
          <p className='mb-3 text-[12px] text-muted-foreground'>
            Add typed operations, then preview the impact of the whole set.
          </p>

          <div className='space-y-2'>
            {ops.map((o) => (
              <div
                key={o.key}
                className='flex flex-wrap items-center gap-2 rounded-md border border-slate-100 p-2 dark:border-border'
              >
                <span className='w-[130px] shrink-0 rounded bg-slate-100 px-2 py-1 text-center text-[11px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'>
                  {OP_LABELS[o.op]}
                </span>
                <div className='w-[220px]'>
                  <CollectionCombobox
                    value={o.collection}
                    onChange={(v) => patchOp(o.key, { collection: v })}
                    options={collectionNames}
                  />
                </div>
                {o.op !== 'add_collection' && (
                  <Input
                    value={o.field}
                    onChange={(e) => patchOp(o.key, { field: e.target.value })}
                    placeholder='column'
                    className='h-8 w-[160px] font-mono text-[12px]'
                  />
                )}
                {o.op === 'rename_column' && (
                  <>
                    <span className='text-[12px] text-slate-400'>→</span>
                    <Input
                      value={o.new_name}
                      onChange={(e) => patchOp(o.key, { new_name: e.target.value })}
                      placeholder='new name'
                      className='h-8 w-[160px] font-mono text-[12px]'
                    />
                  </>
                )}
                {o.op === 'add_column' && (
                  <>
                    <Select value={o.type} onValueChange={(v) => patchOp(o.key, { type: v })}>
                      <SelectTrigger className='h-8 w-[130px] text-[12px]'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COLUMN_TYPES.map((t) => (
                          <SelectItem key={t} value={t} className='text-[12px]'>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className='flex items-center gap-1.5 text-[11px] text-slate-500'>
                      <Switch
                        checked={o.nullable}
                        onCheckedChange={(v) => patchOp(o.key, { nullable: v })}
                        aria-label='nullable'
                      />
                      nullable
                    </span>
                  </>
                )}
                <Button
                  size='sm'
                  variant='ghost'
                  className='ml-auto h-7 w-7 p-0 text-slate-400 hover:text-red-500'
                  onClick={() => removeOp(o.key)}
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </Button>
              </div>
            ))}
            {ops.length === 0 && (
              <p className='rounded-md border border-dashed border-slate-200 px-3 py-5 text-center text-[12px] text-slate-400 dark:border-border'>
                No operations yet — add one below.
              </p>
            )}
          </div>

          <div className='mt-3 flex flex-wrap items-center gap-2'>
            {(Object.keys(OP_LABELS) as OpType[]).map((t) => (
              <Button key={t} size='sm' variant='outline' onClick={() => addOp(t)}>
                <Plus className='mr-1 h-3 w-3' />
                {OP_LABELS[t]}
              </Button>
            ))}
            <Button
              size='sm'
              className='ml-auto'
              disabled={ops.length === 0 || incomplete || planMut.isPending}
              onClick={() => planMut.mutate()}
            >
              {planMut.isPending ? (
                <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
              ) : (
                <Search className='mr-1.5 h-3.5 w-3.5' />
              )}
              Preview impact
            </Button>
          </div>
          {incomplete && ops.length > 0 && (
            <p className='mt-2 text-[11px] text-amber-600'>
              Fill in every operation before previewing.
            </p>
          )}
        </section>

        {/* Plan */}
        {plan && (
          <section className='w-full max-w-3xl rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
            <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Preview
            </h2>
            <p className='mb-3 text-[12px] text-muted-foreground'>
              {plan.blocked > 0
                ? `${plan.blocked} operation(s) are blocked — fix them before applying.`
                : plan.warnings > 0
                  ? `${plan.warnings} operation(s) carry warnings — review the affected config.`
                  : 'All operations validate cleanly.'}
            </p>
            <div className='space-y-2'>
              {plan.operations.map((p, i) => (
                <div
                  key={`${i}-${describeOp(p.op)}`}
                  className={cn(
                    'rounded-md border p-3',
                    p.status === 'blocked'
                      ? 'border-red-200 bg-red-50/60 dark:border-red-900/50 dark:bg-red-900/10'
                      : p.status === 'warning'
                        ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-400/10'
                        : 'border-green-200 bg-green-50/50 dark:border-green-900/50 dark:bg-green-900/10'
                  )}
                >
                  <div className='flex items-center gap-2'>
                    {p.status === 'blocked' ? (
                      <XCircle className='h-3.5 w-3.5 shrink-0 text-red-500' />
                    ) : p.status === 'warning' ? (
                      <AlertTriangle className='h-3.5 w-3.5 shrink-0 text-amber-500' />
                    ) : (
                      <CheckCircle2 className='h-3.5 w-3.5 shrink-0 text-green-600' />
                    )}
                    <span className='font-mono text-[12px] font-medium text-slate-800 dark:text-slate-200'>
                      {describeOp(p.op)}
                    </span>
                  </div>
                  {p.messages.length > 0 && (
                    <ul className='mt-1.5 space-y-0.5 pl-6 text-[12px] text-slate-600 dark:text-slate-300'>
                      {p.messages.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  )}
                  {p.impact && p.impact.total > 0 && (
                    <div className='mt-2 pl-6'>
                      {p.impact.surfaces
                        .filter((s) => s.hits.length > 0)
                        .map((s) => (
                          <p key={s.surface} className='text-[11px] text-slate-500'>
                            <span className='font-medium'>{s.surface}:</span>{' '}
                            {s.hits
                              .slice(0, 5)
                              .map((h) => h.ref)
                              .join(', ')}
                            {s.hits.length > 5 && ` +${s.hits.length - 5} more`}
                          </p>
                        ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Apply confirm */}
            {plan.can_apply && !applied && (
              <div className='mt-4 flex items-center gap-2 border-t border-slate-100 pt-4 dark:border-border'>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder='Type APPLY to confirm'
                  className='h-8 w-[200px] text-[12px]'
                />
                <Button
                  size='sm'
                  disabled={confirmText !== 'APPLY' || applyMut.isPending}
                  onClick={() => applyMut.mutate()}
                >
                  {applyMut.isPending ? (
                    <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Play className='mr-1.5 h-3.5 w-3.5' />
                  )}
                  Apply {plan.operations.length} operation(s)
                </Button>
              </div>
            )}
          </section>
        )}

        {/* Results */}
        {applied && (
          <section className='w-full max-w-3xl rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
            <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Results
            </h2>
            <p className='mb-3 text-[12px] text-muted-foreground'>
              {applied.applied} applied · {applied.failed} failed · {applied.not_attempted} not
              attempted
            </p>
            <div className='space-y-1.5'>
              {applied.results.map((r, i) => (
                <div
                  key={`${i}-${describeOp(r.op)}`}
                  className='flex items-start gap-2 text-[12px]'
                >
                  {r.status === 'applied' ? (
                    <CheckCircle2 className='mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600' />
                  ) : r.status === 'failed' ? (
                    <XCircle className='mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500' />
                  ) : (
                    <span className='mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border border-slate-300' />
                  )}
                  <div>
                    <span className='font-mono text-slate-700 dark:text-slate-300'>
                      {describeOp(r.op)}
                    </span>
                    {r.error && <p className='text-[11px] text-red-500'>{r.error}</p>}
                    {r.status === 'not_attempted' && (
                      <p className='text-[11px] text-slate-400'>
                        Not attempted — an earlier operation failed
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
