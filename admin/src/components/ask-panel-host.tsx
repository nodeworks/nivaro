import { type AiStreamSubscribe, AskContextProvider, AskPanel } from '@nivaro/shared'
import type { ReactNode } from 'react'
import { getSocket } from '@/lib/socket'

// Answers stream over the shared admin socket (#688), the same transport the
// Ask page uses: the route emits to the user's own room and the panel pairs
// the events to its stream id.
const subscribeAi: AiStreamSubscribe = (event, handler) => {
  const s = getSocket()
  s.on(event, handler)
  return () => {
    s.off(event, handler)
  }
}

/**
 * Ask AI from anywhere (#1835): one context provider above the page outlet
 * (pages publish what they show) and one panel, opened with ⌘J or the
 * command palette's "Ask…". Mount inside a NivaroProvider and NavigationContext.
 */
export function AskPanelHost({ children }: { children: ReactNode }) {
  return (
    <AskContextProvider>
      {children}
      <AskPanel subscribe={subscribeAi} connected={() => getSocket().connected} />
    </AskContextProvider>
  )
}
