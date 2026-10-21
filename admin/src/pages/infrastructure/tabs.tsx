import type { ComponentType } from 'react'
import { OverviewTab } from './OverviewTab'

/**
 * Infrastructure page tabs, in display order. Each area adds one entry (and its own file in this
 * folder); `id` is the `?tab=` value.
 */
export interface InfraTab {
  id: string
  label: string
  component: ComponentType
}

export const INFRA_TABS: InfraTab[] = [
  { id: 'overview', label: 'Overview', component: OverviewTab }
]
