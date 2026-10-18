import { useQuery } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useApiFetchConfig, useOptionalNivaroClient } from '../context'
import { userCardQuery } from '../lib/user-cards'
import { DEMO_USER, useIsRecordingSelf } from './help-videos/recorder/cleanRecording'

function photoUri(uri: unknown): string | null {
  return typeof uri === 'string' && uri.startsWith('data:image/') ? uri : null
}

/**
 * Real profile photo (Microsoft Graph, captured at login) with the caller's
 * initials disc as the fallback. The photo is a small data URI on the
 * person's card, read through the batched card loader (lib/user-cards) — so
 * a list of twenty people costs one request, and react-query keeps it per
 * user. Without a Nivaro client (no provider) it falls back to
 * GET /users/:id/avatar.
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
  const client = useOptionalNivaroClient()
  const demo = useIsRecordingSelf(userId)
  // With a client the photo rides the person's card (the same ['user-card']
  // entry the chip beside it reads), so a list's avatars and chips are ONE
  // batched POST /users/cards — and someone without a photo costs nothing.
  const { data: card } = useQuery({
    ...userCardQuery(client, userId),
    enabled: !!client && !!userId,
    staleTime: 30 * 60_000,
    retry: false
  })
  const { data: fetched } = useQuery<string | null>({
    queryKey: ['user-avatar', userId],
    enabled: !client && !!userId,
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
      return photoUri(body?.data?.avatar)
    }
  })
  const avatar = client ? photoUri(card?.avatar) : (fetched ?? null)

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
