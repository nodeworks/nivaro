import { type ComponentType, lazy } from 'react'
import { Navigate, useLocation } from 'react-router'
import { HubPage } from '@/components/hub-page'
import { hubForPath } from '@/lib/hubs'

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
    'request-story': page(() => import('@/pages/RequestStory'), 'RequestStoryPage')
  },
  '/environments': {
    '': lazy(() => import('@/pages/Environments')),
    config: page(() => import('@/pages/ConfigDiff'), 'ConfigDiffPage'),
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
    inbound: page(() => import('@/pages/InboundMappings'), 'InboundMappingsPage')
  },
  '/reports': {
    '': page(() => import('@/pages/ReportStudio'), 'ReportStudioPage'),
    scheduled: page(() => import('@/pages/ScheduledReports'), 'ScheduledReportsPage'),
    throughput: page(() => import('@/pages/TeamThroughput'), 'TeamThroughputPage')
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
    gaps: page(() => import('@/pages/CoverageGaps'), 'CoverageGapsPage')
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
  }
}

/** The hub page for the current path (App.tsx routes every hub tab here). */
export function HubRoute() {
  const { pathname } = useLocation()
  const match = hubForPath(pathname)
  const screens = match ? SCREENS[match.hub.base] : undefined
  if (!match || !screens) return <Navigate to='/' replace />
  return <HubPage hub={match.hub} components={screens} />
}
