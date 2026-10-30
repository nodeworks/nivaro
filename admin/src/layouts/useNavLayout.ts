import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { effectiveNavLayout, type NavLayout, parseNavLayout, sameLayout } from './nav-layout'

/**
 * #3227 — the reader's sidebar layout: their own (`preferences.nav_layout`),
 * else their role's starter (GET /nav-layout/starter), else the code default.
 *
 * Saves are optimistic and serialised the same way favorites are
 * (FavoritesNav.useNavFavorites): one PATCH at a time, in order, and the
 * optimistic copy stays until the server's copy matches, so quick clicks in
 * Customize never repaint an older arrangement.
 */
export function useNavLayout() {
  const { user, refetch } = useAuth()
  const fromServer = useMemo(
    () =>
      parseNavLayout(
        (user as { preferences?: Record<string, unknown> } | null)?.preferences?.nav_layout ?? null
      ),
    [user]
  )
  const { data: starter = null } = useQuery({
    queryKey: ['nav-layout-starter', user?.role ?? null],
    queryFn: () =>
      api
        .get<{ data: { layout: unknown } }>('/nav-layout/starter')
        .then((r) => parseNavLayout(r.data.data?.layout ?? null))
        .catch(() => null),
    enabled: !!user,
    staleTime: 5 * 60_000
  })
  // `undefined` = nothing pending; `null` is a real pending value (reset).
  const [pending, setPending] = useState<NavLayout | null | undefined>(undefined)
  const seq = useRef(0)
  const chain = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    if (pending !== undefined && sameLayout(pending, fromServer)) setPending(undefined)
  }, [pending, fromServer])

  const personal = pending !== undefined ? pending : fromServer

  const save = useCallback(
    (next: NavLayout | null, message?: string) => {
      const mine = ++seq.current
      setPending(next)
      const run = chain.current.then(async () => {
        try {
          await api.patch('/users/me/preferences', { nav_layout: next })
          if (mine === seq.current) {
            await refetch()
            setPending((p) => (p === next ? undefined : p))
          }
          if (message) toast.success(message)
        } catch {
          toast.error('Could not save your sidebar')
          if (mine === seq.current) setPending(undefined)
        }
      })
      chain.current = run
      return run
    },
    [refetch]
  )

  return {
    /** The person's own layout (null = none; they follow the starter). */
    personal,
    starter,
    effective: effectiveNavLayout(personal, starter),
    save
  }
}

export type NavLayoutApi = ReturnType<typeof useNavLayout>
