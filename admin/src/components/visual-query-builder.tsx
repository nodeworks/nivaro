import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronsUpDown, Plus, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Visual query builder (#689) ─────────────────────────────────────────────
// Build a custom query without writing SQL: pick a collection, columns,
// filters (literals or :param tokens), aggregates, grouping and sorting —
// "Apply to SQL" GENERATES T-SQL into the editor. One-way by design (the PDF
// designer precedent): the SQL stays the source of truth and remains freely
// hand-editable after generation. Builder state persists per query in
// localStorage so reopening the page keeps your last configuration.

const OPS = ['=', '<>', '>', '>=', '<', '<=', 'contains', 'is null', 'is not null'] as const
const AGGS = ['count', 'sum', 'avg', 'min', 'max'] as const

interface FilterRow {
  field: string
  op: string
  value: string
}
interface AggRow {
  func: string
  field: string
  alias: string
}
interface BuilderState {
  collection: string
  columns: string[]
  filters: FilterRow[]
  aggs: AggRow[]
  groupBy: string[]
  sortField: string
  sortDir: 'asc' | 'desc'
  limit: string
}

const EMPTY: BuilderState = {
  collection: '',
  columns: [],
  filters: [],
  aggs: [],
  groupBy: [],
  sortField: '',
  sortDir: 'desc',
  limit: '100'
}

function ident(name: string): string {
  return `[${name.replace(/[[\]]/g, '')}]`
}

function sqlValue(v: string): string {
  const t = v.trim()
  if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return t // execute-param token
  if (/^-?\d+(\.\d+)?$/.test(t)) return t
  return `N'${t.replace(/'/g, "''")}'`
}

function generateSql(s: BuilderState): string {
  const parts: string[] = []
  const selects: string[] = []
  for (const c of s.columns) selects.push(ident(c))
  for (const a of s.aggs) {
    const inner = a.func === 'count' && !a.field ? '*' : ident(a.field || 'id')
    selects.push(`${a.func.toUpperCase()}(${inner}) AS ${ident(a.alias || `${a.func}_${a.field || 'all'}`)}`)
  }
  const top = /^\d+$/.test(s.limit.trim()) ? `TOP (${s.limit.trim()}) ` : ''
  parts.push(`SELECT ${top}${selects.length ? selects.join(', ') : '*'}`)
  parts.push(`FROM ${ident(s.collection)}`)
  const where = s.filters
    .filter((f) => f.field)
    .map((f) => {
      if (f.op === 'is null') return `${ident(f.field)} IS NULL`
      if (f.op === 'is not null') return `${ident(f.field)} IS NOT NULL`
      if (f.op === 'contains') return `${ident(f.field)} LIKE '%' + ${sqlValue(f.value)} + '%'`
      return `${ident(f.field)} ${f.op} ${sqlValue(f.value)}`
    })
  if (where.length) parts.push(`WHERE ${where.join('\n  AND ')}`)
  if (s.groupBy.length) parts.push(`GROUP BY ${s.groupBy.map(ident).join(', ')}`)
  if (s.sortField) parts.push(`ORDER BY ${ident(s.sortField)} ${s.sortDir.toUpperCase()}`)
  return parts.join('\n')
}

function FieldCombo({
  value,
  fields,
  placeholder,
  onChange
}: {
  value: string
  fields: string[]
  placeholder: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-7 min-w-[130px] items-center justify-between gap-1 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
        >
          <span className={cn('truncate', !value && 'text-slate-400')}>{value || placeholder}</span>
          <ChevronsUpDown className='h-3 w-3 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-56 p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList className='max-h-56'>
            <CommandEmpty>No match</CommandEmpty>
            {fields.map((f) => (
              <CommandItem
                key={f}
                value={f}
                onSelect={() => {
                  onChange(f)
                  setOpen(false)
                }}
                className='text-[12px]'
              >
                <Check className={cn('mr-1.5 h-3 w-3', value === f ? 'opacity-100' : 'opacity-0')} />
                {f}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function VisualQueryBuilder({
  storageKey,
  onApply
}: {
  storageKey: string
  onApply: (sql: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<BuilderState>(() => {
    try {
      const raw = localStorage.getItem(`nvr_vqb_${storageKey}`)
      const parsed = raw ? (JSON.parse(raw) as BuilderState) : null
      return parsed?.collection !== undefined ? { ...EMPTY, ...parsed } : EMPTY
    } catch {
      return EMPTY
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(`nvr_vqb_${storageKey}`, JSON.stringify(state))
    } catch {
      /* storage full/blocked — builder still works for the session */
    }
  }, [state, storageKey])

  const { data: collections = [] } = useQuery({
    queryKey: ['vqb-collections'],
    enabled: open,
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string }> }>('/collections?tables_only=true')
        .then((r) => r.data.data.map((c) => c.collection))
  })
  const { data: fields = [] } = useQuery({
    queryKey: ['vqb-fields', state.collection],
    enabled: open && !!state.collection,
    queryFn: () =>
      api
        .get<{ data: { fields?: Array<{ field: string; type: string }> } }>(
          `/collections/${state.collection}`
        )
        .then((r) =>
          (r.data.data.fields ?? [])
            .filter((f) => !['alias'].includes(f.type))
            .map((f) => f.field)
        )
  })

  const set = (patch: Partial<BuilderState>) => setState((p) => ({ ...p, ...patch }))
  const toggleIn = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

  return (
    <div className='rounded-lg border border-slate-200 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='flex w-full items-center gap-2 px-3 py-2 text-left'
      >
        <Wand2 className='h-3.5 w-3.5 text-nvr-cyan' />
        <span className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
          Build visually
        </span>
        <span className='text-[11px] text-slate-400'>
          pick a collection, filters and aggregates — generates the SQL below
        </span>
        <ChevronDown
          className={cn('ml-auto h-3.5 w-3.5 text-slate-400 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className='space-y-3 border-t border-slate-100 px-3 py-3 dark:border-border/60'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-[11.5px] text-slate-500'>Collection</span>
            <FieldCombo
              value={state.collection}
              fields={collections}
              placeholder='Choose…'
              onChange={(v) =>
                set({ collection: v, columns: [], filters: [], aggs: [], groupBy: [], sortField: '' })
              }
            />
            <span className='ml-3 text-[11.5px] text-slate-500'>Limit</span>
            <Input
              value={state.limit}
              onChange={(e) => set({ limit: e.target.value })}
              className='h-7 w-20 text-[12px] tabular-nums'
            />
          </div>

          {state.collection && (
            <>
              <div>
                <p className='mb-1 text-[11px] font-medium text-slate-500'>
                  Columns <span className='font-normal text-slate-400'>(none = all)</span>
                </p>
                <div className='flex max-h-28 flex-wrap gap-1 overflow-y-auto'>
                  {fields.map((f) => (
                    <button
                      key={f}
                      type='button'
                      onClick={() => set({ columns: toggleIn(state.columns, f) })}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                        state.columns.includes(f)
                          ? 'border-nvr-cyan bg-nvr-cyan/10 font-medium text-nvr-navy dark:text-nvr-cyan'
                          : 'border-slate-200 text-slate-500 dark:border-border'
                      )}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className='mb-1 text-[11px] font-medium text-slate-500'>Filters</p>
                {state.filters.map((f, i) => (
                  <div key={`f-${i}-${f.field}`} className='mb-1.5 flex flex-wrap items-center gap-1.5'>
                    <FieldCombo
                      value={f.field}
                      fields={fields}
                      placeholder='field'
                      onChange={(v) =>
                        set({ filters: state.filters.map((x, j) => (j === i ? { ...x, field: v } : x)) })
                      }
                    />
                    <Select
                      value={f.op}
                      onValueChange={(v) =>
                        set({ filters: state.filters.map((x, j) => (j === i ? { ...x, op: v } : x)) })
                      }
                    >
                      <SelectTrigger className='h-7 w-28 text-[12px]'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPS.map((o) => (
                          <SelectItem key={o} value={o}>
                            {o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!f.op.includes('null') && (
                      <Input
                        value={f.value}
                        onChange={(e) =>
                          set({
                            filters: state.filters.map((x, j) =>
                              j === i ? { ...x, value: e.target.value } : x
                            )
                          })
                        }
                        placeholder='value or :param'
                        className='h-7 w-40 text-[12px]'
                      />
                    )}
                    <button
                      type='button'
                      onClick={() => set({ filters: state.filters.filter((_, j) => j !== i) })}
                      className='rounded p-1 text-slate-400 hover:text-red-500'
                      aria-label='Remove filter'
                    >
                      <Trash2 className='h-3 w-3' />
                    </button>
                  </div>
                ))}
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-6 text-[11px]'
                  onClick={() => set({ filters: [...state.filters, { field: '', op: '=', value: '' }] })}
                >
                  <Plus className='mr-1 h-3 w-3' /> Filter
                </Button>
                <span className='ml-2 text-[10.5px] text-slate-400'>
                  a value like <code className='font-mono'>:region</code> becomes an execute
                  parameter
                </span>
              </div>

              <div>
                <p className='mb-1 text-[11px] font-medium text-slate-500'>Aggregates</p>
                {state.aggs.map((a, i) => (
                  <div key={`a-${i}-${a.func}`} className='mb-1.5 flex flex-wrap items-center gap-1.5'>
                    <Select
                      value={a.func}
                      onValueChange={(v) =>
                        set({ aggs: state.aggs.map((x, j) => (j === i ? { ...x, func: v } : x)) })
                      }
                    >
                      <SelectTrigger className='h-7 w-24 text-[12px]'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AGGS.map((g) => (
                          <SelectItem key={g} value={g}>
                            {g}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldCombo
                      value={a.field}
                      fields={fields}
                      placeholder={a.func === 'count' ? '(all rows)' : 'field'}
                      onChange={(v) =>
                        set({ aggs: state.aggs.map((x, j) => (j === i ? { ...x, field: v } : x)) })
                      }
                    />
                    <Input
                      value={a.alias}
                      onChange={(e) =>
                        set({ aggs: state.aggs.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)) })
                      }
                      placeholder='alias'
                      className='h-7 w-28 text-[12px]'
                    />
                    <button
                      type='button'
                      onClick={() => set({ aggs: state.aggs.filter((_, j) => j !== i) })}
                      className='rounded p-1 text-slate-400 hover:text-red-500'
                      aria-label='Remove aggregate'
                    >
                      <Trash2 className='h-3 w-3' />
                    </button>
                  </div>
                ))}
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-6 text-[11px]'
                  onClick={() => set({ aggs: [...state.aggs, { func: 'count', field: '', alias: '' }] })}
                >
                  <Plus className='mr-1 h-3 w-3' /> Aggregate
                </Button>
              </div>

              {state.aggs.length > 0 && (
                <div>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>Group by</p>
                  <div className='flex max-h-20 flex-wrap gap-1 overflow-y-auto'>
                    {fields.map((f) => (
                      <button
                        key={f}
                        type='button'
                        onClick={() => set({ groupBy: toggleIn(state.groupBy, f) })}
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                          state.groupBy.includes(f)
                            ? 'border-nvr-cyan bg-nvr-cyan/10 font-medium text-nvr-navy dark:text-nvr-cyan'
                            : 'border-slate-200 text-slate-500 dark:border-border'
                        )}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className='flex flex-wrap items-center gap-2'>
                <span className='text-[11.5px] text-slate-500'>Sort</span>
                <FieldCombo
                  value={state.sortField}
                  fields={fields}
                  placeholder='(none)'
                  onChange={(v) => set({ sortField: v })}
                />
                {state.sortField && (
                  <Select
                    value={state.sortDir}
                    onValueChange={(v) => set({ sortDir: v as 'asc' | 'desc' })}
                  >
                    <SelectTrigger className='h-7 w-24 text-[12px]'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='desc'>newest first</SelectItem>
                      <SelectItem value='asc'>oldest first</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className='flex items-center justify-between border-t border-slate-100 pt-2 dark:border-border/60'>
                <pre className='max-h-24 flex-1 overflow-auto rounded bg-slate-50 px-2 py-1.5 font-mono text-[10.5px] leading-snug text-slate-500 dark:bg-muted/40'>
                  {generateSql(state)}
                </pre>
                <Button
                  type='button'
                  size='sm'
                  className='ml-3 h-7 shrink-0 text-[12px]'
                  onClick={() => onApply(generateSql(state))}
                >
                  Apply to SQL
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
