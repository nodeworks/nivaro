import type { ComponentType } from 'react'
import { HealthTab } from './HealthTab'
import { OverviewTab } from './OverviewTab'
import { SecretsTab } from './SecretsTab'
import { StacksTab } from './StacksTab'
import { SwarmTab } from './SwarmTab'
import { UpdatesTab } from './UpdatesTab'

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
  { id: 'overview', label: 'Overview', component: OverviewTab },
  { id: 'stacks', label: 'Stacks', component: StacksTab },
  { id: 'updates', label: 'Updates', component: UpdatesTab },
  { id: 'health', label: 'Health', component: HealthTab },
  { id: 'swarm', label: 'Swarm', component: SwarmTab },
  { id: 'secrets', label: 'Secrets', component: SecretsTab }
]
