// api/src/routes/traffic-map-extras/inspect-entities.ts
import type { FastifyPluginAsync } from 'fastify'
// Loads the group's inspect sources (they register at module load). Task 6 fills both files.
import '../../services/traffic-inspect/entities.js'

/** Group "entities" routes beyond the generic inspect ones (none yet). */
export const inspectEntitiesRoutes: FastifyPluginAsync = async () => {}
