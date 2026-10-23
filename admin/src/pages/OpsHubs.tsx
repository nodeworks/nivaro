import { Activity, Database, HeartPulse } from 'lucide-react'
import { lazy } from 'react'
import { HubPage, type HubTab } from '@/components/hub-page'

/**
 * The Operations hubs: Jobs, Database and Health. Each was several sidebar
 * entries (Background Jobs, Cron Timeline, Ops Calendar, Ops Tasks / DB &
 * Runtime, Database tuning, SQL checks, Redis Keys / Health, Monitors,
 * Telemetry); the old paths redirect onto the tabs (App.tsx). Every tab stays
 * its own lazy chunk.
 */

const JOBS_TABS: HubTab[] = [
  { path: '', label: 'Runs & schedules', component: lazy(() => import('@/pages/BackgroundJobs')) },
  {
    path: 'timeline',
    label: 'Timeline',
    component: lazy(() =>
      import('@/pages/CronTimeline').then((m) => ({ default: m.CronTimelinePage }))
    )
  },
  { path: 'calendar', label: 'Calendar', component: lazy(() => import('@/pages/OpsCalendar')) },
  { path: 'tasks', label: 'Repair tasks', component: lazy(() => import('@/pages/OpsTasks')) }
]

const DATABASE_TABS: HubTab[] = [
  {
    path: '',
    label: 'Overview',
    component: lazy(() => import('@/pages/DbHealth').then((m) => ({ default: m.DbHealthPage })))
  },
  { path: 'tuning', label: 'Tuning', component: lazy(() => import('@/pages/DbTuning')) },
  { path: 'sql-checks', label: 'SQL checks', component: lazy(() => import('@/pages/SqlChecks')) },
  {
    path: 'redis',
    label: 'Redis keys',
    component: lazy(() => import('@/pages/OpsRedis').then((m) => ({ default: m.OpsRedisPage })))
  }
]

const HEALTH_TABS: HubTab[] = [
  {
    path: '',
    label: 'Status',
    component: lazy(() =>
      import('@/pages/HealthDashboard').then((m) => ({ default: m.HealthDashboardPage }))
    )
  },
  { path: 'monitors', label: 'Monitors', component: lazy(() => import('@/pages/Monitors')) },
  {
    path: 'telemetry',
    label: 'Telemetry',
    component: lazy(() => import('@/pages/Telemetry').then((m) => ({ default: m.TelemetryPage })))
  }
]

export function JobsHub() {
  return (
    <HubPage
      icon={Activity}
      title='Jobs'
      hint='Scheduled and background work: what runs, when it runs, and how it went.'
      base='/jobs'
      tabs={JOBS_TABS}
    />
  )
}

export function DatabaseHub() {
  return (
    <HubPage
      icon={Database}
      title='Database'
      hint='SQL Server, Redis and this process: live diagnostics, tuning and checks.'
      base='/database'
      tabs={DATABASE_TABS}
    />
  )
}

export function HealthHub() {
  return (
    <HubPage
      icon={HeartPulse}
      title='Health'
      hint='Is this instance up, are its checks passing, and is the monitoring stack receiving.'
      base='/health'
      tabs={HEALTH_TABS}
    />
  )
}
