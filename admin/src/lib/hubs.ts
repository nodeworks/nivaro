import { Activity, Database, HeartPulse, type LucideIcon } from 'lucide-react'

/**
 * Hub pages: several related screens behind one nav entry, one tab per screen
 * (components/hub-page.tsx renders them; pages/OpsHubs.tsx maps each tab to
 * its screen). This file is data only, so the layout and nav can ask "is this
 * path a hub tab?" without loading any screen.
 *
 * A tab is a PATH segment under the hub's base, never a `?tab=` param, so each
 * tab keeps its own query string. `legacy` is the standalone path the screen
 * had before the merge: App.tsx redirects it onto the tab (query and hash
 * kept).
 */
export type HubTabDef = {
  /** Path segment under the hub's base; '' for the first tab. */
  path: string
  label: string
  /** The screen's old standalone path, redirected here. */
  legacy?: string
}

export type HubDef = {
  base: string
  title: string
  hint: string
  icon: LucideIcon
  tabs: HubTabDef[]
}

export const JOBS_HUB: HubDef = {
  base: '/jobs',
  title: 'Jobs',
  hint: 'Scheduled and background work: what runs, when it runs, and how it went.',
  icon: Activity,
  tabs: [
    { path: '', label: 'Runs & schedules', legacy: '/background-jobs' },
    { path: 'timeline', label: 'Timeline', legacy: '/cron-timeline' },
    { path: 'calendar', label: 'Calendar', legacy: '/ops-calendar' },
    { path: 'tasks', label: 'Repair tasks', legacy: '/ops-tasks' }
  ]
}

export const DATABASE_HUB: HubDef = {
  base: '/database',
  title: 'Database',
  hint: 'SQL Server, Redis and this process: live diagnostics, tuning and checks.',
  icon: Database,
  tabs: [
    { path: '', label: 'Overview', legacy: '/db-health' },
    { path: 'tuning', label: 'Tuning', legacy: '/db-tuning' },
    { path: 'sql-checks', label: 'SQL checks', legacy: '/sql-checks' },
    { path: 'redis', label: 'Redis keys', legacy: '/ops-redis' }
  ]
}

export const HEALTH_HUB: HubDef = {
  base: '/health',
  title: 'Health',
  hint: 'Uptime and checks for this instance, and the monitoring stack that watches it.',
  icon: HeartPulse,
  tabs: [
    { path: '', label: 'Status' },
    { path: 'monitors', label: 'Monitors', legacy: '/monitors' },
    { path: 'telemetry', label: 'Telemetry', legacy: '/telemetry' }
  ]
}

export const HUBS: HubDef[] = [JOBS_HUB, DATABASE_HUB, HEALTH_HUB]

export const hubTabPath = (hub: HubDef, tab: HubTabDef) =>
  tab.path ? `${hub.base}/${tab.path}` : hub.base

/** The hub and tab a pathname shows, or null when it is not a hub tab. */
export function hubForPath(pathname: string): { hub: HubDef; tab: HubTabDef } | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  for (const hub of HUBS) {
    if (path !== hub.base && !path.startsWith(`${hub.base}/`)) continue
    const tab = hub.tabs.find((t) => hubTabPath(hub, t) === path)
    if (tab) return { hub, tab }
  }
  return null
}
