import type { ComponentType } from 'react'
import { FaultsTab } from './FaultsTab'
import { GameDaysTab } from './GameDaysTab'
import { MatrixTab } from './MatrixTab'
import { MonkeyTab } from './MonkeyTab'
import { RunsTab } from './RunsTab'
import { SettingsTab } from './SettingsTab'
import { TrendsTab } from './TrendsTab'

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
  { id: 'runs', label: 'Runs', component: RunsTab },
  { id: 'matrix', label: 'Matrix', component: MatrixTab },
  { id: 'trends', label: 'Trends', component: TrendsTab },
  { id: 'gamedays', label: 'Game days', component: GameDaysTab },
  { id: 'monkey', label: 'Monkey', component: MonkeyTab },
  { id: 'settings', label: 'Settings', component: SettingsTab }
]
