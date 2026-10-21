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

/** The groups the tab strip divides into (and the narrow-screen menu lists as headings). */
export type InfraGroup =
  | 'Overview'
  | 'Workloads'
  | 'Swarm'
  | 'Hosts'
  | 'Images and storage'
  | 'Proxy and build'

/**
 * Infrastructure page tabs, in display order, grouped. Each area adds one entry (and its own file
 * in this folder) inside its group; `id` is the `?tab=` value.
 */
export interface InfraTab {
  id: string
  label: string
  group: InfraGroup
  component: ComponentType
}

export const INFRA_TABS: InfraTab[] = [
  { id: 'overview', label: 'Overview', group: 'Overview', component: OverviewTab },
  { id: 'stacks', label: 'Stacks', group: 'Workloads', component: StacksTab },
  { id: 'containers', label: 'Containers', group: 'Workloads', component: ContainersTab },
  { id: 'updates', label: 'Updates', group: 'Workloads', component: UpdatesTab },
  { id: 'health', label: 'Health', group: 'Workloads', component: HealthTab },
  { id: 'swarm', label: 'Swarm', group: 'Swarm', component: SwarmTab },
  { id: 'secrets', label: 'Secrets', group: 'Swarm', component: SecretsTab },
  { id: 'hosts', label: 'Hosts', group: 'Hosts', component: HostsTab },
  { id: 'resources', label: 'Resources', group: 'Hosts', component: ResourcesTab },
  { id: 'reboot', label: 'Reboot', group: 'Hosts', component: RebootTab },
  { id: 'logs', label: 'Logs', group: 'Hosts', component: LogsTab },
  { id: 'volumes', label: 'Volumes', group: 'Images and storage', component: VolumesTab },
  { id: 'images', label: 'Images', group: 'Images and storage', component: ImagesTab },
  { id: 'provenance', label: 'Provenance', group: 'Images and storage', component: ProvenanceTab },
  { id: 'proxy', label: 'Proxy', group: 'Proxy and build', component: ProxyTab },
  { id: 'gitlab', label: 'GitLab', group: 'Proxy and build', component: GitlabTab }
]
