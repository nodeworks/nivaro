import { useQuery } from '@tanstack/react-query'
import { useAuth } from './auth'
import { api } from './api'

export function useUiPermissions(): Set<string> {
  const { user } = useAuth()
  const roleId = user?.role ?? null

  const { data } = useQuery({
    queryKey: ['role-ui-permissions', roleId],
    queryFn: () => api.get<{ data: { ui_permissions: string[] } }>(`/roles/${roleId}`).then((r) => r.data.data),
    enabled: !!roleId && !user?.is_admin,
    staleTime: 60_000
  })

  // Admins are never restricted
  if (!roleId || user?.is_admin) return new Set()

  return new Set(data?.ui_permissions ?? [])
}
