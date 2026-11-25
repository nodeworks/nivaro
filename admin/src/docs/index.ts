import type { DocSection } from './types.js'

// ─── Section imports ──────────────────────────────────────────────────────────

export * from './sections/access-insights.js'
export * from './sections/admin-ux.js'
export * from './sections/ai-ask-context.js'
export * from './sections/ai-conversations.js'
export * from './sections/ai-design.js'
export * from './sections/ai-explain.js'
export * from './sections/ai-knowledge.js'
export * from './sections/ai-panel.js'
export * from './sections/assist-ops.js'
export * from './sections/attributes.js'
export * from './sections/back-and-peek.js'
export * from './sections/bulk-actions.js'
export * from './sections/changed-after-approval.js'
export * from './sections/changed-by-others.js'
export * from './sections/chaos.js'
export * from './sections/chaos-ci.js'
export * from './sections/chaos-client.js'
export * from './sections/chaos-faults-db.js'
export * from './sections/chaos-faults-redis.js'
export * from './sections/chaos-gameday.js'
export * from './sections/chaos-map.js'
export * from './sections/chaos-ops.js'
export * from './sections/chaos-report.js'
export * from './sections/collaboration.js'
export * from './sections/command-center.js'
export * from './sections/config-review.js'
export * from './sections/content-ops.js'
export * from './sections/copying-records.js'
export * from './sections/data-safety.js'
export * from './sections/db-connections.js'
export * from './sections/db-tuning.js'
export * from './sections/deployment-modes.js'
export * from './sections/detail-sheets.js'
export * from './sections/devex.js'
export * from './sections/disaster-recovery.js'
export * from './sections/duplicate-warnings.js'
export * from './sections/env-refresh.js'
export * from './sections/ext-assistant-tools.js'
export * from './sections/extensions-system.js'
export * from './sections/features.js'
export * from './sections/field-display.js'
export * from './sections/field-rules.js'
export * from './sections/file-downloads.js'
export * from './sections/graphql.js'
export * from './sections/help-videos.js'
export * from './sections/hub.js'
export * from './sections/hub-data.js'
export * from './sections/hub-shared.js'
export * from './sections/ideas.js'
export * from './sections/import-templates.js'
export * from './sections/infrastructure.js'
export * from './sections/infrastructure-drift.js'
export * from './sections/infrastructure-edge.js'
export * from './sections/infrastructure-host.js'
export * from './sections/infrastructure-inventory.js'
export * from './sections/integration-obligations.js'
export * from './sections/integrations.js'
export * from './sections/integrations-console.js'
export * from './sections/issue-trackers.js'
export * from './sections/layout-editor.js'
export * from './sections/line-split.js'
export * from './sections/live-attention.js'
export * from './sections/live-coedit.js'
export * from './sections/live-conflicts.js'
export * from './sections/live-editing.js'
export * from './sections/live-feeds.js'
export * from './sections/live-forms.js'
export * from './sections/live-groups-drags.js'
export * from './sections/live-lists.js'
export * from './sections/live-ops.js'
export * from './sections/live-outside.js'
export * from './sections/live-people.js'
export * from './sections/live-progress.js'
export * from './sections/live-record-moves.js'
export * from './sections/live-records.js'
export * from './sections/live-saves.js'
export * from './sections/live-screens.js'
export * from './sections/live-selection.js'
export * from './sections/live-setting.js'
export * from './sections/live-sync.js'
export * from './sections/low-code.js'
export * from './sections/mobile-app.js'
export * from './sections/monitoring.js'
export * from './sections/observability.js'
export * from './sections/offline-popout.js'
export * from './sections/ops-daily-report.js'
export * from './sections/ops-observability.js'
export * from './sections/ops-tooling.js'
export * from './sections/overview.js'
export * from './sections/partner-needs.js'
export * from './sections/payload-templates.js'
export * from './sections/picker-badges.js'
export * from './sections/platform.js'
export * from './sections/platform-additions.js'
export * from './sections/quality-checks.js'
export * from './sections/queues.js'
export * from './sections/ready-to-send.js'
export * from './sections/realtime-tier.js'
export * from './sections/record-context.js'
export * from './sections/record-glance.js'
export * from './sections/record-insights.js'
export * from './sections/record-integrations.js'
export * from './sections/release-image.js'
export * from './sections/reload-trust.js'
export * from './sections/request-story.js'
export * from './sections/rest-api.js'
export * from './sections/sdk-core.js'
export * from './sections/sdk-extended.js'
export * from './sections/security.js'
export * from './sections/send-my-view.js'
export * from './sections/sql-checks.js'
export * from './sections/storage.js'
export * from './sections/summary-mode.js'
export * from './sections/team-board.js'
export * from './sections/team-throughput.js'
export * from './sections/tree-advanced.js'
export * from './sections/trees.js'
export * from './sections/watch-list.js'
export * from './sections/workflows-pipelines.js'

