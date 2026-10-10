import type { FastifyInstance, FastifyReply } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  appendNotebookEntry,
  cleanAtMs,
  cleanNoteText,
  copyNoteToIssue,
  deleteNote,
  fmtOffset,
  getNote,
  insertNote,
  isUuid,
  linkedIssues,
  listNotes,
  NOTES_TABLE,
  notebookEntryText,
  notesReady,
  recordingExists,
  updateNote
} from '../services/session-replay-notes.js'

/**
 * Timestamped notes on a recording (#1363). Admin-only, like every read of a
 * recording: a recording is someone's session, and so is what is said about it.
 *
 *   GET    /session-recordings/:id/notes                 → { data: notes[], targets }
 *   POST   /session-recordings/:id/notes                 { at_ms, text } → 201 { data }
 *   PATCH  /session-recordings/:id/notes/:noteId         { at_ms?, text? }  (its author)
 *   DELETE /session-recordings/:id/notes/:noteId
 *   POST   /session-recordings/:id/notes/:noteId/copy    { issue_id } | { investigation_id }
 *
 * `targets` names where a note can be copied: the issues linked to this
 * recording (nivaro_issues.recording_id) and the open investigation notebooks
 * of the Traffic Map (#1212, self-hosted only — the map is off in cloud mode).
 * A copy carries a deep link back to the second: /session-replays?recording=…&t=…
 */

const NOT_FOUND = { error: 'No recording with that id', code: 'RECORDING_NOT_FOUND' }
const NOTE_NOT_FOUND = { error: 'No note with that id on this recording', code: 'NOTE_NOT_FOUND' }
const NOT_READY = {
  error: 'Replay notes need migration 423 — run migrations on this instance first',
  code: 'NOTES_NOT_READY'
}

type IdParams = { Params: { id: string } }
type NoteParams = { Params: { id: string; noteId: string } }

/** The notebook store is loaded lazily: the Traffic Map is optional here. */
async function notebooks() {
  if (process.env.CLOUD_META_DB_URL) return null
  const store = await import('../services/traffic-inspect/actions-store.js')
  if (!(await store.investigationsReady())) return null
  const { NOTES_MAX } = await import('../services/traffic-inspect/actions-logic.js')
  return { ...store, NOTES_MAX }
}

/** True when the recording exists and the table is there; otherwise the reply is sent. */
async function guard(id: string, reply: FastifyReply): Promise<boolean> {
  if (!isUuid(id)) {
    reply.code(404).send(NOT_FOUND)
    return false
  }
  if (!(await notesReady())) {
    reply.code(503).send(NOT_READY)
    return false
  }
  if (!(await recordingExists(id))) {
    reply.code(404).send(NOT_FOUND)
    return false
  }
  return true
}

