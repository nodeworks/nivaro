import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { useRef, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { helpVideoApi, helpVideoKeys } from '../api'
import { PickerCombo, RemovableChip } from '../editor/PickerCombo'

const AUTHOR_ROLES_KEY = ['help-videos', 'author-roles']

const noteClass = 'text-[12.5px] text-muted-foreground'
const errorClass =
  'flex items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12.5px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'

/** Admins choose which roles may record and edit videos (admins always can). */
export function AuthorRolesButton() {
  const { isAdmin } = useItemEditAuth()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // The last list the server confirmed; a failed save puts this back.
  const confirmed = useRef<string[] | null>(null)
  const current = useQuery({
    queryKey: AUTHOR_ROLES_KEY,
    enabled: isAdmin && open,
    queryFn: async () => {
      const ids = await helpVideoApi(client).authorRoles()
      confirmed.current = ids
      return ids
    }
  })
  const roles = useQuery({
    queryKey: ['chat-roles'],
    enabled: isAdmin && open,
    queryFn: async () =>
      (await client.request(get<{ data: Array<{ id: string; name: string }> }>('/chat/roles'))).data
  })
  if (!isAdmin) return null
  const ids = current.data ?? []
  const name = (id: string) => {
    if (roles.isPending) return 'Loading…'
    return roles.data?.find((r) => r.id.toUpperCase() === id.toUpperCase())?.name ?? 'Unknown role'
  }
  const save = async (next: string[]) => {
    setSaveError(null)
    qc.setQueryData(AUTHOR_ROLES_KEY, next)
    try {
      await helpVideoApi(client).setAuthorRoles(next)
      confirmed.current = next
      // can_author changes for people in these roles; refresh every list that reports it.
      void qc.invalidateQueries({ queryKey: helpVideoKeys.all })
    } catch (e) {
      qc.setQueryData(AUTHOR_ROLES_KEY, confirmed.current ?? [])
      setSaveError(`That change was not saved. ${(e as Error).message}`)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size='sm' variant='outline' data-hv-author-roles>
          <Users className='mr-1 h-4 w-4' aria-hidden /> Who can record
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[min(320px,calc(100vw-2rem))] space-y-3 text-[13px]'>
        <p className='text-muted-foreground'>
          Administrators can always record and edit videos. Add roles to let their members do it
          too.
        </p>
        {current.isPending ? (
          <p className={noteClass} role='status'>
            Loading…
          </p>
        ) : current.isError ? (
          <div className={errorClass} role='alert'>
            <span>The roles that can record could not be loaded.</span>
            <Button size='sm' variant='outline' onClick={() => void current.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className='flex flex-wrap items-center gap-1.5'>
            {ids.length === 0 && <span className={noteClass}>No roles added yet.</span>}
            {ids.map((id) => (
              <RemovableChip
                key={id}
                data-hv-author-role={id}
                removeLabel={`Remove ${name(id)}`}
                onRemove={() => void save(ids.filter((x) => x !== id))}
              >
                {name(id)}
              </RemovableChip>
            ))}
            <PickerCombo
              ariaLabel='Add a role'
              placeholder='Add a role'
              emptyText={
                roles.isPending
                  ? 'Loading…'
                  : roles.isError
                    ? 'Roles could not be loaded.'
                    : 'Nothing matches.'
              }
              options={(roles.data ?? [])
                .filter((r) => !ids.some((x) => x.toUpperCase() === r.id.toUpperCase()))
                .map((r) => ({ value: r.id, label: r.name }))}
              onPick={(v) => void save([...ids, v])}
            />
          </div>
        )}
        {roles.isError && (
          <div className={errorClass} role='alert'>
            <span>Role names could not be loaded.</span>
            <Button size='sm' variant='outline' onClick={() => void roles.refetch()}>
              Try again
            </Button>
          </div>
        )}
        {saveError && (
          <p className={errorClass} role='alert'>
            {saveError}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
