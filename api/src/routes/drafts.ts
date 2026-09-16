import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'

// ─── #24 — server-side autosave drafts ──────────────────────────────────────
// The record form keeps its unsaved draft in IndexedDB (fast, private); this
// mirrors it per (user, collection, record) so the same draft is offered on
// another device or browser. Rows are the caller's own, always.

const PAYLOAD_CAP = 256 * 1024
const KEY_RE = /^[A-Za-z0-9_.:-]{1,255}$/

export async function draftsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/', async (req) => {
    const rows = (await db('nivaro_drafts')
      .where({ user: req.user!.id })
      .orderBy('saved_at', 'desc')
      .select('collection', 'item_key', 'saved_at')) as Array<{
      collection: string
      item_key: string
      saved_at: Date
    }>
    return { data: rows }
  })

  app.get<{ Params: { collection: string; item: string } }>(
    '/:collection/:item',
    async (req, reply) => {
      const row = (await db('nivaro_drafts')
        .where({ user: req.user!.id, collection: req.params.collection, item_key: req.params.item })
        .first('payload', 'saved_at')) as { payload: string; saved_at: Date } | undefined
      // "No draft yet" is the normal case on every record open — answer it
      // with an empty body rather than a 404 the browser console shouts about.
      if (!row) return { data: null }
      let payload: unknown = null
      try {
        payload = JSON.parse(row.payload)
      } catch {
        return { data: null }
      }
      return { data: { payload, saved_at: row.saved_at } }
    }
  )

  app.put<{
    Params: { collection: string; item: string }
    Body: { payload?: unknown; saved_at?: string }
  }>('/:collection/:item', async (req, reply) => {
    const { collection, item } = req.params
    if (!KEY_RE.test(collection) || !KEY_RE.test(item))
      return reply.code(400).send({ error: 'Bad draft key' })
    if (req.body?.payload == null || typeof req.body.payload !== 'object')
      return reply.code(400).send({ error: 'payload object required' })
    const text = JSON.stringify(req.body.payload)
    if (text.length > PAYLOAD_CAP) return reply.code(413).send({ error: 'Draft too large' })
    const savedAt = req.body.saved_at ? new Date(req.body.saved_at) : new Date()
    const where = { user: req.user!.id, collection, item_key: item }
    const existing = await db('nivaro_drafts').where(where).first('id')
    if (existing)
      await db('nivaro_drafts').where(where).update({ payload: text, saved_at: savedAt })
    else await db('nivaro_drafts').insert({ ...where, payload: text, saved_at: savedAt })
    return { data: { saved_at: savedAt } }
  })

  app.delete<{ Params: { collection: string; item: string } }>(
    '/:collection/:item',
    async (req, reply) => {
      await db('nivaro_drafts')
        .where({ user: req.user!.id, collection: req.params.collection, item_key: req.params.item })
        .delete()
      return reply.code(204).send()
    }
  )
}
