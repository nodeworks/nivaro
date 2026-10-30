import type { ComponentType } from 'react'
import { AttentionPanel } from './AttentionPanel'
import { FeedPanel } from './FeedPanel'
import { FlowPanel } from './FlowPanel'
import { ForecastPanel } from './ForecastPanel'
import { MapPanel } from './MapPanel'
import { PartnersPanel } from './PartnersPanel'
import { PeoplePanel } from './PeoplePanel'
import { SystemPanel } from './SystemPanel'
import { ThroughputPanel } from './ThroughputPanel'
import { TrafficPanel } from './TrafficPanel'
import { WorkloadPanel } from './WorkloadPanel'

/**
 * Every Command Center panel. `key` is stable: saved layouts (CcLayout.order / hidden, per
 * person and per role) name panels by it. `area` is where the default layout puts it; a panel
 * renders its own frame and returns null when it has nothing to show (or the viewer may not
 * see it), so hidden-by-permission panels simply drop out.
 */
export interface PanelDef {
  key: string
  label: string
  area: 'main' | 'rail' | 'bottom'
  /** Shown only to administrators (the server withholds the data anyway). */
  adminOnly?: boolean
  component: ComponentType
}

export const CC_PANELS: PanelDef[] = [
  { key: 'map', label: 'Live map', area: 'main', component: MapPanel },
  { key: 'attention', label: 'Needs attention', area: 'rail', component: AttentionPanel },
  { key: 'flow', label: 'Pipeline flow', area: 'rail', component: FlowPanel },
  { key: 'throughput', label: 'Throughput today', area: 'rail', component: ThroughputPanel },
  { key: 'forecast', label: 'Today’s forecast', area: 'rail', component: ForecastPanel },
  { key: 'workload', label: 'Workload', area: 'rail', component: WorkloadPanel },
  { key: 'people', label: 'People on now', area: 'rail', component: PeoplePanel },
  { key: 'partners', label: 'Partners', area: 'rail', component: PartnersPanel },
  { key: 'traffic', label: 'Traffic', area: 'rail', adminOnly: true, component: TrafficPanel },
  { key: 'system', label: 'System', area: 'rail', adminOnly: true, component: SystemPanel },
  { key: 'feed', label: 'Live feed', area: 'bottom', component: FeedPanel }
]

export const CC_PANEL_KEYS = CC_PANELS.map((p) => p.key)
