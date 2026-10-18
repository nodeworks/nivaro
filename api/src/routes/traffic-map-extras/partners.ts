// api/src/routes/traffic-map-extras/partners.ts
/**
 * Traffic Map partner and API-shape lenses (under /api/traffic-map, admin only):
 *   #2150 GET /partner-contract?id=ext:<apiId>  response time + availability against the figures
 *         agreed on the external API, hourly breaches and month-to-date attainment;
 *   #2200 GET /partner-shapes?id=ext:<apiId>    fields a partner started or stopped sending,
 *         learned from the bodies the outbound recorder still holds (paths + types only);
 *   #2205 GET /graphql-cost?window=             GraphQL operations ranked by cost (the per-operation
 *         detail rides GET /entity-detail, tap `graphql-cost`);
 *   #2201 inbound mapping outcomes and #2206 REST field heat ride GET /entity-detail
 *         (taps `inbound-outcomes`, `rest-fields`).
 * Importing the tap modules here registers them at boot.
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { pathTemplate } from '../../services/traffic-entities.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import {
  attainment,
  type CallRow,
  monthStartUtc,
  readAgreed
} from '../../services/traffic-partner-contract.js'
import { type DriftReport, driftReport, shapeOfBody } from '../../services/traffic-payload-drift.js'
import { costRanking } from '../../services/traffic-taps/graphql-cost.js'
import '../../services/traffic-taps/inbound-outcomes.js'
import '../../services/traffic-taps/rest-field-heat.js'

const WINDOWS = new Set([60, 300, 900])
/** Month-to-date calls read for attainment (newest first); past it the figures say so. */
const CONTRACT_ROW_CAP = 60_000
/** Bodies read per partner for the shape comparison, and the window they are kept for. */
const BODY_ROW_CAP = 600
const BODY_HOURS = 24
const GROUPS_SHOWN = 6
const API_ID = /^ext:(\d{1,9})$/

interface OutboundRow {
  created_at: Date | string
  status: number | null
  duration_ms: number | null
}
interface BodyRow {
  created_at: Date | string
  method: string
  path: string
  request_body: string | null
  response_body: string | null
}

export interface ShapeGroup {
  endpoint: string
  side: 'request' | 'response'
  report: DriftReport
}

/** Drift per endpoint and side, the ones that moved first. Rows arrive newest first. */
export function shapeGroups(rows: readonly BodyRow[]): ShapeGroup[] {
  const buckets = new Map<string, ReturnType<typeof shapeOfBody>[]>()
  for (const r of [...rows].reverse()) {
    const endpoint = `${String(r.method).toUpperCase()} ${pathTemplate(String(r.path ?? ''))}`
    for (const side of ['request', 'response'] as const) {
      const shape = shapeOfBody(side === 'request' ? r.request_body : r.response_body)
      if (!shape) continue
      const k = `${side}|${endpoint}`
      const list = buckets.get(k)
      if (list) list.push(shape)
      else buckets.set(k, [shape])
    }
  }
  const out: ShapeGroup[] = []
  for (const [k, shapes] of buckets) {
    const cut = k.indexOf('|')
    out.push({
      side: k.slice(0, cut) as 'request' | 'response',
      endpoint: k.slice(cut + 1),
      report: driftReport(shapes.filter((s): s is NonNullable<typeof s> => !!s))
    })
  }
  const rank = (g: ShapeGroup) =>
    g.report.status === 'drifting' ? 0 : g.report.status === 'steady' ? 1 : 2
  return out.sort((a, b) => rank(a) - rank(b) || b.report.bodies - a.report.bodies)
}

export async function partnersRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { id?: string } }>('/partner-contract', async (req, reply) => {
    const m = String(req.query.id ?? '').match(API_ID)
    if (!m)
      return reply.code(400).send({ error: 'id must be ext:<api id>', code: 'PARTNER_ID_INVALID' })
    const apiId = Number(m[1])
    const api = (await db('nivaro_external_apis')
      .where({ id: apiId })
      .first('id', 'name', 'outbound_contract')) as
      | { id: number; name: string; outbound_contract: string | null }
      | undefined
    if (!api) return reply.code(404).send({ error: 'No such external API' })
    const targets = readAgreed(api.outbound_contract)
    if (!targets) return { data: { api: { id: api.id, name: api.name }, targets: null } }
    const now = Date.now()
    const rows = (await db('nivaro_outbound_log')
      .where({ api_id: apiId })
      .where('created_at', '>=', new Date(monthStartUtc(now)))
      .orderBy('created_at', 'desc')
      .limit(CONTRACT_ROW_CAP)
      .select('created_at', 'status', 'duration_ms')) as OutboundRow[]
    const calls: CallRow[] = rows.map((r) => ({
      at: new Date(r.created_at).getTime(),
      status: r.status ?? null,
      ms: r.duration_ms ?? null
    }))
    return {
      data: {
        api: { id: api.id, name: api.name },
        ...attainment(calls, targets, now, rows.length >= CONTRACT_ROW_CAP)
      }
    }
  })

  app.get<{ Querystring: { id?: string } }>('/partner-shapes', async (req, reply) => {
    const m = String(req.query.id ?? '').match(API_ID)
    if (!m)
      return reply.code(400).send({ error: 'id must be ext:<api id>', code: 'PARTNER_ID_INVALID' })
    const apiId = Number(m[1])
    const api = (await db('nivaro_external_apis').where({ id: apiId }).first('id', 'name')) as
      | { id: number; name: string }
      | undefined
    if (!api) return reply.code(404).send({ error: 'No such external API' })
    if (!(await hasColumn('nivaro_outbound_log', 'response_body').catch(() => false)))
      return { data: { api, available: false, groups: [], bodies_hours: BODY_HOURS } }
    const rows = (await db('nivaro_outbound_log')
      .where({ api_id: apiId })
      .where('created_at', '>=', new Date(Date.now() - BODY_HOURS * 3_600_000))
      .where((q) => {
        void q.whereNotNull('request_body').orWhereNotNull('response_body')
      })
      .orderBy('created_at', 'desc')
      .limit(BODY_ROW_CAP)
      .select('created_at', 'method', 'path', 'request_body', 'response_body')) as BodyRow[]
    const groups = shapeGroups(rows)
    return {
      data: {
        api,
        available: true,
        bodies_hours: BODY_HOURS,
        rows: rows.length,
        groups: groups.slice(0, GROUPS_SHOWN)
      }
    }
  })

  // The ranking reads only this process's tap state for the caller's store.
  app.get<{ Querystring: { window?: string } }>(
    '/graphql-cost',
    { config: { trafficTenantAware: true } },
    async (req, reply) => {
      const w = Number(req.query.window ?? 300)
      if (!WINDOWS.has(w))
        return reply
          .code(400)
          .send({ error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' })
      return { data: { window_s: w, operations: costRanking(w, currentTrafficSec()).slice(0, 25) } }
    }
  )
}
