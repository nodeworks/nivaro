import type { FastifyInstance, FastifyReply } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  checkWatch,
  createWatch,
  deleteWatch,
  listWatchSummaries,
  summariseWatch,
  updateWatch,
  WatchError
} from '../services/ai-watches.js'

/**
 * Watched numbers (#1892, #1987, #1948) — a person's own list, so every route
 * is scoped to the caller; there is no way to read or change another
 * person's watches. Creating one evaluates it at once as the caller, which is
 * also how an unknown field or a collection they cannot read is refused.
 */
export async function aiWatchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof WatchError) return reply.code(err.statusCode).send({ error: err.message })
    throw err
  }

  app.get('/', async (req, reply) =>
    reply.send({ data: await listWatchSummaries(req.user?.id as string) })
  )

  app.post('/', async (req, reply) => {
    try {
      const w = await createWatch(req.user as never, (req.body ?? {}) as Record<string, unknown>)
      await logActivity({
        action: 'ai-watch-create',
        user: req.user?.id,
        comment: w.label,
        req
      })
      return reply.code(201).send({ data: summariseWatch(w) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.patch('/:id', async (req, reply) => {
    try {
      const w = await updateWatch(
        req.user?.id as string,
        (req.params as { id: string }).id,
        (req.body ?? {}) as Record<string, unknown>
      )
      return reply.send({ data: summariseWatch(w) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.delete('/:id', async (req, reply) => {
    try {
      await deleteWatch(req.user?.id as string, (req.params as { id: string }).id)
      return reply.code(204).send()
    } catch (err) {
      return fail(reply, err)
    }
  })

  // Read it again now. Alerts are sent exactly as the scheduled check would.
  app.post('/:id/check', async (req, reply) => {
    try {
      const o = await checkWatch(app, req.user as never, (req.params as { id: string }).id)
      return reply.send({ data: summariseWatch(o.watch), alerted: !!o.alert })
    } catch (err) {
      return fail(reply, err)
    }
  })
}
