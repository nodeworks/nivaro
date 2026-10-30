import type { ComponentType } from 'react'
import { InstanceSection } from './InstanceGrid'
import { PinnedWidgetsSection } from './PinnedWidgets'
import { QuickActionsSection } from './QuickActions'
import { RecentlyViewedSection } from './RecentlyViewed'
import { type OverviewSectionMeta, SECTION_META } from './sections-meta'
import { YourWorkSection } from './YourWork'

/**
 * The Overview section REGISTRY: every section the page can show, with its component.
 *
 *   { key, title, component, adminOnly?, defaultOrder, defaultVisible, column, phoneFirst? }
 *
 * The data half lives in sections-meta.ts (tested without React); this file adds components.
 * `stats` and `activity` are drawn by the page itself (they share its live feed), so they carry
 * a marker component. A key with no component renders nothing and is left out of Customize —
 * which is how the agent-built sections in ./sections/ stay dormant until mounted:
 *
 *   // in this file, once ./sections/NeedsYou.tsx exists:
 *   import { NeedsYouSection } from './sections/NeedsYou'
 *   ...SECTION_COMPONENTS: { 'needs-you': NeedsYouSection, ... }
 *
 * or at run time (an extension, a test): registerOverviewSection('needs-you', NeedsYouSection).
 * Components receive OverviewSectionProps and must handle their own loading, empty and error
 * states (skeleton shaped like the content, an empty state with a next step).
 */

export interface OverviewSectionProps {
  userId: string
  isAdmin: boolean
}

export type OverviewSectionComponent = ComponentType<OverviewSectionProps>

export interface OverviewSectionDef extends OverviewSectionMeta {
  component?: OverviewSectionComponent
}

/** Drawn by Dashboard.tsx itself (shared live feed + figures); never rendered from here. */
export const PAGE_DRAWN = new Set(['stats', 'activity'])
const PageDrawn: OverviewSectionComponent = () => null

const SECTION_COMPONENTS: Record<string, OverviewSectionComponent | undefined> = {
  stats: PageDrawn,
  activity: PageDrawn,
  'quick-actions': QuickActionsSection,
  recent: RecentlyViewedSection,
  'pinned-widgets': PinnedWidgetsSection,
  'your-work': YourWorkSection,
  instance: InstanceSection,
  // Mounted by the lead once ./sections/ lands:
  'needs-you': undefined,
  health: undefined,
  timeline: undefined,
  problems: undefined,
  'config-changes': undefined,
  'people-waiting': undefined,
  usage: undefined,
  following: undefined
}

const runtime = new Map<string, OverviewSectionComponent>()

/** Mount (or replace) a section's component at run time. Unknown keys are ignored. */
export function registerOverviewSection(key: string, component: OverviewSectionComponent): void {
  if (SECTION_META.some((m) => m.key === key)) runtime.set(key, component)
}

export function overviewSections(): OverviewSectionDef[] {
  return SECTION_META.map((m) => ({
    ...m,
    component: runtime.get(m.key) ?? SECTION_COMPONENTS[m.key]
  }))
}

/** The keys that can draw something right now. */
export function availableSectionKeys(): Set<string> {
  return new Set(
    overviewSections()
      .filter((s) => !!s.component)
      .map((s) => s.key)
  )
}
