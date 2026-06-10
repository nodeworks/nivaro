import { useQuery } from '@tanstack/react-query'
import { api, type CMSSettings } from './api'

export function useSettings() {
  return useQuery<CMSSettings>({
    queryKey: ['settings'],
    queryFn: () => api.get<{ data: CMSSettings }>('/settings').then((r) => r.data.data),
    staleTime: 60_000
  })
}
