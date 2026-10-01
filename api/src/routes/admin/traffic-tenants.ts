import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { getMetaDb } from '../../middleware/tenant.js'
import { INSTANCE_ID } from '../../services/instance-roster.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import { tenantLoadRanking } from '../../services/traffic-taps/tenant-load.js'

/**
 * #1185 — noisy tenant ranking, for the cloud OPERATOR only. Cloud mode keeps one Traffic Map
 * store per tenant; this ranks the tenants THIS API process served over the window by database
 * time, then requests, then errors, so a slow shared process names its noisy neighbour.
 *
 * There is no operator user in core: the control plane is trusted through the same
 * `x-provision-secret` header (PROVISION_SECRET) the provisioning routes already use, and the
 * path is tenant-free (no tenant resolution). Registered only when CLOUD_META_DB_URL is set.
 * Per process: a multi-replica deployment asks each replica (the answer names its instance).
 */
const WINDOWS = new Set([60, 300, 900])

function secretMatches(given: unknown): boolean {
  const want = process.env.PROVISION_SECRET
  if (!want || typeof given !== 'string' || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function adminTrafficTenantRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { window?: string; limit?: string } }>(
    '/admin/traffic-tenants',
    async (req, reply) => {
      if (!secretMatches(req.headers['x-provision-secret']))
        return reply.code(401).send({ error: 'Unauthorized' })
      const windowS = Number(req.query.window ?? 300)
      if (!WINDOWS.has(windowS))
        return reply
          .code(400)
          .send({ error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' })
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50))
      const rows = tenantLoadRanking(windowS, currentTrafficSec()).slice(0, limit)
      // Names from the control-plane database; a lookup failure still answers with ids.
      const ids = rows.map((r) => r.tenant_id).filter((v): v is string => !!v)
      const names = new Map<string, { slug: string | null; name: string | null }>()
      if (ids.length && process.env.CLOUD_META_DB_URL) {
        try {
          const found = (await getMetaDb()('cloud_tenants')
            .whereIn('id', ids)
            .select('id', 'slug', 'name')) as Array<{ id: string; slug: string; name: string }>
          for (const t of found)
            names.set(String(t.id).toLowerCase(), { slug: t.slug ?? null, name: t.name ?? null })
        } catch {
          /* ids only */
        }
      }
      return {
        data: {
          instance: INSTANCE_ID,
          window_s: windowS,
          tenants: rows.map((r) => ({
            ...r,
            slug: r.tenant_id ? (names.get(r.tenant_id.toLowerCase())?.slug ?? null) : null,
            name: r.tenant_id ? (names.get(r.tenant_id.toLowerCase())?.name ?? null) : null
          }))
        }
      }
    }
  )
}
