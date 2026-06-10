import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, GripVertical, Plus, ScrollText, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, type Collection } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type Rule = {
  id: string
  name: string
  collection: string
  trigger: string
  enabled: boolean
  sort: number
}

// ─── Collection filter combobox ────────────────────────────────────────────────

function CollectionFilterCombobox({
  collections,
  value,
  onChange
}: {
  collections: Collection[]
  value: string
  onChange: (collection: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = collections.find((c) => c.collection === value)

  const filtered = collections.filter((c) => {
    const q = query.trim().toLowerCase()
    return (
      c.collection.toLowerCase().includes(q) || (c.display_name ?? '').toLowerCase().includes(q)
    )
  })

  const label = value
    ? (selected?.display_name ?? selected?.collection ?? value)
    : 'All collections'

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-44 justify-between text-[12px] font-normal'
        >
          <span className='truncate'>{label}</span>
          <ChevronsUpDown className='ml-2 h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-64 p-0' align='end'>
        <div className='p-2'>
          <div className='relative mb-1.5'>
            <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search collections…'
              className='h-8 w-full rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-[13px] placeholder-slate-400 focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30 dark:border-slate-700 dark:bg-slate-800'
            />
          </div>
          <div className='max-h-60 overflow-auto'>
            <button
              type='button'
              onClick={() => {
                onChange('')
                setOpen(false)
                setQuery('')
              }}
              className='flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800'
            >
              <Check
                className={cn('mr-2 h-4 w-4 shrink-0', value === '' ? 'opacity-100' : 'opacity-0')}
              />
              <span className='flex-1'>All collections</span>
            </button>
            {filtered.map((col) => (
              <button
                key={col.collection}
                type='button'
                onClick={() => {
                  onChange(col.collection)
                  setOpen(false)
                  setQuery('')
                }}
                className='flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800'
              >
                <Check
                  className={cn(
                    'mr-2 h-4 w-4 shrink-0',
                    value === col.collection ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className='flex-1 truncate'>{col.display_name ?? col.collection}</span>
                <span className='ml-2 font-mono text-xs text-muted-foreground'>
                  {col.collection}
                </span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className='px-2 py-3 text-center text-[12px] text-muted-foreground'>
                No collections found.
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

const TRIGGER_CONFIG: Record<string, string> = {
  before_create: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  before_update: 'bg-amber-50 text-amber-700 border-amber-200',
  after_create: 'bg-sky-50 text-sky-700 border-sky-200',
  after_update: 'bg-violet-50 text-violet-700 border-violet-200'
}

function TriggerBadge({ trigger }: { trigger: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium',
        TRIGGER_CONFIG[trigger] ?? 'bg-slate-50 text-slate-600 border-slate-200'
      )}
    >
      {trigger}
    </span>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function RulesPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [collectionFilter, setCollectionFilter] = useState<string>('')

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rules'],
    queryFn: () => api.get('/rules').then((r) => r.data)
  })

  const { data: collectionsData } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () => api.get('/collections?tables_only=true').then((r) => r.data.data as Collection[])
  })

  const allRules: Rule[] = data?.data ?? []

  // Only show collections that actually have rules in the filter dropdown.
  const ruleCollections = useMemo(
    () => new Set(allRules.map((r) => r.collection).filter(Boolean)),
    [allRules]
  )

  const filterCollections = useMemo(
    () => (collectionsData ?? []).filter((c) => ruleCollections.has(c.collection)),
    [collectionsData, ruleCollections]
  )

  const rules = useMemo(() => {
    const filtered =
      collectionFilter === '' ? allRules : allRules.filter((r) => r.collection === collectionFilter)
    return [...filtered].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  }, [allRules, collectionFilter])

  const deleteRule = useMutation({
    mutationFn: (id: string) => api.delete(`/rules/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      setPendingDelete(null)
      toast.success('Rule deleted')
    },
    onError: () => toast.error('Failed to delete rule')
  })

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`/rules/${id}`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rules'] }),
    onError: () => toast.error('Failed to update rule')
  })

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900'>Rules</h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500'>
                {allRules.length}
              </span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            <CollectionFilterCombobox
              collections={filterCollections}
              value={collectionFilter}
              onChange={setCollectionFilter}
            />
            <Button size='sm' onClick={() => navigate('/rules/new')}>
              <Plus className='mr-1.5 h-3.5 w-3.5' /> New Rule
            </Button>
          </div>
        </div>
      </div>

      <div className='p-8'>
        {isLoading ? (
          <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
            <div className='divide-y divide-slate-100'>
              {(['a', 'b', 'c', 'd'] as const).map((k) => (
                <div key={k} className='flex items-center gap-4 px-5 py-4'>
                  <Skeleton className='h-4 w-40' />
                  <Skeleton className='h-4 w-24' />
                  <Skeleton className='ml-auto h-4 w-16' />
                </div>
              ))}
            </div>
          </div>
        ) : isError ? (
          <div className='py-20 text-center text-[13px] text-red-500'>Failed to load rules.</div>
        ) : rules.length === 0 ? (
          <div className='flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white py-20'>
            <div className='flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100'>
              <ScrollText className='h-8 w-8 text-slate-400' />
            </div>
            <h3 className='mt-4 text-[15px] font-semibold text-slate-700'>No rules yet</h3>
            <p className='mt-1.5 text-[13px] text-slate-400'>
              Rules run conditions and actions on item lifecycle events.
            </p>
            <Button className='mt-6' onClick={() => navigate('/rules/new')}>
              <Plus className='mr-1.5 h-3.5 w-3.5' /> Create your first rule
            </Button>
          </div>
        ) : (
          <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
            <table className='w-full text-left'>
              <thead>
                <tr className='border-b border-slate-100 bg-slate-50'>
                  <th className='w-10 px-3 py-2.5' />
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Name</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Collection</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Trigger</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Enabled</th>
                  <th className='w-24 px-5 py-2.5' />
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100'>
                {rules.map((rule) => (
                  <tr key={rule.id} className='group hover:bg-slate-50'>
                    <td className='px-3 py-3.5'>
                      <div className='flex items-center gap-1 text-slate-300'>
                        <GripVertical className='h-3.5 w-3.5' />
                        <span className='font-mono text-[11px] tabular-nums text-slate-400'>
                          {rule.sort ?? 0}
                        </span>
                      </div>
                    </td>
                    <td className='px-4 py-3.5'>
                      <p className='text-[13px] font-medium text-slate-800'>{rule.name}</p>
                    </td>
                    <td className='px-4 py-3.5 text-[13px] text-slate-600'>
                      {collectionsData?.find((c) => c.collection === rule.collection)
                        ?.display_name ?? rule.collection}
                    </td>
                    <td className='px-4 py-3.5'>
                      <TriggerBadge trigger={rule.trigger} />
                    </td>
                    <td className='px-4 py-3.5'>
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={(v) => toggleEnabled.mutate({ id: rule.id, enabled: v })}
                      />
                    </td>
                    <td className='px-5 py-3.5'>
                      <div className='flex items-center justify-end gap-1'>
                        <button
                          type='button'
                          onClick={() => navigate(`/rules/${rule.id}`)}
                          className='rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-800'
                        >
                          Edit
                        </button>
                        {pendingDelete === rule.id ? (
                          <div className='flex items-center gap-1'>
                            <button
                              type='button'
                              className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600'
                              onClick={() => deleteRule.mutate(rule.id)}
                            >
                              Confirm
                            </button>
                            <button
                              type='button'
                              className='rounded border px-2 py-0.5 text-[11px] hover:bg-slate-50'
                              onClick={() => setPendingDelete(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type='button'
                            className='rounded-lg p-1.5 text-slate-400 opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:bg-red-50 hover:text-red-500'
                            onClick={() => setPendingDelete(rule.id)}
                            aria-label='Delete rule'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
