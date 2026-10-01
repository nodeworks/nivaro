// api/src/routes/traffic-map-extras/index.ts
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { clusterRoutes } from './cluster.js'
import { compareRoutes } from './compare.js'
import { deepMeasurementRoutes } from './deep-measurement.js'
import { digestRoutes } from './digest.js'
import { inspectorActionRoutes } from './inspector-actions.js'
import { trafficOpsRoutes } from './ops.js'
import { peopleLensesRoutes } from './people-lenses.js'
import { platformRoutes } from './platform.js'
import { replayRoutes } from './replay.js'
import { requestLensesRoutes } from './request-lenses.js'
import { snapshotRoutes } from './snapshots.js'
import { staleTabsRoutes } from './stale-tabs.js'
import { topologyRoutes } from './topology.js'
import { trafficViewRoutes } from './view.js'

/**
 * Extra Traffic Map routes, one plugin per feature. Registered by trafficMapRoutes AFTER its
 * cloud-404 + requireAdmin hooks, so every route here is under /api/traffic-map, admin only, and
 * answers 404 in cloud mode — a feature adds nothing for that. A route that reads only the
 * caller's store (#1132) may opt in to cloud mode with `config: { trafficTenantAware: true }`.
 *
 * To add one: create `./<feature>.ts` exporting `async function <feature>Routes(app)` that declares
 * its routes relative to the prefix (`app.get('/my-thing', …)` → GET /api/traffic-map/my-thing),
 * then import it here and append it to FEATURES. Keep one line per feature so parallel branches
 * merge cleanly.
 */
const FEATURES: FastifyPluginAsync[] = [
  // import { myFeatureRoutes } from './my-feature.js'  →  myFeatureRoutes,
  deepMeasurementRoutes,
  requestLensesRoutes,
  trafficOpsRoutes,
  clusterRoutes,
  snapshotRoutes,
  compareRoutes,
  digestRoutes,
  replayRoutes,
  topologyRoutes,
  inspectorActionRoutes,
  trafficViewRoutes,
  peopleLensesRoutes,
  staleTabsRoutes,
  platformRoutes
]

export async function trafficMapExtraRoutes(app: FastifyInstance): Promise<void> {
  for (const feature of FEATURES) await app.register(feature)
}
