// api/src/routes/traffic-map-extras/inspect-request.ts
import type { FastifyPluginAsync } from 'fastify'
// Loads the group's inspect sources (they register at module load). Task 3 fills both files.
import '../../services/traffic-inspect/request.js'

/** Group "request" routes beyond the generic inspect ones (none yet). */
export const inspectRequestRoutes: FastifyPluginAsync = async () => {}
