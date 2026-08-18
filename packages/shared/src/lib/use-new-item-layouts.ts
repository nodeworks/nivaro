import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useItemEditAuth, useNivaroClient } from '../context'
import { get } from './commands'

/**
 * Layout choices for a "New item" button — the same slug-opt-in rules the
 * admin's classic browser used: grouped layouts only, a non-active layout
 * joins the menu when it has a slug and isn't create_hidden, role-conditioned
 * layouts only show for matching roles (admins see all). Returns null when no
 * alternative layouts exist — hosts render their plain button.
 */
export interface CreateLayoutOption {
  id: number
  name: string
  slug: string | null
  create_label: string | null
  create_hidden: boolean | number
  is_active: boolean | number
  layout_type: string
  conditions: { role_ids?: string[] } | null
}

export function useNewItemLayouts(
  collection: string | null | undefined
): { active: CreateLayoutOption | null; options: CreateLayoutOption[] } | null {
  const client = useNivaroClient()
  const { isAdmin } = useItemEditAuth()

  // Role for conditional layouts — ItemEditAuth carries only id/isAdmin.
  const { data: me } = useQuery<{ role?: string | null }>({
    queryKey: ['nvr-auth-me-role'],
    queryFn: async () => {
      const r = (await client.request(get('/auth/me'))) as Record<string, unknown>
      const user = (r?.data ?? r) as Record<string, unknown>
      return { role: (user?.role as string | null) ?? null }
    },
    staleTime: 300_000,
    enabled: !!collection
  })

  const { data: layouts } = useQuery<CreateLayoutOption[]>({
    queryKey: ['nvr-create-layouts', collection],
    queryFn: () =>
      client
        .request<{ data: CreateLayoutOption[] }>(
          get('/collection-layouts', { collection: collection as string })
        )
        .then((r) => r.data ?? []),
    enabled: !!collection,
    staleTime: 60_000
  })

  return useMemo(() => {
    if (!collection) return null
    const role = me?.role
    const visible = (layouts ?? []).filter((l) => {
      if (l.layout_type !== 'grouped') return false
      const roleIds = l.conditions?.role_ids
      if (!roleIds?.length) return true
      return isAdmin || (role != null && roleIds.includes(role))
    })
    const options = visible.filter((l) => l.slug && !l.is_active && !l.create_hidden)
    if (options.length === 0) return null
    return { active: visible.find((l) => !!l.is_active) ?? null, options }
  }, [collection, layouts, me, isAdmin])
}
