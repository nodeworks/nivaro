import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Users } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * "For THIS write, who would be told — and why was everyone else not?" (#526)
 * plus the owners a transition SHOWS vs the owners it TELLS (#525). Reads
 * POST /notification-bench/who; nothing is sent.
 */

type Event = 'update' | 'create' | 'transition' | 'delete'

interface Delivery {
  inapp: boolean
  push: boolean
  email: 'send' | 'deferred' | 'off' | 'not_requested' | 'no_address'
  dropped: boolean
  reasons: Array<{ code: string; channel: string; text: string }>
}
interface Report {
  to_state: { key: string; label: string } | null
  told: Array<{
    user_id: string
    name: string
    email: string | null
    via: Array<{ kind: string; label: string }>
    delivery: Delivery
  }>
  not_told: Array<{ user_id: string; name: string; via: { label: string }; reason: string }>
  owners: Array<{ user_id: string; name: string; told: boolean; reason: string | null }>
  notes: string[]
}

const EVENTS: Array<{ key: Event; label: string }> = [
  { key: 'update', label: 'Update' },
  { key: 'transition', label: 'State change' },
  { key: 'create', label: 'Create' },
  { key: 'delete', label: 'Delete' }
]

function channelsText(d: Delivery): string {
  if (d.dropped) return 'Nothing — dropped'
  const on: string[] = []
  if (d.inapp) on.push('in-app')
  if (d.push) on.push('push')
  if (d.email === 'send') on.push('email')
  if (d.email === 'deferred') on.push('email in daily summary')
  return on.length ? on.join(' · ') : 'No channel fires'
}

export function WhoWouldHearCard() {
  const [collection, setCollection] = useState('')
  const [pickOpen, setPickOpen] = useState(false)
  const [item, setItem] = useState('')
  const [event, setEvent] = useState<Event>('update')
  const [toState, setToState] = useState('')
  const [fields, setFields] = useState('')
  const { data: cols } = useQuery<{ data: Array<{ collection: string }> }>({
    queryKey: ['who-hear-collections'],
    queryFn: () => api.get('/collections').then((r) => r.data)
  })
  const run = useMutation({
    mutationFn: () =>
      api
        .post('/notification-bench/who', {
          collection,
          item,
          event,
          to_state: toState.trim() || null,
          changed_fields: fields
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean)
        })
        .then((r) => r.data as { data: Report })
  })
  const r = run.data?.data
  const collections = (cols?.data ?? [])
    .map((c) => c.collection)
    .filter((c) => !c.startsWith('nivaro_') && !c.startsWith('directus_'))
    .sort()

  return (
    <section
      className='mt-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
      data-who-would-hear
    >
      <div className='flex items-center gap-2'>
        <Users className='h-4 w-4 text-muted-foreground' aria-hidden='true' />
        <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          Who would hear about this write
        </h2>
      </div>
      <p className='mt-1 max-w-[72ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
        Start from a record and a change. Every subscription, record watch, field watch and — for a
        state change — the owners of the new state, each run through the same delivery rules a real
        notification uses. Anyone a subscription would reach but this write does not is listed with
        the reason.
      </p>
      <div className='mt-3 flex flex-wrap items-end gap-3 text-[12.5px]'>
        <div>
          <p className='mb-1 text-[11px] text-slate-500'>Collection</p>
          <Popover open={pickOpen} onOpenChange={setPickOpen}>
            <PopoverTrigger asChild>
              <Button variant='outline' size='sm' className='w-[220px] justify-between'>
                <span className='truncate'>{collection || 'Choose…'}</span>
                <ChevronsUpDown className='h-3.5 w-3.5 opacity-50' />
              </Button>
            </PopoverTrigger>
            <PopoverContent className='w-[240px] p-0' align='start'>
              <Command>
                <CommandInput placeholder='Search collections…' />
                <CommandList>
                  <CommandEmpty>No collection</CommandEmpty>
                  {collections.map((c) => (
                    <CommandItem
                      key={c}
                      value={c}
                      onSelect={() => {
                        setCollection(c)
                        setPickOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 h-3.5 w-3.5',
                          collection === c ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      {c}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <label>
          <p className='mb-1 text-[11px] text-slate-500'>Record id</p>
          <input
            value={item}
            onChange={(e) => setItem(e.target.value)}
            className='h-8 w-[120px] rounded-md border border-slate-200 bg-background px-2 dark:border-border'
            data-who-item
          />
        </label>
        <div>
          <p className='mb-1 text-[11px] text-slate-500'>Change</p>
          <div className='flex overflow-hidden rounded-md border border-slate-200 dark:border-border'>
            {EVENTS.map((e) => (
              <button
                key={e.key}
                type='button'
                onClick={() => setEvent(e.key)}
                aria-pressed={event === e.key}
                data-who-event={e.key}
                className={cn(
                  'h-8 px-2.5 text-[12px]',
                  event === e.key
                    ? 'bg-nvr-cyan text-white'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-muted'
                )}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
        {event === 'transition' && (
          <label>
            <p className='mb-1 text-[11px] text-slate-500'>Into state key (blank = current)</p>
            <input
              value={toState}
              onChange={(e) => setToState(e.target.value)}
              className='h-8 w-[180px] rounded-md border border-slate-200 bg-background px-2 dark:border-border'
            />
          </label>
        )}
        {event === 'update' && (
          <label>
            <p className='mb-1 text-[11px] text-slate-500'>Fields changed (comma list)</p>
            <input
              value={fields}
              onChange={(e) => setFields(e.target.value)}
              className='h-8 w-[220px] rounded-md border border-slate-200 bg-background px-2 dark:border-border'
            />
          </label>
        )}
        <Button
          size='sm'
          disabled={!collection || !item || run.isPending}
          onClick={() => run.mutate()}
          data-who-run
        >
          {run.isPending ? 'Working it out…' : 'Show who'}
        </Button>
      </div>

      {run.isError && (
        <p className='mt-3 text-[12px] text-red-600'>{(run.error as Error).message}</p>
      )}
      {r && (
        <div className='mt-4 space-y-4' data-who-report>
          {r.notes.map((n) => (
            <p
              key={n}
              className='rounded-md bg-[#fffbeb] px-3 py-1.5 text-[12px] text-[#92400e] dark:bg-[#3a2e14] dark:text-[#f5d58a]'
            >
              {n}
            </p>
          ))}
          {r.owners.length > 0 && (
            <div data-who-owners>
              <h3 className='text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
                Owners of {r.to_state?.label} — shown vs told
              </h3>
              <ul className='mt-1 space-y-0.5 text-[12.5px]'>
                {r.owners.map((o) => (
                  <li
                    key={o.user_id}
                    className='flex gap-2'
                    data-who-owner={o.told ? 'told' : 'not-told'}
                  >
                    <span
                      className={cn(
                        'w-16 shrink-0 font-medium',
                        o.told
                          ? 'text-[#15803d] dark:text-[#9fbf8a]'
                          : 'text-[#b91c1c] dark:text-[#e08383]'
                      )}
                    >
                      {o.told ? 'Told' : 'Not told'}
                    </span>
                    <span className='text-slate-800 dark:text-foreground'>{o.name}</span>
                    {o.reason && <span className='text-slate-500'>— {o.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className='text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
              Told ({r.told.length})
            </h3>
            {r.told.length === 0 ? (
              <p className='mt-1 text-[12.5px] text-slate-500'>Nobody — no path reaches anyone.</p>
            ) : (
              <table className='mt-1 w-full text-[12.5px]'>
                <tbody>
                  {r.told.map((t) => (
                    <tr
                      key={t.user_id}
                      className='border-t border-slate-100 align-top dark:border-border'
                      data-who-told
                    >
                      <td className='py-1.5 pr-3 font-medium text-slate-800 dark:text-foreground'>
                        {t.name}
                      </td>
                      <td className='py-1.5 pr-3 text-slate-500'>
                        {t.via.map((v) => v.label).join(' · ')}
                      </td>
                      <td className='py-1.5 pr-3 text-slate-700 dark:text-slate-200'>
                        {channelsText(t.delivery)}
                      </td>
                      <td className='py-1.5 text-[11.5px] text-slate-500'>
                        {t.delivery.reasons
                          .filter((x) => x.code !== 'default')
                          .map((x) => x.text)
                          .slice(0, 2)
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {r.not_told.length > 0 && (
            <div>
              <h3 className='text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
                Subscribed but not told ({r.not_told.length})
              </h3>
              <ul className='mt-1 space-y-0.5 text-[12.5px]'>
                {r.not_told.map((m, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: one person may miss via several subscriptions
                    key={`${m.user_id}-${i}`}
                    className='text-slate-600 dark:text-slate-300'
                    data-who-not-told
                  >
                    <span className='font-medium text-slate-800 dark:text-foreground'>
                      {m.name}
                    </span>{' '}
                    <span className='text-slate-400'>({m.via.label})</span> — {m.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
