import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { bustPortalLinkCache } from '../services/app-links.js'
import { noteReadDuration } from '../services/background-runs.js'
import { clearMetadataCache } from '../services/collections.js'
import { announceConfigChanged, collectionHint, isConfigWrite } from '../services/config-live.js'
import { bustDefinitionCache } from '../services/definition-cache.js'
import { bustLayoutReferences } from '../services/layout-references.js'
import { clearPickerRuleCache } from '../services/picker-rules.js'
import { accessAnnouncement, announceAccessChanged } from '../services/record-events.js'
import { clearRelationLimitCache } from '../services/relation-limits.js'
import { clearRowRuleCache } from '../services/row-rules-autofill.js'
import { bustSectionLockCache } from '../services/section-locks.js'
import { requestAccessRecheck } from '../services/socket-access.js'
import { accessAuditsRoutes } from './access-audits.js'
import { accessExplainRoutes } from './access-explain.js'
import { accessInsightRoutes } from './access-insights.js'
import { accessRequestRoutes } from './access-requests.js'
import { activityRoutes } from './activity.js'
import { addendumsRoutes } from './addendums.js'
import { aiRoutes } from './ai.js'
import { aiAskContextRoutes } from './ai-ask-context.js'
import { aiConversationRoutes } from './ai-conversations.js'
import { aiDesignRoutes } from './ai-design.js'
import { aiDesignTextRoutes } from './ai-design-text.js'
import { aiExplainRoutes } from './ai-explain.js'
import { aiFeatureRoutes } from './ai-features.js'
import { aiFieldFillRoutes } from './ai-field-fill.js'
import { aiKnowledgeRoutes } from './ai-knowledge.js'
import { aiMemoryAdminRoutes, aiMemoryRoutes } from './ai-memory.js'
import { aiPlanRoutes } from './ai-plans.js'
import { aiQualityRoutes } from './ai-quality.js'
import { aiSettingsRoutes } from './ai-settings.js'
import { aiWatchRoutes } from './ai-watches.js'
import { alertsRoutes } from './alerts.js'
import { analyticsRoutes } from './analytics.js'
import { announcementRoutes } from './announcements.js'
import { apiAnalyticsRoutes } from './api-analytics.js'
import { apiKeyUsageRoutes } from './api-key-usage.js'
import { apiKeysRoutes } from './api-keys.js'
import { approvalsRoutes } from './approvals.js'
import { atRiskRoutes } from './at-risk.js'
import { attributesRoutes } from './attributes.js'
import { authRoutes } from './auth.js'
import { automationTestRoutes } from './automation-tests.js'
import { backgroundRunsRoutes } from './background-runs.js'
import { backupsRoutes } from './backups.js'
import { blackoutDatesRoutes } from './blackout-dates.js'
import { blueprintsRoutes } from './blueprints.js'
import { bulkActionsRoutes } from './bulk-actions.js'
import { bulkRecipeRoutes } from './bulk-recipes.js'
import { changeSetsRoutes } from './change-sets.js'
import { chaosRoutes } from './chaos.js'
import { chatPushReplyRoutes, chatRoutes } from './chat.js'
import { chatAdminRoutes } from './chat-admin.js'
import { chatHuddleRoutes } from './chat-huddle.js'
import { collectionDesignerRoutes } from './collection-designer.js'
import { collectionLayoutsRoutes } from './collection-layouts.js'
import { collectionPresetsRoutes } from './collection-presets.js'
import { collectionSnapshotRoutes } from './collection-snapshots.js'
import { collectionsRoutes } from './collections.js'
import { commandCenterRoutes } from './command-center.js'
import { commentsRoutes } from './comments.js'
import { configConformanceRecordRoutes, configConformanceRoutes } from './config-conformance.js'
import { configDiffRoutes } from './config-diff.js'
import { configHealthRoutes } from './config-health.js'
import { configReviewRoutes } from './config-review.js'
import { configSearchRoutes } from './config-search.js'
import { configSeedRoutes } from './config-seeds.js'
import { connectionReportRoutes } from './connection-reports.js'
import { contentExportRoutes } from './content-export.js'
import { coverageGapsRoutes } from './coverage-gaps.js'
import { cronRoutes } from './cron.js'
import { cronTimelineRoutes } from './cron-timeline.js'
import { crossTriggersRoutes } from './cross-triggers.js'
import { customActionRoutes } from './custom-actions.js'
import { customQueriesRoutes } from './custom-queries.js'
import { dashboardFeedRoutes } from './dashboard-feed.js'
import { dashboardLinkRoutes } from './dashboard-links.js'
import { dashboardsRoutes } from './dashboards.js'
import { dataModelReadRoutes, dataModelRoutes } from './data-model.js'
import { dataQualityRoutes } from './data-quality.js'
import { dbTuningRoutes } from './db-tuning.js'
import { deadLettersRoutes } from './dead-letters.js'
import { delegationRoutes } from './delegation.js'
import { devToolsRoutes } from './dev-tools.js'
import { directoryRoutes } from './directory.js'
import { dossierRoutes } from './dossier.js'
import { draftPublishRoutes } from './draft-publish.js'
import { draftsRoutes } from './drafts.js'
import { envPresenceRoutes } from './env-presence.js'
import { environmentRoutes } from './environments.js'
import { erpSubmissionsRoutes } from './erp-submissions.js'
import { eventsStreamRoutes } from './events-stream.js'
import { exportPresetRoutes } from './export-presets.js'
import { extensionEventRoutes } from './extension-events.js'
import { extensionRegistryRoutes } from './extension-registry.js'
import { extensionsRoutes } from './extensions.js'
import { externalApiObservabilityRoutes } from './external-api-observability.js'
import { externalApisRoutes } from './external-apis.js'
import { featureFlagRoutes } from './feature-flags.js'
import { fieldConfigRoutes } from './field-config.js'
import { fieldGroupsRoutes } from './field-groups.js'
import { fieldHistoryRoutes } from './field-history.js'
import { fieldRulesRoutes } from './field-rules.js'
import { fieldTranslationsRoutes } from './field-translations.js'
import { fieldWatchesRoutes } from './field-watches.js'
import { filesRoutes } from './files.js'
import { findReplaceRoutes } from './find-replace.js'
import { flowRegistryRoutes } from './flow-registry.js'
import { flowsRoutes, webhookFlowRoute } from './flows.js'
import { geocodeRoutes } from './geocode.js'
import { geocodeBackfillRoutes } from './geocode-backfill.js'
import { geocodeSuggestRoutes } from './geocode-suggest.js'
import { globalSearchRoutes } from './global-search.js'
import { healthRoutes } from './health.js'
import { helpVideoAdminRoutes } from './help-video-admin.js'
import { helpVideoMediaRoutes, helpVideosRoutes } from './help-videos.js'
import { hierarchyRoutes } from './hierarchy.js'
import { ideasRoutes } from './ideas.js'
import { importTemplatesRoutes } from './import-templates.js'
import { importsRoutes } from './imports.js'
import { inactiveUserLinkRoutes } from './inactive-user-links.js'
import { inboundMappingsRoutes, inboundRoutes } from './inbound-mappings.js'
import { indexAdvisorRoutes } from './index-advisor.js'
import { integrationContractRoutes } from './integration-contracts.js'
import { integrationEventsRoutes } from './integration-events.js'
import { integrationHealthRoutes } from './integration-health.js'
import { integrationObligationsRoutes } from './integration-obligations.js'
import { integrationPartnersRoutes } from './integration-partners.js'
import { integrationSignalsRoutes } from './integration-signals.js'
import { issuesRoutes } from './issues.js'
import { itemActionsRoutes } from './item-actions.js'
import { itemLocksRoutes } from './item-locks.js'
import { itemsRoutes } from './items.js'
import { jobRunRoutes } from './job-runs.js'
import { journeyRoutes } from './journeys.js'
import { lastTouchRoutes } from './last-touch.js'
import { layoutAbRoutes } from './layout-ab.js'
import { layoutChangeRequestRoutes } from './layout-change-requests.js'
import { formPreviewPublicRoutes, layoutCollabRoutes } from './layout-collab.js'
import { layoutDependencyRoutes } from './layout-dependencies.js'
import { layoutInspectRoutes } from './layout-inspect.js'
import { layoutPromoteRoutes } from './layout-promote.js'
import { layoutTestingRoutes } from './layout-testing.js'
import { layoutUsageRoutes } from './layout-usage.js'
import { layoutWhyRoutes } from './layout-why.js'
import { legalHoldRoutes } from './legal-holds.js'
import { lineageRoutes } from './lineage.js'
import { mailRoutes } from './mail.js'
import { mailLogReadRoutes, mailLogRoutes } from './mail-log.js'
import { mailSuppressionRoutes } from './mail-suppressions.js'
import { mailTemplateRoutes } from './mail-templates.js'
import { mailTypeRoutes } from './mail-types.js'
import { mcpRoutes } from './mcp.js'
import { mcpConnectionRoutes } from './mcp-connections.js'
import { mcpConsoleRoutes } from './mcp-console.js'
import { mcpToolRoutes } from './mcp-tools.js'
import { meNotificationRoutes } from './me-notifications.js'
import { mergeRoutes } from './merge.js'
import { messageActionsRoutes } from './message-actions.js'
import { metricAlertsRoutes } from './metric-alerts.js'
import { monitorRoutes } from './monitors.js'
import { myJobsRoutes } from './my-jobs.js'
import { myWorkRoutes } from './my-work.js'
import { notificationBenchRoutes } from './notification-bench.js'
import { notificationSubscriptionsRoutes } from './notification-subscriptions.js'
import { notificationTemplateRoutes } from './notification-templates.js'
import { notificationsRoutes } from './notifications.js'
import { oauthConnectionRoutes } from './oauth.js'
import { offboardingRoutes } from './offboarding.js'
import { opsAssistantRoutes } from './ops-assistant.js'
import { opsCalendarRoutes } from './ops-calendar.js'
import { opsDbRoutes } from './ops-db.js'
import { opsLogsRoutes } from './ops-logs.js'
import { opsRedisRoutes } from './ops-redis.js'
import { opsRuntimeRoutes } from './ops-runtime.js'
import { opsTaskRoutes } from './ops-tasks.js'
import { pagesRoutes } from './pages.js'
import { partnerDependencyRoutes } from './partner-dependencies.js'
import { pdfTemplatesRoutes } from './pdf-templates.js'
import { persistedQueriesRoutes } from './persisted-queries.js'
import { personSummaryRoutes } from './person-summary.js'
import { pickerExclusionRoutes } from './picker-exclusions.js'
import { pickerMissRoutes } from './picker-misses.js'
import { pickerNarrowingRoutes } from './picker-narrowing.js'
import { pinnedRoutes } from './pinned.js'
import { pipelinesRoutes } from './pipelines.js'
import { preflightRoutes } from './preflight.js'
import { buildScript, presenceAdminRoutes, presenceOnlineRoutes } from './presence.js'
import { presetsRoutes } from './presets.js'
import { procedureRoutes } from './procedures.js'
import { profileFieldsRoutes } from './profile-fields.js'
import { promotionRoutes } from './promotion.js'
import { provenanceTraceRoutes } from './provenance-trace.js'
import { pushRoutes } from './push.js'
import { qualityCheckRoutes } from './quality-checks.js'
import { queuesRoutes } from './queues.js'
import { readinessRoutes } from './readiness.js'
import { realtimeRoutes, recordViewersRoutes } from './realtime.js'
import { realtimeVerifyRoutes } from './realtime-verify.js'
import { realtimeWorkerRoutes } from './realtime-worker.js'
import { recordGraphRoutes } from './record-graph.js'
import { recordIntegrationsRoutes } from './record-integrations.js'
import { recordLinkRoutes } from './record-links.js'
import { recordMergeRoutes } from './record-merge.js'
import { recordMetaRoutes } from './record-meta.js'
import { recordPromotionRoutes } from './record-promotion.js'
import { recordTemplatesRoutes } from './record-templates.js'
import { recordViewRoutes } from './record-views.js'
import { referencedByRoutes } from './referenced-by.js'
import { releaseRunsRoutes } from './release-runs.js'
import { remindersRoutes } from './reminders.js'
import { reportStudioRoutes } from './report-studio.js'
import { reportsRoutes } from './reports.js'
import { retentionRoutes } from './retention.js'
import { revisionsRoutes } from './revisions.js'
import { roleChecklistRoutes } from './role-checklists.js'
import { rolesRoutes } from './roles.js'
import { rulesRoutes } from './rules.js'
import { rumRoutes } from './rum.js'
import { runbookRoutes } from './runbooks.js'
import { savedViewsRoutes } from './saved-views.js'
import { scheduledChangesRoutes } from './scheduled-changes.js'
import { scheduledReportsRoutes } from './scheduled-reports.js'
import { schemaRoutes } from './schema.js'
import { schemaSnapshotRoutes } from './schema-snapshot.js'
import { scimRoutes } from './scim.js'
import { searchRoutes } from './search.js'
import { searchAnalyticsRoutes } from './search-analytics.js'
import { securityRoutes, securitySelfRoutes } from './security.js'
import { semanticSearchRoutes } from './semantic-search.js'
import { sequenceRoutes } from './sequences.js'
import { sessionRecordingRoutes } from './session-recordings.js'
import { sessionReplayClipRoutes } from './session-replay-clips.js'
import { sessionReplayExportRoutes } from './session-replay-export.js'
import { sessionReplayInsightRoutes } from './session-replay-insights.js'
import { sessionReplayNotesRoutes } from './session-replay-notes.js'
import { sessionReplaySearchRoutes } from './session-replay-search.js'
import { sessionReplayShareRoutes } from './session-replay-shares.js'
import { sessionReplaySpecRoutes } from './session-replay-spec.js'
import { settingsRoutes } from './settings.js'
import { setupRoutes } from './setup.js'
import { shareLinksRoutes } from './share-links.js'
import { slaRoutes } from './sla.js'
import { sqlChecksRoutes } from './sql-checks.js'
import { sqlScratchpadRoutes } from './sql-scratchpad.js'
import { ssoProviderRoutes } from './sso-providers.js'
import { stagedImportRoutes } from './staged-imports.js'
import { streamRoutes } from './stream.js'
import { subRowsRoutes } from './sub-rows.js'
import { submissionFormsRoutes } from './submission-forms.js'
import { supportRoutes } from './support.js'
import { syncJobsRoutes } from './sync-jobs.js'
import { tasksRoutes } from './tasks.js'
import { teamMiscRoutes, teamUserRoutes } from './team.js'
import { telemetryRoutes } from './telemetry.js'
import { testDataRoutes } from './test-data.js'
import { throughputRoutes } from './throughput.js'
import { timelineRoutes } from './timeline.js'
import { traceRoutes } from './traces.js'
import { trafficMapRoutes } from './traffic-map.js'
import { trashRoutes } from './trash.js'
import { treeRoutes } from './tree.js'
import { treePermissionsRoutes } from './tree-permissions.js'
import { twoFactorRoutes } from './two-factor.js'
import { userActivityRoutes } from './user-activity.js'
import { userGroupsRoutes } from './user-groups.js'
import { userScopesRoutes } from './user-scopes.js'
import { usersRoutes } from './users.js'
import { viewStreamRoutes } from './view-stream.js'
import { viewSubscriptionsRoutes } from './view-subscriptions.js'
import { virtualCollectionsRoutes } from './virtual-collections.js'
import { webhooksRoutes } from './webhooks.js'
import { buildWidgetScript, widgetRoutes } from './widget.js'
import { widgetsInternalRoutes } from './widgets-internal.js'
import { workflowsRoutes } from './workflows.js'
import { workspacesRoutes } from './workspaces.js'
import { zapierRoutes } from './zapier.js'

