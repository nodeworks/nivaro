import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { clearMetadataCache } from '../services/collections.js'
import { clearRowRuleCache } from '../services/row-rules-autofill.js'
import { accessAuditsRoutes } from './access-audits.js'
import { accessExplainRoutes } from './access-explain.js'
import { accessRequestRoutes } from './access-requests.js'
import { activityRoutes } from './activity.js'
import { addendumsRoutes } from './addendums.js'
import { aiRoutes } from './ai.js'
import { aiSettingsRoutes } from './ai-settings.js'
import { alertsRoutes } from './alerts.js'
import { analyticsRoutes } from './analytics.js'
import { apiAnalyticsRoutes } from './api-analytics.js'
import { apiKeysRoutes } from './api-keys.js'
import { approvalsRoutes } from './approvals.js'
import { atRiskRoutes } from './at-risk.js'
import { attributesRoutes } from './attributes.js'
import { authRoutes } from './auth.js'
import { backupsRoutes } from './backups.js'
import { blackoutDatesRoutes } from './blackout-dates.js'
import { blueprintsRoutes } from './blueprints.js'
import { bulkActionsRoutes } from './bulk-actions.js'
import { chatRoutes } from './chat.js'
import { collectionLayoutsRoutes } from './collection-layouts.js'
import { collectionPresetsRoutes } from './collection-presets.js'
import { collectionsRoutes } from './collections.js'
import { commentsRoutes } from './comments.js'
import { configDiffRoutes } from './config-diff.js'
import { environmentRoutes } from './environments.js'
import { lineageRoutes } from './lineage.js'
import { configConformanceRecordRoutes, configConformanceRoutes } from './config-conformance.js'
import { announcementRoutes } from './announcements.js'
import { readinessRoutes } from './readiness.js'
import { contentExportRoutes } from './content-export.js'
import { coverageGapsRoutes } from './coverage-gaps.js'
import { cronRoutes } from './cron.js'
import { jobRunRoutes } from './job-runs.js'
import { monitorRoutes } from './monitors.js'
import { integrationContractRoutes } from './integration-contracts.js'
import { rumRoutes } from './rum.js'
import { indexAdvisorRoutes } from './index-advisor.js'
import { securityRoutes, securitySelfRoutes } from './security.js'
import { configHealthRoutes } from './config-health.js'
import { legalHoldRoutes } from './legal-holds.js'
import { automationTestRoutes } from './automation-tests.js'
import { bulkRecipeRoutes } from './bulk-recipes.js'
import { findReplaceRoutes } from './find-replace.js'
import { customActionRoutes } from './custom-actions.js'
import { offboardingRoutes } from './offboarding.js'
import { mailTemplateRoutes } from './mail-templates.js'
import { opsCalendarRoutes } from './ops-calendar.js'
import { setupRoutes } from './setup.js'
import { configSearchRoutes } from './config-search.js'
import { mailLogReadRoutes, mailLogRoutes } from './mail-log.js'
import { sequenceRoutes } from './sequences.js'
import { sqlScratchpadRoutes } from './sql-scratchpad.js'
import { collectionSnapshotRoutes } from './collection-snapshots.js'
import { exportPresetRoutes } from './export-presets.js'
import { recordMergeRoutes } from './record-merge.js'
import { realtimeRoutes, recordViewersRoutes } from './realtime.js'
import { chaosRoutes } from './chaos.js'
import { geocodeRoutes } from './geocode.js'
import { recordMetaRoutes } from './record-meta.js'
import { crossTriggersRoutes } from './cross-triggers.js'
import { customQueriesRoutes } from './custom-queries.js'
import { dashboardLinkRoutes } from './dashboard-links.js'
import { dashboardsRoutes } from './dashboards.js'
import { dataModelReadRoutes, dataModelRoutes } from './data-model.js'
import { dataQualityRoutes } from './data-quality.js'
import { deadLettersRoutes } from './dead-letters.js'
import { devToolsRoutes } from './dev-tools.js'
import { draftPublishRoutes } from './draft-publish.js'
import { erpSubmissionsRoutes } from './erp-submissions.js'
import { extensionRegistryRoutes } from './extension-registry.js'
import { extensionsRoutes } from './extensions.js'
import { externalApisRoutes } from './external-apis.js'
import { fieldConfigRoutes } from './field-config.js'
import { fieldGroupsRoutes } from './field-groups.js'
import { fieldHistoryRoutes } from './field-history.js'
import { fieldRulesRoutes } from './field-rules.js'
import { fieldTranslationsRoutes } from './field-translations.js'
import { fieldWatchesRoutes } from './field-watches.js'
import { filesRoutes } from './files.js'
import { flowRegistryRoutes } from './flow-registry.js'
import { flowsRoutes, webhookFlowRoute } from './flows.js'
import { globalSearchRoutes } from './global-search.js'
import { healthRoutes } from './health.js'
import { hierarchyRoutes } from './hierarchy.js'
import { importTemplatesRoutes } from './import-templates.js'
import { importsRoutes } from './imports.js'
import { integrationHealthRoutes } from './integration-health.js'
import { issuesRoutes } from './issues.js'
import { itemActionsRoutes } from './item-actions.js'
import { itemLocksRoutes } from './item-locks.js'
import { itemsRoutes } from './items.js'
import { journeyRoutes } from './journeys.js'
import { lastTouchRoutes } from './last-touch.js'
import { mailRoutes } from './mail.js'
import { meNotificationRoutes } from './me-notifications.js'
import { mergeRoutes } from './merge.js'
import { messageActionsRoutes } from './message-actions.js'
import { metricAlertsRoutes } from './metric-alerts.js'
import { myWorkRoutes } from './my-work.js'
import { notificationSubscriptionsRoutes } from './notification-subscriptions.js'
import { notificationsRoutes } from './notifications.js'
import { pagesRoutes } from './pages.js'
import { pdfTemplatesRoutes } from './pdf-templates.js'
import { persistedQueriesRoutes } from './persisted-queries.js'
import { pickerExclusionRoutes } from './picker-exclusions.js'
import { pinnedRoutes } from './pinned.js'
import { pipelinesRoutes } from './pipelines.js'
import { preflightRoutes } from './preflight.js'
import { buildScript, presenceAdminRoutes, presenceOnlineRoutes } from './presence.js'
import { presetsRoutes } from './presets.js'
import { promotionRoutes } from './promotion.js'
import { pushRoutes } from './push.js'
import { queuesRoutes } from './queues.js'
import { recordGraphRoutes } from './record-graph.js'
import { recordLinkRoutes } from './record-links.js'
import { recordTemplatesRoutes } from './record-templates.js'
import { recordViewRoutes } from './record-views.js'
import { reportStudioRoutes } from './report-studio.js'
import { reportsRoutes } from './reports.js'
import { retentionRoutes } from './retention.js'
import { revisionsRoutes } from './revisions.js'
import { rolesRoutes } from './roles.js'
import { rulesRoutes } from './rules.js'
import { savedViewsRoutes } from './saved-views.js'
import { scheduledChangesRoutes } from './scheduled-changes.js'
import { scheduledReportsRoutes } from './scheduled-reports.js'
import { schemaRoutes } from './schema.js'
import { schemaSnapshotRoutes } from './schema-snapshot.js'
import { scimRoutes } from './scim.js'
import { searchRoutes } from './search.js'
import { semanticSearchRoutes } from './semantic-search.js'
import { sessionRecordingRoutes } from './session-recordings.js'
import { settingsRoutes } from './settings.js'
import { shareLinksRoutes } from './share-links.js'
import { slaRoutes } from './sla.js'
import { stagedImportRoutes } from './staged-imports.js'
import { streamRoutes } from './stream.js'
import { subRowsRoutes } from './sub-rows.js'
import { submissionFormsRoutes } from './submission-forms.js'
import { syncJobsRoutes } from './sync-jobs.js'
import { tasksRoutes } from './tasks.js'
import { remindersRoutes } from './reminders.js'
import { opsDbRoutes } from './ops-db.js'
import { opsRuntimeRoutes } from './ops-runtime.js'
import { opsLogsRoutes } from './ops-logs.js'
import { commandCenterRoutes } from './command-center.js'
import { featureFlagRoutes } from './feature-flags.js'
import { eventsStreamRoutes } from './events-stream.js'
import { apiKeyUsageRoutes } from './api-key-usage.js'
import { opsRedisRoutes } from './ops-redis.js'
import { cronTimelineRoutes } from './cron-timeline.js'
import { referencedByRoutes } from './referenced-by.js'
import { userGroupsRoutes } from './user-groups.js'
import { throughputRoutes } from './throughput.js'
import { timelineRoutes } from './timeline.js'
import { traceRoutes } from './traces.js'
import { trashRoutes } from './trash.js'
import { treeRoutes } from './tree.js'
import { treePermissionsRoutes } from './tree-permissions.js'
import { twoFactorRoutes } from './two-factor.js'
import { userActivityRoutes } from './user-activity.js'
import { userScopesRoutes } from './user-scopes.js'
import { usersRoutes } from './users.js'
import { viewSubscriptionsRoutes } from './view-subscriptions.js'
import { virtualCollectionsRoutes } from './virtual-collections.js'
import { webhooksRoutes } from './webhooks.js'
import { buildWidgetScript, widgetRoutes } from './widget.js'
import { widgetsInternalRoutes } from './widgets-internal.js'
import { workflowsRoutes } from './workflows.js'
import { workspacesRoutes } from './workspaces.js'
import { zapierRoutes } from './zapier.js'

