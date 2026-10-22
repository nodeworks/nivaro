import type { ComponentType } from 'react'
import { FaultsTab } from './FaultsTab'
import { RunsTab } from './RunsTab'

/**
 * Chaos console tabs (#2827), in display order. Each chaos area adds ONE entry here and its own
 * file in this folder; `id` is the `?tab=` value. The page renders `component` under the gate
 * strip; a tab gets no props — it reads `useSearchParams()` for its own deep links (`?run=`).
 */
export interface ChaosTab {
  id: string
  label: string
  component: ComponentType
}

export const CHAOS_TABS: ChaosTab[] = [
  { id: 'faults', label: 'Faults', component: FaultsTab },
  { id: 'runs', label: 'Runs', component: RunsTab }
]
