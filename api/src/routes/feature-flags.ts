import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { parseJson, toJsonStr } from '../services/pipeline-engine.js'

/**
 * Feature flags (#651): ship dark, enable per role or percentage.
 * `GET /feature-flags/mine` resolves the caller's effective set — role gate
 * first, then a stable percentage bucket (sha256(userId+key) % 100) so a
 * gradual rollout never flip-flops for one person. Admin CRUD is audited;
 * a 60s in-process cache keeps the resolve path off the DB per request.
 */

interface FlagRow {
  id: number
  key: string
  label: string | null
  description: string | null
  enabled: boolean
  role_ids: string | null
  percentage: number | null
}

let cache: { at: number; rows: FlagRow[] } | null = null
const bust = () => {
  cache = null
}
async function allFlags(): Promise<FlagRow[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows
  const rows = (await db('nivaro_feature_flags').select('*')) as FlagRow[]
  cache = { at: Date.now(), rows }
  return rows
}

function bucketOf(userId: string, key: string): number {
  const h = createHash('sha256').update(`${userId}:${key}`).digest()
  return h.readUInt16BE(0) % 100
}

export async function featureFlagRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate)

  app.get('/feature-flags/mine', { preHandler: requireAuth }, async (req) => {
    const rows = await allFlags()
    const userId = String(req.user?.id ?? '')
    const role = String(req.user?.role ?? '')
    const enabled: string[] = []
    for (const f of rows) {
      if (!f.enabled) continue
      const roles = (parseJson(f.role_ids) as string[] | null) ?? []
      if (roles.length > 0 && !roles.map((r) => r.toUpperCase()).includes(role.toUpperCase()))
        continue
      if (f.percentage != null && f.percentage < 100 && bucketOf(userId, f.key) >= f.percentage)
        continue
      enabled.push(f.key)
    }
    return { data: enabled }
  })

  app.get('/feature-flags', { preHandler: requireAdmin }, async () => {
    const rows = (await db('nivaro_feature_flags').orderBy('key')) as FlagRow[]
    return { data: rows.map((r) => ({ ...r, role_ids: (parseJson(r.role_ids) as string[] | null) ?? [] })) }
  })

  app.post<{ Body: Partial<FlagRow> & { role_ids?: string[] } }>(
    '/feature-flags',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const key = String(req.body?.key ?? '').trim()
      if (!/^[a-z0-9_.-]{2,100}$/i.test(key)) {
        return reply.code(400).send({ error: 'key must be 2-100 chars of a-z 0-9 _ . -' })
      }
      await db('nivaro_feature_flags').insert({
        key,
        label: req.body?.label ?? null,
        description: req.body?.description ?? null,
        enabled: req.body?.enabled === true,
        role_ids: toJsonStr(req.body?.role_ids ?? []),
        percentage: req.body?.percentage ?? null,
        created_at: new Date(),
        updated_at: new Date()
      })
      bust()
      await logActivity({ action: 'feature-flag-create', user: req.user?.id, comment: key, req })
      return reply.code(201).send({ data: { key } })
    }
  )

  app.patch<{ Params: { id: string }; Body: Partial<FlagRow> & { role_ids?: string[] } }>(
    '/feature-flags/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (req.body?.label !== undefined) patch.label = req.body.label
      if (req.body?.description !== undefined) patch.description = req.body.description
      if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled === true
      if (req.body?.role_ids !== undefined) patch.role_ids = toJsonStr(req.body.role_ids ?? [])
      if (req.body?.percentage !== undefined) {
        patch.percentage =
          req.body.percentage == null
            ? null
            : Math.min(100, Math.max(0, Number(req.body.percentage)))
      }
      const n = await db('nivaro_feature_flags').where('id', Number(req.params.id)).update(patch)
      if (!n) return reply.code(404).send({ error: 'Flag not found' })
      bust()
      await logActivity({
        action: 'feature-flag-update',
        user: req.user?.id,
        comment: `#${req.params.id}`,
        req
      })
      return { data: { ok: true } }
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/feature-flags/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = (await db('nivaro_feature_flags').where('id', Number(req.params.id)).first('key')) as
        | { key: string }
        | undefined
      const n = await db('nivaro_feature_flags').where('id', Number(req.params.id)).del()
      if (!n) return reply.code(404).send({ error: 'Flag not found' })
      bust()
      await logActivity({
        action: 'feature-flag-delete',
        user: req.user?.id,
        comment: row?.key ?? String(req.params.id),
        req
      })
      return reply.code(204).send()
    }
  )
}
