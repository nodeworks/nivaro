import { createNivaro } from '@nivaro/sdk'
import {
  defaultItemUrl,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider,
  ProfileView
} from '@nivaro/shared'
import { useNavigate } from 'react-router'
import { useAuth } from '@/lib/auth'

// Shared-component host client (team-chat.tsx precedent — cookie session
// rides the same-origin requests).
const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

/**
 * /profile — the OWN profile on the shared ProfileView (identity, out of
 * office, notification rules and sources, security, preferences, browser push
 * via this app's /sw.js).
 */
export function ProfilePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  return (
    <NivaroProvider client={sharedClient}>
      <NavigationContext.Provider
        value={{
          navigate: (path) => navigate(path),
          itemUrl: defaultItemUrl,
          userUrl: (uid) => `/users/${uid}`
        }}
      >
        <ItemEditAuthContext.Provider
          value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
        >
          <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
            <h1 className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
              My profile
            </h1>
          </div>
          <div className='p-8'>
            <ProfileView />
          </div>
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
