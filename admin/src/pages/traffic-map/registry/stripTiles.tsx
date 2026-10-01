import type { ComponentType } from 'react'
import { byOrder, FeatureBoundary, type Registered } from './registry'

/**
 * Extra summary-strip tiles, appended after the built-in six. Each reads what it needs from
 * useTrafficMap(); render a `bg-[var(--tm-card)]` cell so the strip's 1px grid lines hold.
 */
export interface StripTile extends Registered {
  Component: ComponentType
}

export const stripTiles: StripTile[] = []

export function StripTiles() {
  if (stripTiles.length === 0) return null
  return (
    <>
      {byOrder(stripTiles).map((t) => (
        <FeatureBoundary key={t.id} id={t.id}>
          <t.Component />
        </FeatureBoundary>
      ))}
    </>
  )
}
