import { SlidersHorizontal } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { cn } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'
import { useRailDrop } from './dnd/rail-drop'
import { useLayoutOverview, useOverviewFields, useRuleChoiceLabels } from './overview/overview-api'
import { Pill, purposeSegments, rowPill, Sentence } from './overview/purpose'
import type { OverviewRow, OverviewSection } from './overview/types'

// The editor's left list: every layout of the collection, grouped as the
// overview groups them, each with its purpose in words, plus Form settings.

const RAIL_SECTIONS: Array<{ id: OverviewSection; title: string }> = [
  { id: 'forms', title: 'Forms' },
  { id: 'link_only', title: 'Link only' },
  { id: 'other_views', title: 'Other views' },
  { id: 'unused', title: 'Unused' }
]

const head = 'px-2 pb-1 pt-3 text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'

/** One layout in the rail; while a section is dragged (#2584) it takes the drop as a copy. */
function RailRow({
  row,
  current,
  settingsOpen,
  unused,
  dropTarget,
  onOpen,
  children
}: {
  row: OverviewRow
  current: boolean
  settingsOpen: boolean
  unused: boolean
  dropTarget: boolean
  onOpen: (layoutId: number) => void
  children: ReactNode
}) {
  const drop = useRailDrop(row.layout_id, current || !dropTarget)
  const on = current && !settingsOpen
  const pill = rowPill(row)
  return (
    <button
      ref={drop.ref}
      type='button'
      data-rail-layout={row.layout_id}
      data-rail-drop={drop.over ? 'over' : drop.armed ? 'armed' : undefined}
      aria-current={current ? 'page' : undefined}
      onClick={() => onOpen(row.layout_id)}
      className={cn(
        'flex flex-col gap-px rounded-md px-2 py-1.5 text-left transition-colors',
        on ? 'bg-accent' : 'hover:bg-muted',
        current && settingsOpen && 'bg-muted',
        drop.armed &&
          'outline-dashed outline-1 -outline-offset-1 outline-slate-300 dark:outline-border',
        drop.over && 'bg-nvr-cyan/10 outline-nvr-cyan dark:outline-nvr-cyan'
      )}
    >
      <span
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-slate-900 dark:text-foreground',
          unused && 'font-medium text-slate-500 dark:text-muted-foreground'
        )}
      >
        <span className='truncate'>{row.name}</span>
        {pill && <Pill tone={pill.tone}>{pill.text}</Pill>}
        {drop.over && (
          <span className='ml-auto shrink-0 text-[11px] font-medium text-[#0089ad] dark:text-nvr-cyan'>
            Copy here
          </span>
        )}
      </span>
      {children}
    </button>
  )
}

export function LayoutsRail({
  collection,
  currentId,
  onOpen,
  settingsOpen,
  onSettings,
  dropTargets = false
}: {
  collection: string
  currentId: number
  onOpen: (layoutId: number) => void
  settingsOpen: boolean
  onSettings: () => void
  /** Rows take a section dragged from the canvas (copied there, #2584). */
  dropTargets?: boolean
}) {
  const { data, isLoading } = useLayoutOverview(collection)
  const { data: fields = [] } = useOverviewFields(collection)
  const rows = useMemo(() => data?.rows ?? [], [data])
  const choices = useRuleChoiceLabels(collection, fields, rows)

  return (
    <nav data-editor-rail='' aria-label='Forms' className='flex flex-col gap-0.5 px-2 pb-4'>
      {isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className='mx-2 mt-3 h-9 rounded-md' />)}
      {RAIL_SECTIONS.map((s) => {
        const list = rows.filter((r) => r.section === s.id)
        if (!list.length) return null
        return (
          <div key={s.id} className='flex flex-col gap-0.5'>
            <p className={head}>{s.title}</p>
            {list.map((row) => (
              <RailRow
                key={row.layout_id}
                row={row}
                current={row.layout_id === currentId}
                settingsOpen={settingsOpen}
                unused={s.id === 'unused'}
                dropTarget={dropTargets}
                onOpen={onOpen}
              >
                <span className='line-clamp-2 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground [&_b]:font-medium [&_b]:text-slate-600 dark:[&_b]:text-muted-foreground'>
                  <Sentence segs={purposeSegments(row, fields, choices)} />
                </span>
              </RailRow>
            ))}
          </div>
        )
      })}
      <p className={head}>Form settings</p>
      <button
        type='button'
        data-rail-settings=''
        aria-pressed={settingsOpen}
        onClick={onSettings}
        className={cn(
          'flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
          settingsOpen ? 'bg-accent' : 'hover:bg-muted'
        )}
      >
        <SlidersHorizontal className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-muted-foreground' />
        <span className='flex flex-col gap-px'>
          <span className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
            Steps, buttons, panels…
          </span>
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Who gets this form and how it behaves
          </span>
        </span>
      </button>
    </nav>
  )
}
