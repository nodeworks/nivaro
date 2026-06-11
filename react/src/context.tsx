import type { NivaroClient } from '@nivaro/sdk'
import React, { createContext, useContext } from 'react'

type NivaroFormContextValue = {
  client: NivaroClient
}

const NivaroFormContext = createContext<NivaroFormContextValue | null>(null)

/**
 * Provides a NivaroClient to descendant form hooks/components so they don't
 * have to be passed a client explicitly. Optional — every hook also accepts a
 * client argument directly.
 */
export function NivaroProvider({
  client,
  children
}: {
  client: NivaroClient
  children: React.ReactNode
}) {
  return <NivaroFormContext.Provider value={{ client }}>{children}</NivaroFormContext.Provider>
}

/** Read the client from context. Throws if used outside <NivaroProvider>. */
export function useNivaroClient(): NivaroClient {
  const ctx = useContext(NivaroFormContext)
  if (!ctx) throw new Error('useNivaroClient must be used within <NivaroProvider>')
  return ctx.client
}

/** Internal: read the client from context, returning null if absent (no throw). */
export function useOptionalNivaroClient(): NivaroClient | null {
  const ctx = useContext(NivaroFormContext)
  return ctx?.client ?? null
}
