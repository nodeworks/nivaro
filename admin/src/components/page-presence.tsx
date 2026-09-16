import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/**
 * #42 — "who else is on this config page": the admin's page-presence pings
 * (page:at, the same signal the journeys + presence map use) filtered to the
 * current path. Polls; a page that two admins edit at once is exactly the
 * moment nobody should be surprised by.
 */
export function PagePresence() {
  const { pathname } = useLocation()
  const { user } = useAuth()
  const { data } = useQuery({
    queryKey: ['page-presence', pathname],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string; name: string; since: number }> }>('/journeys/here', {
          params: { path: pathname }
        })
        .then((r) => r.data.data),
    refetchInterval: 15_000,
    staleTime: 10_000
  })
  const others = (data ?? []).filter((p) => p.id !== user?.id)
  if (others.length === 0) return null
  const names = others.map((p) => p.name)
  const text =
    names.length === 1
      ? `${names[0]} is also on this page`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are also on this page`
        : `${names[0]}, ${names[1]} and ${names.length - 2} more are also on this page`
  return (
    <span
      data-page-presence={others.length}
      title={names.join(', ')}
      className='inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300'
    >
      <span className='relative flex h-1.5 w-1.5'>
        <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75' />
        <span className='relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500' />
      </span>
      {text}
    </span>
  )
}
