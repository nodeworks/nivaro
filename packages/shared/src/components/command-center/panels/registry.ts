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
 * person and per role) name panels by it. `area` is the slot it lives in; the shell arranges the
 * slots for the screen (layout.ts arrangeBoard):
 *   lead   — "what needs someone now": its own left column on very wide screens, the top of the
 *            rail beside the map on desktop, first of all on a phone
 *   main   — the big column (the map)
 *   bottom — under the map in the big column (the live feed strip)
 *   rail   — the right-hand column
 * Within a slot the person's saved order applies (Customise). A panel renders its own frame and
 * returns null when it has nothing to show (or the viewer may not see it), so hidden-by-
 * permission panels simply drop out. `hint` is the one-line description Customise shows.
 */
export interface PanelDef {
  key: string
  label: string
  area: 'lead' | 'main' | 'rail' | 'bottom'
  hint?: string
  /** Shown only to administrators (the server withholds the data anyway). */
  adminOnly?: boolean
  component: ComponentType
}

export const CC_PANELS: PanelDef[] = [
  {
    key: 'map',
    label: 'Live map',
    area: 'main',
    hint: 'Where the work is, and who is on',
    component: MapPanel
  },
  {
    key: 'attention',
    label: 'Needs attention',
    area: 'lead',
    hint: 'Breached and stuck work, failing partners, gaps',
    component: AttentionPanel
  },
  {
    key: 'flow',
    label: 'Pipeline flow',
    area: 'rail',
    hint: 'Open records in each state',
    component: FlowPanel
  },
  {
    key: 'throughput',
    label: 'Throughput today',
    area: 'rail',
    hint: 'Moves per hour against yesterday',
    component: ThroughputPanel
  },
  {
    key: 'forecast',
    label: 'Today’s forecast',
    area: 'rail',
    hint: 'Arrivals and completions against the usual day',
    component: ForecastPanel
  },
  {
    key: 'workload',
    label: 'Workload',
    area: 'lead',
    hint: 'Who is over their usual load',
    component: WorkloadPanel
  },
  {
    key: 'people',
    label: 'People on now',
    area: 'rail',
    hint: 'Who is signed in, by office or region',
    component: PeoplePanel
  },
  {
    key: 'partners',
    label: 'Partners',
    area: 'rail',
    hint: 'Health of connected systems',
    component: PartnersPanel
  },
  {
    key: 'traffic',
    label: 'Traffic',
    area: 'rail',
    adminOnly: true,
    hint: 'Live API traffic (administrators)',
    component: TrafficPanel
  },
  {
    key: 'system',
    label: 'System',
    area: 'rail',
    adminOnly: true,
    hint: 'Database, jobs and errors (administrators)',
    component: SystemPanel
  },
  {
    key: 'feed',
    label: 'Live feed',
    area: 'bottom',
    hint: 'The latest changes you can see',
    component: FeedPanel
  }
]

export const CC_PANEL_KEYS = CC_PANELS.map((p) => p.key)
