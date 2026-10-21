import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { loadFormLayout } from '../services/form-layout.js'
import {
  getLayoutOwnerId,
  layoutWatcherIds,
  listLayoutOwnerIds,
  markSeen,
  peopleByIds,
  setLayoutOwnerId,
  setLayoutWatch,
  whatsNewFor
} from '../services/layout-notify.js'
import {
  addPreviewComment,
  cleanComment,
  countPreviewView,
  createPreviewLink,
  deletePreviewComment,
  listPreviewComments,
  listPreviewLinks,
  type PreviewLink,
  previewLinkByToken,
  renderFormPreviewHtml,
  revokePreviewLink
} from '../services/layout-preview.js'
import { can, getAllowedFields } from '../services/permissions.js'
import type { User } from '../types.js'

/**
 * Layout watch, owner, "what's new" and shareable form previews (#2655 #2656 #2657 #2666).
 * Mounted at /api/layout-collab — deliberately NOT under /collection-layouts: none of these
 * writes change a form, and every non-GET there flushes the metadata caches tenant-wide
 * (isConfigWrite). The public preview page lives at /api/form-preview/:token.
 */

const isId = (v: unknown) => typeof v === 'string' && /^\d{1,9}$/.test(v)

async function layoutRow(id: string) {
  if (!isId(id)) return null
  return (await db('nivaro_collection_layouts')
    .where({ id: Number(id) })
    .first('id', 'name', 'collection', 'layout_type')) as
    | { id: number; name: string; collection: string; layout_type: string | null }
    | undefined
}

/** Field filter for a reader: null = every field. */
async function readableFields(user: User, isAdmin: boolean, collection: string) {
  if (isAdmin) return null
  const allowed = await getAllowedFields(user, 'read', collection)
  if (allowed === null || allowed.includes('*')) return null
  return new Set(allowed)
}

