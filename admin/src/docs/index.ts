import type { DocSection } from './types.js'

// ─── Section imports ──────────────────────────────────────────────────────────

export * from './sections/admin-ux.js'
export * from './sections/attributes.js'
export * from './sections/collaboration.js'
export * from './sections/content-ops.js'
export * from './sections/devex.js'
export * from './sections/extensions-system.js'
export * from './sections/features.js'
export * from './sections/field-display.js'
export * from './sections/field-rules.js'
export * from './sections/graphql.js'
export * from './sections/integrations.js'
export * from './sections/low-code.js'
export * from './sections/monitoring.js'
export * from './sections/observability.js'
export * from './sections/overview.js'
export * from './sections/platform.js'
export * from './sections/rest-api.js'
export * from './sections/sdk-core.js'
export * from './sections/sdk-extended.js'
export * from './sections/security.js'
export * from './sections/storage.js'
export * from './sections/tree-advanced.js'
export * from './sections/trees.js'
export * from './sections/workflows-pipelines.js'

import {
  adminUxAiMapping,
  adminUxAiQuery,
  adminUxGlobalSearch,
  adminUxImportFromUrl,
  adminUxSavedViews,
  adminUxSemanticSearch
} from './sections/admin-ux.js'
import { attributesGuide } from './sections/attributes.js'
import {
  collabApprovals,
  collabItemLocking,
  collabKeyboardShortcuts,
  collabMessageActions,
  collabNotificationsCenter,
  collabSmsPush,
  collabTasks,
  collabUserActivityFeed
} from './sections/collaboration.js'
import {
  contentOpsAddendums,
  contentOpsCloneItem,
  contentOpsCollectionPresets,
  contentOpsComputedDefaults,
  contentOpsCrossRecordDefaults,
  contentOpsDataExport,
  contentOpsDatetimeAuto,
  contentOpsDraftPublish,
  contentOpsCascadeFilters,
  contentOpsFieldDependencies,
  contentOpsFieldGroups,
  contentOpsFieldHistory,
  contentOpsFieldLocking,
  contentOpsFieldVisibility,
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
  pickerFilterGuide,
  pickerExclusionsGuide
} from './sections/content-ops.js'
import {
  devexCdcStream,
  devexCodegen,
  devexDeadLetters,
  devexEnvSync,
  devexFlowVersioning,
  devexMarketplace,
  devexOpenApi,
  devexPersistedQueries,
  devexRateLimits,
  devexRequestSigning,
  devexRevisionDiff,
  devexSchemaMigrations,
  devexSdkPlayground,
  devexWebhookDeliveries,
  devexWebhookSigning
} from './sections/devex.js'
import {
  extContext,
  extCron,
  extExample,
  extExternalApis,
  extFlows,
  extHooks,
  extInngest,
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
  aiGenerate,
  aiOverview,
  aiSummarize,
  analyticsGuide,
  columnPresets,
  commentsApiDoc,
  dashboardsApiDoc,
  externalApisApiDoc,
  externalApiSpecImportDoc,
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
import {
  integrationsConnector,
  integrationsCrossTriggers,
  integrationsErp,
  integrationsParallelBranches,
  integrationsSyncJobs
} from './sections/integrations.js'
import {
  lowCodeFormulaBuilder,
  lowCodePageBuilder,
  lowCodeRuleBuilder
} from './sections/low-code.js'
import {
  alertEngineGuide,
  alertsApiDoc,
  analyticsApiDoc,
  atRiskFlagging,
  dataImportGuide,
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
import {
  obsApiAnalytics,
  obsDataQuality,
  obsHealthDashboard,
  obsIssueLog
} from './sections/observability.js'
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
  sdkNotificationSubscriptions,
  sdkPresence,
  sdkRules,
  sdkSchemaSnapshot,
  sdkSlaRules,
  sdkWebhooks
} from './sections/sdk-extended.js'
import {
  securityApiKeys,
  securityFieldEncryption,
  securityMultiDb,
  securityQuotas,
  securityReadReplica,
  securityRetentionPolicies,
  securityRowIsolation,
  securitySaml,
  securityScim,
  securityTwoFactor,
  securityWorkspaceTemplates
} from './sections/security.js'
import {
  storageFileExpiry,
  storageImageTransforms,
  storagePdfTemplates,
  storageProviders
} from './sections/storage.js'
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
import {
  pipelineApi,
  pipelineBranching,
  pipelineDimensions,
  pipelineOverview,
  pipelineOwnerMatrix,
  pipelineSpecificity,
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
      pipelineOverview,
      pipelineDimensions,
      pipelineOwnerMatrix,
      pipelineSpecificity,
      pipelineBranching
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
      sdkSchemaSnapshot,
      sdkAlerts,
      sdkAttributes,
      sdkNotificationSubscriptions,
      sdkSlaRules,
      sdkPresence,
      sdkTreeHierarchy,
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
      extInngest,
      extExternalApis,
      extFlows,
      extRegistrations,
      extExample,
      extPluginSystem,
      extPluginManifest,
      extPluginSlots,
      extPluginBuildGuide,
      extPluginIntegrationTypes
    ]
  },
  {
    id: 'ai-features',
    label: 'AI Features',
    items: [aiOverview, aiGenerate, aiSummarize, aiContentValidation, aiDuplicateDetection]
  },
  {
    id: 'monitoring',
    label: 'Monitoring & Automation',
    items: [
      submissionFormsGuide,
      fieldWatchesGuide,
      notificationSubscriptionsGuide,
      dataImportGuide,
      slaTrackingGuide,
      queueSlaTimers,
      alertEngineGuide,
      atRiskFlagging,
      anomalyDetection,
      smtpConfig,
      smsConfig,
      digestEmails
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
      contentOpsDraftPublish,
      contentOpsScheduledChanges,
      contentOpsDataExport,
      contentOpsFieldGroups,
      contentOpsFieldVisibility,
      contentOpsFieldLocking,
      contentOpsFieldDependencies,
      contentOpsCascadeFilters,
      contentOpsValidationRules,
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
      contentOpsAddendums,
      contentOpsPercentComplete,
      contentOpsPolymorphicRelations,
      pickerFilterGuide,
      pickerExclusionsGuide
    ]
  },
  {
    id: 'security',
    label: 'Security & Infrastructure',
    items: [
      securityMultiDb,
      securityReadReplica,
      securityTwoFactor,
      securitySaml,
      securityApiKeys,
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
      devexMarketplace,
      devexSdkPlayground,
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
      integrationsErp,
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
      collabApprovals,
      collabItemLocking,
      collabNotificationsCenter,
      collabUserActivityFeed,
      collabKeyboardShortcuts,
      collabSmsPush,
      collabMessageActions
    ]
  },
  {
    id: 'admin-ux',
    label: 'Admin UX & Search',
    items: [
      adminUxGlobalSearch,
      adminUxSavedViews,
      adminUxImportFromUrl,
      adminUxAiMapping,
      adminUxAiQuery,
      adminUxSemanticSearch
    ]
  },
  {
    id: 'low-code',
    label: 'Low-Code Builders',
    items: [lowCodePageBuilder, lowCodeRuleBuilder, lowCodeFormulaBuilder]
  },
  {
    id: 'observability',
    label: 'Observability',
    items: [obsApiAnalytics, obsHealthDashboard, obsDataQuality, obsIssueLog]
  },
  {
    id: 'data-model',
    label: 'Data Model',
    items: [
      systemTables,
      permissionsModel,
      mssqlRules,
      fieldDisplaySettingsGuide,
      fieldRulesGuide,
      attributesGuide,
      collectionLayouts,
      layoutStepsMode,
      layoutSummaryPanel,
      layoutPageSlots,
      layoutConditional,
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
  }
]

// ─── Flat lookup ──────────────────────────────────────────────────────────────

export const allSections: Record<string, DocSection> = Object.fromEntries(
  navSections.flatMap((g) => g.items.map((s) => [s.id, s]))
)
