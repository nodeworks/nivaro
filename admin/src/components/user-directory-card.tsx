import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookUser, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api, type User } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Directory card — what Microsoft's directory says about this person right
 * now, beside what Nivaro stores, with a one-click pull. Login enrichment only
 * refreshes a profile when the person signs in; this reads the tenant with the
 * app's own token, so a profile can be filled before their first login.
 */

type DirectoryStatus = {
  configured: boolean
  granted: boolean
  roles: string[]
  reason: string | null
}

type DirectoryEntry = {
  id: string
  display_name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  upn: string | null
  title: string | null
  department: string | null
  company: string | null
  office_location: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  phone: string | null
  employee_id?: string | null
  preferred_language: string | null
  account_enabled: boolean | null
  manager: DirectoryEntry | null
  nivaro_user: { id: string; status: string | null } | null
}

const FIELDS: Array<{ key: keyof DirectoryEntry; label: string; userKey: string }> = [
  { key: 'first_name', label: 'First name', userKey: 'first_name' },
  { key: 'last_name', label: 'Last name', userKey: 'last_name' },
  { key: 'title', label: 'Title', userKey: 'title' },
  { key: 'department', label: 'Department', userKey: 'department' },
  { key: 'company', label: 'Company', userKey: 'company' },
  { key: 'phone', label: 'Phone', userKey: 'phone' },
  { key: 'office_location', label: 'Office', userKey: 'office_location' },
  { key: 'city', label: 'City', userKey: 'city' },
  { key: 'state', label: 'State', userKey: 'state' },
  { key: 'country', label: 'Country', userKey: 'country' },
  { key: 'employee_id', label: 'Employee id', userKey: 'employee_id' },
  { key: 'preferred_language', label: 'Language', userKey: 'preferred_language' }
]

export function UserDirectoryCard({ user }: { user: User }) {
  const queryClient = useQueryClient()
  const status = useQuery<DirectoryStatus>({
    queryKey: ['directory-status'],
    queryFn: () => api.get('/directory/status').then((r) => r.data.data),
    staleTime: 5 * 60_000
  })
  const entry = useQuery<DirectoryEntry | null>({
    queryKey: ['directory-entry', user.email],
    queryFn: () =>
      api
        .get(`/directory/users/${encodeURIComponent(user.email)}`)
        .then((r) => r.data.data as DirectoryEntry)
        .catch((err: { response?: { status?: number } }) => {
          if (err.response?.status === 404) return null
          throw err
        }),
    enabled: Boolean(status.data?.granted && user.email),
    staleTime: 60_000
  })
  const sync = useMutation({
    mutationFn: () => api.post(`/directory/sync/${user.id}`).then((r) => r.data.data),
    onSuccess: (data: { changed: string[] }) => {
      queryClient.invalidateQueries({ queryKey: ['user', user.id] })
      queryClient.invalidateQueries({ queryKey: ['users'] })
      queryClient.invalidateQueries({ queryKey: ['user-avatar', user.id] })
      toast.success(
        data.changed.length === 0
          ? 'Profile already matches the directory'
          : `Updated ${data.changed.map((c) => c.replace(/_/g, ' ')).join(', ')}`
      )
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Directory sync failed')
    }
  })

  // Deployments without a Microsoft tenant never see this card.
  if (status.isLoading || !status.data?.configured) return null

  const current = user as unknown as Record<string, unknown>
  const e = entry.data

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex items-start justify-between gap-3'>
        <div>
          <h3 className='flex items-center gap-1.5 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            <BookUser className='h-3.5 w-3.5 text-slate-400' />
            Microsoft directory
          </h3>
          <p className='mt-0.5 max-w-[60ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            What the tenant directory holds for {user.email}. Pulling writes every field the
            directory has a value for; blanks there never clear a stored value.
          </p>
        </div>
        {status.data.granted && e && (
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className='gap-1.5 text-[12px]'
          >
            <RefreshCw className={cn('h-3.5 w-3.5', sync.isPending && 'animate-spin')} />
            {sync.isPending ? 'Pulling…' : 'Pull into profile'}
          </Button>
        )}
      </div>

      {!status.data.granted ? (
        <div className='mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200'>
          <p className='font-medium'>Directory access is not granted yet.</p>
          <p className='mt-0.5'>
            {status.data.reason ??
              'The app token cannot read other users. Grant User.Read.All as an application permission with admin consent in Azure.'}
          </p>
        </div>
      ) : entry.isLoading ? (
        <p className='mt-3 text-[12px] text-slate-400'>Looking up the directory…</p>
      ) : entry.isError ? (
        <p className='mt-3 text-[12px] text-red-600 dark:text-red-400'>
          {(entry.error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            'The directory lookup failed.'}
        </p>
      ) : !e ? (
        <p className='mt-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No directory entry matches {user.email}.
        </p>
      ) : (
        <div className='mt-3 space-y-3'>
          <div className='flex flex-wrap items-center gap-2 text-[12px]'>
            <span className='font-medium text-slate-800 dark:text-foreground'>
              {e.display_name ?? `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim()}
            </span>
            {e.upn && e.upn.toLowerCase() !== user.email.toLowerCase() && (
              <span className='text-slate-400'>UPN {e.upn}</span>
            )}
            {e.account_enabled === false && (
              <span className='rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-400/10 dark:text-red-300'>
                Disabled in Azure
              </span>
            )}
            {e.manager && (
              <span className='text-slate-500 dark:text-muted-foreground'>
                Reports to{' '}
                <span className='font-medium text-slate-700 dark:text-foreground'>
                  {e.manager.display_name ?? e.manager.email}
                </span>
              </span>
            )}
          </div>
          <dl className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border sm:grid-cols-2 lg:grid-cols-3'>
            {FIELDS.filter((f) => f.key in e).map((f) => {
              const next = (e[f.key] as string | null) ?? null
              const stored = (current[f.userKey] as string | null | undefined) ?? null
              const differs = Boolean(next) && next !== stored
              return (
                <div
                  key={f.key}
                  className={cn(
                    'bg-white px-3 py-2 dark:bg-card',
                    differs && 'bg-amber-50/60 dark:bg-amber-400/10'
                  )}
                >
                  <dt className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                    {f.label}
                  </dt>
                  <dd className='mt-0.5 text-[12.5px] text-slate-800 dark:text-foreground'>
                    {next ?? <span className='text-slate-300 dark:text-slate-600'>—</span>}
                  </dd>
                  {differs && (
                    <dd className='text-[11px] text-slate-400'>
                      stored: {stored ?? <span className='italic'>empty</span>}
                    </dd>
                  )}
                </div>
              )
            })}
          </dl>
        </div>
      )}
    </div>
  )
}
