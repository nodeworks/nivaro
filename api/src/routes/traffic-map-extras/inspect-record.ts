// api/src/routes/traffic-map-extras/inspect-record.ts
import type { FastifyPluginAsync } from 'fastify'
// Loads the group's inspect sources (they register at module load). Task 4 fills both files.
import '../../services/traffic-inspect/record.js'

/** Group "record" routes beyond the generic inspect ones (none yet). */
export const inspectRecordRoutes: FastifyPluginAsync = async () => {}