import { accessInsightsDocs } from './sections/access-insights.js'
import {
  adminUxAiMapping,
  adminUxAiQuery,
  adminUxFormCollaboration,
  adminUxGlobalSearch,
  adminUxImportFromUrl,
  adminUxListSignals,
  adminUxNavigation,
  adminUxSavedViews,
  adminUxSemanticSearch
} from './sections/admin-ux.js'
import { aiAskContextDocs } from './sections/ai-ask-context.js'
import { aiCallLogDocs } from './sections/ai-call-log.js'
import { aiConversationsDocs } from './sections/ai-conversations.js'
import { aiDesignDocs } from './sections/ai-design.js'
import { aiExplainGuide } from './sections/ai-explain.js'
import { aiKnowledgeDocs } from './sections/ai-knowledge.js'
import { aiPanelDocs } from './sections/ai-panel.js'
import { aiTaskDoDocs } from './sections/ai-task-do.js'
import {
  adminI18nDocs,
  aiChatDocs,
  aiPlansDocs,
  aiQualityDocs,
  fieldImpactDocs,
  formsV2Docs,
  pipelineHealthDocs,
  pipelineSimulatorDocs,
  scheduledReportsDocs,
  slaScheduleDocs,
  ssoDocs
} from './sections/assist-ops.js'
import { attributesGuide } from './sections/attributes.js'
import { collabBackAndPeek } from './sections/back-and-peek.js'
import { bulkActionsGuide } from './sections/bulk-actions.js'
import { collabChangedAfterApproval } from './sections/changed-after-approval.js'
import { collabChangedByOthers } from './sections/changed-by-others.js'
import { chaosDocs } from './sections/chaos.js'
import { chaosBuilderDocs } from './sections/chaos-builder.js'
import { chaosCiDocs } from './sections/chaos-ci.js'
import { chaosClientDocs } from './sections/chaos-client.js'
import { chaosFaultsDbDocs } from './sections/chaos-faults-db.js'
import { chaosFaultsRedisDocs } from './sections/chaos-faults-redis.js'
import { chaosGamedayDocs } from './sections/chaos-gameday.js'
import { chaosTrafficMapDocs } from './sections/chaos-map.js'
import { chaosOpsDocs } from './sections/chaos-ops.js'
import { chaosReportDocs } from './sections/chaos-report.js'
import {
  collabApprovals,
  collabChangeProposals,
  collabChat,
  collabItemLocking,
  collabKeyboardShortcuts,
  collabMessageActions,
  collabNotificationsCenter,
  collabSmsPush,
  collabSupportRequests,
  collabTasks,
  collabTeamsBot,
  collabUserActivityFeed
} from './sections/collaboration.js'
import { commandCenterDocs } from './sections/command-center.js'
import { configReviewDocs } from './sections/config-review.js'
import {
  contentOpsAddendums,
  contentOpsCascadeFilters,
  contentOpsChangeReasons,
  contentOpsCloneItem,
  contentOpsCollectionPresets,
  contentOpsComputedDefaults,
  contentOpsCrossRecordDefaults,
  contentOpsDataExport,
  contentOpsDatetimeAuto,
  contentOpsDraftPublish,
  contentOpsFieldDependencies,
  contentOpsFieldGroups,
  contentOpsFieldHistory,
  contentOpsFieldLocking,
  contentOpsFieldVisibility,
  contentOpsGridPresets,
  contentOpsPercentComplete,
  contentOpsPolymorphicRelations,
  contentOpsRecordTemplates,
  contentOpsRemoteOptions,
  contentOpsRepeaterFields,
  contentOpsRichText,
  contentOpsRollback,
  contentOpsScheduledChanges,
  contentOpsSubRows,
  contentOpsTranslations,
  contentOpsValidationRules,
  contentOpsVirtualCollections,
  pickerExclusionsGuide,
  pickerFilterGuide,
  upsertKeysGuide
} from './sections/content-ops.js'
import { copyingRecordsDocs } from './sections/copying-records.js'
import {
  auditLevelDocs,
  bugReporterDocs,
  dashboardLinkDocs,
  journeyTrailDocs,
  mergeDocs,
  reportStudioDocs,
  schemaGraphDocs,
  sessionReplayDocs,
  spreadsheetDocs,
  timeTravelDocs,
  trashDocs,
  widgetImageDocs
} from './sections/data-safety.js'
import { dbConnectionsDocs } from './sections/db-connections.js'
import { dbTuning } from './sections/db-tuning.js'
import { deploymentModesDocs } from './sections/deployment-modes.js'
import { detailSheets } from './sections/detail-sheets.js'
import {
  devexCdcStream,
  devexCodegen,
  devexDeadLetters,
  devexDevTooling,
  devexEnvSync,
  devexFlowVersioning,
  devexMarketplace,
  devexOpenApi,
  devexPersistedQueries,
  devexPlayground,
  devexRateLimits,
  devexRequestSigning,
  devexRevisionDiff,
  devexSchemaMigrations,
  devexWebhookDeliveries,
  devexWebhookSigning
} from './sections/devex.js'
import { disasterRecoveryDocs } from './sections/disaster-recovery.js'
import { duplicateWarningsDocs } from './sections/duplicate-warnings.js'
import { envRefreshDocs } from './sections/env-refresh.js'
import { extAssistantTools } from './sections/ext-assistant-tools.js'
import {
  extContext,
  extCron,
  extExample,
  extExternalApis,
  extFlows,
  extHooks,
  extOverview,
  extPluginBuildGuide,
  extPluginIntegrationTypes,
  extPluginManifest,
  extPluginSlots,
  extPluginSystem,
  extRegistrations,
  extRoutes,
  mssqlRules,
  permissionsModel,
  systemTables
} from './sections/extensions-system.js'
import {
  aiDocumentAutofill,
  aiGenerate,
  aiOverview,
  aiReviewBrief,
  aiSummarize,
  analyticsGuide,
  columnPresets,
  commentsApiDoc,
  dashboardsApiDoc,
  externalApiSpecImportDoc,
  externalApisApiDoc,
  presenceGuide,
  presetsApiDoc,
  reportsApiDoc,
  userComments,
  userComputedFields,
  userDashboardsGuide,
  userDelegation,
  userExternalApisGuide,
  userMicrosoftGuide,
  userNotifications,
  userProfile,
  userReportsGuide,
  userWorkspacesGuide,
  workspacesApiDoc
} from './sections/features.js'
import { fieldDisplaySettingsGuide } from './sections/field-display.js'
import { fieldRulesGuide } from './sections/field-rules.js'
import { fileDownloadsGuide } from './sections/file-downloads.js'
import { formHiddenAndFieldComments } from './sections/form-explain-comment'
import {
  graphqlAuth,
  graphqlFilters,
  graphqlMutations,
  graphqlOverview,
  graphqlQueries,
  graphqlRebuild,
  graphqlSchema,
  graphqlSort,
  graphqlSubscriptions
} from './sections/graphql.js'
import { helpVideosApi, helpVideosGuide, sdkHelpVideos } from './sections/help-videos.js'
import {
  hubCreateDocs,
  hubDatabasesDocs,
  hubDockerDocs,
  hubLinkDocs,
  hubOverviewDocs,
  hubPromotionsDocs,
  hubSigninDocs
} from './sections/hub.js'
import { hubDataDocs } from './sections/hub-data.js'
import { hubMovesDocs, hubSharedDocs } from './sections/hub-shared.js'
import { ideasDocs } from './sections/ideas.js'
import { importTemplatesGuide } from './sections/import-templates.js'
import { infrastructureDocs } from './sections/infrastructure.js'
import { infrastructureDriftDocs } from './sections/infrastructure-drift.js'
import { infrastructureEdgeDocs } from './sections/infrastructure-edge.js'
import { infrastructureHostGuide } from './sections/infrastructure-host.js'
import { infrastructureInventory } from './sections/infrastructure-inventory.js'
import { integrationObligations } from './sections/integration-obligations.js'
import {
  integrationsConnector,
  integrationsCrossTriggers,
  integrationsErp,
  integrationsEvents,
  integrationsOutboundTooling,
  integrationsParallelBranches,
  integrationsSyncJobs
} from './sections/integrations.js'
import { integrationsConsole } from './sections/integrations-console.js'
import { issueTrackers } from './sections/issue-trackers.js'
import { layoutEditor, layoutPersonalDefaults } from './sections/layout-editor.js'
import { lineSplitDocs } from './sections/line-split.js'
import { listEditing } from './sections/list-editing'
import { collabLiveTrace, collabTabCount } from './sections/live-attention.js'
import { collabLiveCoedit } from './sections/live-coedit.js'
import { collabLiveConflicts } from './sections/live-conflicts.js'
import { liveEditingDocs } from './sections/live-editing.js'
import { liveWidgetsDocs, viewStreamDocs } from './sections/live-feeds.js'
import { liveFormsDocs } from './sections/live-forms.js'
import { collabLiveGroupsDrags } from './sections/live-groups-drags.js'
import { collabLiveConfig, collabLiveCounts, collabLiveLists } from './sections/live-lists.js'
import {
  aiActionsDocs,
  flowMapReplayDocs,
  recordGraphDocs,
  wallboardPulseDocs,
  webPushDocs
} from './sections/live-ops.js'
import { liveOutsideDocs } from './sections/live-outside.js'
import { livePeopleDocs } from './sections/live-people.js'
import { collabLiveProgress } from './sections/live-progress.js'
import { liveRecordMovesDocs } from './sections/live-record-moves.js'
import {
  collabLiveAdmin,
  collabLiveOps,
  collabLiveRecords,
  collabPresence
} from './sections/live-records.js'
import { liveSavesDocs } from './sections/live-saves.js'
import { liveScreensDocs } from './sections/live-screens.js'
import { liveSelectionDocs } from './sections/live-selection.js'
import { collabLiveSetting } from './sections/live-setting.js'
import { collabLiveSync } from './sections/live-sync.js'
import { loadingFeelDocs } from './sections/loading-feel'
import {
  lowCodeFormulaBuilder,
  lowCodePageBuilder,
  lowCodeRuleBuilder
} from './sections/low-code.js'
import { managedProceduresDocs } from './sections/managed-procedures.js'
import { mcpDocs } from './sections/mcp.js'
import { mcpAgentsDocs } from './sections/mcp-agents.js'
import { metricAlertsGuide } from './sections/metric-alerts.js'
import { mobileAppDocs } from './sections/mobile-app.js'
import {
  alertEngineGuide,
  alertsApiDoc,
  analyticsApiDoc,
  atRiskFlagging,
  dataImportGuide,
  dataIntegrityGuide,
  fieldWatchesApiDoc,
  fieldWatchesGuide,
  importsApiDoc,
  notificationSubscriptionsApiDoc,
  notificationSubscriptionsGuide,
  presenceApiDoc,
  queueSlaTimers,
  slaApiDoc,
  slaTrackingGuide,
  submissionFormsApiDoc,
  submissionFormsGuide
} from './sections/monitoring.js'
import { navigationPersonal } from './sections/navigation-personal'
import {
  obsApiAnalytics,
  obsDataQuality,
  obsHealthDashboard,
  obsIssueLog,
  obsRealtimePipeline,
  obsTrafficMap,
  obsTrafficMapAct,
  obsTrafficMapInvestigate,
  obsTrafficMapLenses,
  obsTrafficMapPlatform
} from './sections/observability.js'
import { collabOfflinePopout } from './sections/offline-popout.js'
import { opsDailyReportDocs } from './sections/ops-daily-report.js'
import {
  dbHealthDocs,
  deploysVersionsDocs,
  instanceOverridesDocs,
  mailHarnessDocs,
  opsAssistantDocs,
  opsConsoleDocs
} from './sections/ops-observability.js'
import {
  opsBackups,
  opsContentPromotion,
  opsErdView,
  opsErrorTracking,
  opsFileUsage,
  opsPermissionSimulator
} from './sections/ops-tooling.js'
import {
  architecture,
  userActivity,
  userCollections,
  userDashboard,
  userExtensions,
  userFiles,
  userFlows,
  userSettings,
  userUsersRoles,
  whatIsNivaro
} from './sections/overview.js'
import { overviewPageDocs } from './sections/overview-page'
import { overviewSectionsDocs } from './sections/overview-sections'
import { partnerNeedsDocs } from './sections/partner-needs.js'
import { payloadTemplates } from './sections/payload-templates.js'
import { pickerBadgesDocs } from './sections/picker-badges.js'
import {
  aiContentValidation,
  aiDuplicateDetection,
  anomalyDetection,
  collectionLayouts,
  digestEmails,
  ecommercePrimitives,
  layoutAiFeatures,
  layoutConditional,
  layoutPageSlots,
  layoutQuickPicker,
  layoutStepsMode,
  layoutSummaryPanel,
  publicApiDocs,
  roleUiPermissions,
  rowLevelSecurity,
  sdkCoverage,
  smsConfig,
  smtpConfig,
  widgetSdk,
  zapierMake,
  zeroDowntimeMigrations
} from './sections/platform.js'
import {
  adminOpsAdditions,
  eventsAndFlags,
  recordToolkit,
  reportingAdditions
} from './sections/platform-additions.js'
import { qualityChecksDocs } from './sections/quality-checks.js'
import { queuesGuide } from './sections/queues.js'
import { readyToSend } from './sections/ready-to-send.js'
import { realtimeLoadTest } from './sections/realtime-load-test.js'
import { realtimePresenceLoad } from './sections/realtime-presence-load.js'
import { realtimeTierDocs } from './sections/realtime-tier.js'
import { realtimeTransport } from './sections/realtime-transport.js'
import { collabRecordContext } from './sections/record-context.js'
import { collabRecordGlance } from './sections/record-glance.js'
import { recordInsightsDocs } from './sections/record-insights.js'
import { recordIntegrations } from './sections/record-integrations.js'
import { releaseImageDocs } from './sections/release-image.js'
import { collabReloadTrust } from './sections/reload-trust.js'
import { requestStoryDocs } from './sections/request-story.js'
import {
  apiCollections,
  apiFiles,
  apiFilter,
  apiFlows,
  apiHealth,
  apiItems,
  apiOverview,
  apiRoles,
  apiSchemaEndpoints,
  apiStaticTokens,
  apiUsers
} from './sections/rest-api.js'
import {
  sdkActivity,
  sdkAuth,
  sdkFiles,
  sdkFilters,
  sdkForms,
  sdkGraphql,
  sdkNotifications,
  sdkPipeline,
  sdkReact,
  sdkReactLayout,
  sdkReactLive,
  sdkRealtime,
  sdkRest,
  sdkSetup,
  sdkTokens,
  sdkWorkflow
} from './sections/sdk-core.js'
import {
  customQueriesGuide,
  sdkAlerts,
  sdkAttributes,
  sdkBlackoutDates,
  sdkCollections,
  sdkComments,
  sdkCustomQueries,
  sdkExternalApis,
  sdkFlowRuns,
  sdkLayoutEditor,
  sdkNotificationSubscriptions,
  sdkPresence,
  sdkQueues,
  sdkRules,
  sdkSchemaSnapshot,
  sdkSlaRules,
  sdkWebhooks
} from './sections/sdk-extended.js'
import {
  securityAlerts,
  securityApiKeys,
  securityFieldEncryption,
  securityMasquerade,
  securityMultiDb,
  securityQuotas,
  securityReadReplica,
  securityRetentionPolicies,
  securityRowIsolation,
  securitySaml,
  securityScim,
  securityTwoFactor,
  securityUserScopes,
  securityWorkspaceTemplates
} from './sections/security.js'
import { collabSendMyView } from './sections/send-my-view.js'
import { sqlChecksDocs } from './sections/sql-checks.js'
import {
  storageFileExpiry,
  storageImageTransforms,
  storagePdfTemplates,
  storageProviders
} from './sections/storage.js'
import { summaryMode } from './sections/summary-mode.js'
import { collabTeamBoard } from './sections/team-board.js'
import {
  managersTeamGuide,
  peoplePageGuide,
  teamThroughputGuide
} from './sections/team-throughput.js'
import {
  orgChartView,
  treeInheritedFields,
  treePathColumn,
  treePermissionsGuide,
  treeReorder
} from './sections/tree-advanced.js'
import {
  hierarchyBrowserScope,
  hierarchyItemContext,
  multiHierarchyApi,
  multiHierarchyExample,
  multiHierarchyOverview,
  multiHierarchySetup,
  sdkTreeHierarchy,
  treeApi,
  treeExample,
  treeExtensions,
  treeOverview,
  treeSetup
} from './sections/trees.js'
import { collabWatchList } from './sections/watch-list.js'
import {
  pipelineApi,
  pipelineBranching,
  pipelineDimensions,
  pipelineNoOwnerSteps,
  pipelineOpenWhen,
  pipelineOverview,
  pipelineOwnerMatrix,
  pipelineOwnerOpened,
  pipelineSpecificity,
  pipelineStartState,
  pipelineUpdateState,
  userWorkflows,
  workflowsApi
} from './sections/workflows-pipelines.js'

