import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Check, ChevronsUpDown, SlidersHorizontal, Trash2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { del, get, post } from '../../../lib/commands'
import { toastError } from '../../../lib/error-toast'
import { cn } from '../../../lib/utils'
import { Segmented } from '../../delivery-analytics/ui'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import type { FacetOption, SavedView } from './types'
import { FILTER_KEYS, listOf, toggleIn } from './url'

const trigger =
  'inline-flex h-8 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
const triggerIdle =
  'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
const triggerOn = 'border-nvr-cyan/60 bg-nvr-cyan/10 text-slate-900 dark:text-foreground'

type SetParams = (mutate: (p: URLSearchParams) => void, opts?: { replace?: boolean }) => void

/** A searchable many-choice filter on one comma-list URL key (Popover + Command). */
export function MultiPicker({
  label,
  paramKey,
  params,
  setParams,
  options,
  render
}: {
  label: string
  paramKey: string
  params: URLSearchParams
  setParams: SetParams
  options: FacetOption[]
  render?: (o: FacetOption) => string
}) {
  const [open, setOpen] = useState(false)
  const picked = listOf(params, paramKey)
  const name = (v: string) => {
    const o = options.find((x) => x.value === v)
    return o ? (render ? render(o) : o.label) : v
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-ai-filter={paramKey}
          aria-label={`${label}: ${picked.length ? picked.map(name).join(', ') : 'all'}`}
          className={cn(trigger, picked.length ? triggerOn : triggerIdle)}
        >
          <span className='text-slate-500 dark:text-muted-foreground'>{label}</span>
          <span className='min-w-0 truncate font-medium'>
            {picked.length === 0
              ? 'All'
              : picked.length === 1
                ? name(picked[0])
                : `${picked.length} picked`}
          </span>
          <ChevronsUpDown className='h-3 w-3 shrink-0 opacity-50' aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput
            placeholder={`Find a ${label.toLowerCase()}…`}
            className='h-9 text-[12.5px]'
          />
          <CommandList>
            <CommandEmpty>Nothing in this window.</CommandEmpty>
            {options.map((o) => {
              const on = picked.includes(o.value)
              return (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  onSelect={() =>
                    setParams((p) => toggleIn(p, paramKey, o.value), { replace: true })
                  }
                  className='text-[12.5px]'
                >
                  <span
                    className={cn(
                      'mr-2 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
                      on
                        ? 'border-nvr-cyan bg-nvr-cyan text-white'
                        : 'border-slate-300 dark:border-border'
                    )}
                    aria-hidden
                  >
                    {on && <Check className='h-2.5 w-2.5' />}
                  </span>
                  <span className='min-w-0 flex-1 truncate'>{render ? render(o) : o.label}</span>
                  <span className='ml-2 text-[11px] tabular-nums text-slate-400'>
                    {o.count.toLocaleString('en-US')}
                  </span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A number box that commits on change (popover inputs never rely on blur). */
function NumBox({
  label,
  value,
  onChange,
  step,
  suffix
}: {
  label: string
  value: string
  onChange: (v: string) => void
  step?: string
  suffix?: string
}) {
  return (
    <label className='flex min-w-0 flex-col gap-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
      {label}
      <span className='flex items-center gap-1'>
        <input
          type='number'
          inputMode='decimal'
          min={0}
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className='h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-900 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-background dark:text-foreground'
        />
        {suffix && <span className='shrink-0 text-[11px]'>{suffix}</span>}
      </span>
    </label>
  )
}

/** Ranges (cost, tokens, time), thumbs and error text — the filters that do not need a list. */
export function MoreFilters({
  params,
  setParams
}: {
  params: URLSearchParams
  setParams: SetParams
}) {
  const [open, setOpen] = useState(false)
  const keys = [
    'cost_min',
    'cost_max',
    'tokens_min',
    'tokens_max',
    'ms_min',
    'ms_max',
    'feedback',
    'error'
  ]
  const on = keys.filter((k) => params.get(k)).length
  const set = (k: string) => (v: string) =>
    setParams(
      (p) => {
        if (v) p.set(k, v)
        else p.delete(k)
        p.delete('page')
      },
      { replace: true }
    )
  // Time is entered in seconds, stored in ms.
  const sec = (k: string) => {
    const v = params.get(k)
    return v ? String(Number(v) / 1000) : ''
  }
  const setSec = (k: string) => (v: string) => set(k)(v ? String(Math.round(Number(v) * 1000)) : '')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(trigger, on ? triggerOn : triggerIdle)}
          data-ai-more-filters
        >
          <SlidersHorizontal className='h-3.5 w-3.5' aria-hidden />
          More filters{on ? ` · ${on}` : ''}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-3' align='start'>
        <div className='grid grid-cols-2 gap-x-3 gap-y-2.5'>
          <NumBox
            label='Cost from ($)'
            step='0.001'
            value={params.get('cost_min') ?? ''}
            onChange={set('cost_min')}
          />
          <NumBox
            label='Cost to ($)'
            step='0.001'
            value={params.get('cost_max') ?? ''}
            onChange={set('cost_max')}
          />
          <NumBox
            label='Tokens from'
            step='100'
            value={params.get('tokens_min') ?? ''}
            onChange={set('tokens_min')}
          />
          <NumBox
            label='Tokens to'
            step='100'
            value={params.get('tokens_max') ?? ''}
            onChange={set('tokens_max')}
          />
          <NumBox
            label='Time from'
            step='0.5'
            suffix='s'
            value={sec('ms_min')}
            onChange={setSec('ms_min')}
          />
          <NumBox
            label='Time to'
            step='0.5'
            suffix='s'
            value={sec('ms_max')}
            onChange={setSec('ms_max')}
          />
          <label className='col-span-2 flex flex-col gap-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
            Error text contains
            <input
              type='text'
              value={params.get('error') ?? ''}
              onChange={(e) => set('error')(e.target.value)}
              placeholder='e.g. rate limit'
              className='h-8 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-background dark:text-foreground'
            />
          </label>
          <div className='col-span-2 flex flex-col gap-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
            Feedback on the answer
            <Segmented
              ariaLabel='Feedback'
              value={params.get('feedback') ?? ''}
              onChange={set('feedback')}
              options={[
                { value: '', label: 'Any' },
                { value: 'any', label: 'Rated' },
                { value: 'up', label: 'Up' },
                { value: 'down', label: 'Down' },
                { value: 'none', label: 'Unrated' }
              ]}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Saved filter sets: everyone's shared views plus your own; save the current one. */
export function SavedViews({
  params,
  setParams
}: {
  params: URLSearchParams
  setParams: SetParams
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const views = useQuery({
    queryKey: ['nvr-ai-call-log-views'],
    queryFn: () => client.request<{ data: SavedView[] }>(get('/ai/call-log/views')),
    enabled: open,
    staleTime: 30_000
  })
  const current = new URLSearchParams()
  for (const k of [...FILTER_KEYS, 'sort']) {
    const v = params.get(k)
    if (v) current.set(k, v)
  }
  const save = useMutation({
    mutationFn: () =>
      client.request(
        post('/ai/call-log/views', { name: name.trim(), query: current.toString(), shared })
      ),
    onSuccess: () => {
      setName('')
      void qc.invalidateQueries({ queryKey: ['nvr-ai-call-log-views'] })
    },
    onError: (e) => toastError(e, 'The view was not saved')
  })
  const remove = useMutation({
    mutationFn: (id: string) => client.request(del(`/ai/call-log/views/${id}`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-ai-call-log-views'] }),
    onError: (e) => toastError(e, 'The view was not deleted')
  })
  useEffect(() => {
    if (!open) setName('')
  }, [open])
  const apply = (v: SavedView) => {
    const next = new URLSearchParams(v.query)
    setParams((p) => {
      for (const k of [...FILTER_KEYS, 'sort', 'page', 'call', 'thread']) p.delete(k)
      for (const [k, val] of next) p.set(k, val)
    })
    setOpen(false)
  }
  const list = views.data?.data ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type='button' className={cn(trigger, triggerIdle)} data-ai-saved-views>
          <Bookmark className='h-3.5 w-3.5' aria-hidden />
          Views
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[300px] p-0' align='end'>
        <div className='max-h-[260px] overflow-y-auto py-1'>
          {views.isLoading ? (
            <p className='px-3 py-2 text-[12px] text-slate-500'>Loading…</p>
          ) : list.length === 0 ? (
            <p className='px-3 py-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
              No saved views yet. Set the filters, name the view below and save it.
            </p>
          ) : (
            list.map((v) => (
              <div key={v.id} className='group flex items-center gap-1 px-1'>
                <button
                  type='button'
                  onClick={() => apply(v)}
                  className='flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
                >
                  <span className='min-w-0 flex-1 truncate'>{v.name}</span>
                  {v.shared && (
                    <span
                      className='inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-slate-400'
                      data-tip={
                        v.mine ? 'Shared with every administrator' : `Shared by ${v.owner_name}`
                      }
                    >
                      <Users className='h-3 w-3' aria-hidden />
                      {v.mine ? 'shared' : v.owner_name.split(' ')[0]}
                    </span>
                  )}
                </button>
                {v.mine && (
                  <button
                    type='button'
                    aria-label={`Delete the view ${v.name}`}
                    onClick={() => remove.mutate(v.id)}
                    className='invisible inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-muted hover:text-red-700 focus-visible:visible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 group-hover:visible'
                  >
                    <Trash2 className='h-3.5 w-3.5' aria-hidden />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
        <form
          className='flex flex-col gap-2 border-t border-slate-100 p-3 dark:border-border/60'
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) save.mutate()
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder='Name this view'
            aria-label='View name'
            className='h-8 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-background'
          />
          <div className='flex items-center gap-2'>
            <label className='inline-flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
              <input
                type='checkbox'
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
              />
              Share with administrators
            </label>
            <button
              type='submit'
              disabled={!name.trim() || save.isPending}
              className='ml-auto inline-flex h-7 items-center rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
            >
              {save.isPending ? 'Saving…' : 'Save view'}
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
