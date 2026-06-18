import type { NivaroClient } from '@nivaro/sdk'
import type React from 'react'
import { createContext, useContext } from 'react'

// ─── Grid flush registry ───────────────────────────────────────────────────

export type GridFlushContextValue = {
  register: (key: string, fn: () => Promise<void>) => void
  unregister: (key: string) => void
}

export const GridFlushContext = createContext<GridFlushContextValue | null>(null)

export function useGridFlush(): GridFlushContextValue | null {
  return useContext(GridFlushContext)
}

// ─── Nivaro client context ─────────────────────────────────────────────────

type NivaroFormContextValue = {
  client: NivaroClient
}

const NivaroFormContext = createContext<NivaroFormContextValue | null>(null)

export function NivaroProvider({
  client,
  children
}: {
  client: NivaroClient
  children: React.ReactNode
}) {
  return <NivaroFormContext.Provider value={{ client }}>{children}</NivaroFormContext.Provider>
}

export function useNivaroClient(): NivaroClient {
  const ctx = useContext(NivaroFormContext)
  if (!ctx) throw new Error('useNivaroClient must be used within <NivaroProvider>')
  return ctx.client
}

export function useOptionalNivaroClient(): NivaroClient | null {
  const ctx = useContext(NivaroFormContext)
  return ctx?.client ?? null
}

// ─── Auth context (injected by consumers; defaults to non-admin) ───────────

export type ItemEditAuthContextValue = {
  isAdmin: boolean
  userId: string
}

export const ItemEditAuthContext = createContext<ItemEditAuthContextValue>({
  isAdmin: false,
  userId: ''
})

export function useItemEditAuth(): ItemEditAuthContextValue {
  return useContext(ItemEditAuthContext)
}

// ─── Navigation context (injected by consumers; no-op default) ────────────

export type NavigationContextValue = {
  navigate: (path: string) => void
}

export const NavigationContext = createContext<NavigationContextValue>({
  navigate: (path) => { window.location.href = path },
})

export function useNavigation(): NavigationContextValue {
  return useContext(NavigationContext)
}
