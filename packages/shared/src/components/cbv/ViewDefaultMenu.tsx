import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * The ★ on a saved-view pill (admins). Two layers of default:
 * the collection default everyone gets, and — optionally — a default for one
 * role, which wins for that role's members (#672). A role can have one
 * default per collection; picking a role here moves it off any other view.
 */
export function ViewDefaultMenu({
  name,
  isDefault,
  roleId,
  onCollectionDefault,
  onRoleDefault
}: {
  name: string
  isDefault: boolean
  roleId: string | null
  onCollectionDefault: (on: boolean) => void
  onRoleDefault: (roleId: string | null) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data: roles = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['cbv-view-default-roles'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string; name: string }> }>(get('/roles'))
        .then((r) => r.data ?? []),
    enabled: open,
    staleTime: 5 * 60_000
  })
  const same = (a: string | null, b: string) => !!a && a.toUpperCase() === b.toUpperCase()
  const row = (label: string, on: boolean, onClick: () => void, testId: string) => (
    <button
      type='button'
      data-view-default-option={testId}
      aria-pressed={on}
      onClick={() => {
        onClick()
        setOpen(false)
      }}
      className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-muted'
    >
      <Check className={cn('h-3.5 w-3.5 shrink-0', on ? 'opacity-100' : 'opacity-0')} />
      <span className='truncate'>{label}</span>
    </button>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-view-default-menu
          title='Default view settings'
          aria-label={`Default settings for ${name}`}
          className={isDefault || roleId ? 'text-[#00a5cc]' : 'text-slate-400 hover:text-[#00a5cc]'}
        >
          ★
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-64 p-1'>
        <p className='px-2 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
          Default for everyone
        </p>
        {row(
          isDefault ? 'Collection default (on)' : 'Make the collection default',
          isDefault,
          () => onCollectionDefault(!isDefault),
          'collection'
        )}
        <p className='px-2 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
          Default for one role (optional, wins for its members)
        </p>
        <div className='max-h-56 overflow-y-auto'>
          {row('No role', !roleId, () => onRoleDefault(null), 'role:none')}
          {roles.map((r) =>
            row(
              r.name,
              same(roleId, r.id),
              () => onRoleDefault(same(roleId, r.id) ? null : r.id),
              `role:${r.id}`
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
