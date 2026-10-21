import type { ComponentType } from 'react'
import { GitlabTab } from './GitlabTab'
import { OverviewTab } from './OverviewTab'
import { ProxyTab } from './ProxyTab'
import { ResourcesTab } from './ResourcesTab'

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
  { id: 'proxy', label: 'Proxy', component: ProxyTab },
  { id: 'resources', label: 'Resources', component: ResourcesTab },
  { id: 'gitlab', label: 'GitLab', component: GitlabTab }
]
