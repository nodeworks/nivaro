import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LogOut, Smartphone } from 'lucide-react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { formatDate, formatRelative } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { useOverflowTip } from '../TipLayer'
import { Skeleton } from '../ui/skeleton'
import { ConfirmButton, EmptyLine, SectionCard } from './primitives'

/**
 * Profile → Signed-in phones: every phone signed in to a Nivaro app (device grants, routes/
 * devices.ts). Own page reads /auth/devices; an admin's view of someone else reads
 * /users/:id/devices. Sign out ends that phone's sign-in, its tokens and its alerts. `current`
 * marks the phone making the call — only ever true when the page is open on that phone, and that
 * row offers no Sign out: the app signs itself out (and forgets its push registration).
 */

export interface SignedInDevice {
  id: string
  client_name: string
  device_name: string | null
  platform: 'ios' | 'android' | null
  created_at: string
  last_used_at: string | null
  current: boolean
}

const PLATFORM: Record<string, string> = { ios: 'iPhone', android: 'Android phone' }

const platformLabel = (d: SignedInDevice) => (d.platform ? PLATFORM[d.platform] : 'Phone')

export function SignedInDevices({ userId, name }: { userId?: string; name?: string | null }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const base = userId ? `/users/${userId}/devices` : '/auth/devices'
  const key = ['nvr-signed-in-devices', userId ?? 'me']

  const list = useQuery({
    queryKey: key,
    queryFn: () => client.request<{ data: SignedInDevice[] }>(get(base)).then((r) => r.data ?? []),
    staleTime: 30_000
  })

  const signOut = useMutation({
    mutationFn: (d: SignedInDevice) => client.request(del(`${base}/${d.id}`)),
    onSuccess: (_r, d) => {
      qc.setQueryData<SignedInDevice[]>(key, (rows) => rows?.filter((r) => r.id !== d.id))
      toast.success(`${d.device_name ?? platformLabel(d)} is signed out`)
    },
    onError: (err) => toastError(err, 'Could not sign that phone out')
  })

  const phones = list.data ?? []
  const who = name?.trim() || 'This person'

  return (
    <SectionCard
      icon={<Smartphone className='h-4 w-4' />}
      title='Signed-in phones'
      hint={
        userId
          ? 'Signing a phone out ends its sign-in and stops its alerts'
          : 'Phones signed in to the Nivaro app. Signing one out also stops its alerts'
      }
      testId='signed-in-phones'
    >
      {list.isLoading ? (
        <div className='space-y-3' aria-hidden>
          <Skeleton className='h-9 w-full' />
          <Skeleton className='h-9 w-2/3' />
        </div>
      ) : list.isError ? (
        <ErrorNotice error={list.error} what='signed-in phones' onRetry={() => list.refetch()} />
      ) : phones.length === 0 ? (
        <div data-devices-empty>
          <EmptyLine>No phones signed in.</EmptyLine>
          <p className='mt-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
            {userId
              ? `${who} has not signed in from the Nivaro app.`
              : 'Sign in from the Nivaro app on your phone and it shows up here.'}
          </p>
        </div>
      ) : (
        <ul className='-my-2 divide-y divide-slate-100 dark:divide-border/60'>
          {phones.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              pending={signOut.isPending && signOut.variables?.id === d.id}
              onSignOut={() => signOut.mutate(d)}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

function DeviceRow({
  device: d,
  pending,
  onSignOut
}: {
  device: SignedInDevice
  pending: boolean
  onSignOut: () => void
}) {
  const name = d.device_name ?? platformLabel(d)
  const meta = [
    d.device_name ? platformLabel(d) : null,
    `${d.client_name} app`,
    d.last_used_at ? `Last used ${formatRelative(d.last_used_at)}` : 'Not used since sign-in',
    `Signed in ${formatDate(d.created_at)}`
  ]
    .filter(Boolean)
    .join(' · ')
  const nameRef = useOverflowTip<HTMLSpanElement>(name)
  const metaRef = useOverflowTip<HTMLParagraphElement>(meta)
  return (
    <li data-device-row={d.id} className='flex items-center gap-3 py-2.5'>
      <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-300'>
        <Smartphone className='h-4 w-4' aria-hidden />
      </span>
      <div className='min-w-0 flex-1'>
        <p className='flex min-w-0 items-center gap-2'>
          <span
            ref={nameRef}
            data-device-name
            className='truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-100'
          >
            {name}
          </span>
          {d.current && (
            <span
              data-device-current
              className='shrink-0 rounded-full bg-nvr-cyan/10 px-1.5 py-px text-[10.5px] font-medium text-sky-700 dark:text-nvr-cyan'
            >
              This phone
            </span>
          )}
        </p>
        <p
          ref={metaRef}
          className='mt-0.5 truncate text-[11.5px] text-slate-500 dark:text-slate-400'
        >
          {meta}
        </p>
      </div>
      {d.current ? (
        // Signing out the phone you are on belongs in the app: it also forgets its push
        // registration there, which a web button cannot do.
        <span
          data-device-sign-out-in-app
          className='shrink-0 text-[11.5px] text-slate-500 dark:text-slate-400'
        >
          Sign out from the app
        </span>
      ) : (
        <span data-device-sign-out className='contents'>
          <ConfirmButton
            title={`Sign out ${name}`}
            onConfirm={onSignOut}
            confirmLabel='Sign it out?'
            disabled={pending}
            className='inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-600 transition-colors hover:border-red-300 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:opacity-40 dark:border-border dark:text-slate-300 dark:hover:border-red-500/40 dark:hover:text-red-400'
            armedClassName='border-red-300 font-semibold text-red-600 dark:border-red-500/40 dark:text-red-400'
          >
            <LogOut className='h-3 w-3' aria-hidden />
            {pending ? 'Signing out…' : 'Sign out'}
          </ConfirmButton>
        </span>
      )}
    </li>
  )
}
