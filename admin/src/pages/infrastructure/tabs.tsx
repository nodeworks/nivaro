import type { ComponentType } from 'react'
import { ContainersTab } from './ContainersTab'
import { ImagesTab } from './ImagesTab'
import { OverviewTab } from './OverviewTab'
import { ProvenanceTab } from './ProvenanceTab'
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
  { id: 'containers', label: 'Containers', component: ContainersTab },
  { id: 'volumes', label: 'Volumes', component: VolumesTab },
  { id: 'images', label: 'Images', component: ImagesTab },
  { id: 'provenance', label: 'Provenance', component: ProvenanceTab }
]
