import type { ComponentType } from 'react'
import type { TrafficEventWire } from '../types'
import { FeatureBoundary, type Registered, safeApplies } from './registry'

/**
 * Per-row trailing actions in the live events list (open the logged request, show the event
 * path…). Keep each one small and keyboard reachable (a real <button> / <a>).
 */
export interface EventAction extends Registered {
  applies(ev: TrafficEventWire): boolean
  Component: ComponentType<{ ev: TrafficEventWire }>
}

export const eventActions: EventAction[] = []

export function EventActions({ ev }: { ev: TrafficEventWire }) {
  if (eventActions.length === 0) return null
  const list = eventActions.filter((a) => safeApplies(() => a.applies(ev)))
  if (list.length === 0) return null
  return (
    <span className='inline-flex shrink-0 items-center gap-1' data-tm-event-actions=''>
      {list.map((a) => (
        <FeatureBoundary key={a.id} id={a.id}>
          <a.Component ev={ev} />
        </FeatureBoundary>
      ))}
    </span>
  )
}
