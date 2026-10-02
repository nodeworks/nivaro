/**
 * Investigation entry points (drill-down Wave 0):
 *  - every live event gets an "Inspect" action that opens (as a new investigation) the most
 *    specific level it names — its request, else the record a write touched, else the entity;
 *  - the inspector gets "Inspect" for the selected node (entity, caller or down node).
 * Clicking a ticker row itself does the same as the event action (EventTicker.tsx).
 */
import { refForEvent } from '../inspect/format'
import { openInspect } from '../inspect/stack'
import { eventActions } from '../registry/eventActions'
import type { InspectRef } from '../registry/inspectables'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import type { Selection, TrafficEventWire } from '../types'
import { BTN } from './shared'

const ROW_LINK =
  'rounded-sm px-1 text-[11px] font-medium text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function InspectEvent({ ev }: { ev: TrafficEventWire }) {
  const ref = refForEvent(ev)
  return (
    <button
      type='button'
      className={ROW_LINK}
      data-tm-inspect-event={`${ref.kind}:${ref.id}`}
      data-tip={`Investigate this ${ref.kind} here, beside the map`}
      onClick={(e) => {
        e.stopPropagation()
        openInspect(ref, { root: true })
      }}
    >
      Inspect
    </button>
  )
}

register(eventActions, {
  id: 'inspect',
  order: 5,
  applies: () => true,
  Component: InspectEvent
})

/** The level a selected node opens; null for a lane (nothing to drill into). */
export function refForSelection(sel: Selection): InspectRef | null {
  if (sel.kind === 'entity') return { kind: 'entity', id: sel.id }
  if (sel.kind === 'caller') return { kind: 'caller', id: sel.id }
  if (sel.kind === 'down') return { kind: 'down', id: sel.id }
  return null
}

function InspectNode({ sel }: { sel: Selection }) {
  const ref = refForSelection(sel)
  if (!ref) return null
  return (
    <button
      type='button'
      className={BTN}
      data-tm-inspect-node={`${ref.kind}:${ref.id}`}
      data-tip='Open this node in the investigation panel'
      onClick={() => openInspect(ref, { root: true })}
    >
      Inspect
    </button>
  )
}

register(inspectorActions, {
  id: 'inspect',
  order: 5,
  applies: (sel) => sel.kind !== 'lane',
  Component: InspectNode
})