export async function registerRoutes(app: FastifyInstance) {
  // Maintenance mode: instance-wide write freeze (admins exempt, reads fine).
  // Auth stays open so admins can get in to turn it off.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const url = req.url
    if (url.startsWith('/api/auth') || url.startsWith('/api/settings') || url.startsWith('/api/rum')) return
    const { maintenanceState } = await import('../services/security.js')
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
      error: maint.message || 'Maintenance in progress — changes are temporarily disabled.',
      code: 'MAINTENANCE'
    })
  })

  // Collection/field metadata is cached in-process (services/collections.ts) to
  // keep schema lookups off the hot path. Any successful write to a route that
  // can change that metadata drops the cache immediately, so edits are visible
  // on the next request instead of waiting out the TTL. One hook rather than a
  // call at every mutation site — no site can be missed.
  const META_ROUTES =
    /^\/api\/(data-model|collections|field-config|collection-layouts|field-groups)\b/
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 400) return
    if (META_ROUTES.test(req.url)) {
      clearMetadataCache()
      clearRowRuleCache()
      // Config hot-push (#268): tell open clients the schema/layout changed —
      // they re-resolve field-config/layout queries in place and show an
      // "updated" chip instead of serving a stale form until reload.
      try {
        const surface = req.url.split('/')[2] ?? 'config'
        app.io?.emit('config:update', { surface, at: Date.now() })
      } catch {
        /* broadcast is best-effort */
      }
    }
  })

  await app.register(healthRoutes)
  await app.register(preflightRoutes)
  await app.register(traceRoutes)
  await app.register(configDiffRoutes)
  await app.register(environmentRoutes, { prefix: '/environments' })
  await app.register(lineageRoutes, { prefix: '/lineage' })
  await app.register(readinessRoutes, { prefix: '/readiness' })
  await app.register(configConformanceRoutes, { prefix: '/config-conformance' })
  await app.register(configConformanceRecordRoutes, { prefix: '/config-conformance' })
  await app.register(announcementRoutes, { prefix: '/announcements' })
  await app.register(viewSubscriptionsRoutes, { prefix: '/view-subscriptions' })
  await app.register(coverageGapsRoutes)
  await app.register(myWorkRoutes)
  await app.register(accessRequestRoutes)
  await app.register(lastTouchRoutes)
  await app.register(recordViewRoutes)
  await app.register(meNotificationRoutes)
  await app.register(recordLinkRoutes)
  await app.register(fieldHistoryRoutes)
  await app.register(integrationHealthRoutes)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(aiRoutes, { prefix: '/ai' })
  await app.register(activityRoutes, { prefix: '/activity' })
  await app.register(cronRoutes, { prefix: '/cron' })
  await app.register(jobRunRoutes, { prefix: '/job-runs' })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(integrationContractRoutes, { prefix: '/integration-contracts' })
  await app.register(rumRoutes, { prefix: '/rum' })
  await app.register(indexAdvisorRoutes, { prefix: '/index-advisor' })
  await app.register(securityRoutes, { prefix: '/security' })
  await app.register(securitySelfRoutes, { prefix: '/security' })
  await app.register(configHealthRoutes, { prefix: '/config-health' })
  await app.register(legalHoldRoutes, { prefix: '/legal-holds' })
  await app.register(automationTestRoutes, { prefix: '/automation-tests' })
  await app.register(bulkRecipeRoutes, { prefix: '/bulk-recipes' })
  await app.register(findReplaceRoutes, { prefix: '/find-replace' })
  await app.register(customActionRoutes, { prefix: '/custom-actions' })
  await app.register(offboardingRoutes, { prefix: '/offboarding' })
  await app.register(mailTemplateRoutes, { prefix: '/mail-templates' })
  await app.register(opsCalendarRoutes, { prefix: '/ops-calendar' })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.register(configSearchRoutes, { prefix: '/config-search' })
  await app.register(mailLogRoutes, { prefix: '/mail-log' })
  await app.register(mailLogReadRoutes, { prefix: '/mail-log' })
  await app.register(sequenceRoutes, { prefix: '/sequences' })
  await app.register(sqlScratchpadRoutes, { prefix: '/sql-scratchpad' })
  await app.register(collectionSnapshotRoutes, { prefix: '/collection-snapshots' })
  await app.register(exportPresetRoutes, { prefix: '/export-presets' })
  await app.register(recordMergeRoutes, { prefix: '/record-merge' })
  await app.register(realtimeRoutes, { prefix: '/realtime' })
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
  await app.register(dataModelRoutes, { prefix: '/data-model' })
  // Same prefix, auth-only: the read-only relation lookup every record form needs
  await app.register(dataModelReadRoutes, { prefix: '/data-model' })
  await app.register(extensionsRoutes, { prefix: '/extensions' })
  await app.register(itemsRoutes, { prefix: '/items' })
  await app.register(accessExplainRoutes)
  await app.register(accessAuditsRoutes, { prefix: '/access-audits' })
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.register(usersRoutes, { prefix: '/users' })
  await app.register(revisionsRoutes, { prefix: '/revisions' })
  await app.register(rolesRoutes, { prefix: '/roles' })
  await app.register(filesRoutes, { prefix: '/files' })
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
  await app.register(webhooksRoutes, { prefix: '/webhooks' })
  await app.register(searchRoutes, { prefix: '/search' })
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
  await app.register(virtualCollectionsRoutes, { prefix: '/virtual-collections' })
  await app.register(recordTemplatesRoutes, { prefix: '/record-templates' })
  await app.register(collectionPresetsRoutes, { prefix: '/collection-presets' })
  await app.register(fieldTranslationsRoutes, { prefix: '/field-translations' })
  await app.register(subRowsRoutes, { prefix: '/sub-rows' })
  await app.register(addendumsRoutes, { prefix: '/addendums' })
  await app.register(tasksRoutes, { prefix: '/tasks' })
  await app.register(remindersRoutes, { prefix: '/reminders' })
  await app.register(opsDbRoutes, { prefix: '/ops-db' })
  await app.register(opsRuntimeRoutes, { prefix: '/ops-runtime' })
  await app.register(opsLogsRoutes, { prefix: '/ops-logs' })
  await app.register(commandCenterRoutes, { prefix: '/command-center' })
  await app.register(featureFlagRoutes)
  await app.register(eventsStreamRoutes, { prefix: '/events' })
  await app.register(apiKeyUsageRoutes, { prefix: '/api-keys' })
  await app.register(opsRedisRoutes, { prefix: '/ops-redis' })
  await app.register(cronTimelineRoutes, { prefix: '/cron-timeline' })
  await app.register(referencedByRoutes, { prefix: '/referenced-by' })
  await app.register(userGroupsRoutes, { prefix: '/user-groups' })
  await app.register(approvalsRoutes, { prefix: '/approvals' })
  await app.register(queuesRoutes, { prefix: '/queues' })
  await app.register(itemLocksRoutes, { prefix: '/item-locks' })
  // No auth hook — callbacks are HMAC-token-authenticated and must be reachable from Teams/Slack
  await app.register(messageActionsRoutes, { prefix: '/message-actions' })
  await app.register(userActivityRoutes, { prefix: '/user-activity' })
  await app.register(globalSearchRoutes, { prefix: '/global-search' })
  await app.register(savedViewsRoutes, { prefix: '/saved-views' })
  await app.register(apiAnalyticsRoutes, { prefix: '/api-analytics' })
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
  await app.register(zapierRoutes, { prefix: '/zapier' })
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
