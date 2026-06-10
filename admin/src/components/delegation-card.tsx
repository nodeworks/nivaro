import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { UserCombobox } from '@/components/user-combobox'
import { api, type User } from '@/lib/api'

/** Convert an ISO string into the value format <input type="datetime-local"> expects. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Delegation editor card. Used by both Profile (self-service, mode="self")
 * and UserEdit (admin, mode="admin"). In admin mode the Manager picker is
 * editable and saving goes through PATCH /users/:id; in self mode it posts to
 * /users/me/delegate and the Manager field is read-only.
 */
export function DelegationCard({
  user,
  mode,
  onSaved
}: {
  user: User
  mode: 'self' | 'admin'
  onSaved?: () => void
}) {
  const queryClient = useQueryClient()
  const isAdmin = mode === 'admin'

  const [isOutOfOffice, setIsOutOfOffice] = useState(user.is_out_of_office)
  const [delegateId, setDelegateId] = useState<string | null>(user.delegate_id)
  const [delegateExpiresAt, setDelegateExpiresAt] = useState<string>(
    toLocalInput(user.delegate_expires_at)
  )
  const [managerId, setManagerId] = useState<string | null>(user.manager_id)

  // Re-sync when the underlying user record changes (e.g. after refetch).
  useEffect(() => {
    setIsOutOfOffice(user.is_out_of_office)
    setDelegateId(user.delegate_id)
    setDelegateExpiresAt(toLocalInput(user.delegate_expires_at))
    setManagerId(user.manager_id)
  }, [user])

  const save = useMutation({
    mutationFn: () => {
      const expires = delegateExpiresAt ? new Date(delegateExpiresAt).toISOString() : null
      if (isAdmin) {
        return api
          .patch(`/users/${user.id}`, {
            is_out_of_office: isOutOfOffice,
            delegate_id: delegateId,
            delegate_expires_at: expires,
            manager_id: managerId
          })
          .then((r) => r.data.data)
      }
      return api
        .post('/users/me/delegate', {
          is_out_of_office: isOutOfOffice,
          delegate_id: delegateId,
          delegate_expires_at: expires
        })
        .then((r) => r.data.data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user', user.id] })
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Delegation saved')
      onSaved?.()
    },
    onError: () => toast.error('Failed to save delegation')
  })

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'>
      <h2 className='mb-1 text-[11px] font-medium text-slate-500'>Delegation</h2>
      <p className='mb-5 text-[12px] text-slate-400'>
        While out of office, pipeline ownership is automatically reassigned to your delegate.
      </p>

      <div className='space-y-4'>
        {/* Out of office toggle */}
        <div className='flex items-center gap-3'>
          <Switch checked={isOutOfOffice} onCheckedChange={setIsOutOfOffice} />
          <Label className='text-[13px]'>Out of office</Label>
        </div>

        {/* Delegate user picker */}
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Delegate to</Label>
          <UserCombobox
            value={delegateId}
            onChange={setDelegateId}
            excludeId={user.id}
            placeholder='No delegate'
          />
        </div>

        {/* Expiry */}
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Delegation expires</Label>
          <input
            type='datetime-local'
            value={delegateExpiresAt}
            onChange={(e) => setDelegateExpiresAt(e.target.value)}
            className='flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-[13px] text-slate-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nvr-cyan dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
          />
          <p className='text-[11px] text-slate-400'>Leave blank for an indefinite delegation.</p>
        </div>

        {/* Manager (admin-only field, read-only in self mode) */}
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Manager</Label>
          <UserCombobox
            value={managerId}
            onChange={setManagerId}
            disabled={!isAdmin}
            excludeId={user.id}
            placeholder='No manager'
          />
          {!isAdmin && (
            <p className='text-[11px] text-slate-400'>Your manager is set by an administrator.</p>
          )}
        </div>

        <Button type='button' size='sm' onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save delegation'}
        </Button>
      </div>
    </div>
  )
}
