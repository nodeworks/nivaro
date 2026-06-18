import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Users } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

interface Owner {
  id: number
  state: string | null
  user: string
  first_name: string | null
  last_name: string | null
  email: string
}

function ownerName(o: Owner): string {
  return [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
}

function initials(o: Owner): string {
  const name = ownerName(o)
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function OwnersSlot({
  collection,
  item,
  title,
  defaultExpanded
}: {
  collection: string
  item: string
  title?: string
  defaultExpanded?: boolean
}) {
  const client = useNivaroClient()
  const [expanded, setExpanded] = useState(false)
  const syncedFromProp = useRef(false)
  useEffect(() => {
    if (!syncedFromProp.current && defaultExpanded !== undefined) {
      syncedFromProp.current = true
      setExpanded(defaultExpanded)
    }
  }, [defaultExpanded])

  const { data: owners = [] } = useQuery<Owner[]>({
    queryKey: ['pipeline-instance-owners', collection, item],
    queryFn: () =>
      client
        .request<{ data: Owner[] }>(get(`/pipelines/instance/${collection}/${item}/owners`))
        .then((r) => r.data ?? []),
    enabled: !!collection && !!item && item !== 'new'
  })

  if (!item || item === 'new') return null

  // Group owners by state (null/empty → "All states")
  const byState = new Map<string, Owner[]>()
  for (const o of owners) {
    const key = o.state ?? '__all__'
    if (!byState.has(key)) byState.set(key, [])
    byState.get(key)!.push(o)
  }

  return (
    <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
      <button
        type='button'
        onClick={() => setExpanded((v) => !v)}
        className='flex w-full items-center gap-2 px-4 py-2.5'
      >
        <Users className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        <span className='text-[12px] font-semibold text-slate-500'>{title || 'Owners'}</span>
        {!expanded && owners.length > 0 && (
          <span className='ml-1 text-[11px] text-slate-400'>{owners.length}</span>
        )}
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150${expanded ? ' rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className='border-t border-slate-100 px-4 py-3'>
          {owners.length === 0 ? (
            <p className='py-1 text-[13px] text-slate-400'>No owners assigned</p>
          ) : (
            <div className='space-y-3'>
              {[...byState.entries()].map(([state, list]) => (
                <div key={state}>
                  {state !== '__all__' && (
                    <p className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                      {state}
                    </p>
                  )}
                  <div className='flex flex-wrap gap-2'>
                    {list.map((o) => (
                      <div
                        key={o.id}
                        className='flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-0.5 pr-2.5'
                      >
                        <span className='flex h-6 w-6 items-center justify-center rounded-full bg-nvr-cyan/15 text-[10px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
                          {initials(o)}
                        </span>
                        <span className='text-[12px] text-slate-700'>{ownerName(o)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
