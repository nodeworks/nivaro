// api/src/routes/traffic-map-extras/inspect-actions.ts
import type { FastifyPluginAsync } from 'fastify'
// Loads the group's inspect sources (they register at module load). Task 8 fills both files.
import '../../services/traffic-inspect/actions.js'

/** Group "actions" routes beyond the generic inspect ones (none yet). */
export const inspectActionsRoutes: FastifyPluginAsync = async () => {}
