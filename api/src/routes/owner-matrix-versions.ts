import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  diffOwnerMatrix,
  loadOwnerMatrixVersion,
  OWNER_MATRIX_VERSIONS_TABLE,
  type OwnerMatrixDiff,
  ownerMatrixVersionsReady,
  readOwnerMatrix,
  restoreOwnerMatrixVersion,
  snapshotOwnerMatrixVersion
} from '../services/owner-matrix-versions.js'

// ─── Owner matrix versions (#833) ────────────────────────────────────────────
//
// ONE capture point: an onRoute hook on the pipelines router appends a
// preHandler to every owner-mutating route — after the route's own
// requireAdmin, so an unauthenticated request never pays for a snapshot — that
// resolves the route's template and snapshots its owner matrix first. A new
// owner route only needs an entry in OWNER_ROUTES.

type Resolve = (params: Record<string, string>) => Promise<string | null>

const viaGroup: Resolve = async (p) =>
  (
    (await db('nivaro_pipeline_owner_groups').where({ id: p.groupId }).first('template')) as
      | { template: string }
      | undefined
  )?.template ?? null

const viaBinding = async (bindingId: unknown): Promise<string | null> =>
  (
    (await db('nivaro_workflow_bindings')
      .where({ id: Number(bindingId) })
      .first('template')) as { template: string } | undefined
  )?.template ?? null

/** Route (method + path suffix under the pipelines prefix) → template + note. */
const OWNER_ROUTES: Array<{ method: string; path: string; note: string; resolve: Resolve }> = [
  {
    method: 'POST',
    path: '/:id/owner-groups/bulk-add',
    note: 'before bulk member add',
    resolve: async (p) => p.id
  },
  {
    method: 'POST',
    path: '/states/:stateId/owner-groups',
    note: 'before owner group create',
    resolve: async (p) =>
      (
        (await db('nivaro_workflow_states').where({ id: p.stateId }).first('template')) as
          | { template: string }
          | undefined
      )?.template ?? null
  },
  {
    method: 'PATCH',
    path: '/owner-groups/:groupId',
    note: 'before owner group update',
    resolve: viaGroup
  },
  {
    method: 'DELETE',
    path: '/owner-groups/:groupId',
    note: 'before owner group delete',
    resolve: viaGroup
  },
  {
    method: 'POST',
    path: '/owner-groups/:groupId/teams',
    note: 'before team assign',
    resolve: viaGroup
  },
  {
    method: 'DELETE',
    path: '/owner-groups/:groupId/teams/:teamId',
    note: 'before team unassign',
    resolve: viaGroup
  },
  {
    method: 'POST',
    path: '/owner-groups/:groupId/merge-into',
    note: 'before owner group merge',
    resolve: viaGroup
  },
  {
    method: 'POST',
    path: '/owner-groups/:groupId/users',
    note: 'before member add',
    resolve: viaGroup
  },
  {
    method: 'DELETE',
    path: '/owner-group-users/:id',
    note: 'before member remove',
    resolve: async (p) =>
      (
        (await db('nivaro_pipeline_owner_group_users as m')
          .join('nivaro_pipeline_owner_groups as g', 'g.id', 'm.group')
          .where('m.id', Number(p.id))
          .first('g.template')) as { template: string } | undefined
      )?.template ?? null
  },
  {
    method: 'POST',
    path: '/bindings/:bindingId/dimensions',
    note: 'before dimension create',
    resolve: async (p) => viaBinding(p.bindingId)
  },
  {
    method: 'PATCH',
    path: '/dimensions/:dimId',
    note: 'before dimension update',
    resolve: async (p) => {
      const dim = (await db('nivaro_pipeline_owner_dimensions')
        .where({ id: Number(p.dimId) })
        .first('binding')) as { binding: number } | undefined
      return dim ? viaBinding(dim.binding) : null
    }
  },
  {
    method: 'DELETE',
    path: '/dimensions/:dimId',
    note: 'before dimension delete',
    resolve: async (p) => {
      const dim = (await db('nivaro_pipeline_owner_dimensions')
        .where({ id: Number(p.dimId) })
        .first('binding')) as { binding: number } | undefined
      return dim ? viaBinding(dim.binding) : null
    }
  },
  {
    method: 'POST',
    path: '/:id/owner-cleanup',
    note: 'before owner cleanup',
    resolve: async (p) => p.id
  }
]

/** The OWNER_ROUTES entry a registered route matches, if any. Exported for tests. */
export function ownerRouteFor(method: string, url: string) {
  return OWNER_ROUTES.find((r) => r.method === method && url.endsWith(`/pipelines${r.path}`))
}

/** Call FIRST inside the pipelines plugin — onRoute only sees routes added after it. */
export function registerOwnerMatrixCapture(app: FastifyInstance): void {
  app.addHook('onRoute', (opts: RouteOptions) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method]
    const entry = methods.map((m) => ownerRouteFor(String(m), opts.url)).find(Boolean)
    if (!entry) return
    const capture = async (req: FastifyRequest) => {
      if (!req.isAdmin) return
      try {
        const template = await entry.resolve((req.params ?? {}) as Record<string, string>)
        if (template) await snapshotOwnerMatrixVersion(template, req.user?.id, entry.note)
      } catch (err) {
        req.log.warn({ err }, 'owner matrix capture failed')
      }
    }
    const existing = opts.preHandler
    opts.preHandler = [
      ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
      capture
    ]
  })
}

