// api/src/routes/traffic-map-extras/inspect-nav.ts
import type { FastifyPluginAsync } from 'fastify'
// Loads the group's inspect sources (they register at module load). Task 7 fills both files.
import '../../services/traffic-inspect/nav.js'

/** Group "nav" routes beyond the generic inspect ones (none yet). */
export const inspectNavRoutes: FastifyPluginAsync = async () => {}
