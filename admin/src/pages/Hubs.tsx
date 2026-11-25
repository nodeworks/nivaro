import { QueryErrorState } from '@nivaro/shared'
import { CircleSlash } from 'lucide-react'
import type { ComponentType } from 'react'
import { Navigate, useLocation } from 'react-router'
import { HubPage } from '@/components/hub-page'
import { Skeleton } from '@/components/ui/skeleton'
import { hubForPath } from '@/lib/hubs'
// React's lazy with the after-deploy recovery every other route has (lib/route-preload.tsx).
import { lazy } from '@/lib/route-preload'
import { useServerFeaturesQuery } from '@/lib/useServerFeatures'

/**
 * Every hub's screens (lib/hubs.ts holds the hubs themselves). App.tsx routes
 * each hub tab here; HubRoute picks the hub from the path. Every screen stays
 * its own lazy chunk — this module only holds the loaders.
 */

type Screens = Record<string, ComponentType>

const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })))

const SCREENS: Record<string, Screens> = {
  '/jobs': {
    '': lazy(() => import('@/pages/BackgroundJobs')),
    timeline: page(() => import('@/pages/CronTimeline'), 'CronTimelinePage'),
    calendar: lazy(() => import('@/pages/OpsCalendar')),
    tasks: lazy(() => import('@/pages/OpsTasks'))
  },
  '/database': {
    '': page(() => import('@/pages/DbHealth'), 'DbHealthPage'),
    connections: lazy(() => import('@/pages/DbConnections')),
    tuning: lazy(() => import('@/pages/DbTuning')),
    'sql-checks': lazy(() => import('@/pages/SqlChecks')),
    redis: page(() => import('@/pages/OpsRedis'), 'OpsRedisPage'),
    caches: lazy(() => import('@/pages/CacheSettings'))
  },
  '/health': {
    '': page(() => import('@/pages/HealthDashboard'), 'HealthDashboardPage'),
    monitors: lazy(() => import('@/pages/Monitors')),
    telemetry: page(() => import('@/pages/Telemetry'), 'TelemetryPage'),
    errors: page(() => import('@/pages/ErrorClusters'), 'ErrorClustersPage'),
    'request-story': page(() => import('@/pages/RequestStory'), 'RequestStoryPage'),
    'daily-report': page(() => import('@/pages/DailyReport'), 'DailyReportPage')
  },
  '/environments': {
    '': lazy(() => import('@/pages/Environments')),
    config: page(() => import('@/pages/ConfigDiff'), 'ConfigDiffPage'),
    'changed-here': lazy(() => import('@/pages/ConfigChangedHere')),
    readiness: lazy(() => import('@/pages/Readiness')),
    quality: lazy(() => import('@/pages/QualityChecks'))
  },
  '/promotion': {
    '': page(() => import('@/pages/ContentPromotion'), 'ContentPromotionPage'),
    blueprints: page(() => import('@/pages/Blueprints'), 'BlueprintsPage'),
    'change-sets': page(() => import('@/pages/ChangeSets'), 'ChangeSetsPage'),
    schema: page(() => import('@/pages/SchemaSnapshot'), 'SchemaSnapshotPage'),
    'starter-kits': lazy(() => import('@/pages/CollectionPresets'))
  },
  '/connections': {
    '': page(() => import('@/pages/ExternalApis'), 'ExternalApisPage'),
    webhooks: page(() => import('@/pages/Webhooks'), 'WebhooksPage'),
    'sync-jobs': page(() => import('@/pages/SyncJobs'), 'SyncJobsPage'),
    inbound: page(() => import('@/pages/InboundMappings'), 'InboundMappingsPage'),
    trackers: page(() => import('@/pages/IssueTrackers'), 'IssueTrackersPage')
  },
  '/reports': {
    '': page(() => import('@/pages/ReportStudio'), 'ReportStudioPage'),
    scheduled: page(() => import('@/pages/ScheduledReports'), 'ScheduledReportsPage'),
    throughput: page(() => import('@/pages/TeamThroughput'), 'TeamThroughputPage'),
    downloads: page(() => import('@/pages/FileDownloads'), 'FileDownloadsPage')
  },
  '/activity': {
    '': page(() => import('@/pages/Activity'), 'ActivityPage'),
    live: page(() => import('@/pages/Pulse'), 'PulsePage'),
    audit: page(() => import('@/pages/Reports'), 'ReportsPage'),
    history: lazy(() => import('@/pages/RevisionSearch')),
    provenance: page(() => import('@/pages/ProvenanceTrace'), 'ProvenanceTracePage')
  },
  '/ai': {
    '': page(() => import('@/pages/AiAnalytics'), 'AiAnalyticsPage'),
    quality: page(() => import('@/pages/AiQuality'), 'AiQualityPage'),
    knowledge: page(() => import('@/pages/AiKnowledge'), 'AiKnowledgePage')
  },
  '/analytics': {
    '': page(() => import('@/pages/Analytics'), 'AnalyticsPage'),
    api: page(() => import('@/pages/ApiAnalytics'), 'ApiAnalyticsPage'),
    search: page(() => import('@/pages/SearchAnalytics'), 'SearchAnalyticsPage'),
    replays: page(() => import('@/pages/SessionReplays'), 'SessionReplaysPage'),
    chat: page(() => import('@/pages/ChatAnalytics'), 'ChatAnalyticsPage')
  },
  '/alerts': {
    '': page(() => import('@/pages/Alerts'), 'AlertsPage'),
    metrics: page(() => import('@/pages/AlertManager'), 'AlertManager'),
    watches: page(() => import('@/pages/FieldWatches'), 'FieldWatchesPage'),
    subscriptions: page(
      () => import('@/pages/NotificationSubscriptions'),
      'NotificationSubscriptionsPage'
    )
  },
  '/delivery': {
    '': lazy(() => import('@/pages/MailLog')),
    templates: lazy(() => import('@/pages/MailTemplates')),
    analytics: lazy(() => import('@/pages/NotificationAnalytics')),
    bench: lazy(() => import('@/pages/NotificationBench'))
  },
  '/flows': {
    '': page(() => import('@/pages/Flows'), 'FlowsPage'),
    rules: page(() => import('@/pages/Rules'), 'RulesPage'),
    tests: lazy(() => import('@/pages/AutomationTests')),
    'dead-letters': page(() => import('@/pages/DeadLetterQueue'), 'DeadLetterQueuePage')
  },
  '/deadlines': {
    '': page(() => import('@/pages/SlaRules'), 'SlaRulesPage'),
    'at-risk': page(() => import('@/pages/AtRisk'), 'AtRiskPage'),
    scheduled: lazy(() => import('@/pages/ScheduledChanges')),
    blackout: page(() => import('@/pages/BlackoutDates'), 'BlackoutDatesPage')
  },
  '/coverage': {
    '': lazy(() => import('@/pages/DelegationConsole')),
    gaps: page(() => import('@/pages/CoverageGaps'), 'CoverageGapsPage'),
    'no-owner': page(() => import('@/pages/NoOwnerSteps'), 'NoOwnerStepsPage')
  },
  '/security-center': {
    '': lazy(() => import('@/pages/SecurityCenter')),
    presence: page(() => import('@/pages/Presence'), 'PresencePage'),
    retention: page(() => import('@/pages/RetentionPolicies'), 'RetentionPoliciesPage'),
    logs: lazy(() => import('@/pages/LogRetention')),
    holds: lazy(() => import('@/pages/LegalHolds'))
  },
  '/access': {
    '': lazy(() => import('@/pages/AccessRequests')),
    audits: lazy(() => import('@/pages/AccessAudit'))
  },
  '/mcp': {
    '': page(() => import('@/pages/McpConnections'), 'McpConnectionsPage'),
    tools: page(() => import('@/pages/McpTools'), 'McpToolsPage'),
    triggers: page(() => import('@/pages/AgentTriggers'), 'AgentTriggersPage'),
    console: page(() => import('@/pages/McpConsole'), 'McpConsolePage')
  },
  '/custom-queries': {
    '': page(() => import('@/pages/CustomQueries'), 'CustomQueriesPage'),
    catalog: lazy(() => import('@/pages/QueryCatalog')),
    scratchpad: lazy(() => import('@/pages/SqlScratchpad'))
  },
  '/graphql': {
    '': page(() => import('@/pages/GraphQLExplorer'), 'GraphQLExplorerPage'),
    persisted: page(() => import('@/pages/PersistedQueries'), 'PersistedQueriesPage')
  },
  '/docs': {
    '': page(() => import('@/pages/Docs'), 'DocsPage'),
    api: page(() => import('@/pages/ApiDocs'), 'ApiDocsPage'),
    releases: lazy(() => import('@/pages/Changelog'))
  },
  '/dev-tools': {
    '': lazy(() => import('@/pages/E2eRecorder')),
    contrast: lazy(() => import('@/pages/ContrastAudit'))
  },
  '/config': {
    '': lazy(() => import('@/pages/ConfigHealth')),
    review: lazy(() => import('@/pages/ConfigReview')),
    search: lazy(() => import('@/pages/ConfigSearch'))
  },
  '/data-integrity': {
    '': page(() => import('@/pages/DataIntegrity'), 'ConformanceTab'),
    quality: page(() => import('@/pages/DataIntegrity'), 'QualityTab'),
    people: page(() => import('@/pages/DataIntegrity'), 'PeopleTab'),
    orphans: page(() => import('@/pages/data-integrity/Orphans'), 'OrphansTab')
  },
  '/hub': {
    '': lazy(() => import('@/pages/hub/HubApps')),
    drivers: lazy(() => import('@/pages/hub/HubDrivers')),
    signin: lazy(() => import('@/pages/hub/signin/HubSignin')),
    targets: lazy(() => import('@/pages/hub/create/HubTargets')),
    databases: lazy(() => import('@/pages/hub/databases/HubDatabases')),
    data: lazy(() => import('@/pages/hub/data/HubData')),
    shared: lazy(() => import('@/pages/hub/shared/HubShared'))
  }
}

