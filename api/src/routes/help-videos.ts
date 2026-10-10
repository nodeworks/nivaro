import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { REVOKED_PREFIX } from '../auth/session.js'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { getFile } from '../services/files.js'
import {
  CaptionsError,
  captionProvider,
  clearCaptionJob,
  readCaptionJob,
  startCaptionJob
} from '../services/help-video-captions.js'
import {
  clipRow,
  createClip,
  deleteClip,
  listClips,
  serializeClip
} from '../services/help-video-clips.js'

import {
  captionsVtt,
  contentDisposition,
  downloadsAllowed,
  hasCaptions,
  isDownloadFile,
  pickDownloadFile,
  safeDownloadName,
  startsDownload,
  transcriptText,
  videoExtension,
  vttToSrt
} from '../services/help-video-download.js'
import { DraftError, suggestDraftForVideo } from '../services/help-video-draft.js'
import {
  captionsToVtt,
  EditsError,
  emptyEdits,
  normalizeEdits
} from '../services/help-video-edits.js'
import {
  answerQuestion,
  askQuestion,
  listQuestions,
  myRating,
  ratingSummary,
  setRating
} from '../services/help-video-feedback.js'
import {
  deleteVideoMusic,
  importOpenverseMusic,
  libraryTrackFile,
  listVideoMusic,
  MUSIC_MAX_BYTES,
  musicLibrary,
  uploadMusic,
  videoMusicRow
} from '../services/help-video-music.js'
import { nextForViewer } from '../services/help-video-next.js'
import {
  OpenverseError,
  openverseEnabled,
  openverseTrack,
  previewBytes,
  searchOpenverse
} from '../services/help-video-openverse.js'
import {
  appendImportPart,
  applyImport,
  discardImport,
  EXPORT_TICKET_PREFIX,
  EXPORT_TICKET_TTL_S,
  exportableVideos,
  exportIds,
  exportPackageStream,
  openImport,
  previewImport
} from '../services/help-video-package.js'
import {
  createPath,
  deletePath,
  listPaths,
  loadPath,
  notifyRequiredPathViewersSafely,
  pathsForUser,
  replacePathItems,
  replacePathRoles,
  requiredRolesOf,
  serializePath,
  splitRequired,
  updatePath
} from '../services/help-video-paths.js'
import {
  deleteReleaseVideo,
  releaseVideosFor,
  setReleaseVideo
} from '../services/help-video-releases.js'
import { queueRender } from '../services/help-video-render.js'
import { dismissStale, StaleError } from '../services/help-video-stale.js'
import {
  abandonUpload,
  activityOfFile,
  appendPart,
  finalizeUpload,
  listOpenUploads,
  MAX_PART_BYTES,
  openUpload,
  pointerOfFile,
  sourceKindOfFile,
  uploadStatus
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
  draftMedia,
  ensureDraft,
  isAuthor,
  isUuid,
  listPages,
  listVersions,
  listVideos,
  loadVersion,
  loadVideoForUser,
  mediaTicket,
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
  viewerMaySee,
  walkStepsFor
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

// Moving videos between instances is an administrator's job. The plugin's
// authenticate hook has already run; a key limited to named collections stays
// out (the same rule as requireAdmin).
async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.isAdmin || req.user?.api_key_scopes) {
    return reply.code(403).send({ error: 'Only administrators can do this', code: 'ADMIN_ONLY' })
  }
}

/** Was this clip cut from the version viewers see (the published one)? */
function clipOfPublished(
  row: Record<string, unknown>,
  video: { published_version_id: string | null }
): boolean {
  return (
    !!row.version_id &&
    !!video.published_version_id &&
    String(row.version_id).toLowerCase() === String(video.published_version_id).toLowerCase()
  )
}