export async function sessionReplayNotesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<IdParams>('/:id/notes', async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send(NOT_FOUND)
    if (!(await notesReady())) {
      return reply.send({ data: [], targets: { issues: [], investigations: [] }, ready: false })
    }
    const [notes, issues, nb] = await Promise.all([
      listNotes(req.params.id),
      linkedIssues(req.params.id),
      notebooks().catch(() => null)
    ])
    const investigations = nb
      ? (await nb.listInvestigations()).map((i) => ({
          id: i.id,
          title: i.title,
          updated_at: i.updated_at,
          created_by_name: i.created_by_name
        }))
      : []
    return reply.send({ data: notes, targets: { issues, investigations }, ready: true })
  })

  app.post<IdParams & { Body: { at_ms?: unknown; text?: unknown } }>(
    '/:id/notes',
    async (req, reply) => {
      if (!(await guard(req.params.id, reply))) return reply
      const atMs = cleanAtMs(req.body?.at_ms)
      if (atMs == null) {
        return reply
          .code(400)
          .send({ error: 'at_ms must be an offset into the recording', code: 'AT_INVALID' })
      }
      const text = cleanNoteText(req.body?.text)
      if (!text) {
        return reply.code(400).send({ error: 'The note is empty', code: 'TEXT_INVALID' })
      }
      const note = await insertNote({
        recording: req.params.id,
        at_ms: atMs,
        text,
        user: req.user?.id ?? null
      })
      await logActivity({
        action: 'session-replay-note',
        user: req.user?.id,
        collection: NOTES_TABLE,
        item: note.id,
        comment: `Note at ${fmtOffset(atMs)} on recording ${req.params.id}`,
        req
      })
      return reply.code(201).send({ data: note })
    }
  )

  app.patch<NoteParams & { Body: { at_ms?: unknown; text?: unknown } }>(
    '/:id/notes/:noteId',
    async (req, reply) => {
      if (!(await guard(req.params.id, reply))) return reply
      if (!isUuid(req.params.noteId)) return reply.code(404).send(NOTE_NOT_FOUND)
      const note = await getNote(req.params.id, req.params.noteId)
      if (!note) return reply.code(404).send(NOTE_NOT_FOUND)
      // Words stay under the name of whoever wrote them.
      if (!note.user || note.user.toLowerCase() !== String(req.user?.id ?? '').toLowerCase()) {
        return reply
          .code(403)
          .send({ error: 'Only the author can change a note', code: 'NOTE_FORBIDDEN' })
      }
      const patch: { at_ms?: number; text?: string } = {}
      if (req.body?.at_ms !== undefined) {
        const atMs = cleanAtMs(req.body.at_ms)
        if (atMs == null) {
          return reply
            .code(400)
            .send({ error: 'at_ms must be an offset into the recording', code: 'AT_INVALID' })
        }
        patch.at_ms = atMs
      }
      if (req.body?.text !== undefined) {
        const text = cleanNoteText(req.body.text)
        if (!text) return reply.code(400).send({ error: 'The note is empty', code: 'TEXT_INVALID' })
        patch.text = text
      }
      if (Object.keys(patch).length > 0) await updateNote(req.params.id, note.id, patch)
      return reply.send({ data: await getNote(req.params.id, note.id) })
    }
  )

  app.delete<NoteParams>('/:id/notes/:noteId', async (req, reply) => {
    if (!(await guard(req.params.id, reply))) return reply
    if (!isUuid(req.params.noteId)) return reply.code(404).send(NOTE_NOT_FOUND)
    const note = await getNote(req.params.id, req.params.noteId)
    if (!note) return reply.code(404).send(NOTE_NOT_FOUND)
    await deleteNote(req.params.id, note.id)
    await logActivity({
      action: 'session-replay-note-delete',
      user: req.user?.id,
      collection: NOTES_TABLE,
      item: note.id,
      comment: `Note at ${fmtOffset(note.at_ms)} on recording ${req.params.id} deleted`,
      req
    })
    return reply.send({ data: { deleted: true } })
  })

  app.post<NoteParams & { Body: { issue_id?: unknown; investigation_id?: unknown } }>(
    '/:id/notes/:noteId/copy',
    async (req, reply) => {
      if (!(await guard(req.params.id, reply))) return reply
      if (!isUuid(req.params.noteId)) return reply.code(404).send(NOTE_NOT_FOUND)
      const note = await getNote(req.params.id, req.params.noteId)
      if (!note) return reply.code(404).send(NOTE_NOT_FOUND)
      const issueId = req.body?.issue_id
      const investigationId = req.body?.investigation_id
      if ((issueId == null) === (investigationId == null)) {
        return reply
          .code(400)
          .send({ error: 'Name one issue_id or one investigation_id', code: 'TARGET_INVALID' })
      }

      if (issueId != null) {
        const n = Number(issueId)
        // Only an issue this recording is linked to: the note is about this session.
        const linked = Number.isInteger(n)
          ? (await linkedIssues(req.params.id)).find((i) => i.id === n)
          : undefined
        if (!linked) {
          return reply.code(404).send({
            error: 'That issue is not linked to this recording',
            code: 'ISSUE_NOT_LINKED'
          })
        }
        const commentId = await copyNoteToIssue(note, linked.id, String(req.user?.id))
        await logActivity({
          action: 'session-replay-note-copy',
          user: req.user?.id,
          collection: 'nivaro_issues',
          item: String(linked.id),
          comment: `Replay note at ${fmtOffset(note.at_ms)} copied to issue #${linked.id}`,
          req
        })
        return reply.send({ data: { target: 'issue', id: linked.id, comment_id: commentId } })
      }

      const nb = await notebooks().catch(() => null)
      if (!nb) {
        return reply.code(503).send({
          error: 'Investigation notebooks are not available on this instance',
          code: 'NOTEBOOKS_UNAVAILABLE'
        })
      }
      const invId = String(investigationId)
      const inv = isUuid(invId) ? await nb.getInvestigation(invId) : null
      if (!inv) {
        return reply
          .code(404)
          .send({ error: 'No investigation with that id here', code: 'INVESTIGATION_NOT_FOUND' })
      }
      const notes = appendNotebookEntry(inv.notes, notebookEntryText(note), nb.NOTES_MAX)
      if (notes == null) {
        return reply.code(409).send({
          error: 'That notebook is full — trim its notes first',
          code: 'NOTEBOOK_FULL'
        })
      }
      await nb.updateInvestigation(inv.id, { notes })
      await logActivity({
        action: 'session-replay-note-copy',
        user: req.user?.id,
        collection: nb.INVESTIGATIONS_TABLE,
        item: inv.id,
        comment: `Replay note at ${fmtOffset(note.at_ms)} copied to "${inv.title}"`.slice(0, 240),
        req
      })
      return reply.send({ data: { target: 'investigation', id: inv.id } })
    }
  )
}