// ─── Navigation structure ─────────────────────────────────────────────────────

export interface NavGroup {
  id: string
  label: string
  items: DocSection[]
}

export const navSections: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [whatIsNivaro, architecture]
  },
  {
    id: 'user-guide',
    label: 'User Guide',
    items: [
      userDashboard,
      overviewPageDocs,
      overviewSectionsDocs,
      userCollections,
      columnPresets,
      userUsersRoles,
      userProfile,
      userDelegation,
      userWorkflows,
      userFlows,
      userFiles,
      userExtensions,
      userSettings,
      userActivity,
      userNotifications,
      userComments,
      userComputedFields,
      userDashboardsGuide,
      userReportsGuide,
      userMicrosoftGuide,
      userWorkspacesGuide,
      userExternalApisGuide,
      customQueriesGuide,
      presenceGuide,
      analyticsGuide
    ]
  },
  {
    id: 'pipeline-engine',
    label: 'Pipeline Engine',
    items: [
      flowMapReplayDocs,
      pipelineSimulatorDocs,
      pipelineHealthDocs,
      pipelineOverview,
      pipelineStartState,
      pipelineUpdateState,
      pipelineDimensions,
      pipelineOwnerMatrix,
      pipelineNoOwnerSteps,
      pipelineOpenWhen,
      pipelineOwnerOpened,
      pipelineSpecificity,
      pipelineBranching,
      queuesGuide,
      bulkActionsGuide
    ]
  },
  {
    id: 'rest-api',
    label: 'REST API',
    items: [
      apiOverview,
      apiStaticTokens,
      apiSchemaEndpoints,
      apiItems,
      apiFilter,
      apiCollections,
      apiUsers,
      apiRoles,
      workflowsApi,
      apiFlows,
      pipelineApi,
      externalApisApiDoc,
      externalApiSpecImportDoc,
      presetsApiDoc,
      commentsApiDoc,
      dashboardsApiDoc,
      reportsApiDoc,
      workspacesApiDoc,
      apiFiles,
      apiHealth
    ]
  },
  {
    id: 'graphql',
    label: 'GraphQL API',
    items: [
      graphqlOverview,
      graphqlSchema,
      graphqlQueries,
      graphqlFilters,
      graphqlSort,
      graphqlMutations,
      graphqlSubscriptions,
      graphqlAuth,
      graphqlRebuild
    ]
  },
  {
    id: 'sdk',
    label: 'SDK (@nivaro/sdk)',
    items: [
      sdkSetup,
      sdkAuth,
      sdkRest,
      sdkWorkflow,
      sdkPipeline,
      sdkForms,
      sdkReact,
      sdkReactLayout,
      sdkReactLive,
      sdkNotifications,
      sdkActivity,
      sdkExternalApis,
      sdkGraphql,
      sdkTokens,
      sdkFiles,
      sdkRealtime,
      sdkFilters,
      sdkComments,
      sdkWebhooks,
      sdkRules,
      sdkFlowRuns,
      sdkCustomQueries,
      sdkCollections,
      sdkBlackoutDates,
      sdkLayoutEditor,
      sdkSchemaSnapshot,
      sdkAlerts,
      sdkAttributes,
      sdkNotificationSubscriptions,
      sdkSlaRules,
      sdkQueues,
      sdkPresence,
      sdkTreeHierarchy,
      sdkHelpVideos,
      sdkCoverage
    ]
  },
  {
    id: 'extensions',
    label: 'Extension Development',
    items: [
      extOverview,
      extContext,
      extHooks,
      extCron,
      extRoutes,
      extExternalApis,
      extFlows,
      extRegistrations,
      extAssistantTools,
      extExample,
      extPluginSystem,
      extPluginManifest,
      extPluginSlots,
      extPluginBuildGuide,
      extPluginIntegrationTypes,
      eventsAndFlags,
      qualityChecksDocs,
      envRefreshDocs
    ]
  },
  {
    id: 'ai-features',
    label: 'AI Features',
    items: [
      aiChatDocs,
      aiQualityDocs,
      aiAskContextDocs,
      aiConversationsDocs,
      aiPanelDocs,
      aiKnowledgeDocs,
      aiCallLogDocs,
      aiActionsDocs,
      aiPlansDocs,
      aiTaskDoDocs,
      accessInsightsDocs,
      aiOverview,
      aiGenerate,
      aiSummarize,
      aiReviewBrief,
      aiDocumentAutofill,
      aiContentValidation,
      aiDuplicateDetection,
      aiDesignDocs,
      mcpDocs,
      mcpAgentsDocs
    ]
  },
  {
    id: 'monitoring',
    label: 'Monitoring & Automation',
    items: [
      reportStudioDocs,
      reportingAdditions,
      scheduledReportsDocs,
      slaScheduleDocs,
      submissionFormsGuide,
      fieldWatchesGuide,
      notificationSubscriptionsGuide,
      dataImportGuide,
      importTemplatesGuide,
      slaTrackingGuide,
      queueSlaTimers,
      alertEngineGuide,
      metricAlertsGuide,
      atRiskFlagging,
      dataIntegrityGuide,
      teamThroughputGuide,
      fileDownloadsGuide,
      managersTeamGuide,
      peoplePageGuide,
      anomalyDetection,
      smtpConfig,
      smsConfig,
      digestEmails,
      aiExplainGuide
    ]
  },
  {
    id: 'monitoring-api',
    label: 'Monitoring APIs',
    items: [
      submissionFormsApiDoc,
      fieldWatchesApiDoc,
      notificationSubscriptionsApiDoc,
      importsApiDoc,
      slaApiDoc,
      alertsApiDoc,
      presenceApiDoc,
      analyticsApiDoc
    ]
  },
  {
    id: 'content-ops',
    label: 'Content Operations',
    items: [
      trashDocs,
      timeTravelDocs,
      auditLevelDocs,
      mergeDocs,
      spreadsheetDocs,
      formsV2Docs,
      contentOpsDraftPublish,
      contentOpsScheduledChanges,
      contentOpsDataExport,
      contentOpsFieldGroups,
      contentOpsFieldVisibility,
      contentOpsFieldLocking,
      contentOpsFieldDependencies,
      contentOpsCascadeFilters,
      contentOpsValidationRules,
      contentOpsChangeReasons,
      contentOpsComputedDefaults,
      contentOpsCrossRecordDefaults,
      contentOpsRemoteOptions,
      contentOpsRepeaterFields,
      contentOpsRichText,
      contentOpsDatetimeAuto,
      contentOpsSubRows,
      contentOpsTranslations,
      contentOpsRecordTemplates,
      contentOpsCollectionPresets,
      ecommercePrimitives,
      contentOpsVirtualCollections,
      contentOpsCloneItem,
      contentOpsRollback,
      contentOpsFieldHistory,
      recordInsightsDocs,
      recordToolkit,
      contentOpsAddendums,
      contentOpsPercentComplete,
      contentOpsPolymorphicRelations,
      contentOpsGridPresets,
      pickerFilterGuide,
      pickerExclusionsGuide,
      upsertKeysGuide
    ]
  },
  {
    id: 'security',
    label: 'Security & Infrastructure',
    items: [
      ssoDocs,
      securityMultiDb,
      securityReadReplica,
      securityTwoFactor,
      securitySaml,
      securityApiKeys,
      securityMasquerade,
      securityAlerts,
      securityUserScopes,
      securityScim,
      securityFieldEncryption,
      securityRowIsolation,
      securityQuotas,
      securityWorkspaceTemplates,
      securityRetentionPolicies,
      rowLevelSecurity,
      roleUiPermissions,
      zeroDowntimeMigrations
    ]
  },
  {
    id: 'devex',
    label: 'Developer Experience',
    items: [
      devexCodegen,
      devexDevTooling,
      devexOpenApi,
      devexWebhookDeliveries,
      devexWebhookSigning,
      devexRequestSigning,
      devexRateLimits,
      devexCdcStream,
      devexPersistedQueries,
      devexDeadLetters,
      devexFlowVersioning,
      devexEnvSync,
      devexSchemaMigrations,
      managedProceduresDocs,
      devexMarketplace,
      devexPlayground,
      devexRevisionDiff,
      publicApiDocs
    ]
  },
  {
    id: 'storage',
    label: 'Storage & Files',
    items: [storageProviders, storageImageTransforms, storageFileExpiry, storagePdfTemplates]
  },
  {
    id: 'integrations',
    label: 'Integration & Sync',
    items: [
      integrationsConsole,
      issueTrackers,
      readyToSend,
      integrationsErp,
      payloadTemplates,
      integrationObligations,
      recordIntegrations,
      integrationsEvents,
      integrationsOutboundTooling,
      integrationsSyncJobs,
      integrationsConnector,
      integrationsParallelBranches,
      integrationsCrossTriggers,
      widgetSdk,
      zapierMake
    ]
  },
  {
    id: 'collaboration',
    label: 'Collaboration',
    items: [
      collabTasks,
      collabSupportRequests,
      collabChangeProposals,
      collabApprovals,
      collabChat,
      collabItemLocking,
      collabLiveRecords,
      collabReloadTrust,
      collabLiveConflicts,
      collabLiveCoedit,
      liveEditingDocs,
      collabLiveSync,
      collabRecordGlance,
      collabRecordContext,
      liveWidgetsDocs,
      liveOutsideDocs,
      livePeopleDocs,
      collabLiveProgress,
      liveFormsDocs,
      pickerBadgesDocs,
      liveSavesDocs,
      liveRecordMovesDocs,
      collabOfflinePopout,
      collabLiveLists,
      liveSelectionDocs,
      collabLiveGroupsDrags,
      collabChangedByOthers,
      collabChangedAfterApproval,
      liveScreensDocs,
      collabLiveCounts,
      collabLiveConfig,
      collabBackAndPeek,
      collabWatchList,
      collabLiveOps,
      collabLiveAdmin,
      collabPresence,
      collabSendMyView,
      collabTabCount,
      collabLiveSetting,
      collabLiveTrace,
      collabTeamBoard,
      collabNotificationsCenter,
      collabUserActivityFeed,
      collabKeyboardShortcuts,
      collabSmsPush,
      webPushDocs,
      collabMessageActions,
      collabTeamsBot,
      helpVideosGuide,
      helpVideosApi,
      ideasDocs
    ]
  },
  {
    id: 'admin-ux',
    label: 'Admin UX & Search',
    items: [
      adminOpsAdditions,
      adminI18nDocs,
      adminUxNavigation,
      navigationPersonal,
      listEditing,
      formHiddenAndFieldComments,
      loadingFeelDocs,
      adminUxGlobalSearch,
      adminUxSavedViews,
      adminUxFormCollaboration,
      duplicateWarningsDocs,
      partnerNeedsDocs,
      lineSplitDocs,
      copyingRecordsDocs,
      adminUxListSignals,
      adminUxImportFromUrl,
      adminUxAiMapping,
      adminUxAiQuery,
      adminUxSemanticSearch
    ]
  },
  {
    id: 'low-code',
    label: 'Low-Code Builders',
    items: [
      lowCodePageBuilder,
      lowCodeRuleBuilder,
      lowCodeFormulaBuilder,
      dashboardLinkDocs,
      widgetImageDocs
    ]
  },
  {
    id: 'observability',
    label: 'Observability',
    items: [
      obsApiAnalytics,
      obsTrafficMap,
      obsTrafficMapInvestigate,
      obsTrafficMapAct,
      obsTrafficMapLenses,
      obsTrafficMapPlatform,
      realtimeTransport,
      viewStreamDocs,
      commandCenterDocs,
      wallboardPulseDocs,
      recordGraphDocs,
      bugReporterDocs,
      journeyTrailDocs,
      sessionReplayDocs,
      obsHealthDashboard,
      opsDailyReportDocs,
      requestStoryDocs,
      obsRealtimePipeline,
      realtimeLoadTest,
      realtimePresenceLoad,
      dbHealthDocs,
      dbConnectionsDocs,
      dbTuning,
      sqlChecksDocs,
      configReviewDocs,
      opsConsoleDocs,
      opsAssistantDocs,
      deploysVersionsDocs,
      instanceOverridesDocs,
      mailHarnessDocs,
      obsDataQuality,
      obsIssueLog,
      opsErrorTracking,
      opsBackups,
      disasterRecoveryDocs,
      opsContentPromotion,
      opsFileUsage,
      opsPermissionSimulator,
      opsErdView
    ]
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    items: [
      infrastructureDocs,
      infrastructureInventory,
      infrastructureEdgeDocs,
      infrastructureHostGuide,
      infrastructureDriftDocs,
      releaseImageDocs,
      realtimeTierDocs,
      deploymentModesDocs,
      hubOverviewDocs,
      hubLinkDocs,
      hubPromotionsDocs,
      hubDockerDocs,
      hubSigninDocs,
      hubDatabasesDocs,
      hubCreateDocs,
      hubSharedDocs,
      hubMovesDocs,
      hubDataDocs
    ]
  },
  {
    id: 'chaos',
    label: 'Chaos engineering',
    items: [
      chaosDocs,
      chaosBuilderDocs,
      chaosFaultsDbDocs,
      chaosFaultsRedisDocs,
      chaosReportDocs,
      chaosGamedayDocs,
      chaosOpsDocs,
      chaosClientDocs,
      chaosTrafficMapDocs,
      chaosCiDocs
    ]
  },
  {
    id: 'data-model',
    label: 'Data Model',
    items: [
      schemaGraphDocs,
      fieldImpactDocs,
      systemTables,
      permissionsModel,
      mssqlRules,
      fieldDisplaySettingsGuide,
      fieldRulesGuide,
      attributesGuide,
      collectionLayouts,
      layoutEditor,
      layoutStepsMode,
      layoutQuickPicker,
      detailSheets,
      summaryMode,
      layoutSummaryPanel,
      layoutPageSlots,
      layoutConditional,
      layoutPersonalDefaults,
      layoutAiFeatures
    ]
  },
  {
    id: 'trees',
    label: 'Tree & Hierarchy',
    items: [
      multiHierarchyOverview,
      multiHierarchySetup,
      multiHierarchyApi,
      multiHierarchyExample,
      hierarchyBrowserScope,
      hierarchyItemContext,
      treeOverview,
      treeSetup,
      orgChartView,
      treeReorder,
      treePathColumn,
      treeInheritedFields,
      treePermissionsGuide,
      treeApi,
      treeExtensions,
      sdkTreeHierarchy,
      treeExample
    ]
  },
  {
    id: 'platform',
    label: 'Platform',
    items: [mobileAppDocs]
  }
]

// ─── Flat lookup ──────────────────────────────────────────────────────────────

export const allSections: Record<string, DocSection> = Object.fromEntries(
  navSections.flatMap((g) => g.items.map((s) => [s.id, s]))
)