export async function layoutCollabRoutes(app: FastifyInstance) {
  // ── Watch + owner (admin: the people who edit forms) ──────────────────────
  app.get('/owners', { preHandler: requireAdmin }, async () => {
    const owners = await listLayoutOwnerIds()
    const people = await peopleByIds([...owners.values()])
    const data: Record<string, { id: string; name: string }> = {}
    for (const [layoutId, userId] of owners) {
      const p = people.get(userId.toUpperCase())
      if (p) data[String(layoutId)] = p
    }
    return { data }
  })

  app.get('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await layoutRow(id)
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    const [ownerId, watcherIds] = await Promise.all([
      getLayoutOwnerId(layout.id),
      layoutWatcherIds(layout.id)
    ])
    const people = await peopleByIds([...(ownerId ? [ownerId] : []), ...watcherIds])
    const me = String(req.user!.id).toUpperCase()
    return {
      data: {
        owner: ownerId ? (people.get(ownerId.toUpperCase()) ?? null) : null,
        watching: watcherIds.some((w) => w.toUpperCase() === me),
        watchers: watcherIds.flatMap((w) => people.get(w.toUpperCase()) ?? [])
      }
    }
  })

  app.put('/:id/watch', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await layoutRow(id)
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    const on = (req.body as { on?: unknown } | null)?.on === true
    await setLayoutWatch(layout.id, req.user!.id, on, `Form: ${layout.name}`)
    return { data: { watching: on } }
  })

  app.put('/:id/owner', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await layoutRow(id)
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    const raw = (req.body as { user_id?: unknown } | null)?.user_id
    const userId = typeof raw === 'string' && raw ? raw : null
    if (userId) {
      const u = (await db('nivaro_users').where({ id: userId }).first('id', 'status')) as
        | { id: string; status: string }
        | undefined
      if (!u) return reply.code(400).send({ error: 'That person does not exist' })
      if (u.status !== 'active')
        return reply.code(400).send({ error: 'Only an active person can own a form' })
    }
    await setLayoutOwnerId(layout.id, userId)
    await logActivity({
      action: 'layout-owner',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: String(layout.id),
      comment: userId ? `owner ${userId}` : 'owner cleared',
      req
    })
    const owner = userId ? ((await peopleByIds([userId])).get(userId.toUpperCase()) ?? null) : null
    return { data: { owner } }
  })

  // ── What's new on this form (#2657): anyone who may read the collection ───
  app.get('/:id/whats-new', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await layoutRow(id)
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && !(await can(req.user!, 'read', layout.collection)))
      return reply.code(404).send({ error: 'Not found' })
    const readable = await readableFields(req.user!, !!req.isAdmin, layout.collection)
    const answer = await whatsNewFor(req.user!.id, layout.id, (f) => !readable || readable.has(f))
    return { data: answer }
  })

  app.post('/:id/whats-new/seen', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rev = (req.body as { rev?: unknown } | null)?.rev
    if (typeof rev !== 'string' || !/^[0-9a-f]{64}$/.test(rev))
      return reply.code(400).send({ error: 'rev required' })
    const layout = await layoutRow(id)
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && !(await can(req.user!, 'read', layout.collection)))
      return reply.code(404).send({ error: 'Not found' })
    await markSeen(req.user!.id, layout.id, rev)
    return { data: { ok: true } }
  })

  // ── Shareable preview links + their comments (#2666, admin) ───────────────
  const linkOut = (l: PreviewLink, comments: number) => ({
    ...l,
    path: `/api/form-preview/${l.token}`,
    comments
  })

  app.get('/:id/preview-links', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await layoutRow(id)
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    const [links, comments] = await Promise.all([
      listPreviewLinks(layout.id),
      listPreviewComments(layout.id)
    ])
    return {
      data: links.map((l) => linkOut(l, comments.filter((c) => c.link_id === l.id).length))
    }
  })

  app.post('/:id/preview-links', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await layoutRow(id)
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    if ((layout.layout_type ?? 'grouped') !== 'grouped')
      return reply.code(400).send({ error: 'Only record forms can be shared as a preview' })
    const days = Number((req.body as { days?: unknown } | null)?.days ?? 14)
    if (!Number.isFinite(days) || days < 1)
      return reply.code(400).send({ error: 'days must be at least 1' })
    const link = await createPreviewLink({
      layoutId: layout.id,
      collection: layout.collection,
      days,
      userId: req.user!.id
    })
    await logActivity({
      action: 'layout-preview-link',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: String(layout.id),
      comment: `preview link, expires ${link.expires_at}`,
      req
    })
    return reply.code(201).send({ data: linkOut(link, 0) })
  })

  app.delete('/preview-links/:linkId', { preHandler: requireAdmin }, async (req, reply) => {
    const { linkId } = req.params as { linkId: string }
    if (!/^[0-9a-f-]{36}$/i.test(linkId)) return reply.code(404).send({ error: 'Not found' })
    if (!(await revokePreviewLink(linkId))) return reply.code(404).send({ error: 'Not found' })
    return reply.code(204).send()
  })

  app.get('/:id/preview-comments', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await layoutRow(id)
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    return { data: await listPreviewComments(layout.id) }
  })

  app.delete(
    '/:id/preview-comments/:commentId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id, commentId } = req.params as { id: string; commentId: string }
      if (!isId(id)) return reply.code(404).send({ error: 'Not found' })
      if (!(await deletePreviewComment(Number(id), commentId)))
        return reply.code(404).send({ error: 'Not found' })
      return reply.code(204).send()
    }
  )
}

// ─── Public preview page (#2666) ─────────────────────────────────────────────

const RATE_WINDOW_S = 600
const RATE_MAX = 20
const memoryHits = new Map<string, { n: number; until: number }>()