/** The hub page for the current path (App.tsx routes every hub tab here). */
export function HubRoute() {
  const { pathname } = useLocation()
  const match = hubForPath(pathname)
  const screens = match ? SCREENS[match.hub.base] : undefined
  const features = useServerFeaturesQuery()
  if (!match || !screens) return <Navigate to='/' replace />
  const needs = match.hub.feature
  if (needs) {
    if (features.isPending) return <FeatureWait />
    if (features.isError)
      return (
        <QueryErrorState
          error={features.error}
          what='what this server offers'
          onRetry={() => void features.refetch()}
          className='m-4 sm:m-6'
        />
      )
    if (!features.data.includes(needs)) return <NotAvailableHere />
  }
  return <HubPage hub={match.hub} components={screens} />
}

function FeatureWait() {
  return (
    <div className='flex-1 space-y-3 bg-slate-50 p-4 sm:p-6 dark:bg-background'>
      <Skeleton className='h-10 w-full max-w-[640px]' />
      <Skeleton className='h-[220px] w-full' />
    </div>
  )
}

/** A hub whose server feature is off here (the route stays, so an old link says why). */
function NotAvailableHere() {
  return (
    <div className='flex flex-1 flex-col items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
      <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
        <CircleSlash className='h-5 w-5 text-slate-400 dark:text-muted-foreground' aria-hidden />
      </div>
      <h1 className='mt-3 mb-0 text-[15px] font-semibold text-slate-800 dark:text-foreground'>
        Not available on this server
      </h1>
      <p className='m-0 mt-1 max-w-[48ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
        This page belongs to a feature this server does not run.
      </p>
    </div>
  )
}
