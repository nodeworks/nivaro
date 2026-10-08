import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import { EditsError } from '../services/help-video-edits.js'
import {
  abandonUpload,
  appendPart,
  finalizeUpload,
  listOpenUploads,
  MAX_PART_BYTES,
  openUpload
} from '../services/help-video-uploads.js'
import {
  archiveVideo,
  createVideo,
  ensureDraft,
  isAuthor,
  listVersions,
  loadVideoForUser,
  publishVideo,
  purgeVideo,
  replaceContexts,
  replaceRequirements,
  rerecordVideo,
  restoreVersion,
  saveDraftEdits,
  serializeVersion,
  serializeVideo,
  updateDetails,
  validateContexts
} from '../services/help-videos.js'

// /api/help-videos — tutorial videos (spec 2026-10-08). Authoring routes need
// an author (admin or a role in help_video_author_roles); everything else is
// visibility-checked per video through loadVideoForUser. Every :id is checked
// to be an exact uuid by the service before it reaches a query (404 otherwise).

async function requireAuthor(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!(await isAuthor(req.user!, !!req.isAdmin))) {
    return reply
      .code(403)
      .send({ error: 'Only video authors can do this', code: 'HELP_VIDEO_AUTHOR_ONLY' })
  }
}

function viewerCtx(req: FastifyRequest, author: boolean) {
  return { author, userId: req.user!.id, role: req.user!.role ?? null }
}

export async function helpVideosRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_PART_BYTES + 1024 },
    (_req, body, done) => done(null, body)
  )

  // ── Uploads ────────────────────────────────────────────────────────────────
  app.post('/uploads', { preHandler: requireAuthor }, async (req, reply) => {
    const { mime } = (req.body ?? {}) as { mime?: string }
    return reply.code(201).send({ data: await openUpload(req.user!, String(mime ?? '')) })
  })
  app.put('/uploads/:id/parts/:n', { preHandler: requireAuthor }, async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string }
    const body = req.body
    if (!Buffer.isBuffer(body)) {
      return reply.code(415).send({ error: 'Send the part as application/octet-stream' })
    }
    return reply.send({ data: await appendPart(req.user!, id, Number(n), body) })
  })
  app.post('/uploads/:id/finalize', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const meta = (req.body ?? {}) as { duration_ms?: number; clicks?: unknown; levels?: unknown }
    return reply.send({ data: await finalizeUpload(req.user!, id, meta) })
  })
  app.get('/uploads/mine', { preHandler: requireAuthor }, async (req, reply) => {
    return reply.send({ data: await listOpenUploads(req.user!) })
  })
  app.delete('/uploads/:id', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await abandonUpload(req.user!, id)
    return reply.code(204).send()
  })

  // ── Authoring ──────────────────────────────────────────────────────────────
  app.post('/', { preHandler: requireAuthor }, async (req, reply) => {
    const id = await createVideo(req.user!, (req.body ?? {}) as Record<string, string>)
    const { video } = await loadVideoForUser(req, id)
    return reply.code(201).send({ data: await serializeVideo(video, viewerCtx(req, true)) })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video, author } = await loadVideoForUser(req, id)
    return reply.send({ data: await serializeVideo(video, viewerCtx(req, author)) })
  })

  app.patch('/:id', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    await updateDetails(video.id, req.user!, (req.body ?? {}) as Record<string, unknown>)
    const fresh = await loadVideoForUser(req, id)
    return reply.send({ data: await serializeVideo(fresh.video, viewerCtx(req, true)) })
  })

  app.put('/:id/contexts', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    await replaceContexts(
      video.id,
      req.user!,
      validateContexts((req.body as { contexts?: unknown })?.contexts)
    )
    return reply.send({ data: { ok: true } })
  })

  app.put('/:id/requirements', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const { added } = await replaceRequirements(
      video.id,
      req.user!,
      (req.body as { role_ids?: unknown })?.role_ids
    )
    return reply.send({ data: { ok: true, added } })
  })

  app.delete('/:id', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { purge } = req.query as { purge?: string }
    const { video } = await loadVideoForUser(req, id)
    if (purge === '1') {
      if (!req.isAdmin) {
        return reply
          .code(403)
          .send({ error: 'Only administrators can delete videos', code: 'ADMIN_ONLY' })
      }
      await purgeVideo(video, req.user!)
    } else {
      await archiveVideo(video, req.user!)
    }
    return reply.code(204).send()
  })

  // ── Draft edits ───────────────────────────────────────────────────────────
  app.get('/:id/draft/edits', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    return reply.send({
      data: serializeVersion(await ensureDraft(video, req.user!), { withRecorderData: true })
    })
  })
  app.put('/:id/draft/edits', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { edits?: unknown; base_hash?: string }
    const { video } = await loadVideoForUser(req, id)
    try {
      return reply.send({
        data: await saveDraftEdits(video, req.user!, body.edits, body.base_hash)
      })
    } catch (err) {
      if (err instanceof EditsError)
        return reply.code(422).send({ error: err.message, code: err.code })
      throw err
    }
  })

  // ── Versions ──────────────────────────────────────────────────────────────
  app.post('/:id/publish', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    await publishVideo(video, req.user!, (req.body ?? {}) as { watch_again?: boolean })
    const fresh = await loadVideoForUser(req, id)
    return reply.send({ data: await serializeVideo(fresh.video, viewerCtx(req, true)) })
  })
  app.post('/:id/rerecord', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const uploadId = String((req.body as { upload_id?: string })?.upload_id ?? '')
    return reply.send({ data: await rerecordVideo(video, req.user!, uploadId) })
  })
  app.get('/:id/versions', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    return reply.send({ data: await listVersions(video) })
  })
  app.post('/:id/versions/:vid/restore', { preHandler: requireAuthor }, async (req, reply) => {
    const { id, vid } = req.params as { id: string; vid: string }
    const { video } = await loadVideoForUser(req, id)
    return reply.send({ data: await restoreVersion(video, req.user!, vid) })
  })
}
