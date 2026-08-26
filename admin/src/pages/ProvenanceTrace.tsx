import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  Check,
  ChevronsUpDown,
  GitBranch,
  Loader2,
  Search,
  Sigma,
  Sparkles,
  Wand2,
  Workflow
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
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
import { api } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'

/**
 * Value provenance trace (#694) — "why does this field hold this value".
 * Pick a collection, record and field; the trace shows how the value can be
 * derived (formulas, rules, auto-ids, transition writebacks) and the actual
 * change timeline mined from revisions.
 */

interface Derivation {
  kind: string
  description: string
  link?: string
}

interface Change {
  when: string | null
  who: string | null
  from: unknown
  to: unknown
  via: string
  action: string
  note: string | null
}

interface Trace {
  collection: string
  id: string
  field: string
  record_exists: boolean
  physical_column: boolean
  current: unknown
  derivations: Derivation[]
  changes: Change[]
}

const VIA_STYLES: Record<string, string> = {
  manual: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300',
  import: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  integration: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  automation: 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300'
}

const KIND_META: Record<string, { label: string; icon: typeof Sigma }> = {
  computed: { label: 'Computed formula', icon: Sigma },
  rollup: { label: 'Rollup aggregate', icon: Sigma },
  field_rule: { label: 'Field rule', icon: Wand2 },
  auto_id: { label: 'Auto-generated id', icon: Sparkles },
  transition_action: { label: 'Workflow transition writeback', icon: Workflow }
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function TraceCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className='h-8 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
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

export function ProvenanceTracePage() {
  const [collection, setCollection] = useState('')
  const [recordId, setRecordId] = useState('')
  const [field, setField] = useState('')

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

  const { data: fields = [] } = useQuery({
    queryKey: ['provenance-fields', collection],
    enabled: !!collection,
    queryFn: () =>
      api
        .get<{ data: Array<{ field: string }> }>(`/field-config/${collection}`)
        .then((r) => r.data.data ?? [])
  })
  const fieldNames = fields
    .map((f) => f.field)
    .filter((f) => f && !f.startsWith('__') && !f.includes('.'))

  const traceMut = useMutation({
    mutationFn: () =>
      api
        .get<{ data: Trace }>(
          `/provenance-trace/${collection}/${encodeURIComponent(recordId.trim())}/${field}`
        )
        .then((r) => r.data.data),
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Trace failed')
    }
  })

  const trace = traceMut.data ?? null
  const ready = !!collection && !!recordId.trim() && !!field

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <GitBranch className='h-4.5 w-4.5 text-nvr-cyan' />
          <div>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Value Provenance
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Why does this field hold this value — how it can be derived, and every actual change
              with who, when and how.
            </p>
          </div>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 flex-col gap-6 overflow-y-auto p-8'>
        {/* Pickers */}
        <section className='w-full max-w-3xl rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
          <div className='flex flex-wrap items-end gap-3'>
            <div className='w-[220px]'>
              <p className='mb-1 text-[11px] font-medium text-slate-500'>Collection</p>
              <TraceCombobox
                value={collection}
                onChange={(v) => {
                  setCollection(v)
                  setField('')
                  traceMut.reset()
                }}
                options={collectionNames}
                placeholder='Collection…'
              />
            </div>
            <div className='w-[160px]'>
              <p className='mb-1 text-[11px] font-medium text-slate-500'>Record ID</p>
              <Input
                value={recordId}
                onChange={(e) => setRecordId(e.target.value)}
                placeholder='id'
                className='h-8 font-mono text-[12px]'
              />
            </div>
            <div className='w-[220px]'>
              <p className='mb-1 text-[11px] font-medium text-slate-500'>Field</p>
              <TraceCombobox
                value={field}
                onChange={(v) => {
                  setField(v)
                  traceMut.reset()
                }}
                options={fieldNames}
                placeholder='Field…'
                disabled={!collection}
              />
            </div>
            <Button
              size='sm'
              disabled={!ready || traceMut.isPending}
              onClick={() => traceMut.mutate()}
            >
              {traceMut.isPending ? (
                <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
              ) : (
                <Search className='mr-1.5 h-3.5 w-3.5' />
              )}
              Trace
            </Button>
          </div>
        </section>

        {trace && (
          <>
            {/* Current value */}
            <section className='w-full max-w-3xl rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
              <p className='text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                Current value
              </p>
              {trace.record_exists ? (
                <p className='mt-1 break-all font-mono text-[14px] text-slate-900 dark:text-foreground'>
                  {trace.physical_column
                    ? fmtValue(trace.current)
                    : '(virtual field — computed at read time)'}
                </p>
              ) : (
                <p className='mt-1 text-[13px] text-red-500'>Record not found</p>
              )}
            </section>

            {/* Derivations */}
            <section className='w-full max-w-3xl'>
              <h2 className='mb-2 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
                How this value is derived
              </h2>
              {trace.derivations.length === 0 ? (
                <p className='rounded-lg border border-slate-200 bg-white px-4 py-3 text-[12px] text-slate-500 dark:border-border dark:bg-card'>
                  No configured derivation — this field only changes when someone (or an
                  integration) writes it directly.
                </p>
              ) : (
                <div className='grid grid-cols-1 gap-2 md:grid-cols-2'>
                  {trace.derivations.map((d, i) => {
                    const meta = KIND_META[d.kind] ?? { label: d.kind, icon: Sigma }
                    const Icon = meta.icon
                    return (
                      <div
                        key={`${d.kind}-${i}`}
                        className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
                      >
                        <div className='flex items-center gap-1.5 text-[11px] font-medium text-nvr-cyan'>
                          <Icon className='h-3.5 w-3.5' />
                          {meta.label}
                        </div>
                        <p className='mt-1 break-words text-[12px] text-slate-600 dark:text-slate-300'>
                          {d.description}
                        </p>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            {/* Timeline */}
            <section className='w-full max-w-3xl'>
              <h2 className='mb-2 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
                Change timeline
              </h2>
              {trace.changes.length === 0 ? (
                <p className='rounded-lg border border-slate-200 bg-white px-4 py-3 text-[12px] text-slate-500 dark:border-border dark:bg-card'>
                  No recorded changes for this field — either it has never changed, or its history
                  predates revision tracking.
                </p>
              ) : (
                <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  {trace.changes.map((c, i) => (
                    <div
                      key={`${c.when}-${i}`}
                      className={cn(
                        'flex flex-wrap items-center gap-2 px-4 py-2.5',
                        i > 0 && 'border-t border-slate-100 dark:border-border'
                      )}
                    >
                      <span className='w-[130px] shrink-0 text-[11px] text-slate-400'>
                        {c.when ? formatDate(c.when) : '—'}
                      </span>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                          VIA_STYLES[c.via] ?? VIA_STYLES.manual
                        )}
                      >
                        {c.via}
                      </span>
                      <span className='flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-slate-700 dark:text-slate-300'>
                        <span className='truncate text-slate-400 line-through'>
                          {fmtValue(c.from)}
                        </span>
                        <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
                        <span className='truncate'>{fmtValue(c.to)}</span>
                      </span>
                      <span className='ml-auto text-[11px] text-slate-500'>
                        {c.who ?? 'System'}
                      </span>
                      {c.action === 'create' && <Badge className='text-[10px]'>created</Badge>}
                      {c.note && (
                        <p className='w-full pl-[138px] text-[11px] italic text-slate-400'>
                          “{c.note}”
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
