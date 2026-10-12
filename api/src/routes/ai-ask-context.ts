import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  saveAskAttachment,
  takeUploadSlot,
  UPLOAD_WINDOW_SECONDS,
  UPLOADS_PER_WINDOW
} from '../services/ai-ask-attachments.js'
import { listRecordFiles } from '../services/ai-ask-context.js'
import { AskExtractError, extractForAsk } from '../services/ai-ask-extract.js'
import { ACCEPTED_EXTENSIONS, type ExtractedDocument } from '../services/document-extract.js'

/**
 * Ask AI from anywhere (#1835): the pieces of page context that need a
 * server round trip before a question is asked. Both routes answer only for
 * the caller — a dropped file is theirs alone, and a record's attachments
 * are listed only when they can read the record.
 */

const MAX_BYTES = 25 * 1024 * 1024
const NAME_RE = /^[A-Za-z0-9_]+$/

export async function aiAskContextRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ── #1842 — read a dropped file for the questions that follow ───────────
  // The text is kept for a day under an id only the caller can use; the file
  // itself is not stored anywhere.
  app.post('/attachments', async (req, reply) => {
    if (!(await takeUploadSlot(app, String(req.user!.id)))) {
      return reply.code(429).send({
        error: `At most ${UPLOADS_PER_WINDOW} files every ${UPLOAD_WINDOW_SECONDS / 60} minutes — try again shortly.`
      })
    }
    let file: { buffer: Buffer; filename: string; mimetype: string | null } | null = null
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') continue
        const buffer = await part.toBuffer()
        if (file) continue
        if (buffer.length > MAX_BYTES)
          return reply.code(413).send({ error: 'File exceeds 25MB limit' })
        file = { buffer, filename: part.filename || 'document', mimetype: part.mimetype || null }
      }
    } catch {
      return reply.code(400).send({ error: 'No file provided' })
    }
    if (!file) return reply.code(400).send({ error: 'No file provided' })
    if (!ACCEPTED_EXTENSIONS.some((ext) => file.filename.toLowerCase().endsWith(ext))) {
      return reply
        .code(400)
        .send({ error: `Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}` })
    }
    let doc: ExtractedDocument
    try {
      doc = await extractForAsk(file.buffer, file.filename, file.mimetype)
    } catch (err) {
      if (err instanceof AskExtractError)
        return reply.code(err.statusCode).send({ error: err.message })
      return reply.code(422).send({ error: 'This file could not be read' })
    }
    if (doc.text.trim().length < 40) {
      return reply.code(422).send({
        error:
          'No readable text in this file. A scanned PDF has no text layer — export it as text or a searchable PDF first.'
      })
    }
    const saved = await saveAskAttachment(app, {
      user: String(req.user!.id),
      name: file.filename.slice(0, 200),
      text: doc.text,
      method: doc.method,
      pages: doc.pages,
      truncated: doc.truncated
    })
    await logActivity({
      action: 'ai-ask-attachment',
      user: req.user!.id,
      comment: `${saved.name} · ${doc.method}${doc.pages ? ` · ${doc.pages} page(s)` : ''}`,
      req
    })
    return reply.send({
      data: {
        id: saved.id,
        name: saved.name,
        pages: saved.pages,
        truncated: saved.truncated,
        chars: saved.text.length
      }
    })
  })

  // ── #1993 — the files on a record the caller may ask about ──────────────
  app.get<{ Querystring: { collection?: string; id?: string } }>(
    '/record-files',
    async (req, reply) => {
      const collection = String(req.query.collection ?? '')
      const id = String(req.query.id ?? '')
      if (!NAME_RE.test(collection) || !id || /^(nivaro|directus)_/i.test(collection))
        return reply.code(400).send({ error: 'collection and id are required' })
      const files = await listRecordFiles(req.user!, { collection, id })
      if (files === null) return reply.code(404).send({ error: 'Record not found' })
      return reply.send({ data: files })
    }
  )
}
