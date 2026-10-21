import type { ComponentType } from 'react'
import { HostsTab } from './HostsTab'
import { LogsTab } from './LogsTab'
import { OverviewTab } from './OverviewTab'
import { RebootTab } from './RebootTab'

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
  { id: 'hosts', label: 'Hosts', component: HostsTab },
  { id: 'reboot', label: 'Reboot', component: RebootTab },
  { id: 'logs', label: 'Logs', component: LogsTab }
]
