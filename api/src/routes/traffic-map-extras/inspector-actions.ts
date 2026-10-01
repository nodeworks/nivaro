// api/src/routes/traffic-map-extras/inspector-actions.ts
/**
 * Group A inspector routes (under /api/traffic-map, admin only, 404 in cloud):
 *  - GET /partner-owes?id=ext:<apiId>  (#1094) obligations a partner is owed + its failed pushes
 *  - GET /probe?key=<lane>/<entity>     (#1155) one safe read at the entity, as the admin
 *  - GET /runbooks                      (#1158) runbook links the map can attach to nodes
 * Importing the tap modules here registers them at boot (#1107 #1115 #1121 #1150).
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { extensionRunbooks } from '../../extensions/loader.js'
import { classifyRequest, entityKey, type TrafficLane } from '../../services/traffic-entities.js'
import '../../services/traffic-taps/error-groups.js'
import '../../services/traffic-taps/inspector-detail.js'

const OPEN_OUTCOMES = ['failed', 'missing', 'overdue'] as const
const NAME_RE = /^[a-z0-9_]{1,128}$/
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/

/** The GET a probe sends at an entity; null when no safe read is known for it. */
export function probePath(lane: string, entity: string): string | null {
  let path: string | null = null
  if ((lane === 'items' || lane === 'system') && NAME_RE.test(entity)) path = `/api/items/${entity}`
  else if (lane === 'pages' && SLUG_RE.test(entity)) path = `/api/pages/${entity}`
  if (!path) return null
  // Only a read that lands on the very entity it names.
  const c = classifyRequest({ method: 'GET', path })
  if (c?.kind !== 'read' || entityKey(c.lane, c.entity) !== `${lane}/${entity}`) return null
  return lane === 'pages' ? path : `${path}?limit=1`
}

export interface RunbookEntry {
  /** Lower-cased keys a node matches: an entity key, a down id, a caller key or a name. */
  match: string[]
  label: string
  url: string
  source: 'environment' | 'extension'
  detail: string
}

const RUNBOOK_LINE = /^\s*runbook(?:\s+([^:]+?))?\s*:\s*(\S+)\s*$/i

/**
 * `runbook: <url>` lines in an Environments component's notes link that component (matched by
 * name); `runbook <node>: <url>` links any node by id (`items/workflows`, `ext:12`, `k7`) or label.
 */
export function runbooksFromNotes(c: {
  name: string
  environment: string | null
  notes: string | null
}): RunbookEntry[] {
  const out: RunbookEntry[] = []
  for (const line of String(c.notes ?? '').split(/\r?\n/)) {
    const m = line.match(RUNBOOK_LINE)
    if (!m) continue
    const url = m[2]
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) continue
    const key = (m[1] ?? c.name).trim().toLowerCase()
    if (!key) continue
    out.push({
      match: [key],
      label: m[1] ? `Runbook for ${m[1].trim()}` : `${c.name} runbook`,
      url,
      source: 'environment',
      detail: [c.environment, c.name].filter(Boolean).join(' · ')
    })
  }
  return out
}

