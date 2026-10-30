import { userErrorMessage } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { ago, Section, SectionEmpty, SectionError, type SectionProps, Surface } from './kit'
import type { PeopleWaiting, WaitingPerson } from './types'

/**
 * #19 People waiting (administrators) — first sign-ins still on the provisional roles
 * (Settings → Sign-in providers → New accounts: `access_request_role` / `new_user_role`,
 * migration 330), longest waiting first, people who sent an access request ahead of those who
 * have not. Approve = the same write the Users page makes: PATCH /users/:id {role, status}
 * (administrators only on the server), after a confirm.
 */

export function usePeopleWaiting() {
  return useQuery({
    queryKey: ['overview', 'people-waiting'],
    queryFn: () =>
      api.get<{ data: PeopleWaiting }>('/overview/people-waiting').then((r) => r.data.data),
    staleTime: 30_000
  })
}

function PersonRow({
  person,
  roles,
  onDone
}: {
  person: WaitingPerson
  roles: Array<{ id: string; name: string }>
  onDone: () => void
}) {
  const asked = roles.find((r) => r.name === person.requested_role)?.id ?? ''
  const [roleId, setRoleId] = useState(asked)
  const [confirming, setConfirming] = useState(false)
  const roleName = roles.find((r) => r.id === roleId)?.name ?? ''
  const approve = useMutation({
    mutationFn: () =>
      api.patch(`/users/${encodeURIComponent(person.id)}`, { role: roleId, status: 'active' }),
    onSuccess: () => {
      toast.success(`${person.name} can now sign in as ${roleName}`)
      onDone()
    },
    onError: (e) => toast.error(userErrorMessage(e, 'Could not approve this person')),
    onSettled: () => setConfirming(false)
  })
  const when = ago(person.waiting_since)

  return (
    <li className='relative px-3 py-2.5' data-person-waiting={person.id}>
      <div className='flex flex-wrap items-start gap-x-3 gap-y-2'>
        <div className='min-w-0 flex-1'>
          <Link
            to={`/users/${encodeURIComponent(person.id)}`}
            className='block truncate text-[13px] font-medium text-slate-800 hover:underline dark:text-slate-100'
          >
            {person.name}
          </Link>
          <p className='truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
            {person.requested ? 'Asked for access' : 'Signed in, has not asked yet'}
            {when ? ` ${when}` : ''}
            {person.requested_role ? ` · wants ${person.requested_role}` : ''}
            {person.role_name ? ` · now ${person.role_name}` : ''}
          </p>
          {person.reason && (
            <p
              className='mt-0.5 line-clamp-2 text-[12px] italic text-slate-600 dark:text-slate-300'
              data-tip={person.reason}
            >
              “{person.reason}”
            </p>
          )}
        </div>
        {confirming ? (
          <div className='flex w-full flex-wrap items-center gap-2 sm:w-auto'>
            <span className='text-[12px] text-slate-600 dark:text-slate-300'>
              Give {person.name} the {roleName} role?
            </span>
            <Button
              size='sm'
              className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
            >
              {approve.isPending ? 'Approving…' : 'Approve'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-7'
              disabled={approve.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className='flex w-full items-center gap-2 sm:w-auto'>
            <SimpleSelect
              value={roleId}
              onChange={setRoleId}
              ariaLabel={`Role for ${person.name}`}
              className='h-7 w-full text-[12px] sm:w-44'
              options={[
                { value: '', label: 'Choose a role…' },
                ...roles.map((r) => ({ value: r.id, label: r.name }))
              ]}
            />
            <Button
              size='sm'
              variant='outline'
              className='h-7 shrink-0'
              disabled={!roleId}
              onClick={() => setConfirming(true)}
            >
              Approve…
            </Button>
          </div>
        )}
      </div>
    </li>
  )
}

export function PeopleWaitingSection({ hideTitle }: SectionProps = {}) {
  const qc = useQueryClient()
  const { data, isLoading, isError, error, refetch } = usePeopleWaiting()
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['overview', 'people-waiting'] })
    void qc.invalidateQueries({ queryKey: ['overview', 'needs-you'] })
  }

  return (
    <Section
      id='people-waiting'
      title='People waiting for access'
      hideTitle={hideTitle}
      more={{ label: 'All people', to: '/users' }}
    >
      {isLoading ? (
        <Surface className='divide-y divide-slate-100 dark:divide-border'>
          {[0, 1].map((i) => (
            <div key={i} className='flex items-center gap-3 px-3 py-2.5'>
              <div className='min-w-0 flex-1 space-y-1.5'>
                <Skeleton className='h-3.5 w-36' />
                <Skeleton className='h-3 w-52 max-w-[80%]' />
              </div>
              <Skeleton className='h-7 w-44' />
            </div>
          ))}
        </Surface>
      ) : isError || !data ? (
        <SectionError
          error={error}
          what='people waiting for access'
          onRetry={() => void refetch()}
        />
      ) : !data.configured ? (
        <SectionEmpty next={{ label: 'Set the new-account roles', to: '/settings' }}>
          New accounts are not held for review on this instance.
        </SectionEmpty>
      ) : data.people.length === 0 ? (
        <SectionEmpty next={{ label: 'All people', to: '/users' }}>
          Nobody is waiting for access.
        </SectionEmpty>
      ) : (
        <Surface>
          <ul className='divide-y divide-slate-100 dark:divide-border'>
            {data.people.slice(0, 5).map((p) => (
              <PersonRow key={p.id} person={p} roles={data.grantable_roles} onDone={done} />
            ))}
          </ul>
          {data.total > 5 && (
            <p className='border-t border-slate-100 px-3 py-2 text-[11.5px] text-slate-500 dark:border-border dark:text-slate-400'>
              {data.total - 5} more waiting.{' '}
              <Link to='/users' className='font-medium hover:underline'>
                See everyone
              </Link>
            </p>
          )}
        </Surface>
      )}
    </Section>
  )
}