function personName(r: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}) {
  return `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email || null
}

/** Names for the users, teams and states a diff mentions — the card shows people, not uuids. */
async function diffNames(diff: OwnerMatrixDiff) {
  const users = new Set<string>()
  const teams = new Set<number>()
  const states = new Set<string>()
  for (const list of [diff.groups.added, diff.groups.removed, diff.groups.changed]) {
    for (const g of list) {
      states.add(g.state)
      for (const u of [...g.members_added, ...g.members_removed]) users.add(u)
      for (const t of [...g.teams_added, ...g.teams_removed]) teams.add(t)
    }
  }
  const [userRows, teamRows, stateRows] = await Promise.all([
    users.size
      ? db('nivaro_users')
          .whereIn('id', [...users].slice(0, 2000))
          .select('id', 'first_name', 'last_name', 'email')
      : [],
    teams.size
      ? db('nivaro_user_groups')
          .whereIn('id', [...teams])
          .select('id', 'name')
      : [],
    states.size
      ? db('nivaro_workflow_states')
          .whereIn('id', [...states].slice(0, 2000))
          .select('id', 'label')
      : []
  ])
  return {
    users: Object.fromEntries(
      (userRows as Array<Record<string, string | null>>).map((r) => [
        String(r.id).toUpperCase(),
        personName(r)
      ])
    ),
    teams: Object.fromEntries(
      (teamRows as Array<{ id: number; name: string }>).map((r) => [String(r.id), r.name])
    ),
    states: Object.fromEntries(
      (stateRows as Array<{ id: string; label: string }>).map((r) => [
        String(r.id).toUpperCase(),
        r.label
      ])
    )
  }
}

export async function ownerMatrixVersionRoutes(app: FastifyInstance) {
  app.get('/:id/owner-matrix/versions', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!(await ownerMatrixVersionsReady())) return reply.send({ data: [] })
    const rows = await db(`${OWNER_MATRIX_VERSIONS_TABLE} as v`)
      .leftJoin('nivaro_users as u', 'v.created_by', 'u.id')
      .where({ 'v.template': id })
      .orderBy('v.version', 'desc')
      .select(
        'v.id',
        'v.version',
        'v.note',
        'v.created_at',
        'v.bytes',
        'v.group_count',
        'v.member_count',
        db.raw("CONCAT(u.first_name, ' ', u.last_name) as created_by_name")
      )
    return reply.send({ data: rows })
  })

  // Capture the matrix as it stands now (a deliberate checkpoint, never coalesced).
  app.post('/:id/owner-matrix/versions', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { note } = (req.body ?? {}) as { note?: string }
    const template = await db('nivaro_workflow_templates').where({ id }).first('id')
    if (!template) return reply.code(404).send({ error: 'Template not found' })
    const version = await snapshotOwnerMatrixVersion(id, req.user?.id, note || 'checkpoint', {
      force: true
    })
    return reply.send({ data: { version, unchanged: version === null } })
  })

  app.get(
    '/:id/owner-matrix/versions/:versionId/diff',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id, versionId } = req.params as { id: string; versionId: string }
      const { against } = req.query as { against?: string }
      const from = await loadOwnerMatrixVersion(id, Number(versionId))
      if (!from) return reply.code(404).send({ error: 'Version not found' })
      let toLabel = 'current matrix'
      let to = null as Awaited<ReturnType<typeof readOwnerMatrix>> | null
      if (against && against !== 'current') {
        const other = await loadOwnerMatrixVersion(id, Number(against))
        if (!other) return reply.code(404).send({ error: 'Comparison version not found' })
        to = other.snapshot
        toLabel = `version ${other.version}`
      } else {
        to = await readOwnerMatrix(id)
      }
      const diff = diffOwnerMatrix(from.snapshot, to)
      return reply.send({
        data: { from_version: from.version, to: toLabel, diff, names: await diffNames(diff) }
      })
    }
  )

  app.post(
    '/:id/owner-matrix/versions/:versionId/restore',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id, versionId } = req.params as { id: string; versionId: string }
      const target = await loadOwnerMatrixVersion(id, Number(versionId))
      if (!target) return reply.code(404).send({ error: 'Version not found' })
      // The CURRENT matrix first — restoring is itself reversible.
      await snapshotOwnerMatrixVersion(id, req.user?.id, 'before restore', { force: true })
      let result: Awaited<ReturnType<typeof restoreOwnerMatrixVersion>>
      try {
        result = await restoreOwnerMatrixVersion(id, Number(versionId))
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : 'Restore failed' })
      }
      await logActivity({
        action: 'owner-matrix-restore',
        collection: 'nivaro_workflow_templates',
        item: id,
        user: req.user?.id,
        comment: `restored owner matrix version ${target.version}`,
        req
      })
      return reply.send({ data: result })
    }
  )
}
