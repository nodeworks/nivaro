import type { FastifyInstance } from 'fastify'
import { itemActionRegistry } from '../extensions/item-actions.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

export async function itemActionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List actions available for a collection
  app.get('/item-actions/registered', { preHandler: [requireAuth] }, async (req) => {
    const q = req.query as Record<string, string>
    const collection = q.collection
    const item = q.item
    const actions = itemActionRegistry.list(collection)
    // With ?item=, per-record applicability gates run so the client only
    // renders buttons that can actually do something on THIS record.
    const kept = item
      ? (
          await Promise.all(
            actions.map(async (a) => {
              if (!collection) return a
              // Declared requirement first: an addendum-creating action hides
              // when the caller couldn't create an addendum here at all.
              if (a.requires_addendum_create) {
                try {
                  const { canCreateAddendum } = await import('../services/addendum-approve.js')
                  const gate = await canCreateAddendum(collection, item, {
                    roleId: (req.user?.role as string | null) ?? null,
                    isAdmin: !!req.isAdmin
                  })
                  if (!gate.ok) return null
                } catch {
                  /* gate error must not hide a working action */
                }
              }
              if (!a.applicable) return a
              const ok = await a.applicable({ collection, itemId: item }).catch(() => true) // broken check must not hide a working action
              return ok ? a : null
            })
          )
        ).filter((a): a is (typeof actions)[number] => a !== null)
      : actions
    return {
      data: kept.map(({ execute: _x, applicable: _a, preflight, ...rest }) => ({
        ...rest,
        // #616 — the form asks /preflight only for actions that can answer.
        has_preflight: typeof preflight === 'function'
      }))
    }
  })

  // #616 — what would stop this action on THIS record, before anyone presses
  // it. Read-only: the extension's own pre-validations, nothing sent.
  app.get<{ Params: { id: string }; Querystring: { collection?: string; item?: string } }>(
    '/item-actions/:id/preflight',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const action = itemActionRegistry.get(req.params.id)
      if (!action) return reply.status(404).send({ error: 'Item action not found' })
      const collection = String(req.query.collection ?? '')
      const item = String(req.query.item ?? '')
      if (!collection || !item)
        return reply.status(400).send({ error: 'collection and item are required' })
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection))
        return reply.status(400).send({ error: 'Not a valid collection' })
      const { can } = await import('../services/permissions.js')
      if (!(await can(req.user!, 'read', collection)))
        return reply.status(403).send({ error: 'Forbidden' })
      if (typeof action.preflight !== 'function')
        return { data: { ready: true, supported: false, issues: [] } }
      try {
        const raw = await action.preflight({ collection, itemId: item, userId: req.user?.id })
        const issues = (Array.isArray(raw) ? raw : [])
          .filter((i) => i && typeof i.message === 'string' && i.message.trim() !== '')
          .slice(0, 50)
          .map((i) => ({
            message: String(i.message).slice(0, 300),
            severity: i.severity === 'warn' ? 'warn' : 'block',
            field: typeof i.field === 'string' ? i.field : undefined,
            collection: typeof i.collection === 'string' ? i.collection : undefined,
            fk_field: typeof i.fk_field === 'string' ? i.fk_field : undefined,
            rows: Array.isArray(i.rows)
              ? i.rows.slice(0, 200).map((r) => ({
                  id: String(r.id),
                  label: r.label != null ? String(r.label) : `#${r.id}`
                }))
              : undefined
          }))
        return {
          data: {
            ready: !issues.some((i) => i.severity === 'block'),
            supported: true,
            issues
          }
        }
      } catch (err) {
        // Never "ready" on a check that failed.
        return {
          data: {
            ready: false,
            supported: true,
            error: err instanceof Error ? err.message : 'Pre-flight check failed',
            issues: []
          }
        }
      }
    }
  )

  // Execute a registered item action
  app.post<{
    Params: { id: string }
    Body: { collection: string; itemId: string | number; payload?: Record<string, unknown> }
  }>('/item-actions/:id/execute', { preHandler: [requireAuth] }, async (req, reply) => {
    const action = itemActionRegistry.get(req.params.id)
    if (!action) return reply.status(404).send({ error: 'Item action not found' })

    const { collection, itemId, payload } = req.body
    if (!collection || itemId == null) {
      return reply.status(400).send({ error: 'collection and itemId are required' })
    }

    if (action.requires_addendum_create) {
      const { canCreateAddendum } = await import('../services/addendum-approve.js')
      const gate = await canCreateAddendum(collection, itemId, {
        roleId: (req.user?.role as string | null) ?? null,
        isAdmin: !!req.isAdmin
      })
      if (!gate.ok) return reply.status(403).send({ error: gate.reason ?? 'Addendums unavailable' })
    }

    try {
      const result = await action.execute({
        collection,
        itemId,
        payload,
        userId: req.user?.id
      })
      // The mutation itself lives in extension code — log the invocation.
      await logActivity({
        action: 'item-action-execute',
        user: req.user?.id,
        collection,
        item: String(itemId),
        comment: req.params.id,
        req
      })
      return { data: result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed'
      return reply.status(500).send({ error: msg })
    }
  })
}
