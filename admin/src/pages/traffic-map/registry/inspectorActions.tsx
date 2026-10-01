import type { ComponentType } from 'react'
import type { InspectorData } from '../Inspector'
import type { Selection } from '../types'
import { byOrder, FeatureBoundary, type Registered, safeApplies } from './registry'

/**
 * Inspector header actions: small buttons in one compact row right under the inspector header
 * (open in…, explain, pause, alert). The row is not rendered when no action applies.
 */
export interface InspectorAction extends Registered {
  applies(sel: Selection, d: InspectorData): boolean
  Component: ComponentType<{ sel: Selection; d: InspectorData }>
}

export const inspectorActions: InspectorAction[] = []

export function InspectorActions({ sel, d }: { sel: Selection; d: InspectorData }) {
  if (inspectorActions.length === 0) return null
  const list = byOrder(inspectorActions).filter((a) => safeApplies(() => a.applies(sel, d)))
  if (list.length === 0) return null
  const resetKey = `${sel.kind}:${sel.id}`
  return (
    <div
      className='flex flex-wrap items-center gap-1.5 border-b border-[var(--tm-line-2)] px-3.5 py-1.5'
      data-tm-inspector-actions=''
    >
      {list.map((a) => (
        <FeatureBoundary key={a.id} id={a.id} resetKey={resetKey}>
          <a.Component sel={sel} d={d} />
        </FeatureBoundary>
      ))}
    </div>
  )
}
