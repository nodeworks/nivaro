import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { type FeedRow, snapshotFeed } from '../services/command-center/activity.js'
import { ccIsAdmin, ccReadAuth } from '../services/command-center/auth.js'
import { snapshotFlowBlock } from '../services/command-center/flow.js'
import {
  countsOnlyPeople,
  EMPTY_PEOPLE,
  snapshotPeople
} from '../services/command-center/people.js'
import { snapshotRiskBlock } from '../services/command-center/risk.js'
import { readCcScope } from '../services/command-center/scope.js'
import { readSystemHealth } from '../services/command-center/system.js'
import { snapshotThroughput } from '../services/command-center/throughput.js'
import { can } from '../services/permissions.js'
import { geoRoute, peopleGeoRoute } from './command-center-place.js'

/**
 * Command Center (/command): one aggregator over data the platform already
 * computes — nothing here derives new state, it composes existing services
 * into a live ops board. Every sub-block is independently try/caught so one
 * broken source degrades to an empty pane, never a dead board.
 *
 * Reads honor the caller: record-level payloads (map pins) go through the
 * items service (RBAC/RLS/scopes); aggregate counts are gated on collection
 * read permission; the system-health block is admin-only.
 */

export async function commandCenterRoutes(app: FastifyInstance) {
  // Every route here is a read; writes add ccWriteAuth on the route itself.
  app.addHook('preHandler', ccReadAuth)

  // ── Snapshot: everything except map geometry, one round trip ─────────────
  app.get('/snapshot', async (req, reply) => {
    const isAdmin = ccIsAdmin(req)
    const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn()
      } catch {
        return fallback
      }
    }

    const [flow, risk, people, throughput, health, activity] = await Promise.all([
      // Flow + risk blocks: services/command-center/flow.ts + risk.ts (scoped, region, rewind).
      safe(() => snapshotFlowBlock(req), [] as Awaited<ReturnType<typeof snapshotFlowBlock>>),
      safe(() => snapshotRiskBlock(req), {
        at_risk: 0,
        tracked: 0,
        open_issues: isAdmin ? 0 : null
      } as Awaited<ReturnType<typeof snapshotRiskBlock>>),

      // People on now (slice 1: services/command-center/people.ts).
      // A wallboard gets counts only (no names, pages or records).
      safe(async () => {
        const block = await snapshotPeople(app, req, readCcScope(req.query))
        return req.ccKiosk ? countsOnlyPeople(block) : block
      }, EMPTY_PEOPLE),

      // Throughput: transitions today vs same time yesterday, the person's day (slice 3 service).
      safe(() => snapshotThroughput(req), {
        transitions_today: 0,
        transitions_yesterday_same_time: 0
      }),

      // System rail — ADMIN ONLY (names internal jobs and error details).
      isAdmin ? safe(() => readSystemHealth(app.redis), null) : Promise.resolve(null),

      // Feed seed: the newest readable entries with sentences (slice 3 service). Comment text and
      // who-did-what stay off a wallboard.
      req.ccKiosk
        ? Promise.resolve([] as FeedRow[])
        : safe(() => snapshotFeed(req), [] as FeedRow[])
    ])

    return reply.send({ data: { flow, risk, people, throughput, health, activity } })
  })

  // ── Map geometry (slice 1: routes/command-center-place.ts → services/command-center/geo.ts)
  app.get('/geo', geoRoute)
  app.get('/people-geo', peopleGeoRoute)
}
