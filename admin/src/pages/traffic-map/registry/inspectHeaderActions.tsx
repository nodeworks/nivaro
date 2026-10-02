import type { ComponentType } from 'react'
import type { InspectPanelProps, InspectRef } from './inspectables'
import { byOrder, FeatureBoundary, type Registered, safeApplies } from './registry'

/**
 * Small buttons in the investigation panel header, for the current level (rewind, explain,
 * export, live tail, notebook — Tasks 7/8). Keep each one a real <button> with a
 * `data-tm-inspect-*` hook.
 */
export interface InspectHeaderAction extends Registered {
  applies?(ref: InspectRef): boolean
  Component: ComponentType<InspectPanelProps>
}

export const inspectHeaderActions: InspectHeaderAction[] = []

export function InspectHeaderActions(props: InspectPanelProps) {
  if (inspectHeaderActions.length === 0) return null
  const ref = props.inspectRef
  const list = byOrder(inspectHeaderActions).filter(
    (a) => !a.applies || safeApplies(() => a.applies?.(ref) ?? true)
  )
  if (list.length === 0) return null
  const resetKey = `${ref.kind}:${ref.id}`
  return (
    <span className='inline-flex items-center gap-1' data-tm-inspect-header-actions=''>
      {list.map((a) => (
        <FeatureBoundary key={a.id} id={a.id} resetKey={resetKey}>
          <a.Component {...props} />
        </FeatureBoundary>
      ))}
    </span>
  )
}