/** The finalize body (the recording's metadata) may be this large. */
export const FINALIZE_BODY_BYTES = 8 * 1024 * 1024

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
    const { mime, source, name, size } = (req.body ?? {}) as {
      mime?: string
      source?: string
      name?: unknown
      size?: unknown
    }
    return reply
      .code(201)
      .send({ data: await openUpload(req.user!, String(mime ?? ''), { source, name, size }) })
  })
  app.put('/uploads/:id/parts/:n', { preHandler: requireAuthor }, async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string }
    const body = req.body
    if (!Buffer.isBuffer(body)) {
      return reply.code(415).send({ error: 'Send the part as application/octet-stream' })
    }
    return reply.send({ data: await appendPart(req.user!, id, Number(n), body) })
  })
  // The metadata (clicks, levels, activity, script, marks) is bounded by its
  // normalisers at under 3 MB, so the body need not parse under the global limit.
  app.post(
    '/uploads/:id/finalize',
    { preHandler: requireAuthor, bodyLimit: FINALIZE_BODY_BYTES },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const meta = (req.body ?? {}) as {
        duration_ms?: number
        clicks?: unknown
        levels?: unknown
        activity?: unknown
        script?: unknown
        marks?: unknown
      }
      const result = await finalizeUpload(req.user!, id, meta)
      // An uploaded file is checked (and maybe converted) in the background:
      // poll GET /uploads/:id until it is finalized.
      if ('processing' in result) return reply.code(202).send({ data: result })
      return reply.send({ data: result })
    }
  )
  app.get('/uploads/mine', { preHandler: requireAuthor }, async (req, reply) => {
    return reply.send({ data: await listOpenUploads(req.user!) })
  })
  app.get('/uploads/:id', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    return reply.send({ data: await uploadStatus(req.user!, id) })
  })
  app.delete('/uploads/:id', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await abandonUpload(req.user!, id)
    return reply.code(204).send()
  })

  // ── Moving videos between instances (administrators) ─────────────────────
  // Export: a short-lived one-purpose link (10 min) the browser downloads
  // directly, so a multi-GB package never passes through page memory.
  app.post('/packages', { preHandler: requireAdmin }, async (req, reply) => {
    const ids = exportIds((req.body as { ids?: unknown } | undefined)?.ids)
    await exportableVideos(ids)
    const token = randomUUID()
    await app.redis.set(
      `${EXPORT_TICKET_PREFIX}${token}`,
      // Bound to the asking session (dies with it, like media tickets) and
      // spent on first use: the link sits in a URL, so it must not be a
      // reusable bearer for every exported video.
      JSON.stringify({ user: req.user!.id, ids, tag: sessionTag(req) }),
      'EX',
      EXPORT_TICKET_TTL_S
    )
    return reply.send({ data: { url: `/api/help-videos/packages/${token}`, count: ids.length } })
  })
  // Import: open, send 8 MB parts, preview (checks + extracts), apply.
  app.post('/packages/imports', { preHandler: requireAdmin }, async (req, reply) => {
    return reply.code(201).send({ data: await openImport(req.user!) })
  })
  app.put('/packages/imports/:id/parts/:n', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string }
    if (!Buffer.isBuffer(req.body)) {
      return reply.code(415).send({ error: 'Send the part as application/octet-stream' })
    }
    return reply.send({ data: await appendImportPart(req.user!, id, Number(n), req.body) })
  })
  app.post('/packages/imports/:id/preview', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    return reply.send({ data: await previewImport(req.user!, id) })
  })
  app.post('/packages/imports/:id/apply', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { video_ids?: unknown }
    return reply.send({ data: await applyImport(req.user!, id, body.video_ids) })
  })
  app.delete('/packages/imports/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await discardImport(req.user!, id)
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
  // `labels` (optional): the click targets the client saw on the page, for
  // the nightly "may be out of date" check (#1495). Checked and capped.
  app.post('/pages', { preHandler: requireAuthor }, async (req, reply) => {
    const b = (req.body ?? {}) as { key?: string; label?: string; app?: string; labels?: unknown }
    await registerPage(String(b.key ?? ''), String(b.label ?? ''), b.app ?? null, b.labels)
    return reply.code(204).send()
  })

  // ── Learning paths (#1508) ────────────────────────────────────────────────
  // Authors make ordered lists of videos for roles; everyone gets the paths
  // for their role (and the New User paths while their account is new) with
  // their own progress. Every :pid is an exact uuid or 404.
  app.post('/paths', { preHandler: requireAuthor }, async (req, reply) => {
    const id = await createPath(req.user!, req.body)
    return reply.code(201).send({ data: await serializePath(await loadPath(id)) })
  })
  app.get('/paths', { preHandler: requireAuthor }, async (_req, reply) => {
    return reply.send({ data: await listPaths() })
  })
  app.get('/paths/mine', async (req, reply) => {
    return reply.send({ data: await pathsForUser(req) })
  })
  app.get('/paths/:pid', { preHandler: requireAuthor }, async (req, reply) => {
    const { pid } = req.params as { pid: string }
    return reply.send({ data: await serializePath(await loadPath(pid)) })
  })
  app.patch('/paths/:pid', { preHandler: requireAuthor }, async (req, reply) => {
    const { pid } = req.params as { pid: string }
    const row = await loadPath(pid)
    const { published_now } = await updatePath(row, req.user!, req.body)
    const fresh = await loadPath(pid)
    if (published_now) {
      // Publishing tells the roles it is required for, like a required video.
      const roles = await requiredRolesOf(row.id)
      if (roles.length) {
        void notifyRequiredPathViewersSafely(String(row.id), String(fresh.title ?? ''), roles)
      }
    }
    return reply.send({ data: await serializePath(fresh) })
  })
  app.put('/paths/:pid/items', { preHandler: requireAuthor }, async (req, reply) => {
    const { pid } = req.params as { pid: string }
    const row = await loadPath(pid)
    await replacePathItems(row, req.user!, (req.body as { video_ids?: unknown })?.video_ids)
    return reply.send({ data: await serializePath(await loadPath(pid)) })
  })
  app.put('/paths/:pid/roles', { preHandler: requireAuthor }, async (req, reply) => {
    const { pid } = req.params as { pid: string }
    const row = await loadPath(pid)
    const { added_required } = await replacePathRoles(
      row,
      req.user!,
      (req.body as { roles?: unknown })?.roles
    )
    if (row.status === 'published' && added_required.length) {
      void notifyRequiredPathViewersSafely(String(row.id), String(row.title ?? ''), added_required)
    }
    return reply.send({ data: await serializePath(await loadPath(pid)), added: added_required })
  })
  app.delete('/paths/:pid', { preHandler: requireAuthor }, async (req, reply) => {
    const { pid } = req.params as { pid: string }
    await deletePath(await loadPath(pid), req.user!)
    return reply.code(204).send()
  })

  // ── Release videos (#1528b) ───────────────────────────────────────────────
  // One video per changelog release. Readers get only what they may watch.
  app.get('/releases', async (req, reply) => {
    return reply.send({ data: await releaseVideosFor(req) })
  })
  app.put('/releases/:version', { preHandler: requireAdmin }, async (req, reply) => {
    const { version } = req.params as { version: string }
    return reply.send({ data: await setReleaseVideo(req.user!, version, req.body) })
  })
  app.delete('/releases/:version', { preHandler: requireAdmin }, async (req, reply) => {
    const { version } = req.params as { version: string }
    await deleteReleaseVideo(req.user!, version)
    return reply.code(204).send()
  })

  // ── Watching ──────────────────────────────────────────────────────────────
  // The required list: single required videos, plus required learning paths
  // (#1508) that are not finished — one entry per path, carrying its videos
  // and the next one to watch. A video inside such a path is not listed on
  // its own as well.
  app.get('/required/mine', async (req, reply) => {
    const ids = await requiredForUser(req.user!)
    const rows = ids.length
      ? ((await db('nivaro_help_videos').whereIn('id', ids)) as VideoRow[])
      : []
    const singles = await Promise.all(
      rows
        .filter((v) => viewerMaySee(v, req.user!.role, false))
        .map((v) => serializeVideo(v, viewerCtx(req, false)))
    )
    const mine = await pathsForUser(req).catch(() => [])
    const { data, paths } = splitRequired(singles, mine)
    return reply.send({ data, paths })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video, author } = await loadVideoForUser(req, id)
    return reply.send({ data: await serializeVideo(video, viewerCtx(req, author)) })
  })

  // "Show me on this page": the published version's labelled clicks as steps.
  // Same visibility as watching; a draft is never served.
  app.get('/:id/walk', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    return reply.send({ data: await walkStepsFor(video) })
  })

  // A fresh ticketed download link (the DTO's download_urls carry the same
  // links; this is the SDK command for hosts that build their own UI).
  app.get('/:id/download-link', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { file?: string; draft?: string }
    const file = q.file ?? 'video'
    if (!isDownloadFile(file)) {
      return reply
        .code(400)
        .send({ error: 'Unknown download', code: 'HELP_VIDEO_DOWNLOAD_UNKNOWN' })
    }
    const { video, author } = await loadVideoForUser(req, id)
    const draft = q.draft === '1'
    if (draft && !author) {
      return reply
        .code(403)
        .send({ error: 'Only video authors can do this', code: 'HELP_VIDEO_AUTHOR_ONLY' })
    }
    if (!author && !downloadsAllowed(video.visibility)) {
      return reply.code(403).send({
        error: 'Downloads are turned off for this video.',
        code: 'HELP_VIDEO_DOWNLOAD_OFF'
      })
    }
    if (!(draft ? video.draft_version_id : video.published_version_id)) {
      return reply.code(404).send({ error: 'Video not found', code: 'HELP_VIDEO_NOT_FOUND' })
    }
    const vid = String(video.id).toLowerCase()
    const t = mediaTicket(vid, req.user!.id, draft ? 'd' : 'p', Date.now(), sessionTag(req))
    return reply.send({
      data: { url: `/api/help-videos/${vid}/download?st=${t}&file=${encodeURIComponent(file)}` }
    })
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

  // "May be out of date" (#1495): an author dismisses the note; publishing
  // clears it by itself. 409 HELP_VIDEO_NOT_STALE when there is none.
  app.post('/:id/stale/dismiss', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    try {
      await dismissStale(video, req.user!)
    } catch (err) {
      if (err instanceof StaleError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code })
      }
      throw err
    }
    const fresh = await loadVideoForUser(req, id)
    return reply.send({ data: await serializeVideo(fresh.video, viewerCtx(req, true)) })
  })

  app.get('/:id/analytics', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const [analytics, ratings, questions] = await Promise.all([
      videoAnalytics(video),
      ratingSummary(video),
      listQuestions(video, { userId: req.user!.id, author: true })
    ])
    return reply.send({ data: { ...analytics, ratings, questions } })
  })

  // ── "Was this helpful?" and questions at a moment (#1505) ─────────────────
  // Like progress, nothing is written for a masquerade session: an admin
  // looking as someone else must not vote or ask in that person's name.
  const notWhileMasquerading = (reply: FastifyReply) =>
    reply.code(403).send({
      error: 'Not while viewing as someone else',
      code: 'HELP_VIDEO_MASQUERADE'
    })
  app.put('/:id/rating', async (req, reply) => {
    if (req.masqueradeAdminId) return notWhileMasquerading(reply)
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const body = (req.body ?? {}) as { helpful?: unknown }
    return reply.send({ data: await setRating(req.user!, video, body.helpful) })
  })
  app.get('/:id/questions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video, author } = await loadVideoForUser(req, id)
    const [data, rating] = await Promise.all([
      listQuestions(video, { userId: req.user!.id, author }),
      myRating(video, req.user!.id)
    ])
    return reply.send({ data, my_rating: rating })
  })
  app.post('/:id/questions', async (req, reply) => {
    if (req.masqueradeAdminId) return notWhileMasquerading(reply)
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const body = (req.body ?? {}) as { at_ms?: unknown; text?: unknown }
    return reply.code(201).send({ data: await askQuestion(req.user!, video, body) })
  })
  app.post('/:id/questions/:qid/answer', { preHandler: requireAuthor }, async (req, reply) => {
    const { id, qid } = req.params as { id: string; qid: string }
    const { video } = await loadVideoForUser(req, id)
    const body = (req.body ?? {}) as { answer?: unknown }
    return reply.send({ data: await answerQuestion(req.user!, video, qid, body) })
  })

  // ── "Up next" (#1530): what people in this role watched after this one ──
  app.get('/:id/next', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    return reply.send({ data: await nextForViewer(req, video) })
  })

  // ── Draft edits ───────────────────────────────────────────────────────────
  app.get('/:id/draft/edits', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const draft = await ensureDraft(video, req.user!)
    return reply.send({
      data: {
        ...serializeVersion(draft, {
          withRecorderData: true,
          // The sprite sheet (#1560) rides a draft ticket, like the draft stream.
          media: draftMedia(String(video.id), req.user!.id, sessionTag(req))
        }),
        source_kind: await sourceKindOfFile(draft.source_file),
        activity: await activityOfFile(draft.source_file),
        pointer: await pointerOfFile(draft.source_file)
      }
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

  // ── AI first draft (#1487) ────────────────────────────────────────────────
  // Suggestions only: chapters, callouts at the clicks, a title, a
  // description and the screens it explains. Nothing is written here; the
  // editor accepts each one through the draft save and the detail routes.
  app.post('/:id/draft/suggest', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const draft = await loadVersion(video.draft_version_id)
    if (!draft) {
      return reply.code(409).send({
        error: 'This video has no draft yet. Open it in the editor first.',
        code: 'HELP_VIDEO_NO_DRAFT'
      })
    }
    try {
      return reply.send({ data: await suggestDraftForVideo(video, draft, req.user!) })
    } catch (err) {
      if (err instanceof DraftError)
        return reply.code(err.statusCode).send({ error: err.message, code: err.code })
      throw err
    }
  })

  // ── Automatic captions (#1520) ───────────────────────────────────────────
  // A background transcription of the draft's sound; the result is a pending
  // set the editor shows until the author uses or discards it (24 h).
  const captionsReply = (reply: FastifyReply, err: unknown) => {
    if (err instanceof CaptionsError)
      return reply.code(err.statusCode).send({ error: err.message, code: err.code })
    throw err
  }
  app.get('/:id/captions/generate', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const job = video.draft_version_id ? await readCaptionJob(video.draft_version_id) : null
    const p = await captionProvider()
    return reply.send({
      data: {
        job: job && job.video_id === String(video.id).toLowerCase() ? job : null,
        provider: {
          kind: p.kind,
          model: p.kind === 'none' ? null : p.model,
          reason: p.kind === 'none' ? p.reason : null
        }
      }
    })
  })
  app.post('/:id/captions/generate', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const draft = await loadVersion(video.draft_version_id)
    if (!draft) {
      return reply.code(409).send({
        error: 'This video has no draft yet. Open it in the editor first.',
        code: 'HELP_VIDEO_NO_DRAFT'
      })
    }
    try {
      const job = await startCaptionJob({ id: String(video.id) }, String(draft.id), req.user!)
      await logActivity({
        action: 'help-video-captions',
        user: req.user!.id,
        collection: 'nivaro_help_videos',
        item: String(video.id).toLowerCase(),
        comment: `generate (${job.provider ?? 'unknown'})`
      })
      return reply.code(202).send({ data: job })
    } catch (err) {
      return captionsReply(reply, err)
    }
  })
  app.delete('/:id/captions/generate', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    if (video.draft_version_id) {
      const job = await readCaptionJob(video.draft_version_id)
      if (job && (job.status === 'queued' || job.status === 'running')) {
        return reply.code(409).send({
          error: 'Captions are still being generated',
          code: 'HELP_VIDEO_CAPTIONS_BUSY'
        })
      }
      await clearCaptionJob(video.draft_version_id)
    }
    return reply.code(204).send()
  })

  // ── Versions ──────────────────────────────────────────────────────────────
  app.post('/:id/publish', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    await publishVideo(
      video,
      req.user!,
      (req.body ?? {}) as { watch_again?: boolean; note?: unknown }
    )
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

  // ── Clips and GIFs (#1562) ────────────────────────────────────────────────
  // Anyone who can watch the video sees its clips (the list carries ticketed
  // links); only authors make and delete them. A viewer sees only clips of
  // the published version: one cut from the draft shows what is not
  // published yet (the media route refuses it the same way).
  const clipTicket = (req: FastifyRequest, videoId: string) =>
    mediaTicket(String(videoId).toLowerCase(), req.user!.id, 'p', Date.now(), sessionTag(req))
  app.get('/:id/clips', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video, author } = await loadVideoForUser(req, id)
    const t = clipTicket(req, String(video.id))
    const rows = (await listClips(String(video.id))).filter(
      (r) => author || clipOfPublished(r, video)
    )
    return reply.send({ data: rows.map((r) => serializeClip(r, t, { author })) })
  })
  app.post('/:id/clips', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const row = await createClip(
      {
        id: String(video.id),
        published_version_id: video.published_version_id,
        draft_version_id: video.draft_version_id
      },
      req.user!,
      (req.body ?? {}) as Parameters<typeof createClip>[2]
    )
    await logActivity({
      action: 'help-video-clip',
      user: req.user!.id,
      collection: 'nivaro_help_videos',
      item: String(video.id).toLowerCase(),
      comment: `${String(row.kind)} ${Number(row.start_ms)}–${Number(row.end_ms)} ms`
    })
    return reply
      .code(201)
      .send({ data: serializeClip(row, clipTicket(req, String(video.id)), { author: true }) })
  })
  app.delete('/:id/clips/:clipId', { preHandler: requireAuthor }, async (req, reply) => {
    const { id, clipId } = req.params as { id: string; clipId: string }
    const { video } = await loadVideoForUser(req, id)
    await deleteClip(req.user!, String(video.id), clipId)
    return reply.code(204).send()
  })

  // ── Background music (#1547) ──────────────────────────────────────────────
  // Authors only: the editor previews the mix itself; viewers always get the
  // render, which has the music baked in.
  app.get('/music', { preHandler: requireAuthor }, async (_req, reply) => {
    return reply.send({ data: await musicLibrary() })
  })
  app.get('/music/:key', { preHandler: requireAuthor }, async (req, reply) => {
    const { key } = req.params as { key: string }
    const t = /^[a-z][a-z0-9-]{0,39}$/i.test(key) ? await libraryTrackFile(key) : null
    if (!t) return reply.code(404).send({ error: 'Music not found', code: 'HELP_VIDEO_NOT_FOUND' })
    const s = await stat(t.path)
    return reply
      .header('Content-Type', t.mime)
      .header('Content-Length', String(s.size))
      .header('Cache-Control', 'private, max-age=3600')
      .send(createReadStream(t.path))
  })
  // Free music from Openverse: CC0 / public domain only, every call made by
  // the server (the browser never talks to a third-party host).
  const openverseReply = (reply: FastifyReply, err: unknown) => {
    if (err instanceof OpenverseError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code })
    }
    throw err
  }
  app.get('/music/openverse', { preHandler: requireAuthor }, async (req, reply) => {
    const q = req.query as { q?: string; page?: string }
    if (!openverseEnabled()) return reply.send({ data: { enabled: false, results: [] } })
    try {
      const r = await searchOpenverse(String(q.q ?? ''), Number(q.page ?? 1))
      return reply.send({ data: { enabled: true, ...r } })
    } catch (err) {
      return openverseReply(reply, err)
    }
  })
  app.get(
    '/music/openverse/:trackId/preview',
    { preHandler: requireAuthor },
    async (req, reply) => {
      const { trackId } = req.params as { trackId: string }
      try {
        const { type, bytes } = await previewBytes(await openverseTrack(trackId))
        return reply
          .header('Content-Type', type)
          .header('Cache-Control', 'private, max-age=600')
          .send(bytes)
      } catch (err) {
        return openverseReply(reply, err)
      }
    }
  )
  app.post('/:id/music/openverse', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const trackId = String((req.body as { openverse_id?: unknown } | null)?.openverse_id ?? '')
    try {
      const music = await importOpenverseMusic(req.user!, String(video.id), trackId)
      await logActivity({
        action: 'help-video-music-import',
        user: req.user!.id,
        collection: 'nivaro_help_videos',
        item: String(video.id).toLowerCase(),
        comment: `${music.name} · Openverse ${trackId} (${music.origin?.license ?? 'cc0'})`
      })
      return reply.code(201).send({ data: music })
    } catch (err) {
      return openverseReply(reply, err)
    }
  })
  app.get('/:id/music', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    return reply.send({ data: await listVideoMusic(String(video.id)) })
  })
  app.post('/:id/music', { preHandler: requireAuthor }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { video } = await loadVideoForUser(req, id)
    const file = await req.file({ limits: { fileSize: MUSIC_MAX_BYTES, files: 1 } })
    if (!file) return reply.code(400).send({ error: 'No file provided', code: 'MUSIC_EMPTY' })
    const music = await uploadMusic(req.user!, String(video.id), {
      filename: file.filename,
      stream: file.file,
      truncated: () => file.file.truncated
    })
    await logActivity({
      action: 'help-video-music-upload',
      user: req.user!.id,
      collection: 'nivaro_help_videos',
      item: String(video.id).toLowerCase(),
      comment: music.name
    })
    return reply.code(201).send({ data: music })
  })
  app.get('/:id/music/:musicId', { preHandler: requireAuthor }, async (req, reply) => {
    const { id, musicId } = req.params as { id: string; musicId: string }
    const { video } = await loadVideoForUser(req, id)
    const row = await videoMusicRow(String(video.id), musicId)
    const file = row?.file_id ? await getFile(String(row.file_id)) : undefined
    if (!file?.filename_disk) {
      return reply.code(404).send({ error: 'Music not found', code: 'HELP_VIDEO_NOT_FOUND' })
    }
    reply.header('Cache-Control', 'private, max-age=3600')
    return sendStoredObject(reply, file.filename_disk, {
      rangeHeader: req.headers.range,
      contentType: 'audio/mp4'
    })
  })
  app.delete('/:id/music/:musicId', { preHandler: requireAuthor }, async (req, reply) => {
    const { id, musicId } = req.params as { id: string; musicId: string }
    const { video } = await loadVideoForUser(req, id)
    await deleteVideoMusic(req.user!, String(video.id), musicId)
    return reply.code(204).send()
  })
}

