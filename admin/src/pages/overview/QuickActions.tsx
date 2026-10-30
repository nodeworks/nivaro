import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Pin, Plus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { iconForPath, navCategories } from '@/layouts/nav-config'
import { api } from '@/lib/api'
import { hubForPath, isPathDisabled } from '@/lib/hubs'
import { useUiPermissions } from '@/lib/useUiPermissions'
import { cn } from '@/lib/utils'
import { overviewKeys, useOverviewPrefs, useUpdateOverviewPrefs } from './api'
import {
  ADMIN_DEFAULT_ACTIONS,
  buildQuickActions,
  MEMBER_DEFAULT_ACTIONS,
  type QuickAction,
  togglePin
} from './model'
import { Bone, Section } from './parts'

/**
 * Quick actions — a compact row of the screens this person uses: what they pinned, then what
 * they opened most over the last 30 days (their own page loads), then their role's starting
 * set. Pin keeps one; unpinning a suggestion hides it. "Add" pins any screen they may open.
 */

const NAV_ITEMS = navCategories.flatMap((c) => c.items).filter((i) => i.to !== '/')
const NAV_LABEL = new Map(NAV_ITEMS.map((i) => [i.to, i.label]))

function labelFor(path: string): string | null {
  const nav = NAV_LABEL.get(path)
  if (nav) return nav
  const hub = hubForPath(path)
  if (hub) return hub.tab.path ? `${hub.hub.title}: ${hub.tab.label}` : hub.hub.title
  return null
}

export function QuickActionsSection({ isAdmin }: { isAdmin: boolean }) {
  const prefs = useOverviewPrefs()
  const update = useUpdateOverviewPrefs()
  const disabled = useUiPermissions()
  const usage = useQuery({
    queryKey: overviewKeys.usage,
    queryFn: () =>
      api
        .get<{ data: Array<{ path: string; opens: number }> }>('/overview/my-routes')
        .then((r) => r.data.data)
        .catch(() => []),
    staleTime: 10 * 60_000
  })
  const [adding, setAdding] = useState(false)

  const allowed = useCallback((p: string) => !isPathDisabled(p, disabled), [disabled])
  const pinned = prefs.data?.pinned_actions ?? []
  const actions = useMemo(
    () =>
      buildQuickActions({
        pinned,
        usage: usage.data ?? [],
        defaults: isAdmin ? ADMIN_DEFAULT_ACTIONS : MEMBER_DEFAULT_ACTIONS,
        dismissed: prefs.data?.dismissed_actions ?? [],
        labelFor,
        allowed,
        max: 8
      }),
    [pinned, usage.data, isAdmin, prefs.data?.dismissed_actions, allowed]
  )

  const flip = (a: QuickAction) => {
    const next = togglePin(pinned, a)
    // Unpinning something that would come back as a suggestion hides it too.
    const dismissed = prefs.data?.dismissed_actions ?? []
    update.mutate(
      a.pinned
        ? { pinned_actions: next, dismissed_actions: [...new Set([...dismissed, a.path])] }
        : { pinned_actions: next, dismissed_actions: dismissed.filter((p) => p !== a.path) }
    )
  }

  const addable = NAV_ITEMS.filter((i) => allowed(i.to) && !pinned.some((p) => p.path === i.to))

  return (
    <Section
      id='quick-actions'
      title='Quick actions'
      plain
      action={
        <Popover open={adding} onOpenChange={setAdding}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-300 dark:hover:bg-white/[0.06] dark:hover:text-white'
            >
              <Plus className='h-3.5 w-3.5' aria-hidden />
              Pin a screen
            </button>
          </PopoverTrigger>
          <PopoverContent align='end' className='w-72 p-0'>
            <Command>
              <CommandInput placeholder='Find a screen…' />
              <CommandList>
                <CommandEmpty>No screen by that name.</CommandEmpty>
                <CommandGroup>
                  {addable.map((i) => {
                    const Icon = i.icon
                    return (
                      <CommandItem
                        key={i.to}
                        value={`${i.label} ${i.to} ${i.keywords ?? ''}`}
                        onSelect={() => {
                          update.mutate({
                            pinned_actions: togglePin(pinned, { path: i.to, label: i.label }),
                            dismissed_actions: (prefs.data?.dismissed_actions ?? []).filter(
                              (p) => p !== i.to
                            )
                          })
                          setAdding(false)
                        }}
                      >
                        <Icon className='mr-2 h-3.5 w-3.5 text-slate-500' aria-hidden />
                        {i.label}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      }
    >
      {prefs.isLoading ? (
        <div className='flex flex-wrap gap-2' aria-hidden>
          {['w-24', 'w-20', 'w-28', 'w-16', 'w-24', 'w-20'].map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton chips
            <Bone key={i} className={cn('h-8 rounded-md', w)} />
          ))}
        </div>
      ) : actions.length === 0 ? (
        <p className='rounded-lg border border-dashed border-slate-300 px-4 py-3 text-[12.5px] text-slate-600 dark:border-border dark:text-slate-300'>
          Screens you open often show up here. Use “Pin a screen” to keep one.
        </p>
      ) : (
        <ul className='flex flex-wrap gap-2'>
          {actions.map((a) => {
            const Icon = iconForPath(a.path) ?? ArrowUpRight
            return (
              <li
                key={a.path}
                className='group flex items-center rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'
              >
                <Link
                  to={a.path}
                  className='flex items-center gap-1.5 rounded-l-md py-1.5 pl-2.5 pr-1.5 text-[12.5px] font-medium text-slate-700 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-200 dark:hover:text-white'
                  data-tip={
                    a.source === 'usage' && a.opens
                      ? `You opened this ${a.opens} times in the last 30 days`
                      : undefined
                  }
                >
                  <Icon className='h-3.5 w-3.5 text-slate-500 dark:text-slate-400' aria-hidden />
                  {a.label}
                </Link>
                <button
                  type='button'
                  onClick={() => flip(a)}
                  aria-pressed={a.pinned}
                  aria-label={a.pinned ? `Unpin ${a.label}` : `Pin ${a.label}`}
                  data-tip={a.pinned ? 'Unpin' : 'Pin to keep it here'}
                  className={cn(
                    'mr-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:hover:bg-white/[0.06] dark:hover:text-slate-200',
                    // Unpinned: revealed on hover/focus, but its slot is always reserved.
                    a.pinned
                      ? 'text-slate-600 dark:text-slate-300'
                      : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
                  )}
                >
                  <Pin className={cn('h-3 w-3', a.pinned && 'fill-current')} aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
