/**
 * Toolbar "Investigations" (#1212): the saved notebooks of this map store, newest first. Picking
 * one opens it as a new investigation (its `notebook` level), from where "Restore this stack"
 * brings the saved levels back.
 */
import { useQuery } from '@tanstack/react-query'
import { NotebookPen } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { openInspect } from '../../inspect/stack'
import { BTN } from '../shared'
import { apiErrorOf, MUTED, POP } from './ui'

interface InvestigationRow {
  id: string
  title: string
  notes: string | null
  levels: number
  created_by_name: string | null
  updated_at: string
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function InvestigationsList() {
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ['traffic-map', 'investigations'],
    queryFn: async () =>
      (await api.get('/traffic-map/investigations')).data as {
        data: InvestigationRow[]
        ready: boolean
      },
    enabled: open,
    staleTime: 15_000
  })
  const rows = q.data?.data ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={BTN}
          data-tm-inspect-investigations=''
          data-tip='Saved investigations'
        >
          <NotebookPen className='h-3.5 w-3.5' aria-hidden='true' />
          Investigations
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className={cn(POP, 'w-[340px] p-1')}>
        <div className='grid' data-tm-inspect-investigations-list=''>
          {q.isLoading ? (
            <div className='grid gap-2 p-2' aria-busy='true'>
              {[85, 70, 78].map((w) => (
                <div
                  key={w}
                  className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          ) : q.isError ? (
            <p className='p-2 text-[12px] text-[var(--tm-error-ink)]'>
              Saved investigations could not be loaded: {apiErrorOf(q.error).message}
            </p>
          ) : q.data && !q.data.ready ? (
            <p className={cn(MUTED, 'p-2')}>
              Saving investigations needs migration 390, which this instance has not run yet.
            </p>
          ) : rows.length === 0 ? (
            <p className={cn(MUTED, 'p-2')} data-tm-inspect-investigations-empty=''>
              Nothing saved yet. Open something in the investigation panel and use the bookmark
              button in its header to keep it here with your notes.
            </p>
          ) : (
            <ul className='grid max-h-[360px] overflow-auto'>
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    type='button'
                    className='grid w-full gap-0.5 rounded px-2 py-1.5 text-left hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                    data-tm-inspect-investigation={r.id}
                    onClick={() => {
                      setOpen(false)
                      openInspect({ kind: 'notebook', id: r.id, label: r.title }, { root: true })
                    }}
                  >
                    <span className='truncate text-[12.5px] font-medium text-[var(--tm-fg)]'>
                      {r.title}
                    </span>
                    <span className='truncate text-[11.5px] text-[var(--tm-muted)]'>
                      {r.levels} level{r.levels === 1 ? '' : 's'} · {r.created_by_name ?? 'someone'}{' '}
                      · {when(r.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
