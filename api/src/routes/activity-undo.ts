import type { FastifyInstance } from 'fastify'
import { applyUndo, previewUndo, UndoError, type UndoOptions } from '../services/activity-undo.js'
import { realUndoDeps, undoableIds } from '../services/activity-undo-deps.js'

/**
 * Undo from the audit log (#22). Registered inside activityRoutes (signed in).
 *
 *   POST /activity/undoable {ids}       → {data: {undoable: number[]}} — which of these entries
 *                                         may show Undo to the caller (cheap list check)
 *   POST /activity/:id/undo {dry_run?, scope?, fields?}
 *        dry_run (default true)          → the preview: per record, which fields go back, which
 *                                         were changed since, what is skipped and why
 *        dry_run: false                  → apply through the items service as the caller; writes
 *                                         an `undo` activity entry linked to the original
 *
 * Administrators may undo any entry; everyone else only their own changes.
 */
export function registerActivityUndoRoutes(app: FastifyInstance): void {
  app.post('/undoable', async (req, reply) => {
    const raw = (req.body as { ids?: unknown } | null)?.ids
    const ids = [
      ...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isInteger(n)))
    ]
    if (ids.length > 500) return reply.code(400).send({ error: 'Up to 500 ids at a time' })
    const undoable = await undoableIds(req, ids)
    return reply.send({ data: { undoable } })
  })

  app.post('/:id/undo', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid activity id' })
    const body = (req.body ?? {}) as { dry_run?: unknown; scope?: unknown; fields?: unknown }
    const opts: UndoOptions = {
      scope: body.scope === 'entry' ? 'entry' : 'group',
      fields: Array.isArray(body.fields)
        ? body.fields
            .filter((f): f is string => typeof f === 'string' && f.length > 0)
            .slice(0, 200)
        : undefined
    }
    const redis = (app as unknown as { redis?: Parameters<typeof realUndoDeps>[1] }).redis ?? null
    const deps = realUndoDeps(req, redis)
    try {
      if (body.dry_run === false) {
        const result = await applyUndo(deps, id, opts)
        return reply.send({ data: result })
      }
      return reply.send({ data: await previewUndo(deps, id, opts) })
    } catch (err) {
      if (err instanceof UndoError) {
        return reply
          .code(err.statusCode)
          .send({ error: err.message, ...(err.code ? { code: err.code } : {}) })
      }
      throw err
    }
  })
}
