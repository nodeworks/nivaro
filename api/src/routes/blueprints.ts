import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  buildManifest,
  diffBlueprintAgainstInstance,
  exportBlueprint,
  installBlueprint,
  isPublishedBlueprint,
  type PublishedBlueprint,
  unwrapBlueprint
} from '../services/blueprints.js'
import { NIVARO_VERSION } from '../version.js'

/** App blueprints — export/install schema+workflow+layout+queue bundles. */
export async function blueprintsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  function validCollections(collections: unknown): collections is string[] {
    return (
      Array.isArray(collections) &&
      collections.length > 0 &&
      collections.every(
        (c) => typeof c === 'string' && /^[a-zA-Z0-9_]+$/.test(c) && !c.startsWith('nivaro_')
      )
    )
  }

  app.post('/export', async (req, reply) => {
    const b = req.body as { name?: string; collections?: string[] }
    if (!b.name?.trim() || !validCollections(b.collections)) {
      return reply.code(400).send({ error: 'name and valid collections are required' })
    }
    const blueprint = await exportBlueprint(b.name.trim(), b.collections)
    await logActivity({
      action: 'blueprint-export',
      user: req.user?.id,
      comment: `${b.name}: ${b.collections.join(', ')}`.slice(0, 400),
      req
    })
    return reply.send({ data: blueprint })
  })

  // Publish (#661) — the export wrapped with a manifest (name/description/
  // semver/exported_at/nivaro_version/counts) so a receiving instance can
  // show what it is before installing.
  app.post('/publish', async (req, reply) => {
    const b = req.body as {
      name?: string
      description?: string
      version?: string
      collections?: string[]
    }
    if (!b.name?.trim() || !validCollections(b.collections)) {
      return reply.code(400).send({ error: 'name and valid collections are required' })
    }
    if (b.version && !/^[0-9A-Za-z._-]{1,40}$/.test(b.version.trim())) {
      return reply.code(400).send({ error: 'Invalid version string' })
    }
    const blueprint = await exportBlueprint(b.name.trim(), b.collections)
    const pkg: PublishedBlueprint = {
      type: 'nivaro-blueprint-package',
      version: 1,
      manifest: buildManifest(blueprint, {
        description: b.description ?? null,
        version: b.version ?? null,
        nivaroVersion: NIVARO_VERSION
      }),
      blueprint
    }
    await logActivity({
      action: 'blueprint-publish',
      user: req.user?.id,
      comment: `${b.name}${b.version ? ` v${b.version}` : ''}: ${b.collections.join(', ')}`.slice(
        0,
        400
      ),
      req
    })
    return reply.send({ data: pkg })
  })

  // Inspect an uploaded bundle BEFORE install: its manifest (synthesized for
  // bare blueprints) + a diff against this instance — what already exists,
  // what would be added, field-level adds per collection.
  app.post('/manifest-of', async (req, reply) => {
    const { bundle } = req.body as { bundle?: unknown }
    const bp = unwrapBlueprint(bundle)
    if (!bp) return reply.code(400).send({ error: 'Not a nivaro blueprint or blueprint package' })
    const manifest = isPublishedBlueprint(bundle)
      ? bundle.manifest
      : buildManifest(bp, { nivaroVersion: 'unknown' })
    const diff = await diffBlueprintAgainstInstance(bp)
    return reply.send({ data: { manifest, diff, wrapped: isPublishedBlueprint(bundle) } })
  })

  app.post('/install', async (req, reply) => {
    const { blueprint } = req.body as { blueprint?: unknown }
    // Backward compatible: accepts a bare blueprint OR a published package.
    const bp = unwrapBlueprint(blueprint)
    if (!bp) {
      return reply.code(400).send({ error: 'Not a nivaro-blueprint artifact' })
    }
    // Review M2: roles with administrator access arrive without it, unless the installing
    // administrator, on their own session, names them in keep_admin_roles (logged).
    const keepAdmin = Array.isArray((req.body as { keep_admin_roles?: unknown }).keep_admin_roles)
      ? ((req.body as { keep_admin_roles: unknown[] }).keep_admin_roles.filter(
          (x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)
        ) as string[])
      : []
    if (keepAdmin.length) {
      const { ownSession } = await import('../services/hub/changes/emergency.js')
      if (!ownSession(req))
        return reply.code(403).send({
          error:
            'Only an administrator on their own session may keep a role’s administrator access.',
          code: 'OWN_SESSION_REQUIRED'
        })
    }
    const report = await installBlueprint(bp, req.user?.id ?? null, {
      keepAdminRoles: keepAdmin
    })
    if (keepAdmin.length)
      await logActivity({
        action: 'blueprint-keep-admin',
        user: req.user?.id,
        comment: `${bp.name}: roles keep administrator access: ${keepAdmin.join(', ')}`.slice(
          0,
          400
        ),
        req
      })
    await logActivity({
      action: 'blueprint-install',
      user: req.user?.id,
      comment:
        `${bp.name}: +${report.collections.created} collections, +${report.workflows.created} workflows, +${report.queues.created} queues`.slice(
          0,
          400
        ),
      req
    })
    return reply.send({ data: report })
  })
}