export async function inspectorActionRoutes(app: FastifyInstance): Promise<void> {
  // ── #1094 what a partner is owed ─────────────────────────────────────────
  app.get<{ Querystring: { id?: string } }>('/partner-owes', async (req, reply) => {
    const m = String(req.query.id ?? '').match(/^ext:(\d{1,9})$/)
    if (!m)
      return reply.code(400).send({ error: 'id must be ext:<api id>', code: 'PARTNER_ID_INVALID' })
    const apiId = Number(m[1])
    const api = (await db('nivaro_external_apis').where({ id: apiId }).first('id', 'name')) as
      | { id: number; name: string }
      | undefined
    if (!api) return reply.code(404).send({ error: 'No such external API' })
    const { remediationEnabled } = await import('../../services/integration-remediation.js')
    const [obligations, counts, submissions, sendNow] = await Promise.all([
      Promise.resolve(
        db('nivaro_integration_obligations')
          .where({ api: api.name })
          .whereIn('outcome', [...OPEN_OUTCOMES])
          .orderBy('due_at', 'desc')
          .limit(15)
          .select(
            'id',
            'kind',
            'collection',
            'item',
            'outcome',
            'reason',
            'due_at',
            'submission_id'
          )
      ).catch(() => []),
      Promise.resolve(
        db('nivaro_integration_obligations')
          .where({ api: api.name })
          .whereIn('outcome', [...OPEN_OUTCOMES])
          .groupBy('outcome')
          .select('outcome')
          .count({ n: '*' })
      ).catch(() => []),
      Promise.resolve(
        db('nivaro_erp_submissions')
          .where({ external_api: apiId, status: 'failed' })
          .orderBy('updated_at', 'desc')
          .limit(10)
          .select('id', 'collection', 'item', 'attempts', 'last_error', 'updated_at')
      ).catch(() => []),
      remediationEnabled().catch(() => false)
    ])
    const totals: Record<string, number> = { failed: 0, missing: 0, overdue: 0 }
    for (const c of counts as Array<{ outcome: string; n: number | string }>)
      totals[c.outcome] = Number(c.n) || 0
    return {
      data: {
        api: { id: Number(api.id), name: api.name },
        totals,
        send_now: sendNow,
        obligations: (obligations as Array<Record<string, unknown>>).map((o) => ({
          id: Number(o.id),
          kind: o.kind,
          collection: o.collection,
          item: o.item == null ? null : String(o.item),
          outcome: o.outcome,
          reason: o.reason ?? null,
          due_at: o.due_at,
          submission_id: o.submission_id == null ? null : Number(o.submission_id)
        })),
        submissions: (submissions as Array<Record<string, unknown>>).map((s) => ({
          id: Number(s.id),
          collection: s.collection,
          item: String(s.item),
          attempts: Number(s.attempts) || 0,
          last_error: s.last_error ? String(s.last_error).slice(0, 300) : null,
          updated_at: s.updated_at
        }))
      }
    }
  })

  // ── #1155 fire a probe ───────────────────────────────────────────────────
  app.get<{ Querystring: { key?: string } }>('/probe', async (req, reply) => {
    const key = String(req.query.key ?? '')
    const cut = key.indexOf('/')
    const path = cut > 0 ? probePath(key.slice(0, cut) as TrafficLane, key.slice(cut + 1)) : null
    if (!path) {
      return reply
        .code(400)
        .send({ error: 'No safe read is known for this entity', code: 'PROBE_UNSUPPORTED' })
    }
    // As the admin who clicked: their own credential, never a stored one. A real request, so
    // it is logged and counted on the map like any other.
    const headers: Record<string, string> = { 'x-nivaro-probe': '1' }
    if (req.headers.authorization) headers.authorization = String(req.headers.authorization)
    if (req.headers.cookie) headers.cookie = String(req.headers.cookie)
    const began = Date.now()
    const res = await app.inject({ method: 'GET', url: path, headers })
    return {
      data: { path, status: res.statusCode, ms: Date.now() - began, at: new Date().toISOString() }
    }
  })

  // ── #1158 runbook links ──────────────────────────────────────────────────
  app.get('/runbooks', async () => {
    const entries: RunbookEntry[] = []
    const comps = (await Promise.resolve(
      db('nivaro_environment_components as c')
        .leftJoin('nivaro_environments as e', 'e.id', 'c.environment')
        .whereNotNull('c.notes')
        .select('c.name', 'c.notes', 'e.name as environment')
    ).catch(() => [])) as Array<{ name: string; notes: string | null; environment: string | null }>
    for (const c of comps) entries.push(...runbooksFromNotes(c))
    for (const [ext, list] of extensionRunbooks) {
      for (const d of list) {
        entries.push({
          match: [`extension/${ext}`.toLowerCase(), ext.toLowerCase()],
          label: d.label,
          url: '/environments#runbooks',
          source: 'extension',
          detail: d.description ?? `${ext} runbook`
        })
      }
    }
    return { data: { entries } }
  })
}
