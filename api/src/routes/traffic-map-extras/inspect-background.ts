// api/src/routes/traffic-map-extras/inspect-background.ts
import type { FastifyPluginAsync } from 'fastify'
// Loads the group's inspect sources (they register at module load). Task 5 fills both files.
import '../../services/traffic-inspect/background.js'

/** Group "background" routes beyond the generic inspect ones (none yet). */
export const inspectBackgroundRoutes: FastifyPluginAsync = async () => {}
