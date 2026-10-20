import { SlidersHorizontal } from 'lucide-react'
import { useMemo } from 'react'
import { cn } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'
import { choiceLabelsFrom } from './overview/describe-conditions'
import { useLayoutOverview, useOverviewFields } from './overview/overview-api'
import { Pill, purposeSegments, rowPill, Sentence } from './overview/purpose'
import type { OverviewSection } from './overview/types'

// The editor's left list: every layout of the collection, grouped as the
// overview groups them, each with its purpose in words, plus Form settings.

const RAIL_SECTIONS: Array<{ id: OverviewSection; title: string }> = [
  { id: 'forms', title: 'Forms' },
  { id: 'link_only', title: 'Link only' },
  { id: 'other_views', title: 'Other views' },
  { id: 'unused', title: 'Unused' }
]

const head = 'px-2 pb-1 pt-3 text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'

export function LayoutsRail({
  collection,
  currentId,
  onOpen,
  settingsOpen,
  onSettings
}: {
  collection: string
  currentId: number
  onOpen: (layoutId: number) => void
  settingsOpen: boolean
  onSettings: () => void
}) {
  const { data, isLoading } = useLayoutOverview(collection)
  const { data: fields = [] } = useOverviewFields(collection)
  const choices = useMemo(() => choiceLabelsFrom(fields), [fields])
  const rows = data?.rows ?? []

  return (
    <nav data-editor-rail='' aria-label='Layouts' className='flex flex-col gap-0.5 px-2 pb-4'>
      {isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className='mx-2 mt-3 h-9 rounded-md' />)}
      {RAIL_SECTIONS.map((s) => {
        const list = rows.filter((r) => r.section === s.id)
        if (!list.length) return null
        return (
          <div key={s.id} className='flex flex-col gap-0.5'>
            <p className={head}>{s.title}</p>
            {list.map((row) => {
              const on = row.layout_id === currentId && !settingsOpen
              const pill = rowPill(row)
              return (
                <button
                  key={row.layout_id}
                  type='button'
                  data-rail-layout={row.layout_id}
                  aria-current={row.layout_id === currentId ? 'page' : undefined}
                  onClick={() => onOpen(row.layout_id)}
                  className={cn(
                    'flex flex-col gap-px rounded-md px-2 py-1.5 text-left transition-colors',
                    on ? 'bg-accent' : 'hover:bg-muted',
                    row.layout_id === currentId && settingsOpen && 'bg-muted'
                  )}
                >
                  <span
                    className={cn(
                      'flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-slate-900 dark:text-foreground',
                      s.id === 'unused' && 'font-medium text-slate-500 dark:text-muted-foreground'
                    )}
                  >
                    <span className='truncate'>{row.name}</span>
                    {pill && <Pill tone={pill.tone}>{pill.text}</Pill>}
                  </span>
                  <span className='line-clamp-2 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground [&_b]:font-medium [&_b]:text-slate-600 dark:[&_b]:text-muted-foreground'>
                    <Sentence segs={purposeSegments(row, fields, choices)} />
                  </span>
                </button>
              )
            })}
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
