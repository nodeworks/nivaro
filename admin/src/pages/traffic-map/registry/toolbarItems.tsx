import type { ComponentType } from 'react'
import { byOrder, FeatureBoundary, type Registered } from './registry'

/** Header toolbar extras (lenses, toggles), rendered just before the Pause button. */
export interface ToolbarItem extends Registered {
  Component: ComponentType
}

export const toolbarItems: ToolbarItem[] = []

export function ToolbarItems() {
  if (toolbarItems.length === 0) return null
  return (
    <>
      {byOrder(toolbarItems).map((t) => (
        <FeatureBoundary key={t.id} id={t.id}>
          <t.Component />
        </FeatureBoundary>
      ))}
    </>
  )
}
