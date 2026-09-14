import { createNivaro } from '@nivaro/sdk'
import {
  DelegationConsoleView,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider
} from '@nivaro/shared'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

/** Delegation console — hosts the shared view (OOO roster, who covers whom,
 *  expiring delegations, uncovered approvals, blocked records, my delegate). */
export default function DelegationConsole() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const nav = useMemo(() => ({ navigate: (path: string) => navigate(path) }), [navigate])
  const auth = useMemo(
    () => ({ userId: String(user?.id ?? ''), isAdmin: !!user?.is_admin }),
    [user?.id, user?.is_admin]
  )
  return (
    <NivaroProvider client={sharedClient}>
      <NavigationContext.Provider value={nav}>
        <ItemEditAuthContext.Provider value={auth}>
          <DelegationConsoleView onNotice={(m) => toast.success(m)} />
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
