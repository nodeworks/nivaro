import type { ComponentType } from 'react'
import type { InspectPanelProps, InspectRef } from './inspectables'
import { byOrder, FeatureBoundary, type Registered, safeApplies } from './registry'

/**
 * Sections rendered under every investigation panel (the Related rail — Task 7). Each gets the
 * same props as the panel above it.
 */
export interface InspectFooter extends Registered {
  applies?(ref: InspectRef): boolean
  Component: ComponentType<InspectPanelProps>
}

export const inspectFooters: InspectFooter[] = []

export function InspectFooters(props: InspectPanelProps) {
  if (inspectFooters.length === 0) return null
  const ref = props.inspectRef
  const list = byOrder(inspectFooters).filter(
    (f) => !f.applies || safeApplies(() => f.applies?.(ref) ?? true)
  )
  if (list.length === 0) return null
  const resetKey = `${ref.kind}:${ref.id}`
  return (
    <div className='grid gap-3 border-t border-[var(--tm-line-2)] pt-3' data-tm-inspect-footers=''>
      {list.map((f) => (
        <FeatureBoundary key={f.id} id={f.id} resetKey={resetKey}>
          <f.Component {...props} />
        </FeatureBoundary>
      ))}
    </div>
  )
}
