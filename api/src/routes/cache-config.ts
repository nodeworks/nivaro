import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { _backgroundDb, _staticDb } from '../db/index.js'
import { attachIdentitySeam, identityCacheStats, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  CacheConfigError,
  effectiveCacheConfig,
  saveCacheConfig,
  startCacheConfigRefresh,
  stopCacheConfigRefresh
} from '../services/cache-config.js'
import { instanceKey } from '../services/instance-key.js'
import { permissionCacheStats, providePermissionCacheWiring } from '../services/permission-cache.js'
import { layoutBundleStats } from './collection-layouts.js'

/**
 * Cache switches for THIS instance (Database → Caches): every switch with its effective
 * value and where it came from (env / config / default), and a PATCH that stores values
 * under the `cache` key of the instance's nivaro_settings_overrides row. Env still wins.
 *
 * Registering this plugin also starts the 15 s re-read (services/cache-config.ts) and hands
 * over what turning caches on at run time needs: the Redis client and pools the permission
 * cache attaches its write seams to, and the identity-row seam (middleware/authenticate.ts).
 */
export async function cacheConfigRoutes(app: FastifyInstance) {
  const clients = [_staticDb, _backgroundDb]
    .map((k) => (k as unknown as { client?: object } | null)?.client)
    .filter((c): c is object => !!c)
  for (const c of clients) attachIdentitySeam(c as Parameters<typeof attachIdentitySeam>[0])
  providePermissionCacheWiring({
    redis: (app as { redis?: unknown }).redis as Parameters<
      typeof providePermissionCacheWiring
    >[0]['redis'],
    clients,
    procLookup:
      config.DB_CLIENT === 'mssql'
        ? async (name) => {
            const rows = (await _staticDb.raw('SELECT OBJECT_DEFINITION(OBJECT_ID(?)) AS body', [
              name
            ])) as Array<{ body: string | null }>
            return rows?.[0]?.body ?? null
          }
        : null
  })
  startCacheConfigRefresh()
  app.addHook('onClose', async () => stopCacheConfigRefresh())

  app.get('/', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({
      data: effectiveCacheConfig(),
      instance: instanceKey(),
      cloud: !!process.env.CLOUD_META_DB_URL,
      stats: {
        permission: permissionCacheStats(),
        identity: identityCacheStats(),
        layout_bundles: layoutBundleStats()
      }
    })
  })

  app.patch('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { settings?: unknown }
    const settings = body.settings
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      return reply.code(400).send({ error: 'settings must be an object', code: 'INVALID_BODY' })
    try {
      const data = await saveCacheConfig(settings as Record<string, unknown>)
      await logActivity({
        action: 'cache-config-update',
        user: req.user?.id,
        comment: `${instanceKey()}: ${Object.entries(settings)
          .map(([k, v]) => `${k}=${v === null ? 'cleared' : String(v)}`)
          .join(', ')}`.slice(0, 500),
        req
      })
      return reply.send({ data, instance: instanceKey() })
    } catch (err) {
      if (err instanceof CacheConfigError)
        return reply
          .code(400)
          .send({ error: err.message, code: 'INVALID_CACHE_SETTING', field: err.field })
      throw err
    }
  })
}
