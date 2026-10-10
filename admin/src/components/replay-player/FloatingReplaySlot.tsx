/**
 * App-level slot for the floating replay (#1401). Only the tiny store loads
 * with the layout; the window and the player load the first time a replay is
 * floated.
 */
import { lazy, Suspense } from 'react'
import { useFloatingReplay } from './floating-store'

const FloatingReplayHost = lazy(() =>
  import('./FloatingReplay').then((m) => ({ default: m.FloatingReplayHost }))
)

export function FloatingReplaySlot() {
  const floating = useFloatingReplay()
  if (!floating) return null
  return (
    <Suspense fallback={null}>
      <FloatingReplayHost />
    </Suspense>
  )
}
