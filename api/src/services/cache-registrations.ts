import { clearAccountabilityCache } from '../hooks/activity.js'
import { registerCache } from './cache-registry.js'
import { clearMetadataCache } from './collections.js'
import { bustFormulaContextCache } from './formula-context.js'
import { bustMailTemplateOverrides } from './mail.js'
import { bustOwnerGroupCache } from './pipeline-engine.js'
import { bustRollupContributorCache } from './rollups.js'
import { bustInstanceOverridesCache } from './settings-overrides.js'

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
    'Pipeline owner groups per state (60s TTL — ~3,900 groups on EFP)',
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
    'instance-settings-overrides',
    'Per-instance settings override row (30s TTL)',
    bustInstanceOverridesCache
  )
}
