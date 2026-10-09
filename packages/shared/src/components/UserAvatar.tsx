import { useQuery } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useApiFetchConfig } from '../context'
import { DEMO_USER, useIsRecordingSelf } from './help-videos/recorder/cleanRecording'

/**
 * Real profile photo (Microsoft Graph, captured at login) with the caller's
 * initials disc as the fallback. The photo arrives as a small data URI from
 * GET /users/:id/avatar — react-query caches it per user for the session, so
 * an owner stack showing the same person twenty times costs one request.
 *
 * The FALLBACK is the caller's own styled disc: every site already has its
 * exact colors/ring/size, and this component must never change how a user
 * without a photo renders.
 *
 * During a clean help-video recording the signed-in person's own avatar reads
 * as a neutral "DU" (Demo User) disc; everyone else's stays.
 */
export function UserAvatar({
  userId,
  fallback,
  className,
  style,
  alt
}: {
  userId: string | number | null | undefined
  fallback: ReactNode
  /** Applied to the <img> when a photo exists — size + ring classes of the site's disc. */
  className?: string
  /** Inline size for sites whose disc dimensions are dynamic (px-based avatars). */
  style?: CSSProperties
  alt?: string
}) {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const demo = useIsRecordingSelf(userId)
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
      const body = (await res.json().catch(() => null)) as {
        data?: { avatar?: string | null }
      } | null
      const uri = body?.data?.avatar ?? null
      return typeof uri === 'string' && uri.startsWith('data:image/') ? uri : null
    }
  })

  if (demo) {
    const px = typeof style?.width === 'number' ? style.width : null
    return (
      <span
        role='img'
        aria-label={DEMO_USER.name}
        data-nvr-demo-avatar
        className={`inline-flex shrink-0 select-none items-center justify-center rounded-full bg-[#cbd5e1] font-semibold text-[#334155] dark:bg-[#475569] dark:text-[#f1f5f9] ${px ? '' : 'text-[10px]'} ${className ?? ''}`}
        style={px ? { ...style, fontSize: Math.max(8, Math.round(px * 0.38)) } : style}
      >
        {DEMO_USER.initials}
      </span>
    )
  }

  if (avatar) {
    return (
      <img
        src={avatar}
        alt={alt ?? ''}
        className={`shrink-0 rounded-full object-cover ${className ?? ''}`}
        style={style}
        draggable={false}
      />
    )
  }
  return <>{fallback}</>
}
