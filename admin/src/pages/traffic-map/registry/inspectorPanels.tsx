import type { ComponentType } from 'react'
import type { InspectorData } from '../Inspector'
import type { Selection } from '../types'
import { byOrder, FeatureBoundary, type Registered, safeApplies } from './registry'

/**
 * Inspector panels: extra sections a feature adds to the inspector for the selections it
 * `applies` to. Rendered after the built-in live sections; with `history: true` also in the
 * 1h/6h/24h view (after its sections). Use the exported `Section` / `Empty` from Inspector.
 */
export interface InspectorPanel extends Registered {
  applies(sel: Selection, d: InspectorData): boolean
  /** Render in the live view (default true). */
  live?: boolean
  /** Render in the history view (default false). */
  history?: boolean
  Component: ComponentType<{ sel: Selection; d: InspectorData }>
}

export const inspectorPanels: InspectorPanel[] = []

export function InspectorPanels({
  sel,
  d,
  mode
}: {
  sel: Selection
  d: InspectorData
  mode: 'live' | 'history'
}) {
  if (inspectorPanels.length === 0) return null
  const resetKey = `${sel.kind}:${sel.id}`
  return (
    <>
      {byOrder(inspectorPanels)
        .filter((p) => (mode === 'live' ? p.live !== false : p.history === true))
        .filter((p) => safeApplies(() => p.applies(sel, d)))
        .map((p) => (
          <FeatureBoundary key={p.id} id={p.id} resetKey={resetKey}>
            <p.Component sel={sel} d={d} />
          </FeatureBoundary>
        ))}
    </>
  )
}
