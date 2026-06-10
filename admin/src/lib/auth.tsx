import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { api, type User, WORKSPACE_KEY } from './api'

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

  const fetchMe = useCallback(async () => {
    try {
      const res = await api.get<{ data: User }>('/auth/me')
      const u = res.data.data
      if (u.current_workspace) localStorage.setItem(WORKSPACE_KEY, u.current_workspace)
      setUser(u)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

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
  window.location.href = `/login?redirect=${encodeURIComponent(redirect)}`
}
