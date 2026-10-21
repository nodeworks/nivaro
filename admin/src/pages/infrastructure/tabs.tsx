import type { ComponentType } from 'react'
import { ContainersTab } from './ContainersTab'
import { GitlabTab } from './GitlabTab'
import { HealthTab } from './HealthTab'
import { HostsTab } from './HostsTab'
import { ImagesTab } from './ImagesTab'
import { LogsTab } from './LogsTab'
import { OverviewTab } from './OverviewTab'
import { ProvenanceTab } from './ProvenanceTab'
import { ProxyTab } from './ProxyTab'
import { RebootTab } from './RebootTab'
import { ResourcesTab } from './ResourcesTab'
import { SecretsTab } from './SecretsTab'
import { StacksTab } from './StacksTab'
import { SwarmTab } from './SwarmTab'
import { UpdatesTab } from './UpdatesTab'
import { VolumesTab } from './VolumesTab'

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
  { id: 'secrets', label: 'Secrets', component: SecretsTab },
  { id: 'containers', label: 'Containers', component: ContainersTab },
  { id: 'volumes', label: 'Volumes', component: VolumesTab },
  { id: 'images', label: 'Images', component: ImagesTab },
  { id: 'provenance', label: 'Provenance', component: ProvenanceTab },
  { id: 'proxy', label: 'Proxy', component: ProxyTab },
  { id: 'resources', label: 'Resources', component: ResourcesTab },
  { id: 'reboot', label: 'Reboot', component: RebootTab },
  { id: 'logs', label: 'Logs', component: LogsTab },
  { id: 'hosts', label: 'Hosts', component: HostsTab },
  { id: 'gitlab', label: 'GitLab', component: GitlabTab }
]
