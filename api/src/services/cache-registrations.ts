import { clearMetadataQueryCache } from '../db/metadata-query-cache.js'
import { ownersChanged } from '../db/owner-signal.js'
import { clearAccountabilityCache } from '../hooks/activity.js'
import { bustWorkflowAutoCaches } from '../hooks/workflow-auto.js'
import { clearDefaultWorkspaceCache } from '../middleware/workspace.js'
import { bustPortalLinkCache } from './app-links.js'
import { clearScheduleCache } from './business-hours.js'
import { registerCache } from './cache-registry.js'
import { clearMetadataCache } from './collections.js'
import { bustDefinitionCache } from './definition-cache.js'
import { clearEncryptedFieldCache } from './encryption.js'
import { bustFormulaContextCache } from './formula-context.js'
import { bustContractCache } from './integration-contracts.js'
import { bustMailTemplateOverrides } from './mail.js'
import { bustMailBrandingCache } from './mail-branding.js'
import { bustNotificationTemplateCache } from './notification-templates.js'
import { clearPickerRuleCache } from './picker-rules.js'
import { bustOwnerGroupCache } from './pipeline-engine.js'
import { clearRelationLimitCache } from './relation-limits.js'
import { bustRollupContributorCache } from './rollups.js'
import { clearRowRuleCache } from './row-rules-autofill.js'
import { bustSectionLockCache } from './section-locks.js'
import { bustInstanceOverridesCache } from './settings-overrides.js'
import { clearSlaZoneCache } from './sla-zones.js'
import { bustTransitionGuardCache } from './transition-guard.js'
import { clearTreePermissionCache } from './tree-permissions.js'
import { bustScopeDimensionCache, bustScopePathCache, bustUserScopeCache } from './user-scopes.js'

/**
 * Cache console wiring (#236): names the process's major in-memory caches so
 * /ops-runtime/caches can list and bust them without a restart. Registration
 * only — every bust function already existed and keeps its own call sites.
 */
export function registerKnownCaches(): void {
  registerCache(
    'collection-metadata',
    'Collections + fields metadata (30s TTL, also busted by config mutations)',
    () => clearMetadataCache()
  )
  registerCache(
    'owner-groups',
    'Pipeline owner groups per state (60s TTL — thousands of groups on large deployments)',
    bustOwnerGroupCache
  )
  registerCache(
    'rollup-contributors',
    'Stored-rollup contributor map (child collection → parent rollups)',
    bustRollupContributorCache
  )
  registerCache(
    'accountability-levels',
    'Per-collection audit level (all / activity / none, 60s TTL)',
    () => clearAccountabilityCache()
  )
  registerCache(
    'formula-context',
    'Formula constants + fiscal-year settings snapshot',
    bustFormulaContextCache
  )
  registerCache(
    'mail-template-overrides',
    'DB mail-template override layer (60s TTL)',
    bustMailTemplateOverrides
  )
  registerCache(
    'mail-branding',
    'Mail branding per workspace + instance fallback (60s TTL, busted by workspace/settings writes)',
    bustMailBrandingCache
  )
  registerCache(
    'instance-settings-overrides',
    'Per-instance settings override row (30s TTL)',
    bustInstanceOverridesCache
  )
  registerCache(
    'config-reads',
    'Configuration reads at the driver seam (relations, fields, rules, layouts, column lists)',
    clearMetadataQueryCache
  )
  registerCache('user-scopes', 'User scope rows, scope dimensions and resolved scope paths', () => {
    bustUserScopeCache()
    bustScopeDimensionCache()
    bustScopePathCache()
  })
  registerCache(
    'workflow-auto',
    'Workflow bindings and watched child collections for automatic transitions',
    bustWorkflowAutoCaches
  )
  registerCache(
    'owner-derived',
    'Working-on lists and inactive-people scans (cleared whenever owners change)',
    ownersChanged
  )
  registerCache('row-rules', 'Grid row rules read from the active layouts', clearRowRuleCache)
  registerCache(
    'relation-limits',
    'Unique-row and link limits enforced on write',
    clearRelationLimitCache
  )
  registerCache('picker-rules', 'Picker rules enforced on write', clearPickerRuleCache)
  registerCache('section-locks', 'Sections locked per role', bustSectionLockCache)
  registerCache('tree-permissions', 'Which collections carry subtree permission rules', () =>
    clearTreePermissionCache()
  )
  registerCache('definitions', 'Widget and custom query definitions (60s)', () =>
    bustDefinitionCache()
  )
  registerCache('sla-zones', 'Regional business-hour clocks', clearSlaZoneCache)
  registerCache('business-hours', 'Business hours and holidays', clearScheduleCache)
  registerCache('transition-guard', 'Repeat transition guard setting', bustTransitionGuardCache)
  registerCache('integration-contracts', 'Inbound payload contracts', bustContractCache)
  registerCache('notification-templates', 'In-app notification templates', () =>
    bustNotificationTemplateCache()
  )
  registerCache('encrypted-fields', 'Which fields are stored encrypted', () =>
    clearEncryptedFieldCache()
  )
  registerCache('default-workspace', 'The default workspace id', clearDefaultWorkspaceCache)
  registerCache('portal-links', 'Portal base URL and route templates', bustPortalLinkCache)
  registerCache('compiled-checks', 'Data integrity checks compiled per collection', () => {
    void import('./config-conformance.js').then((m) => m.bustCompiledChecks()).catch(() => {})
  })
  registerCache('extension-settings', 'Extension settings values', () => {
    void import('../extensions/loader.js')
      .then((m) => m.bustExtensionSettingsCache())
      .catch(() => {})
  })
}
