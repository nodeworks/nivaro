import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApiFetchConfig } from '../context'

/**
 * Real profile photo (Microsoft Graph, captured at login) with the caller's
 * initials disc as the fallback. The photo arrives as a small data URI from
 * GET /users/:id/avatar — react-query caches it per user for the session, so
 * an owner stack showing the same person twenty times costs one request.
 *
 * The FALLBACK is the caller's own styled disc: every site already has its
 * exact colors/ring/size, and this component must never change how a user
 * without a photo renders.
 */
export function UserAvatar({
  userId,
  fallback,
  className,
  alt
}: {
  userId: string | number | null | undefined
  fallback: ReactNode
  /** Applied to the <img> when a photo exists — size + ring classes of the site's disc. */
  className?: string
  alt?: string
}) {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const { data: avatar } = useQuery<string | null>({
    queryKey: ['user-avatar', userId],
    enabled: !!userId,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`${apiBase}/users/${userId}/avatar`, {
        headers: authHeaders,
        credentials
      })
      if (!res.ok) return null
      const body = (await res.json().catch(() => null)) as { data?: { avatar?: string | null } } | null
      const uri = body?.data?.avatar ?? null
      return typeof uri === 'string' && uri.startsWith('data:image/') ? uri : null
    }
  })

  if (avatar) {
    return (
      <img
        src={avatar}
        alt={alt ?? ''}
        className={`shrink-0 rounded-full object-cover ${className ?? ''}`}
        draggable={false}
      />
    )
  }
  return <>{fallback}</>
}
