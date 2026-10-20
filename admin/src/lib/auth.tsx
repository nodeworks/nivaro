import { clearRecordOutbox } from '@nivaro/shared'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { api, type User, WORKSPACE_KEY } from './api'
import { bootMetadataCache, wipeMetadataOnSignOut } from './metadata-cache'

interface AuthState {
  user: User | null
  loading: boolean
  refetch: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  refetch: async () => {}
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const queryClient = useQueryClient()

  const fetchMe = useCallback(async () => {
    try {
      const res = await api.get<{ data: User }>('/auth/me')
      const u = res.data.data
      if (u.current_workspace) localStorage.setItem(WORKSPACE_KEY, u.current_workspace)
      // Before any screen mounts: last session's metadata fills the cache (#2449).
      await bootMetadataCache(queryClient, u).catch(() => {})
      setUser(u)
    } catch (err) {
      // A session that ended elsewhere is a sign-out: leave no metadata behind.
      // (Offline / 5xx is not — the cached copy is what lets a reload paint.)
      if ((err as { response?: { status?: number } })?.response?.status === 401) {
        void wipeMetadataOnSignOut()
      }
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [queryClient])

  useEffect(() => {
    fetchMe()
  }, [fetchMe])

  return (
    <AuthContext.Provider value={{ user, loading, refetch: fetchMe }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

export async function logout() {
  const redirect = window.location.pathname + window.location.search
  await api.post('/auth/logout')
  // Offline saves (#1678) belong to the person signing out — none survive it.
  await clearRecordOutbox()
  await wipeMetadataOnSignOut()
  window.location.href = `/login?redirect=${encodeURIComponent(redirect)}`
}
