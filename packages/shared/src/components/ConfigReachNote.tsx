import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Radio } from 'lucide-react'
import { useId, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from '../lib/commands'
import { cn, formatNumber } from '../lib/utils'

/**
 * "This reaches 34 open forms, 12 people right now" — beside the save of a config editor
 * (layout, field, rule, pipeline, owner matrix; rt8 #25), so an administrator sees who a change
 * lands on before it lands. Expands to the people, most forms first. Administrators only (the
 * route refuses everyone else, and this renders nothing then); in memory on the server, re-read
 * every 15 s while shown.
 */

export interface ConfigReachAnswer {
  collections: string[]
  forms: number
  people: number
  by_collection: Array<{ collection: string; forms: number; people: number }>
  people_list: Array<{ id: string; name: string; forms: number; records: number }>
  more: number
  at: string
}

const plural = (n: number, one: string, many: string) =>
  `${formatNumber(n)} ${n === 1 ? one : many}`

/** The sentence (pure). */
export function configReachText(r: Pick<ConfigReachAnswer, 'forms' | 'people'>): string {
  if (r.forms === 0) return 'Nobody else has one of these forms open right now'
  return `This reaches ${plural(r.forms, 'open form', 'open forms')}, ${plural(
    r.people,
    'person',
    'people'
  )} right now`
}

export function ConfigReachNote({
  collections,
  className,
  enabled = true
}: {
  /** The collections the change applies to (a layout's, a pipeline's bound ones …). */
  collections: Array<string | null | undefined>
  className?: string
  enabled?: boolean
}) {
  const client = useOptionalNivaroClient()
  const [open, setOpen] = useState(false)
  const listId = useId()
  const list = [...new Set(collections.filter((c): c is string => !!c))].sort()
  const key = list.join(',')
  const q = useQuery({
    queryKey: ['nvr-config-reach', key],
    queryFn: () =>
      client!
        .request<{ data: ConfigReachAnswer }>(get('/realtime/config-reach', { collections: key }))
        .then((r) => r.data),
    enabled: !!client && enabled && key !== '',
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: false
  })
  const r = q.data
  if (!r) return null
  const some = r.forms > 0
  return (
    <div
      data-config-reach={r.forms}
      className={cn('text-[11.5px] leading-snug text-slate-500 dark:text-slate-400', className)}
    >
      <button
        type='button'
        disabled={!some}
        aria-expanded={some ? open : undefined}
        aria-controls={some ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
        className='inline-flex max-w-full items-center gap-1.5 rounded text-left transition-colors enabled:hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 disabled:cursor-default dark:enabled:hover:text-slate-100'
      >
        <Radio
          aria-hidden
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            some ? 'text-nvr-cyan' : 'text-slate-400 dark:text-slate-500'
          )}
        />
        <span className='min-w-0'>
          {some ? (
            <>
              This reaches{' '}
              <span className='font-semibold tabular-nums text-slate-800 dark:text-slate-100'>
                {plural(r.forms, 'open form', 'open forms')}
              </span>
              ,{' '}
              <span className='font-semibold tabular-nums text-slate-800 dark:text-slate-100'>
                {plural(r.people, 'person', 'people')}
              </span>{' '}
              right now
            </>
          ) : (
            configReachText(r)
          )}
        </span>
        {some && (
          <ChevronRight
            aria-hidden
            className={cn(
              'h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none',
              open && 'rotate-90'
            )}
          />
        )}
      </button>
      {some && open && (
        <ul
          id={listId}
          className='mt-1.5 max-h-48 max-w-sm space-y-0.5 overflow-y-auto overscroll-contain border-l border-slate-200 pl-2.5 dark:border-border'
        >
          {r.people_list.map((p) => (
            <li key={p.id} className='flex items-baseline justify-between gap-3'>
              <span className='truncate text-slate-700 dark:text-slate-200'>{p.name}</span>
              <span className='shrink-0 tabular-nums'>
                {plural(p.forms, 'form', 'forms')}
                {p.records !== p.forms ? ` · ${plural(p.records, 'record', 'records')}` : ''}
              </span>
            </li>
          ))}
          {r.more > 0 && <li>and {plural(r.more, 'other', 'others')}</li>}
        </ul>
      )}
    </div>
  )
}
