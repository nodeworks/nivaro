import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { hasChainColumns } from '../services/chain-columns.js'
import { can } from '../services/permissions.js'

/**
 * "Edited 3d ago by Beth" — the newest human-relevant activity row for one
 * record, for the record-header chip. Deliberately its own tiny endpoint:
 * the /activity listing is admin-gated and has no per-item filter, and the
 * chip needs exactly one row.
 */
export async function lastTouchRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string } }>(
    '/last-touch/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const row = (await db('nivaro_activity as a')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .where({ 'a.collection': collection, 'a.item': String(id) })
        .whereIn('a.action', ['create', 'update'])
        .orderBy('a.id', 'desc')
        .first('a.action', 'a.timestamp', 'a.user', 'u.first_name', 'u.last_name', 'u.email')) as
        | {
            action: string
            timestamp: Date
            user: string | null
            first_name: string | null
            last_name: string | null
            email: string | null
          }
        | undefined
      if (!row) return reply.send({ data: null })
      return reply.send({
        data: {
          action: row.action,
          timestamp: new Date(row.timestamp).toISOString(),
          user_id: row.user ?? null,
          user_name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || null
        }
      })
    }
  )

  /**
   * Provenance (#29): where this record CAME FROM, mined from the earliest
   * activity on it. Honest about the gaps — a row with no creation activity
   * (raw importer writes, pre-audit history) says so rather than guessing.
   */
  app.get<{ Params: { collection: string; id: string } }>(
    '/provenance/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      // Provenance judges the record's ORIGIN — bookkeeping rows must not
      // outrank it. Per-collection read logging can write a 'read' row
      // milliseconds before the create lands (the reported false 'likely
      // imported' on a form-created record), and lock heartbeats are noise.
      const activityChained = await hasChainColumns('nivaro_activity')
      const first = (await db('nivaro_activity as a')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .where({ 'a.collection': collection, 'a.item': String(id) })
        .whereNotIn('a.action', ['read', 'lock-acquire', 'lock-release'])
        .orderBy('a.id', 'asc')
        .first(
          ...(activityChained ? ['a.chain_id'] : []),
          'a.id',
          'a.action',
          'a.timestamp',
          'a.comment',
          'a.legacy_id',
          'a.user',
          'u.first_name',
          'u.last_name',
          'u.email',
          'u.status'
        )) as
        | {
            id: number
            action: string
            timestamp: Date
            comment: string | null
            legacy_id: number | null
            user: string | null
            chain_id?: string | null
            first_name: string | null
            last_name: string | null
            email: string | null
            status: string | null
          }
        | undefined
      if (!first) return reply.send({ data: null })

      const name = [first.first_name, first.last_name].filter(Boolean).join(' ') || first.email
      // The inbound request that created the record, when there was one:
      // by chain id (migration 351) first, else the caller's own write to
      // this collection within seconds of the create — the only kind the
      // chain-less history can name. Session auth = a browser form, which
      // stays "Manual"; token / API-key auth = an integration or script.
      const api = first.action === 'create' ? await inboundCreateCall(collection, first) : null
      let origin = 'Manual'
      if (first.legacy_id != null) origin = 'Legacy import'
      else if (api) {
        origin = api.api_key_name
          ? `API key · ${api.api_key_name}`
          : api.path.includes('/graphql')
            ? 'API (GraphQL)'
            : 'API (REST)'
      } else if (first.action !== 'create') origin = 'No creation record — likely imported'
      else if (!first.user) origin = 'Public form'
      else if (
        first.status === 'suspended' &&
        /@(nivaro|invalid)\.local$/i.test(String(first.email ?? ''))
      ) {
        origin = 'Integration'
      } else if (/import/i.test(String(first.comment ?? ''))) origin = 'Import'
      else {
        // An extension breadcrumb (namespaced "<ext>:<action>") stamped on
        // this record around creation names the pipeline that made it.
        const ext = (await db('nivaro_activity')
          .where({ collection, item: String(id) })
          .where('action', 'like', '%:%')
          .whereRaw('ABS(DATEDIFF(second, timestamp, ?)) < 120', [new Date(first.timestamp)])
          .orderBy('id', 'asc')
          .first('action')
          .catch(() => null)) as { action: string } | null | undefined
        if (ext) origin = `Integration (${String(ext.action).split(':')[0]})`
      }
      return reply.send({
        data: {
          origin,
          created: first.action === 'create' || first.legacy_id != null,
          timestamp: new Date(first.timestamp).toISOString(),
          user_name: name ?? null,
          // The request body is what the caller SENT — it may name fields
          // the viewer cannot read, so only admins get it (the event-path
          // service withholds bodies from non-admins the same way).
          api: api
            ? {
                log_id: api.log_id,
                method: api.method,
                path: api.path,
                auth: api.auth,
                api_key_name: api.api_key_name,
                at: api.at,
                chain_id: api.chain_id,
                body: req.isAdmin ? api.body : null,
                body_withheld: !req.isAdmin && api.body != null
              }
            : null
        }
      })
    }
  )
}

interface InboundCreateCall {
  log_id: number
  method: string
  path: string
  auth: string
  api_key_name: string | null
  at: string
  chain_id: string | null
  body: unknown
}

/** The token / API-key request whose write created the record, or null when
 *  the create came from a browser session, a form, an import, an extension
 *  or predates request logging. Chain id when the activity row carries one
 *  (the api-log row that STARTED the chain has no chain_parent); else the
 *  same caller's write to this collection within ±5s of the activity row. */
async function inboundCreateCall(
  collection: string,
  first: { id: number; timestamp: Date; user: string | null; chain_id?: string | null }
): Promise<InboundCreateCall | null> {
  try {
    const cols = [
      'l.id',
      'l.method',
      'l.path',
      'l.auth',
      'l.created_at',
      'l.request_body',
      'l.api_key_id',
      'k.name as api_key_name'
    ]
    const stamped = await hasChainColumns('nivaro_api_logs')
    const base = () =>
      db('nivaro_api_logs as l')
        .leftJoin('nivaro_api_keys as k', 'k.id', 'l.api_key_id')
        .whereIn('l.auth', ['token', 'api_key'])
        .whereIn('l.method', ['POST', 'PUT'])
    let row: Record<string, unknown> | undefined
    if (stamped && first.chain_id) {
      row = (await base()
        .where('l.chain_id', first.chain_id)
        .whereNull('l.chain_parent')
        .orderBy('l.id', 'asc')
        .first(...cols, 'l.chain_id')) as Record<string, unknown> | undefined
    }
    if (!row && first.user) {
      const at = new Date(first.timestamp)
      row = (await base()
        .where('l.user', first.user)
        .whereBetween('l.created_at', [
          new Date(at.getTime() - 5000),
          new Date(at.getTime() + 5000)
        ])
        .where((w) =>
          w
            .where('l.path', 'like', `/api/items/${collection}%`)
            .orWhere('l.path', 'like', '%/graphql%')
        )
        .orderBy('l.id', 'desc')
        .first(...cols, ...(stamped ? ['l.chain_id'] : []))) as Record<string, unknown> | undefined
    }
    if (!row) return null
    let body: unknown = null
    const raw = row.request_body as string | null
    if (raw) {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    return {
      log_id: Number(row.id),
      method: String(row.method),
      path: String(row.path),
      auth: String(row.auth),
      api_key_name: (row.api_key_name as string | null) ?? null,
      at: new Date(row.created_at as string).toISOString(),
      chain_id: (row.chain_id as string | null | undefined) ?? null,
      body
    }
  } catch {
    return null
  }
}
