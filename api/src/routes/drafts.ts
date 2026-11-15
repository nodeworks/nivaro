import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { isOutOfView, readOne } from '../services/items.js'
import { can, getAllowedFields } from '../services/permissions.js'
import {
  cleanDevice,
  DRAFT_PAYLOAD_CAP,
  draftExpired,
  filterDraftFields,
  LAYOUT_STAGED_COLLECTION,
  openDraft,
  pruneOwnDrafts,
  sealDraft
} from '../services/record-drafts.js'
import { isInternalCollection } from '../services/system-collections.js'
import { viewAsAdminOf } from '../services/view-as-attribution.js'

// ─── Server-side autosave drafts (#24, rt4 #21) ─────────────────────────────
// The record form keeps its unsaved draft in IndexedDB (fast, private); this mirrors it per
// (user, collection, record) so the same draft is offered on another device or browser.
// Rows are the caller's own, always. The text is sealed at rest, lives 7 days from its last
// save, is re-judged against the caller's access on every read (a record they can no longer
// open gives no draft; fields they can no longer edit are left out), and View-as never reads
// or writes the viewed person's drafts. See services/record-drafts.ts.

const KEY_RE = /^[A-Za-z0-9_.:-]{1,255}$/

/**
 * May the caller keep / read a draft for this record? System, chat and layout-editor
 * collections never take a server draft. A SAVE only asks the cached collection permission
 * (create for 'new', else update) — it runs on every autosave. A READ (`deep`) also opens the
 * record as the caller: null or out of view = no draft shown.
 */
async function mayHoldDraft(req: FastifyRequest, collection: string, item: string, deep = false) {
  if (isInternalCollection(collection) || collection === LAYOUT_STAGED_COLLECTION) return false
  try {
    if (item === 'new') return await can(req.user!, 'create', collection)
    if (!deep) return await can(req.user!, 'update', collection)
    const row = await readOne(req.user!, collection, item, req.workspaceId ?? undefined)
    return !!row && !isOutOfView(row)
  } catch {
    return false
  }
}

/** Not kept — answered quietly (200, `kept: false`) so an autosave never shows as an error. */
const NOT_KEPT = { data: { saved_at: null, kept: false } }

export async function draftsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/', async (req) => {
    if (viewAsAdminOf(req)) return { data: [] }
    const rows = (await db('nivaro_drafts')
      .where({ user: req.user!.id })
      .whereNot('collection', LAYOUT_STAGED_COLLECTION)
      .orderBy('saved_at', 'desc')
      .select('collection', 'item_key', 'saved_at')) as Array<{
      collection: string
      item_key: string
      saved_at: Date
    }>
    return { data: rows.filter((r) => !draftExpired(r.saved_at)) }
  })

  app.get<{ Params: { collection: string; item: string } }>('/:collection/:item', async (req) => {
    const { collection, item } = req.params
    // "No draft yet" is the normal case on every record open — answer it with an empty body
    // rather than a 404 the browser console shouts about.
    if (viewAsAdminOf(req)) return { data: null }
    const where = { user: req.user!.id, collection, item_key: item }
    const row = (await db('nivaro_drafts').where(where).first('payload', 'saved_at')) as
      | { payload: string; saved_at: Date }
      | undefined
    if (!row) return { data: null }
    if (draftExpired(row.saved_at)) {
      await db('nivaro_drafts').where(where).delete()
      return { data: null }
    }
    const opened = openDraft(row.payload)
    if (!opened) return { data: null }
    // The draft stays stored when access is gone (it may come back); it is just not shown.
    if (!(await mayHoldDraft(req, collection, item, true))) return { data: null }
    const allowed = await getAllowedFields(
      req.user!,
      item === 'new' ? 'create' : 'update',
      collection
    )
    const { payload, dropped } = filterDraftFields(opened.payload, allowed)
    return {
      data: {
        payload,
        saved_at: row.saved_at,
        device: opened.device,
        ...(dropped ? { dropped_fields: dropped } : {})
      }
    }
  })

  app.put<{
    Params: { collection: string; item: string }
    Body: { payload?: unknown; saved_at?: string; device?: unknown }
  }>('/:collection/:item', async (req, reply) => {
    const { collection, item } = req.params
    // View-as is exactly the person: their drafts are never written or read from it.
    if (viewAsAdminOf(req)) return NOT_KEPT
    if (!KEY_RE.test(collection) || !KEY_RE.test(item))
      return reply.code(400).send({ error: 'Bad draft key' })
    if (req.body?.payload == null || typeof req.body.payload !== 'object')
      return reply.code(400).send({ error: 'payload object required' })
    const text = JSON.stringify(req.body.payload)
    if (text.length > DRAFT_PAYLOAD_CAP) return reply.code(413).send({ error: 'Draft too large' })
    if (!(await mayHoldDraft(req, collection, item))) return NOT_KEPT
    const now = new Date()
    const given = req.body.saved_at ? new Date(req.body.saved_at) : now
    // A client clock a long way ahead must not make a draft immortal.
    const savedAt = Number.isNaN(given.getTime()) || given > now ? now : given
    const sealed = sealDraft(
      req.body.payload as Record<string, unknown>,
      cleanDevice(req.body.device)
    )
    const where = { user: req.user!.id, collection, item_key: item }
    const existing = await db('nivaro_drafts').where(where).first('id')
    if (existing)
      await db('nivaro_drafts').where(where).update({ payload: sealed, saved_at: savedAt })
    else await db('nivaro_drafts').insert({ ...where, payload: sealed, saved_at: savedAt })
    void pruneOwnDrafts(req.user!.id).catch(() => {})
    return { data: { saved_at: savedAt, kept: true } }
  })

  app.delete<{ Params: { collection: string; item: string } }>(
    '/:collection/:item',
    async (req, reply) => {
      if (viewAsAdminOf(req)) return reply.code(204).send()
      if (req.params.collection === LAYOUT_STAGED_COLLECTION) return reply.code(204).send()
      await db('nivaro_drafts')
        .where({
          user: req.user!.id,
          collection: req.params.collection,
          item_key: req.params.item
        })
        .delete()
      return reply.code(204).send()
    }
  )
}
