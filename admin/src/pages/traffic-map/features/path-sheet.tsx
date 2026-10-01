/**
 * #1092 — the event-chain sheet the Integrations console uses (request → writes → transitions →
 * partner pushes → flows), opened on one chain id. Loaded lazily: it pulls the shared console.
 */
import { createNivaro } from '@nivaro/sdk'
import {
  defaultItemUrl,
  EventPathSheet,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider
} from '@nivaro/shared'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/lib/auth'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

export default function PathSheetHost({
  chainId,
  label,
  onClose
}: {
  chainId: string
  label?: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  // Replay links swap the sheet to another chain.
  const [target, setTarget] = useState<{ chainId: string }>({ chainId })
  return (
    <NivaroProvider client={sharedClient}>
      <NavigationContext.Provider
        value={{ navigate: (path) => navigate(path), itemUrl: defaultItemUrl }}
      >
        <ItemEditAuthContext.Provider
          value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
        >
          <EventPathSheet
            target={target}
            event={label ? { label } : null}
            onClose={onClose}
            onOpenRecord={(c, id) => {
              onClose()
              navigate(`/collections/${c}/${id}`)
            }}
            onOpenEvent={setTarget}
          />
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
