import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { addSuggestedNote, forgetMemory, readMemoryOf } from '../services/ai-memory.js'

/**
 * Ask AI memory routes beside the Profile card's own PATCH /users/me/preferences.
 *
 *  - POST /ai/memory (#1845): the asker clicked "Remember this?" under an
 *    answer. Writes the CALLER's own notes only, with the usual caps.
 *  - GET / DELETE /users/:id/ai-memory[/:noteId] (#1897): an administrator
 *    reads or clears someone's notes for a support or compliance request.
 *    Each view and each clear is an activity row (counts only — the notes
 *    themselves never go into the log). There is deliberately no admin
 *    write: an administrator can remove notes but never add or reword one,
 *    and PATCH /users/:id keeps ignoring ai_memory for anyone but the person.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function aiMemoryRoutes(app: FastifyInstance) {
  app.post('/memory', { preHandler: authenticate }, async (req, reply) => {
    const { text } = (req.body ?? {}) as { text?: unknown }
    const r = await addSuggestedNote(String(req.user!.id), text)
    if ('error' in r) {
      return reply.code(r.status).send({ error: r.error, ...(r.code ? { code: r.code } : {}) })
    }
    return reply.send({ data: r })
  })
}

export async function aiMemoryAdminRoutes(app: FastifyInstance) {
  app.get('/:id/ai-memory', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) return reply.code(404).send({ error: 'Not found' })
    const notes = await readMemoryOf(id)
    if (!notes) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'ai-memory-view',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: id,
      comment: `viewed Ask AI memory (${notes.length} note${notes.length === 1 ? '' : 's'})`,
      req
    })
    return reply.send({ data: { notes } })
  })

  const clear = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, noteId } = req.params as { id: string; noteId?: string }
    if (!UUID.test(id)) return reply.code(404).send({ error: 'Not found' })
    const r = await forgetMemory(id, noteId)
    if (!r) return reply.code(404).send({ error: 'Not found' })
    if (noteId && r.removed === 0) return reply.code(404).send({ error: 'Note not found' })
    await logActivity({
      action: 'ai-memory-clear',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: id,
      comment: noteId
        ? `removed 1 Ask AI memory note (${r.remaining} left)`
        : `cleared Ask AI memory (${r.removed} note${r.removed === 1 ? '' : 's'})`,
      req
    })
    return reply.send({ data: r })
  }
  app.delete('/:id/ai-memory', { preHandler: requireAdmin }, clear)
  app.delete('/:id/ai-memory/:noteId', { preHandler: requireAdmin }, clear)
}
