import type { ComponentType } from 'react'
import { ConfigChangesSection } from './config-changes'
import { FollowingSection } from './following'
import { HealthSection } from './health'
import type { SectionProps } from './kit'
import { NeedsYouSection } from './needs-you'
import { PeopleWaitingSection } from './people-waiting'
import { ProblemsSection } from './problems'
import { TimelineSection } from './timeline'
import { UsageSection } from './usage'

/**
 * The Overview page's sections (route `/`). Each component fetches its own data
 * (`['overview', key, …]` query keys, GET /api/overview/<key>), draws its own skeleton, empty
 * and error states, and renders its own heading unless `hideTitle` is passed. `adminOnly`
 * sections are also refused server-side (403) for anyone else — the flag only saves a request.
 * NeedsYouSection renders nothing when nothing is waiting.
 */
export interface OverviewSectionDef {
  key:
    | 'needs-you'
    | 'health'
    | 'timeline'
    | 'problems'
    | 'config-changes'
    | 'people-waiting'
    | 'usage'
    | 'following'
  title: string
  component: ComponentType<SectionProps>
  adminOnly: boolean
}

export const OVERVIEW_SECTIONS: OverviewSectionDef[] = [
  { key: 'needs-you', title: 'Needs you', component: NeedsYouSection, adminOnly: false },
  { key: 'health', title: 'System', component: HealthSection, adminOnly: false },
  { key: 'timeline', title: 'Today on this instance', component: TimelineSection, adminOnly: true },
  { key: 'problems', title: 'Top problems', component: ProblemsSection, adminOnly: true },
  {
    key: 'config-changes',
    title: 'Recent config changes',
    component: ConfigChangesSection,
    adminOnly: true
  },
  {
    key: 'people-waiting',
    title: 'People waiting for access',
    component: PeopleWaitingSection,
    adminOnly: true
  },
  { key: 'usage', title: 'Usage today', component: UsageSection, adminOnly: true },
  { key: 'following', title: 'Following', component: FollowingSection, adminOnly: false }
]

export type { SectionProps as OverviewSectionProps } from './kit'
export {
  ConfigChangesSection,
  FollowingSection,
  HealthSection,
  NeedsYouSection,
  PeopleWaitingSection,
  ProblemsSection,
  TimelineSection,
  UsageSection
}
