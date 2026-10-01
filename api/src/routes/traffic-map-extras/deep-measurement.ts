// api/src/routes/traffic-map-extras/deep-measurement.ts
import type { FastifyInstance } from 'fastify'
import '../../services/traffic-taps/field-change-heat.js'
import '../../services/traffic-taps/graphql-field-heat.js'
import '../../services/traffic-taps/hot-records.js'
import '../../services/traffic-taps/read-shapes.js'
import {
  N_PLUS_ONE_AVG_TRIPS,
  N_PLUS_ONE_MIN_REQUESTS
} from '../../services/traffic-taps/request-cost.js'

/**
 * Group B2 — deep measurement (#1108 #1119 #1134 #1135 #1136 #1145 #1146 #1151). Importing this
 * module registers the five taps (request cost, read shapes, GraphQL field heat, field change
 * heat, hot records); their figures ride frames, snapshots and GET /entity-detail. The one route
 * here tells the page the thresholds it badges by.
 */
export async function deepMeasurementRoutes(app: FastifyInstance): Promise<void> {
  app.get('/deep-measurement/config', async () => ({
    data: {
      n_plus_one_avg_trips: N_PLUS_ONE_AVG_TRIPS,
      n_plus_one_min_requests: N_PLUS_ONE_MIN_REQUESTS
    }
  }))
}