/** Media routes (stream, captions, poster): <video>, <track> and <img> cannot
 *  send an Authorization header, so these sit in their own plugin WITHOUT the
 *  authenticate hook and are authorised by a signed ticket (?st=) instead.
 *  The ticket only names the person: every request re-checks that person's
 *  CURRENT status and role and the video's CURRENT visibility. Unknown,
 *  invisible, expired and unauthorised all answer the same 404. */
export async function helpVideoMediaRoutes(app: FastifyInstance) {
  async function resolve(req: FastifyRequest, opts: { needVersion?: boolean } = {}) {
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
    if (!version && opts.needVersion !== false) throw notFound
    return {
      video,
      version: version as NonNullable<typeof version>,
      draft: t.scope === 'd',
      author,
      userId: String(user.id)
    }
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

  // Download to the desktop: the file playback would give this person (see
  // pickDownloadFile), as an attachment. Viewers are refused when the video's
  // "Allow downloads" switch is off; authors and admins always may. Each
  // download (not each resumed range) is an activity row — data egress.
  app.get('/:id/download', async (req, reply) => {
    const { video, version, draft, author, userId } = await resolve(req)
    const q = req.query as { file?: string; source?: string }
    const file = q.file ?? 'video'
    if (!isDownloadFile(file)) {
      return reply
        .code(400)
        .send({ error: 'Unknown download', code: 'HELP_VIDEO_DOWNLOAD_UNKNOWN' })
    }
    if (!author && !downloadsAllowed(video.visibility)) {
      return reply.code(403).send({
        error: 'Downloads are turned off for this video.',
        code: 'HELP_VIDEO_DOWNLOAD_OFF'
      })
    }
    const pick = pickDownloadFile(version, { author, source: q.source === '1' })
    const log = (what: string) =>
      logActivity({
        action: 'help-video-download',
        user: userId,
        collection: 'nivaro_help_videos',
        item: String(video.id).toLowerCase(),
        comment: `v${Number(version.version)}${draft ? ' (draft)' : ''} · ${what}`
      })
    reply.header('Cache-Control', 'private, no-cache').header('X-Content-Type-Options', 'nosniff')
    if (file === 'video') {
      if (!pick) {
        return reply.code(409).send({
          error: 'This video is still being prepared. It can be downloaded once it is ready.',
          code: 'HELP_VIDEO_PROCESSING'
        })
      }
      const stored = await getFile(pick.fileId)
      if (!stored?.filename_disk) return reply.code(404).send({ error: 'Recording not found' })
      const name = safeDownloadName(video.title, videoExtension(pick.kind, stored.type))
      if (startsDownload(req.headers.range)) {
        void log(pick.kind === 'rendered' ? 'video (rendered MP4)' : 'video (original recording)')
      }
      return sendStoredObject(reply, stored.filename_disk, {
        rangeHeader: req.headers.range,
        contentType: pick.kind === 'rendered' ? 'video/mp4' : String(stored.type ?? 'video/webm'),
        disposition: contentDisposition(name)
      })
    }
    if (!hasCaptions(version)) {
      return reply
        .code(404)
        .send({ error: 'This video has no captions', code: 'HELP_VIDEO_NO_CAPTIONS' })
    }
    const vtt = captionsVtt(version, pick?.kind === 'source' ? 'source' : 'edited')
    const srt = file === 'captions.srt'
    void log(srt ? 'captions (.srt)' : 'captions (.vtt)')
    return reply
      .header(
        'Content-Type',
        srt ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8'
      )
      .header(
        'Content-Disposition',
        contentDisposition(safeDownloadName(video.title, srt ? 'srt' : 'vtt'))
      )
      .send(srt ? vttToSrt(vtt) : vtt)
  })

  // A plain-text transcript (#1529) for anyone who can watch: captions with
  // chapter headings. Not gated by "Allow downloads" — it is reading, not the
  // video file. Logged like a download (data egress).
  app.get('/:id/transcript.txt', async (req, reply) => {
    const { video, version, draft, author, userId } = await resolve(req)
    const pick = pickStreamFile(version, { author, forceSource: draft })
    const text = transcriptText(version, video.title, pick?.kind === 'source' ? 'source' : 'edited')
    if (!text) {
      return reply
        .code(404)
        .send({ error: 'This video has no captions', code: 'HELP_VIDEO_NO_CAPTIONS' })
    }
    void logActivity({
      action: 'help-video-download',
      user: userId,
      collection: 'nivaro_help_videos',
      item: String(video.id).toLowerCase(),
      comment: `v${Number(version.version)}${draft ? ' (draft)' : ''} · transcript (.txt)`
    })
    return reply
      .header('Cache-Control', 'private, no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header(
        'Content-Disposition',
        contentDisposition(safeDownloadName(`${video.title || 'Help video'} transcript`, 'txt'))
      )
      .send(text)
  })

  // A help-video package (see POST /packages). The link names the admin who
  // asked; that person must still be an active administrator now.
  app.get('/packages/:token', async (req, reply) => {
    const { token } = req.params as { token: string }
    const gone = () =>
      reply.code(404).send({
        error: 'This download link has expired. Export again.',
        code: 'HELP_VIDEO_PACKAGE_LINK_EXPIRED'
      })
    if (!isUuid(token)) return gone()
    const key = `${EXPORT_TICKET_PREFIX}${token}`
    // Single use: read and delete in one step so a second request finds nothing.
    const raw = await app.redis
      .multi()
      .get(key)
      .del(key)
      .exec()
      .then((r) => (r?.[0]?.[1] as string | null) ?? null)
      .catch(() => null)
    if (!raw) return gone()
    let ticket: { user?: string; ids?: string[]; tag?: string | null }
    try {
      ticket = JSON.parse(raw)
    } catch {
      return gone()
    }
    if (!isUuid(ticket.user) || !Array.isArray(ticket.ids)) return gone()
    if (ticket.tag) {
      // The session that asked has signed out: the link dies with it. Unlike
      // media tickets this fails CLOSED — an export is every chosen video.
      const sid = await app.redis.get(`${SIDTAG_PREFIX}${ticket.tag}`).catch(() => null)
      if (!sid) return gone()
      const revoked = await app.redis.exists(`${REVOKED_PREFIX}${sid}`).catch(() => 1)
      if (revoked) return gone()
    }
    const user = (await db('nivaro_users').where({ id: ticket.user, status: 'active' }).first()) as
      | (User & { is_redacted?: unknown })
      | undefined
    const role = user?.role
      ? await db('nivaro_roles').where({ id: user.role }).first('admin_access')
      : null
    if (!user || user.is_redacted === true || user.is_redacted === 1 || !role?.admin_access) {
      return gone()
    }
    const { stream, filename } = await exportPackageStream(ticket.ids, user)
    return reply
      .header('Content-Type', 'application/x-tar')
      .header('Content-Disposition', contentDisposition(filename))
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(stream)
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

  // The thumbnail sprite sheet (#1560) of the ticket's version: frames of the
  // ORIGINAL recording (nothing blurred or cut), so authors only.
  app.get('/:id/sprite', async (req, reply) => {
    const { version, author } = await resolve(req)
    if (!author)
      return reply.code(404).send({ error: 'Video not found', code: 'HELP_VIDEO_NOT_FOUND' })
    const file = version.sprite_file ? await getFile(String(version.sprite_file)) : undefined
    if (!file?.filename_disk) return reply.code(404).send({ error: 'No thumbnails yet' })
    reply.header('Cache-Control', 'private, no-cache')
    return sendStoredObject(reply, file.filename_disk, { contentType: 'image/jpeg' })
  })

  // A clip (#1562): the same people as the video (no version needed — the
  // clip row says which one it was cut from). A viewer gets only a clip of
  // the published version; one cut from the draft is 404 like the draft
  // itself. `download=1` saves it. Each fetch (not each resumed range) is an
  // activity row — data egress, like /:id/download.
  app.get('/:id/clips/:clipId', async (req, reply) => {
    const { video, author, userId } = await resolve(req, { needVersion: false })
    const { clipId } = req.params as { clipId: string }
    const q = req.query as { download?: string }
    const row = await clipRow(String(video.id), clipId)
    const visible = !!row && (author || clipOfPublished(row, video))
    const file =
      visible && row.status === 'ready' && row.file_id
        ? await getFile(String(row.file_id))
        : undefined
    if (!row || !file?.filename_disk) {
      return reply.code(404).send({ error: 'Clip not found', code: 'HELP_VIDEO_CLIP_NOT_FOUND' })
    }
    const gif = row.kind === 'gif'
    reply.header('Cache-Control', 'private, no-cache').header('X-Content-Type-Options', 'nosniff')
    const name = safeDownloadName(
      `${video.title || 'Help video'}${row.label ? ` - ${String(row.label)}` : ''}`,
      gif ? 'gif' : 'mp4'
    )
    if (startsDownload(req.headers.range)) {
      void logActivity({
        action: 'help-video-download',
        user: userId,
        collection: 'nivaro_help_videos',
        item: String(video.id).toLowerCase(),
        comment: `clip ${String(row.id).toLowerCase()} (${gif ? 'gif' : 'mp4'})${q.download === '1' ? ' · download' : ''}`
      })
    }
    return sendStoredObject(reply, file.filename_disk, {
      rangeHeader: req.headers.range,
      contentType: gif ? 'image/gif' : 'video/mp4',
      ...(q.download === '1' ? { disposition: contentDisposition(name) } : {})
    })
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