/** Comments per IP per link per 10 minutes. Redis first; this process alone when it is down. */
async function overLimit(app: FastifyInstance, req: FastifyRequest, token: string) {
  const key = `nvr:formpreview:rl:${token.slice(0, 16)}:${req.ip}`
  try {
    const n = await app.redis.incr(key)
    if (n === 1) await app.redis.expire(key, RATE_WINDOW_S)
    return n > RATE_MAX
  } catch {
    const now = Date.now()
    const hit = memoryHits.get(key)
    if (!hit || hit.until < now) {
      if (memoryHits.size > 5000) memoryHits.clear()
      memoryHits.set(key, { n: 1, until: now + RATE_WINDOW_S * 1000 })
      return false
    }
    hit.n += 1
    return hit.n > RATE_MAX
  }
}

/** The form as the link's creator would see it; null when the link no longer works. */
async function previewStructure(link: PreviewLink) {
  if (!link.created_by) return null
  const creator = (await db('nivaro_users').where({ id: link.created_by }).first()) as
    | User
    | undefined
  if (creator?.status !== 'active') return null
  const role = creator.role
    ? ((await db('nivaro_roles').where({ id: creator.role }).first('admin_access')) as
        | { admin_access?: boolean | number }
        | undefined)
    : undefined
  const structure = await loadFormLayout(link.layout_id, link.collection, {
    includeReadonly: true
  })
  if (!structure) return null
  const readable = await readableFields(creator, !!role?.admin_access, link.collection)
  if (!readable) return structure
  const sections = structure.sections
    .map((s) => ({ ...s, fields: s.fields.filter((f) => readable.has(f.path)) }))
    .filter((s) => s.fields.length > 0)
  return {
    ...structure,
    sections,
    field_paths: structure.field_paths.filter((p) => readable.has(p))
  }
}

function gone(reply: FastifyReply, title: string, msg: string) {
  return reply
    .code(404)
    .type('text/html')
    .header('Cache-Control', 'no-store')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font-family:'DM Sans',system-ui,sans-serif;padding:60px 16px;text-align:center;color:#6b7280"><h2 style="color:#111827;font-size:18px">${title}</h2><p>${msg}</p></body></html>`
    )
}

export async function formPreviewPublicRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>('/:token', async (req, reply) => {
    const link = await previewLinkByToken(req.params.token)
    if (!link)
      return gone(reply, 'Link not available', 'This preview link expired or was turned off.')
    const structure = await previewStructure(link)
    if (!structure)
      return gone(reply, 'Link not available', 'This form can no longer be previewed.')
    const [layout, col, comments] = await Promise.all([
      db('nivaro_collection_layouts').where({ id: link.layout_id }).first('name'),
      db('nivaro_collections').where({ collection: link.collection }).first('display_name'),
      listPreviewComments(link.layout_id, link.id)
    ])
    countPreviewView(link.id)
    return reply
      .type('text/html')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex')
      .send(
        renderFormPreviewHtml({
          title: String(col?.display_name ?? link.collection),
          layoutName: String(layout?.name ?? 'Form'),
          structure,
          comments,
          token: req.params.token,
          expiresAt: link.expires_at
        })
      )
  })

  app.post<{ Params: { token: string } }>('/:token/comments', async (req, reply) => {
    const link = await previewLinkByToken(req.params.token)
    if (!link) return reply.code(404).send({ error: 'This preview link expired or was turned off' })
    if (await overLimit(app, req, req.params.token))
      return reply
        .code(429)
        .header('Retry-After', String(RATE_WINDOW_S))
        .send({ error: 'Too many comments from here — try again in a few minutes' })
    const structure = await previewStructure(link)
    if (!structure) return reply.code(404).send({ error: 'This form can no longer be previewed' })
    const clean = cleanComment(req.body, structure.field_paths)
    if ('error' in clean) return reply.code(400).send({ error: clean.error })
    const saved = await addPreviewComment(link, clean)
    if ('error' in saved) return reply.code(409).send({ error: saved.error })
    return reply.code(201).send({ data: saved })
  })
}