export async function registerRoutes(app: FastifyInstance) {
  // #2759 — how long a cache-missing custom query / widget read takes, so a known-slow one can
  // offer "Run in background" (services/background-runs.ts).
  app.addHook('onResponse', noteReadDuration(app))
  // Maintenance mode: instance-wide write freeze (admins exempt, reads fine).
  // Auth stays open so admins can get in to turn it off.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const url = req.url
    if (
      url.startsWith('/api/auth') ||
      url.startsWith('/api/settings') ||
      url.startsWith('/api/rum') ||
      // Batches of reads (#1304, people cards) are POSTs only because they carry a body.
      url.startsWith('/api/items/batch-read') ||
      url.startsWith('/api/users/cards') ||
      // The layout editor canvas's draft field rows: a read carrying placements.
      /^\/api\/field-config\/[^/?]+\/project(\?|$)/.test(url) ||
      // The MCP endpoint only carries protocol messages; each tool call inside it is its
      // own API request, judged by this hook on its own method and path.
      url === '/api/mcp' ||
      url.startsWith('/api/mcp?')
    )
      return
    const { maintenanceState, MAINTENANCE_EXPLAINER, MAINTENANCE_DEFAULT_MESSAGE } = await import(
      '../services/security.js'
    )
    const maint = await maintenanceState()
    if (!maint.on) return
    // This app-level hook runs BEFORE the routes' own authenticate
    // preHandler, so identity isn't resolved yet — resolve it here (only
    // while maintenance is actually on) so admins stay exempt.
    if (!req.user) {
      const { authenticate } = await import('../middleware/authenticate.js')
      await authenticate(req, reply).catch(() => {})
    }
    if (req.isAdmin) return
    return reply.code(503).send({
      error: `${(maint.message || MAINTENANCE_DEFAULT_MESSAGE).trim()} ${MAINTENANCE_EXPLAINER}`,
      code: 'MAINTENANCE',
      until: maint.until
    })
  })

  // Collection/field metadata is cached in-process (services/collections.ts) to
  // keep schema lookups off the hot path. Any successful write to a route that
  // can change that metadata drops the cache immediately, so edits are visible
  // on the next request instead of waiting out the TTL. One hook rather than a
  // call at every mutation site — no site can be missed.
  // (The route list and the read-only exemptions: isConfigWrite, services/config-live.ts.)
  // Definition rows (widgets, custom queries) are cached per id for renders
  // (#494); a write to their editors drops that cache the same way.
  const DEFINITION_ROUTES = /^\/api\/(widgets-internal|custom-queries)\b/
  // #1720 — writes that can change what someone may see ask every replica to re-check the
  // rooms open sockets hold (debounced). Kept narrow (H4): a write naming a person re-checks
  // that person; a channel change re-checks channel rooms only; an everyone-pass (roles,
  // policies, teams, scope dimensions, tree permissions, directory sync, retention,
  // offboarding) runs only for an administrator's write — a non-admin cannot make every
  // socket re-gate on demand.
  const ACCESS_USER_ROUTE = /^\/api\/(users|user-scopes|offboarding)\/([0-9a-f-]{36})\b/i
  const ACCESS_CHANNEL_MEMBER = /^\/api\/chat\/channels\/[^/]+\/members\/([0-9a-f-]{36})\b/i
  const ACCESS_CHANNEL_ROUTE = /^\/api\/chat\/channels\/[^/]+$/
  const ACCESS_ALL_ROUTE =
    /^\/api\/(roles|user-groups|scope-dimensions|tree-permissions|access-requests\/[^/]+\/resolve|users\/bulk|directory|retention|offboarding)\b/
  const ACCESS_READ_LIKE = /\/(impact|simulate|row-filter-impact|preview|coverage|dry-run)\b/
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 400) return
    const path = req.url.split('?')[0]
    if (!ACCESS_READ_LIKE.test(path)) {
      const one = ACCESS_USER_ROUTE.exec(path)
      const member = ACCESS_CHANNEL_MEMBER.exec(path)
      if (one) requestAccessRecheck({ userIds: [one[2]] })
      // Someone taken off a channel: that person's rooms.
      else if (member && req.method === 'DELETE') requestAccessRecheck({ userIds: [member[1]] })
      // A channel made private, archived or re-roled: channel rooms only.
      else if (ACCESS_CHANNEL_ROUTE.test(path) && req.method !== 'POST')
        requestAccessRecheck({ roomPrefixes: ['chat:ch:'] })
      else if (ACCESS_ALL_ROUTE.test(path) && req.isAdmin) requestAccessRecheck({ all: true })
      // A person narrowing their own scopes (Profile) re-checks only their own sockets.
      else if (path.startsWith('/api/users/me/scopes') && req.user?.id)
        requestAccessRecheck({ userIds: [String(req.user.id)] })
    }
    if (DEFINITION_ROUTES.test(req.url) && !/\/(render|action|execute|run)\b/.test(req.url)) {
      bustDefinitionCache()
    }
    if (isConfigWrite(req)) {
      clearMetadataCache()
      bustSectionLockCache()
      // Live integrity checks compile field/layout config per collection — same
      // staleness rules as the metadata caches they read from.
      void import('../services/config-conformance.js').then((m) => m.bustCompiledChecks())
      bustPortalLinkCache()
      clearRowRuleCache()
      clearRelationLimitCache()
      clearPickerRuleCache()
      bustLayoutReferences()
      // Config hot-push (#268): tell open clients the schema/layout changed —
      // they re-resolve field-config/layout queries in place and show an
      // "updated" chip instead of serving a stale form until reload.
      // Tenant-scoped, and named by collection when the request names one (#1740).
      try {
        const surface = req.url.split('/')[2]?.split('?')[0] ?? 'config'
        announceConfigChanged(
          surface,
          collectionHint(req),
          (req as unknown as { nvrTenantId?: string }).nvrTenantId
        )
      } catch {
        /* broadcast is best-effort */
      }
    }
  })
  // #1925: a write that may change who reads which records tells open record
  // pages to re-check their own access (payload-free, coalesced).
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400) return
    const who = accessAnnouncement(req)
    if (who) announceAccessChanged(who === 'tenant' ? {} : who)
  })

  await app.register(healthRoutes)
  await app.register(preflightRoutes)
  await app.register(traceRoutes)
  await app.register(configDiffRoutes)
  await app.register(environmentRoutes, { prefix: '/environments' })
  await app.register(envPresenceRoutes, { prefix: '/environments' })
  await app.register(releaseRunsRoutes, { prefix: '/release' })
  await app.register(runbookRoutes, { prefix: '/runbooks' })
  await app.register(qualityCheckRoutes, { prefix: '/quality-checks' })
  await app.register(integrationEventsRoutes, { prefix: '/integration-events' })
  await app.register(inboundMappingsRoutes, { prefix: '/inbound-mappings' })
  await app.register(inboundRoutes, { prefix: '/inbound' })
  await app.register(draftsRoutes, { prefix: '/drafts' })
  await app.register(lineageRoutes, { prefix: '/lineage' })
  await app.register(readinessRoutes, { prefix: '/readiness' })
  await app.register(aiExplainRoutes, { prefix: '/ai-explain' })
  await app.register(configConformanceRoutes, { prefix: '/config-conformance' })
  await app.register(configConformanceRecordRoutes, { prefix: '/config-conformance' })
  await app.register(announcementRoutes, { prefix: '/announcements' })
  await app.register(myJobsRoutes, { prefix: '/my-jobs' })
  await app.register(backgroundRunsRoutes, { prefix: '/background-runs' })
  await app.register(viewSubscriptionsRoutes, { prefix: '/view-subscriptions' })
  await app.register(coverageGapsRoutes)
  await app.register(inactiveUserLinkRoutes, { prefix: '/inactive-user-links' })
  await app.register(delegationRoutes)
  // A manager's view of their direct reports (#1030–#1043): /delegation/team,
  // /delegation/:userId/remind, /access-requests/:id/vouch.
  await app.register(teamMiscRoutes)
  await app.register(myWorkRoutes)
  await app.register(roleChecklistRoutes)
  await app.register(dashboardFeedRoutes, { prefix: '/dashboard' })
  await app.register(accessRequestRoutes)
  await app.register(lastTouchRoutes)
  // What the record form shows about partner integrations (#609 #615 #616 #617).
  await app.register(recordIntegrationsRoutes)
  await app.register(recordViewRoutes)
  await app.register(meNotificationRoutes)
  await app.register(recordLinkRoutes)
  await app.register(fieldHistoryRoutes)
  await app.register(integrationHealthRoutes)
  await app.register(integrationObligationsRoutes)
  await app.register(integrationSignalsRoutes)
  await app.register(integrationPartnersRoutes)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(aiRoutes, { prefix: '/ai' })
  await app.register(aiQualityRoutes, { prefix: '/ai' })
  await app.register(aiConversationRoutes, { prefix: '/ai/conversations' })
  await app.register(aiWatchRoutes, { prefix: '/ai/watches' })
  await app.register(aiPlanRoutes, { prefix: '/ai' })
  await app.register(aiFeatureRoutes, { prefix: '/ai' })
  await app.register(aiAskContextRoutes, { prefix: '/ai/ask' })
  await app.register(aiMemoryRoutes, { prefix: '/ai' })
  await app.register(aiDesignRoutes, { prefix: '/ai-design' })
  await app.register(aiFieldFillRoutes, { prefix: '/ai' })
  await app.register(aiDesignTextRoutes, { prefix: '/ai-design' })
  await app.register(activityRoutes, { prefix: '/activity' })
  await app.register(cronRoutes, { prefix: '/cron' })
  await app.register(jobRunRoutes, { prefix: '/job-runs' })
  await app.register(opsTaskRoutes, { prefix: '/ops-tasks' })
  await app.register(configSeedRoutes, { prefix: '/config-seeds' })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(integrationContractRoutes, { prefix: '/integration-contracts' })
  await app.register(rumRoutes, { prefix: '/rum' })
  // #2263 — browsers report a failed / downgraded live-update connection (Traffic Map)
  await app.register(connectionReportRoutes, { prefix: '/connection-reports' })
  await app.register(indexAdvisorRoutes, { prefix: '/index-advisor' })
  await app.register(dbTuningRoutes, { prefix: '/db-tuning' })
  await app.register(sqlChecksRoutes, { prefix: '/sql-checks' })
  await app.register(securityRoutes, { prefix: '/security' })
  await app.register(securitySelfRoutes, { prefix: '/security' })
  await app.register(configHealthRoutes, { prefix: '/config-health' })
  await app.register(configReviewRoutes, { prefix: '/config-review' })
  await app.register(legalHoldRoutes, { prefix: '/legal-holds' })
  await app.register(automationTestRoutes, { prefix: '/automation-tests' })
  await app.register(bulkRecipeRoutes, { prefix: '/bulk-recipes' })
  await app.register(findReplaceRoutes, { prefix: '/find-replace' })
  await app.register(customActionRoutes, { prefix: '/custom-actions' })
  await app.register(offboardingRoutes, { prefix: '/offboarding' })
  await app.register(mailTemplateRoutes, { prefix: '/mail-templates' })
  await app.register(mailTypeRoutes, { prefix: '/mail-types' })
  await app.register(opsCalendarRoutes, { prefix: '/ops-calendar' })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.register(configSearchRoutes, { prefix: '/config-search' })
  await app.register(mailLogRoutes, { prefix: '/mail-log' })
  await app.register(notificationBenchRoutes, { prefix: '/notification-bench' })
  await app.register(notificationTemplateRoutes, { prefix: '/notification-templates' })
  await app.register(mailLogReadRoutes, { prefix: '/mail-log' })
  await app.register(mailSuppressionRoutes, { prefix: '/mail-suppressions' })
  await app.register(sequenceRoutes, { prefix: '/sequences' })
  await app.register(sqlScratchpadRoutes, { prefix: '/sql-scratchpad' })
  await app.register(collectionSnapshotRoutes, { prefix: '/collection-snapshots' })
  await app.register(exportPresetRoutes, { prefix: '/export-presets' })
  await app.register(recordMergeRoutes, { prefix: '/record-merge' })
  await app.register(realtimeRoutes, { prefix: '/realtime' })
  // #2463 / #2477 / #2478 / #2760 — realtime verification tooling (admin).
  await app.register(realtimeVerifyRoutes, { prefix: '/realtime' })
  // #2475 — the SharedWorker script (no sign-in: code, not data); apart from the admin routes.
  await app.register(realtimeWorkerRoutes, { prefix: '/realtime' })
  await app.register(trafficMapRoutes, { prefix: '/traffic-map' })
  await app.register(recordViewersRoutes, { prefix: '/presence' })
  await app.register(geocodeRoutes)
  await app.register(recordMetaRoutes)
  // Chaos drills (#333) — only when explicitly enabled; never by default.
  if (process.env.CHAOS_ENABLED === 'true') {
    await app.register(chaosRoutes, { prefix: '/chaos' })
  }
  await app.register(collectionsRoutes, { prefix: '/collections' })
  await app.register(stagedImportRoutes, { prefix: '/staged-imports' })
  await app.register(chatRoutes, { prefix: '/chat' })
  // Token-authenticated (the push notification's own reply token).
  await app.register(chatPushReplyRoutes, { prefix: '/chat-push' })
  await app.register(chatAdminRoutes, { prefix: '/chat/admin' })
  await app.register(chatHuddleRoutes, { prefix: '/chat/huddle' })
  await app.register(dataModelRoutes, { prefix: '/data-model' })
  // Same prefix, auth-only: the read-only relation lookup every record form needs
  await app.register(dataModelReadRoutes, { prefix: '/data-model' })
  await app.register(extensionsRoutes, { prefix: '/extensions' })
  await app.register(itemsRoutes, { prefix: '/items' })
  await app.register(accessExplainRoutes)
  await app.register(accessInsightRoutes)
  await app.register(pickerNarrowingRoutes)
  await app.register(accessAuditsRoutes, { prefix: '/access-audits' })
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.register(usersRoutes, { prefix: '/users' })
  await app.register(personSummaryRoutes, { prefix: '/users' })
  await app.register(teamUserRoutes, { prefix: '/users' })
  await app.register(aiMemoryAdminRoutes, { prefix: '/users' })
  await app.register(directoryRoutes, { prefix: '/directory' })
  await app.register(revisionsRoutes, { prefix: '/revisions' })
  await app.register(rolesRoutes, { prefix: '/roles' })
  await app.register(filesRoutes, { prefix: '/files' })
  await app.register(helpVideosRoutes, { prefix: '/help-videos' })
  // Settings + render queue (admin); static paths beside helpVideosRoutes' /:id.
  await app.register(helpVideoAdminRoutes, { prefix: '/help-videos' })
  // Stream / captions / poster: no authenticate hook — a signed ?st= ticket
  // authorises them, since <video>/<track>/<img> cannot send a bearer token.
  await app.register(helpVideoMediaRoutes, { prefix: '/help-videos' })
  await app.register(ideasRoutes, { prefix: '/ideas' })
  await app.register(flowsRoutes, { prefix: '/flows' })
  await app.register(webhookFlowRoute, { prefix: '/flows' })
  // Static /flows/registered-* routes — no extra prefix; registerRoutes is
  // already mounted at /api. Static routes win over flows/:id param matching.
  await app.register(flowRegistryRoutes)
  await app.register(mailRoutes, { prefix: '/mail' })
  await app.register(notificationsRoutes, { prefix: '/notifications' })
  await app.register(pipelinesRoutes, { prefix: '/pipelines' })
  app.get('/presence.js', async (_req, reply) => {
    const row = await db('nivaro_settings')
      .first('presence_ping_interval')
      .catch(() => null)
    const pingInterval = row?.presence_ping_interval ?? 10_000
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'no-cache, must-revalidate')
    return reply.send(buildScript(pingInterval))
  })
  await app.register(presenceAdminRoutes, { prefix: '/presence' })
  await app.register(presenceOnlineRoutes, { prefix: '/presence' })
  await app.register(externalApisRoutes, { prefix: '/external-apis' })
  await app.register(externalApiObservabilityRoutes, { prefix: '/external-apis' })
  await app.register(webhooksRoutes, { prefix: '/webhooks' })
  await app.register(searchRoutes, { prefix: '/search' })
  await app.register(searchAnalyticsRoutes, { prefix: '/search-analytics' })
  await app.register(commentsRoutes, { prefix: '/comments' })
  await app.register(customQueriesRoutes, { prefix: '/custom-queries' })
  await app.register(userScopesRoutes)
  await app.register(schemaSnapshotRoutes, { prefix: '/schema-snapshot' })
  await app.register(blackoutDatesRoutes, { prefix: '/blackout-dates' })
  await app.register(rulesRoutes, { prefix: '/rules' })
  await app.register(fieldRulesRoutes, { prefix: '/field-rules' })
  await app.register(pinnedRoutes, { prefix: '/pinned' })
  await app.register(dashboardsRoutes, { prefix: '/dashboards' })
  await app.register(reportsRoutes, { prefix: '/reports' })
  await app.register(throughputRoutes, { prefix: '/reports' })
  await app.register(presetsRoutes, { prefix: '/presets' })
  await app.register(workspacesRoutes, { prefix: '/workspaces' })
  await app.register(schemaRoutes)
  await app.register(submissionFormsRoutes, { prefix: '/submission-forms' })
  await app.register(fieldWatchesRoutes, { prefix: '/field-watches' })
  await app.register(notificationSubscriptionsRoutes, { prefix: '/notification-subscriptions' })
  await app.register(importsRoutes, { prefix: '/imports' })
  await app.register(importTemplatesRoutes, { prefix: '/import-templates' })
  await app.register(slaRoutes, { prefix: '/sla' })
  await app.register(alertsRoutes, { prefix: '/alerts' })
  await app.register(metricAlertsRoutes, { prefix: '/metric-alerts' })
  await app.register(analyticsRoutes, { prefix: '/analytics' })
  await app.register(treeRoutes)
  await app.register(treePermissionsRoutes)
  await app.register(atRiskRoutes, { prefix: '/at-risk' })
  await app.register(retentionRoutes, { prefix: '/retention' })
  await app.register(backupsRoutes, { prefix: '/backups' })
  await app.register(promotionRoutes, { prefix: '/promotion' })
  await app.register(scheduledReportsRoutes, { prefix: '/scheduled-reports' })
  await app.register(timelineRoutes, { prefix: '/timeline' })
  await app.register(shareLinksRoutes, { prefix: '/share-links' })
  await app.register(blueprintsRoutes, { prefix: '/blueprints' })
  await app.register(recordGraphRoutes, { prefix: '/record-graph' })
  await app.register(pushRoutes, { prefix: '/push' })
  await app.register(trashRoutes, { prefix: '/trash' })
  await app.register(mergeRoutes, { prefix: '/merge' })
  await app.register(dashboardLinkRoutes, { prefix: '/dashboard-links' })
  await app.register(journeyRoutes, { prefix: '/journeys' })
  await app.register(sessionRecordingRoutes, { prefix: '/session-recordings' })
  // Clips / library / shares of recordings — full paths, no prefix (#1366).
  await app.register(sessionReplayClipRoutes)
  await app.register(sessionReplayShareRoutes)
  // #1374 / #1372 — search over the replay index (/search, /search/keys)
  await app.register(sessionReplaySearchRoutes, { prefix: '/session-recordings' })
  // #1364 / #1388 — heatmaps and frustration scores folded from recordings
  await app.register(sessionReplayInsightRoutes, { prefix: '/session-replay-insights' })
  // #1363 timestamped notes on a recording (admin-only, own file beside the recordings routes)
  await app.register(sessionReplayNotesRoutes, { prefix: '/session-recordings' })
  // #1375 export a recording as a self-contained HTML replay or a WebM (background job)
  await app.register(sessionReplayExportRoutes, { prefix: '/session-recordings' })
  // #1393 a Playwright spec (golden-path recorder steps) from a stretch of a recording
  await app.register(sessionReplaySpecRoutes, { prefix: '/session-recordings' })
  await app.register(reportStudioRoutes, { prefix: '/report-studio' })
  await app.register(bulkActionsRoutes)
  await app.register(itemActionsRoutes)
  await app.register(extensionRegistryRoutes)
  await app.register(hierarchyRoutes)
  await app.register(attributesRoutes)
  await app.register(contentExportRoutes, { prefix: '/content-export' })
  await app.register(draftPublishRoutes, { prefix: '/draft-publish' })
  await app.register(scheduledChangesRoutes, { prefix: '/scheduled-changes' })
  await app.register(fieldConfigRoutes, { prefix: '/field-config' })
  await app.register(fieldGroupsRoutes, { prefix: '/field-groups' })
  await app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
  await app.register(layoutUsageRoutes, { prefix: '/layout-usage' })
  // #2726: picker search gaps (zero-result picker searches per placement).
  await app.register(pickerMissRoutes, { prefix: '/layout-usage' })
  // #2593 / #2609 / #2613 — promote one layout, change requests, dependencies.
  await app.register(layoutPromoteRoutes, { prefix: '/collection-layouts' })
  await app.register(layoutChangeRequestRoutes, { prefix: '/layout-change-requests' })
  await app.register(layoutDependencyRoutes, { prefix: '/collection-layouts' })
  // #2596: GET /collection-layouts/why (static path beside the layouts routes' /:id).
  await app.register(layoutWhyRoutes, { prefix: '/collection-layouts' })
  await app.register(layoutCollabRoutes, { prefix: '/layout-collab' })
  await app.register(formPreviewPublicRoutes, { prefix: '/form-preview' })
  await app.register(layoutInspectRoutes, { prefix: '/layout-inspect' })
  await app.register(layoutTestingRoutes, { prefix: '/collection-layouts' })
  // #2614: A/B layouts.
  await app.register(layoutAbRoutes, { prefix: '/collection-layouts' })
  await app.register(virtualCollectionsRoutes, { prefix: '/virtual-collections' })
  await app.register(recordTemplatesRoutes, { prefix: '/record-templates' })
  await app.register(collectionPresetsRoutes, { prefix: '/collection-presets' })
  await app.register(fieldTranslationsRoutes, { prefix: '/field-translations' })
  await app.register(subRowsRoutes, { prefix: '/sub-rows' })
  await app.register(addendumsRoutes, { prefix: '/addendums' })
  await app.register(tasksRoutes, { prefix: '/tasks' })
  await app.register(supportRoutes, { prefix: '/support' })
  await app.register(remindersRoutes, { prefix: '/reminders' })
  await app.register(opsDbRoutes, { prefix: '/ops-db' })
  await app.register(telemetryRoutes, { prefix: '/telemetry' })
  await app.register(opsRuntimeRoutes, { prefix: '/ops-runtime' })
  await app.register(opsLogsRoutes, { prefix: '/ops-logs' })
  await app.register(opsAssistantRoutes, { prefix: '/ops-assistant' })
  await app.register(commandCenterRoutes, { prefix: '/command-center' })
  await app.register(featureFlagRoutes)
  await app.register(eventsStreamRoutes, { prefix: '/events' })
  // #1680 — the event stream narrowed to one saved view, judged as the caller.
  await app.register(viewStreamRoutes, { prefix: '/events/views' })
  await app.register(apiKeyUsageRoutes, { prefix: '/api-keys' })
  await app.register(opsRedisRoutes, { prefix: '/ops-redis' })
  await app.register(cronTimelineRoutes, { prefix: '/cron-timeline' })
  await app.register(referencedByRoutes, { prefix: '/referenced-by' })
  await app.register(userGroupsRoutes, { prefix: '/user-groups' })
  await app.register(geocodeBackfillRoutes, { prefix: '/geocode' })
  await app.register(extensionEventRoutes, { prefix: '/extension-events' })
  await app.register(geocodeSuggestRoutes)
  await app.register(testDataRoutes)
  await app.register(dossierRoutes, { prefix: '/dossier' })
  await app.register(changeSetsRoutes, { prefix: '/change-sets' })
  await app.register(collectionDesignerRoutes, { prefix: '/data-model/designer' })
  await app.register(recordPromotionRoutes, { prefix: '/record-promotion' })
  await app.register(provenanceTraceRoutes)
  await app.register(ssoProviderRoutes, { prefix: '/sso-providers' })
  await app.register(procedureRoutes, { prefix: '/procedures' })
  await app.register(profileFieldsRoutes, { prefix: '/profile-fields' })
  await app.register(approvalsRoutes, { prefix: '/approvals' })
  await app.register(queuesRoutes, { prefix: '/queues' })
  await app.register(itemLocksRoutes, { prefix: '/item-locks' })
  // No auth hook — callbacks are HMAC-token-authenticated and must be reachable from Teams/Slack
  await app.register(messageActionsRoutes, { prefix: '/message-actions' })
  await app.register(userActivityRoutes, { prefix: '/user-activity' })
  await app.register(globalSearchRoutes, { prefix: '/global-search' })
  await app.register(savedViewsRoutes, { prefix: '/saved-views' })
  await app.register(apiAnalyticsRoutes, { prefix: '/api-analytics' })
  await app.register(partnerDependencyRoutes, { prefix: '/partner-dependencies' })
  await app.register(dataQualityRoutes, { prefix: '/data-quality' })
  await app.register(issuesRoutes, { prefix: '/issues' })
  await app.register(devToolsRoutes, { prefix: '/dev-tools' })
  await app.register(persistedQueriesRoutes, { prefix: '/persisted-queries' })
  await app.register(streamRoutes)
  await app.register(deadLettersRoutes, { prefix: '/dead-letters' })
  await app.register(pagesRoutes, { prefix: '/pages' })
  await app.register(semanticSearchRoutes, { prefix: '/search' })
  await app.register(twoFactorRoutes, { prefix: '/two-factor' })
  await app.register(apiKeysRoutes, { prefix: '/api-keys' })
  await app.register(scimRoutes, { prefix: '/scim/v2' })
  await app.register(pdfTemplatesRoutes, { prefix: '/pdf-templates' })
  await app.register(pickerExclusionRoutes, { prefix: '/picker-exclusions' })
  await app.register(erpSubmissionsRoutes, { prefix: '/erp-submissions' })
  await app.register(syncJobsRoutes, { prefix: '/sync-jobs' })
  await app.register(workflowsRoutes, { prefix: '/workflows' })
  await app.register(crossTriggersRoutes, { prefix: '/cross-triggers' })
  await app.register(aiSettingsRoutes, { prefix: '/ai-settings' })
  await app.register(aiKnowledgeRoutes, { prefix: '/ai-knowledge' })
  await app.register(zapierRoutes, { prefix: '/zapier' })
  // Hosted MCP server (Streamable HTTP) + the person's connected AI apps (OAuth grants).
  await app.register(mcpRoutes)
  await app.register(mcpConsoleRoutes, { prefix: '/mcp-console' })
  // #2464 / #2465 — the instance's own MCP tools (extension + named query/flow tools).
  await app.register(mcpToolRoutes, { prefix: '/mcp-tools' })
  await app.register(oauthConnectionRoutes)
  await app.register(mcpConnectionRoutes, { prefix: '/mcp-connections' })
  await app.register(widgetRoutes, { prefix: '/widget' })
  await app.register(widgetsInternalRoutes, { prefix: '/widgets-internal' })
  // Root-level alias for clean external embeds: <script src="https://host/api/widget.js">
  app.get('/widget.js', async (_req, reply) => {
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
    return reply.send(buildWidgetScript())
  })
}
