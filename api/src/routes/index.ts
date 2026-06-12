import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
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
import { blackoutDatesRoutes } from './blackout-dates.js'
import { bulkActionsRoutes } from './bulk-actions.js'
import { collectionLayoutsRoutes } from './collection-layouts.js'
import { collectionPresetsRoutes } from './collection-presets.js'
import { collectionsRoutes } from './collections.js'
import { commentsRoutes } from './comments.js'
import { contentExportRoutes } from './content-export.js'
import { crossTriggersRoutes } from './cross-triggers.js'
import { customQueriesRoutes } from './custom-queries.js'
import { dashboardsRoutes } from './dashboards.js'
import { dataModelRoutes } from './data-model.js'
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
import { fieldRulesRoutes } from './field-rules.js'
import { fieldTranslationsRoutes } from './field-translations.js'
import { fieldWatchesRoutes } from './field-watches.js'
import { filesRoutes } from './files.js'
import { flowRegistryRoutes } from './flow-registry.js'
import { flowsRoutes, webhookFlowRoute } from './flows.js'
import { globalSearchRoutes } from './global-search.js'
import { healthRoutes } from './health.js'
import { hierarchyRoutes } from './hierarchy.js'
import { importsRoutes } from './imports.js'
import { issuesRoutes } from './issues.js'
import { itemActionsRoutes } from './item-actions.js'
import { itemLocksRoutes } from './item-locks.js'
import { itemsRoutes } from './items.js'
import { subRowsRoutes } from './sub-rows.js'
import { mailRoutes } from './mail.js'
import { messageActionsRoutes } from './message-actions.js'
import { notificationSubscriptionsRoutes } from './notification-subscriptions.js'
import { notificationsRoutes } from './notifications.js'
import { pagesRoutes } from './pages.js'
import { pdfTemplatesRoutes } from './pdf-templates.js'
import { pickerExclusionRoutes } from './picker-exclusions.js'
import { persistedQueriesRoutes } from './persisted-queries.js'
import { pipelinesRoutes } from './pipelines.js'
import { buildScript, presenceAdminRoutes } from './presence.js'
import { presetsRoutes } from './presets.js'
import { recordTemplatesRoutes } from './record-templates.js'
import { reportsRoutes } from './reports.js'
import { revisionsRoutes } from './revisions.js'
import { rolesRoutes } from './roles.js'
import { rulesRoutes } from './rules.js'
import { savedViewsRoutes } from './saved-views.js'
import { scheduledChangesRoutes } from './scheduled-changes.js'
import { schemaRoutes } from './schema.js'
import { schemaSnapshotRoutes } from './schema-snapshot.js'
import { scimRoutes } from './scim.js'
import { semanticSearchRoutes } from './semantic-search.js'
import { settingsRoutes } from './settings.js'
import { slaRoutes } from './sla.js'
import { streamRoutes } from './stream.js'
import { submissionFormsRoutes } from './submission-forms.js'
import { syncJobsRoutes } from './sync-jobs.js'
import { tasksRoutes } from './tasks.js'
import { treeRoutes } from './tree.js'
import { treePermissionsRoutes } from './tree-permissions.js'
import { twoFactorRoutes } from './two-factor.js'
import { userActivityRoutes } from './user-activity.js'
import { usersRoutes } from './users.js'
import { virtualCollectionsRoutes } from './virtual-collections.js'
import { webhooksRoutes } from './webhooks.js'
import { buildWidgetScript, widgetRoutes } from './widget.js'
import { retentionRoutes } from './retention.js'
import { workflowsRoutes } from './workflows.js'
import { workspacesRoutes } from './workspaces.js'
import { zapierRoutes } from './zapier.js'

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(aiRoutes, { prefix: '/ai' })
  await app.register(activityRoutes, { prefix: '/activity' })
  await app.register(collectionsRoutes, { prefix: '/collections' })
  await app.register(dataModelRoutes, { prefix: '/data-model' })
  await app.register(extensionsRoutes, { prefix: '/extensions' })
  await app.register(itemsRoutes, { prefix: '/items' })
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
  await app.register(externalApisRoutes, { prefix: '/external-apis' })
  await app.register(webhooksRoutes, { prefix: '/webhooks' })
  await app.register(commentsRoutes, { prefix: '/comments' })
  await app.register(customQueriesRoutes, { prefix: '/custom-queries' })
  await app.register(schemaSnapshotRoutes, { prefix: '/schema-snapshot' })
  await app.register(blackoutDatesRoutes, { prefix: '/blackout-dates' })
  await app.register(rulesRoutes, { prefix: '/rules' })
  await app.register(fieldRulesRoutes, { prefix: '/field-rules' })
  await app.register(dashboardsRoutes, { prefix: '/dashboards' })
  await app.register(reportsRoutes, { prefix: '/reports' })
  await app.register(presetsRoutes, { prefix: '/presets' })
  await app.register(workspacesRoutes, { prefix: '/workspaces' })
  await app.register(schemaRoutes)
  await app.register(submissionFormsRoutes, { prefix: '/submission-forms' })
  await app.register(fieldWatchesRoutes, { prefix: '/field-watches' })
  await app.register(notificationSubscriptionsRoutes, { prefix: '/notification-subscriptions' })
  await app.register(importsRoutes, { prefix: '/imports' })
  await app.register(slaRoutes, { prefix: '/sla' })
  await app.register(alertsRoutes, { prefix: '/alerts' })
  await app.register(analyticsRoutes, { prefix: '/analytics' })
  await app.register(treeRoutes)
  await app.register(treePermissionsRoutes)
  await app.register(atRiskRoutes, { prefix: '/at-risk' })
  await app.register(retentionRoutes, { prefix: '/retention' })
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
  await app.register(approvalsRoutes, { prefix: '/approvals' })
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
  // Root-level alias for clean external embeds: <script src="https://host/api/widget.js">
  app.get('/widget.js', async (_req, reply) => {
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
    return reply.send(buildWidgetScript())
  })
}
