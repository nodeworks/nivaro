import { clearRecordOutbox, isSignedOutError, noteSignedIn, noteUnauthorized } from '@nivaro/shared'
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
      // The signed-out gate (socket token, RUM, identity reads) opens here and in other tabs.
      noteSignedIn()
      if (u.current_workspace) localStorage.setItem(WORKSPACE_KEY, u.current_workspace)
      // Before any screen mounts: last session's metadata fills the cache (#2449).
      await bootMetadataCache(queryClient, u).catch(() => {})
      setUser(u)
    } catch (err) {
      // A session that ended elsewhere is a sign-out: leave no metadata behind.
      // (Offline / 5xx is not — the cached copy is what lets a reload paint.)
      if ((err as { response?: { status?: number } })?.response?.status === 401) {
        void wipeMetadataOnSignOut()
        if (isSignedOutError(err, true)) noteUnauthorized()
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

/** IndexedDB database + localStorage prefix of the record-form draft store
 *  (packages/shared lib/draft-store.ts) — keep in step with it. */
const DRAFTS_DB = 'nivaro-drafts'
const DRAFT_CREATED_PREFIX = 'nvr:draft-created:'

/** Unsaved record-form drafts hold record values typed by the person signing
 *  out; on a shared machine the next person must not find them. Never blocks
 *  sign-out for long (another open tab can hold the database). */
export function clearLocalDrafts(timeoutMs = 1500): Promise<void> {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(DRAFT_CREATED_PREFIX)) localStorage.removeItem(k)
    }
  } catch {
    /* storage blocked */
  }
  const wipe = new Promise<void>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve()
      const req = indexedDB.deleteDatabase(DRAFTS_DB)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      // Another tab still has it open: the delete completes when it closes.
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
  return Promise.race([wipe, new Promise<void>((r) => setTimeout(r, timeoutMs))])
}

export async function logout() {
  const redirect = window.location.pathname + window.location.search
  await api.post('/auth/logout')
  // Offline saves (#1678) belong to the person signing out — none survive it.
  await clearRecordOutbox()
  await wipeMetadataOnSignOut()
  // Nor do unsaved form drafts (security audit 2026-10-27).
  await clearLocalDrafts()
  window.location.href = `/login?redirect=${encodeURIComponent(redirect)}`
}
