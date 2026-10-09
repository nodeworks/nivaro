import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { REVOKED_PREFIX } from '../auth/session.js'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { getFile } from '../services/files.js'
import {
  captionsToVtt,
  EditsError,
  emptyEdits,
  normalizeEdits
} from '../services/help-video-edits.js'
import { queueRender } from '../services/help-video-render.js'
import {
  abandonUpload,
  appendPart,
  finalizeUpload,
  listOpenUploads,
  MAX_PART_BYTES,
  openUpload
} from '../services/help-video-uploads.js'
import {
  pickStreamFile,
  recordProgress,
  requiredForUser,
  videoAnalytics
} from '../services/help-video-views.js'
import {
  archiveVideo,
  createVideo,
  ensureDraft,
  isAuthor,
  isUuid,
  listPages,
  listVersions,
  listVideos,
  loadVersion,
  loadVideoForUser,
  notifyRequiredViewersSafely,
  publishVideo,
  purgeVideo,
  registerPage,
  replaceContexts,
  replaceRequirements,
  rerecordVideo,
  restoreVersion,
  SIDTAG_PREFIX,
  saveDraftEdits,
  serializeVersion,
  serializeVideo,
  sessionTag,
  updateDetails,
  type VideoRow,
  validateContexts,
  verifyMediaTicket,
  videosForContext,
  viewerMaySee
} from '../services/help-videos.js'
import { sendStoredObject } from '../services/stored-object-stream.js'
import type { User } from '../types.js'

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
  return { author, userId: req.user!.id, role: req.user!.role ?? null, sidTag: sessionTag(req) }
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

  app.get('/', async (req, reply) => {
    return reply.send(await listVideos(req, req.query as Record<string, string>))
  })
  app.get('/for', async (req, reply) => {
    const q = req.query as { collection?: string; item?: string; state?: string; page?: string }
    return reply.send(await videosForContext(req, q))
  })
  app.get('/pages', async (_req, reply) => reply.send({ data: await listPages() }))
  app.post('/pages', { preHandler: requireAuthor }, async (req, reply) => {
    const b = (req.body ?? {}) as { key?: string; label?: string; app?: string }
    await registerPage(String(b.key ?? ''), String(b.label ?? ''), b.app ?? null)
    return reply.code(204).send()
  })

  // ── Watching ──────────────────────────────────────────────────────────────
  app.get('/required/mine', async (req, reply) => {
    const ids = await requiredForUser(req.user!)
    if (!ids.length) return reply.send({ data: [] })
    const rows = (await db('nivaro_help_videos').whereIn('id', ids)) as VideoRow[]
    const data = await Promise.all(
      rows
        .filter((v) => viewerMaySee(v, req.user!.role, false))
        .map((v) => serializeVideo(v, viewerCtx(req, false)))
    )
    return reply.send({ data })
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
    if (video.status === 'published' && added.length) {
      void notifyRequiredViewersSafely(String(video.id), String(video.title ?? ''), added)
    }
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
      // Deleting for good is the second step after archiving; a stale tab or a
      // re-publish must never take a live video with it.
      if (video.status !== 'archived') {
        return reply.code(409).send({
          error: 'Only archived videos can be deleted permanently. Archive it first.',
          code: 'HELP_VIDEO_NOT_ARCHIVED'
        })
      }
      await purgeVideo(video, req.user!)
    } else {
      await archiveVideo(video, req.user!)
    }
    return reply.code(204).send()
  })

  app.post('/:id/progress', async (req, reply) => {
    // Masquerade sessions are not tracked: an admin looking as someone else
    // must never complete that person's required viewing.
    if (req.masqueradeAdminId) return reply.code(204).send()
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    return reply.send({
      data: await recordProgress(
        req.user!,
        video,
        (req.body ?? {}) as Parameters<typeof recordProgress>[2]
      )
    })
  })

  app.get('/:id/analytics', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    return reply.send({ data: await videoAnalytics(video) })
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
  app.post('/:id/render', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { draft } = req.query as { draft?: string }
    const { video } = await loadVideoForUser(req, id)
    const versionId = draft === '1' ? video.draft_version_id : video.published_version_id
    if (!versionId) {
      return reply
        .code(409)
        .send({ error: 'Nothing to render', code: 'HELP_VIDEO_NOTHING_TO_RENDER' })
    }
    await queueRender(String(versionId))
    await logActivity({
      action: 'help-video-render',
      user: req.user!.id,
      collection: 'nivaro_help_videos',
      item: String(video.id).toLowerCase(),
      comment: draft === '1' ? 'draft' : 'published'
    })
    return reply.send({ data: { ok: true } })
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

/** Media routes (stream, captions, poster): <video>, <track> and <img> cannot
 *  send an Authorization header, so these sit in their own plugin WITHOUT the
 *  authenticate hook and are authorised by a signed ticket (?st=) instead.
 *  The ticket only names the person: every request re-checks that person's
 *  CURRENT status and role and the video's CURRENT visibility. Unknown,
 *  invisible, expired and unauthorised all answer the same 404. */
export async function helpVideoMediaRoutes(app: FastifyInstance) {
  async function resolve(req: FastifyRequest) {
    const { id } = req.params as { id: string }
    const { st } = req.query as { st?: string }
    const notFound = Object.assign(new Error('Video not found'), {
      statusCode: 404,
      code: 'HELP_VIDEO_NOT_FOUND'
    })
    if (!isUuid(id)) throw notFound
    const t = typeof st === 'string' ? verifyMediaTicket(st, id) : null
    if (!t || !isUuid(t.userId)) throw notFound
    if (t.tag) {
      // A ticket minted for a session dies with it (logout / logout-all write
      // the revocation marker). A missing tag mapping or a Redis error fails
      // OPEN — the status, role and visibility re-checks below still apply.
      const sid = await app.redis.get(`${SIDTAG_PREFIX}${t.tag}`).catch(() => null)
      if (sid) {
        const revoked = await app.redis.exists(`${REVOKED_PREFIX}${sid}`).catch(() => 0)
        if (revoked) throw notFound
      }
    }
    const user = (await db('nivaro_users').where({ id: t.userId, status: 'active' }).first()) as
      | (User & { is_redacted?: unknown })
      | undefined
    if (!user || user.is_redacted === true || user.is_redacted === 1) throw notFound
    const video = (await db('nivaro_help_videos').where({ id }).first()) as VideoRow | undefined
    if (!video) throw notFound
    const role = user.role
      ? await db('nivaro_roles').where({ id: user.role }).first('admin_access')
      : null
    const author = await isAuthor(user, !!role?.admin_access)
    if (!viewerMaySee(video, user.role ?? null, author)) throw notFound
    if (t.scope === 'd' && !author) throw notFound
    const version = await loadVersion(
      t.scope === 'd' ? video.draft_version_id : video.published_version_id
    )
    if (!version) throw notFound
    return { video, version, draft: t.scope === 'd', author }
  }

  // no-cache on every media answer: a browser may keep the bytes but must ask
  // again, so someone whose role or the video's visibility changed stops
  // getting it at once instead of after an hour of cache.
  app.get('/:id/stream', async (req, reply) => {
    const { version, draft, author } = await resolve(req)
    // ?source=1 is honoured for authors only; a viewer never gets an original
    // whose blurs or cuts would show (see viewerMayPlaySource).
    const pick = pickStreamFile(version, {
      author,
      forceSource: draft || (req.query as { source?: string }).source === '1'
    })
    if (!pick) {
      return reply.code(409).send({
        error: 'This video is still being prepared. Try again in a few minutes.',
        code: 'HELP_VIDEO_PROCESSING'
      })
    }
    const file = await getFile(pick.fileId)
    if (!file?.filename_disk) return reply.code(404).send({ error: 'Recording not found' })
    reply.header('Cache-Control', 'private, no-cache').header('X-Help-Video-Source', pick.kind)
    return sendStoredObject(reply, file.filename_disk, {
      rangeHeader: req.headers.range,
      contentType: pick.kind === 'rendered' ? 'video/mp4' : String(file.type ?? 'video/webm')
    })
  })

  app.get('/:id/captions.vtt', async (req, reply) => {
    const { version } = await resolve(req)
    const sourceMs = Number(version.source_duration_ms ?? 30 * 60_000)
    let raw: unknown = emptyEdits(0)
    try {
      raw = typeof version.edits === 'string' ? JSON.parse(version.edits) : raw
    } catch {
      // unreadable edits read as none — captions simply come back empty
    }
    // Edited time always: a current render plays in edited time, and the
    // player converts live-mode positions to edited time before showing cues.
    let vtt = 'WEBVTT\n\n'
    try {
      vtt = captionsToVtt(normalizeEdits(raw, sourceMs))
    } catch (err) {
      if (!(err instanceof EditsError)) throw err
    }
    return reply
      .header('Content-Type', 'text/vtt; charset=utf-8')
      .header('Cache-Control', 'private, no-cache')
      .send(vtt)
  })

  app.get('/:id/poster', async (req, reply) => {
    const { video } = await resolve(req)
    const file = video.poster_file ? await getFile(String(video.poster_file)) : undefined
    if (!file?.filename_disk) return reply.code(404).send({ error: 'No poster yet' })
    reply.header('Cache-Control', 'private, no-cache')
    return sendStoredObject(reply, file.filename_disk, {
      contentType: String(file.type ?? 'image/jpeg')
    })
  })
}
