import { lazy } from 'react'
import { HubPage } from '@/components/hub-page'
import { DATABASE_HUB, HEALTH_HUB, JOBS_HUB } from '@/lib/hubs'

/**
 * The Operations hubs (lib/hubs.ts): Jobs, Database and Health. Each was
 * several sidebar entries; the old paths redirect onto the tabs (App.tsx).
 * Every tab stays its own lazy chunk.
 */

const JOBS_SCREENS = {
  '': lazy(() => import('@/pages/BackgroundJobs')),
  timeline: lazy(() =>
    import('@/pages/CronTimeline').then((m) => ({ default: m.CronTimelinePage }))
  ),
  calendar: lazy(() => import('@/pages/OpsCalendar')),
  tasks: lazy(() => import('@/pages/OpsTasks'))
}

const DATABASE_SCREENS = {
  '': lazy(() => import('@/pages/DbHealth').then((m) => ({ default: m.DbHealthPage }))),
  tuning: lazy(() => import('@/pages/DbTuning')),
  'sql-checks': lazy(() => import('@/pages/SqlChecks')),
  redis: lazy(() => import('@/pages/OpsRedis').then((m) => ({ default: m.OpsRedisPage })))
}

const HEALTH_SCREENS = {
  '': lazy(() =>
    import('@/pages/HealthDashboard').then((m) => ({ default: m.HealthDashboardPage }))
  ),
  monitors: lazy(() => import('@/pages/Monitors')),
  telemetry: lazy(() => import('@/pages/Telemetry').then((m) => ({ default: m.TelemetryPage })))
}

export function JobsHub() {
  return <HubPage hub={JOBS_HUB} components={JOBS_SCREENS} />
}

export function DatabaseHub() {
  return <HubPage hub={DATABASE_HUB} components={DATABASE_SCREENS} />
}

export function HealthHub() {
  return <HubPage hub={HEALTH_HUB} components={HEALTH_SCREENS} />
}
