/**
 * The shared-component context a record read view and the event path need (the same setup
 * features/path-sheet.tsx makes): an SDK client, navigation, admin auth — plus a drill-down
 * context that opens related records as investigation levels instead of a sheet.
 */
import { createNivaro } from '@nivaro/sdk'
import {
  DrilldownContext,
  defaultItemUrl,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider
} from '@nivaro/shared'
import { type ReactNode, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/lib/auth'
import type { InspectRef } from '../../registry/inspectables'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

export function SharedProviders({
  children,
  open
}: {
  children: ReactNode
  /** Opens a related record as a deeper investigation level. */
  open(ref: InspectRef): void
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const drill = useMemo(
    () => ({
      open: (t: { collection: string; itemId: string; title?: string }) =>
        open({
          kind: 'record',
          id: `${t.collection}:${t.itemId}`,
          label: t.title || `${t.collection} ${t.itemId}`
        })
    }),
    [open]
  )
  return (
    <NivaroProvider client={sharedClient}>
      <NavigationContext.Provider
        value={{ navigate: (path) => navigate(path), itemUrl: defaultItemUrl }}
      >
        <ItemEditAuthContext.Provider
          value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
        >
          <DrilldownContext.Provider value={drill}>{children}</DrilldownContext.Provider>
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
