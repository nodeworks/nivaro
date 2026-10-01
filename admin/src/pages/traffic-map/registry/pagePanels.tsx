import type { ComponentType } from 'react'
import { byOrder, FeatureBoundary, type Registered } from './registry'

/**
 * Page-level panels (in-flight requests, compare views…) in a grid row below the live events /
 * hot entities row. The row is not rendered when none is registered. Use the same card frame as
 * the ticker: `rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]`.
 */
export interface PagePanel extends Registered {
  Component: ComponentType
}

export const pagePanels: PagePanel[] = []

export function PagePanels() {
  if (pagePanels.length === 0) return null
  return (
    <div
      className='mt-3.5 grid items-start gap-3.5 min-[1100px]:grid-cols-2'
      data-tm-page-panels=''
    >
      {byOrder(pagePanels).map((p) => (
        <FeatureBoundary key={p.id} id={p.id}>
          <p.Component />
        </FeatureBoundary>
      ))}
    </div>
  )
}
