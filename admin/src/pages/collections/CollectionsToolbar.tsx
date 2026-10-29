import { LayoutGrid, Rows3, Search } from 'lucide-react'
import { useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { ChipKey, Density, PageState, ViewMode } from './types'

interface Props {
  state: PageState
  onChange: (next: PageState) => void
  filter: string
  onFilterChange: (v: string) => void
  filterRef?: React.Ref<HTMLInputElement>
  counts: { total: number; hidden: number; links: number; chip: Partial<Record<ChipKey, number>> }
  isAdmin: boolean
  selectedCount: number
  onMoveSelected: () => void
  onClearSelection: () => void
}

const VIEWS: Array<{ key: ViewMode; label: string; adminOnly?: boolean }> = [
  { key: 'folders', label: 'Folders' },
  { key: 'az', label: 'A–Z' },
  { key: 'recent', label: 'Recently changed', adminOnly: true },
  { key: 'records', label: 'Most records', adminOnly: true },
  { key: 'used', label: 'Most used by you' }
]

const CHIPS: Array<{ key: ChipKey; label: string; stat?: boolean }> = [
  { key: 'has_records', label: 'Has records', stat: true },
  { key: 'empty', label: 'Empty', stat: true },
  { key: 'hidden', label: 'Hidden' },
  { key: 'link', label: 'Link tables' },
  { key: 'virtual', label: 'Virtual' },
  { key: 'singleton', label: 'Singleton' },
  { key: 'pipeline', label: 'Has pipeline', stat: true },
  { key: 'form', label: 'Has form', stat: true }
]

const btnBase =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
const idle = 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10'
const active = 'bg-nvr-cyan/10 text-cyan-700 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'

export function CollectionsToolbar({
  state,
  onChange,
  filter,
  onFilterChange,
  filterRef,
  counts,
  isAdmin,
  selectedCount,
  onMoveSelected,
  onClearSelection
}: Props) {
  const innerRef = useRef<HTMLInputElement | null>(null)

  const setRefs = (el: HTMLInputElement | null) => {
    innerRef.current = el
    if (typeof filterRef === 'function') filterRef(el)
    else if (filterRef) (filterRef as React.MutableRefObject<HTMLInputElement | null>).current = el
  }

  const views = VIEWS.filter((v) => isAdmin || !v.adminOnly)
  const chips = CHIPS.filter((c) => (isAdmin || !c.stat) && (counts.chip[c.key] ?? 0) > 0)
  const anyChip = state.chips.length > 0

  const toggleChip = (k: ChipKey) =>
    onChange({
      ...state,
      chips: state.chips.includes(k) ? state.chips.filter((c) => c !== k) : [...state.chips, k]
    })

  const setView = (view: ViewMode) => onChange({ ...state, view })
  const setDensity = (density: Density) => onChange({ ...state, density })

  const onRadioKey = (e: React.KeyboardEvent, idx: number) => {
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (!dir) return
    e.preventDefault()
    const next = views[(idx + dir + views.length) % views.length]
    setView(next.key)
    const group = (e.currentTarget as HTMLElement).parentElement
    requestAnimationFrame(() =>
      (
        group?.querySelectorAll('[role=radio]')[views.indexOf(next)] as HTMLElement | undefined
      )?.focus()
    )
  }

  const toggleArrange = () =>
    onChange(
      state.arranging
        ? { ...state, arranging: false }
        : { ...state, arranging: true, selecting: false, view: 'folders' }
    )
  const toggleSelect = () =>
    onChange(
      state.selecting
        ? { ...state, selecting: false }
        : { ...state, selecting: true, arranging: false }
    )

  return (
    <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3 dark:border-white/[0.08] dark:bg-[#0f1923] md:px-8 md:py-4'>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
        <div className='flex items-center gap-2'>
          <h1 className='text-[18px] font-semibold text-slate-900 dark:text-slate-100'>
            Collections
          </h1>
          <span className='rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-500 dark:bg-white/10 dark:text-slate-400'>
            {counts.total}
          </span>
        </div>

        <div className='relative'>
          <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <Input
            ref={setRefs}
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder='Filter collections'
            aria-label='Filter collections'
            className='h-8 w-56 border-slate-200 bg-slate-50 pl-8 text-[13px] placeholder:text-slate-400 focus-visible:ring-nvr-cyan dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-200 dark:placeholder:text-slate-500'
          />
        </div>

        <div
          role='radiogroup'
          aria-label='View'
          className='flex flex-wrap items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-white/[0.06]'
        >
          {views.map((v, i) => {
            const on = state.view === v.key
            return (
              // biome-ignore lint/a11y/useSemanticElements: segmented control with roving tabindex
              <button
                key={v.key}
                type='button'
                role='radio'
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                disabled={state.arranging && v.key !== 'folders'}
                onClick={() => setView(v.key)}
                onKeyDown={(e) => onRadioKey(e, i)}
                className={cn(
                  btnBase,
                  'disabled:cursor-not-allowed disabled:opacity-40',
                  on
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-white/15 dark:text-slate-100'
                    : idle
                )}
              >
                {v.label}
              </button>
            )
          })}
        </div>

        <div className='flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-white/[0.06]'>
          <button
            type='button'
            aria-pressed={state.density === 'compact'}
            aria-label='Compact density'
            data-tip='Compact'
            onClick={() => setDensity('compact')}
            className={cn(btnBase, 'px-2', state.density === 'compact' ? active : idle)}
          >
            <Rows3 className='h-3.5 w-3.5' />
          </button>
          <button
            type='button'
            aria-pressed={state.density === 'comfortable'}
            aria-label='Comfortable density'
            data-tip='Comfortable'
            onClick={() => setDensity('comfortable')}
            className={cn(btnBase, 'px-2', state.density === 'comfortable' ? active : idle)}
          >
            <LayoutGrid className='h-3.5 w-3.5' />
          </button>
        </div>

        {isAdmin && (
          <div className='ml-auto flex items-center gap-1'>
            <button
              type='button'
              aria-pressed={state.arranging}
              onClick={toggleArrange}
              className={cn(btnBase, state.arranging ? active : idle)}
            >
              {state.arranging ? 'Done arranging' : 'Arrange'}
            </button>
            <button
              type='button'
              aria-pressed={state.selecting}
              onClick={toggleSelect}
              className={cn(btnBase, state.selecting ? active : idle)}
            >
              Select
            </button>
          </div>
        )}
      </div>

      <div className='mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1.5'>
        {chips.map((c) => {
          const on = state.chips.includes(c.key)
          return (
            <button
              key={c.key}
              type='button'
              aria-pressed={on}
              onClick={() => toggleChip(c.key)}
              className={cn(
                btnBase,
                'h-6 border px-2 text-[11.5px]',
                on
                  ? 'border-nvr-cyan/30 bg-nvr-cyan/10 text-cyan-700 dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/[0.08] dark:text-slate-300 dark:hover:bg-white/10'
              )}
            >
              {c.label}
              <span className='tabular-nums text-slate-400 dark:text-slate-500'>
                {counts.chip[c.key]}
              </span>
            </button>
          )
        })}
        {anyChip && (
          <button
            type='button'
            onClick={() => onChange({ ...state, chips: [] })}
            className='px-1.5 text-[11.5px] text-slate-500 underline-offset-2 hover:underline dark:text-slate-400'
          >
            Clear
          </button>
        )}

        <div className='ml-auto flex flex-wrap items-center gap-x-4 gap-y-1'>
          {counts.hidden > 0 && (
            <label
              htmlFor='coll-show-hidden'
              className='flex cursor-pointer items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-slate-400'
            >
              <Switch
                checked={state.showHidden}
                onCheckedChange={(v) => onChange({ ...state, showHidden: v })}
                id='coll-show-hidden'
                className='h-4 w-7 data-[state=checked]:bg-nvr-cyan [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3'
              />
              Show hidden ({counts.hidden})
            </label>
          )}
          {counts.links > 0 && (
            <label
              htmlFor='coll-show-links'
              className='flex cursor-pointer items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-slate-400'
            >
              <Switch
                checked={state.showLinks}
                onCheckedChange={(v) => onChange({ ...state, showLinks: v })}
                id='coll-show-links'
                className='h-4 w-7 data-[state=checked]:bg-nvr-cyan [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3'
              />
              Show link tables ({counts.links})
            </label>
          )}
        </div>
      </div>

      {isAdmin && state.selecting && (
        <div className='mt-2 flex items-center gap-3 rounded-md bg-nvr-cyan/10 px-3 py-1.5 text-[12px] text-slate-700 dark:text-slate-200'>
          <span className='font-medium tabular-nums'>{selectedCount} selected</span>
          <button
            type='button'
            onClick={onMoveSelected}
            disabled={selectedCount === 0}
            className='font-medium text-cyan-700 hover:underline disabled:opacity-40 dark:text-nvr-cyan'
          >
            Move to folder…
          </button>
          <button
            type='button'
            onClick={onClearSelection}
            className='text-slate-500 hover:underline dark:text-slate-400'
          >
            Clear
          </button>
        </div>
      )}
    </div>
  )
}
