import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import {
  COMPOSE_ACCEPT,
  COMPOSE_MAX_BYTES,
  type ComposeMode,
  ComposeRefusal,
  composeAsk,
  composeForm,
  documentContent,
  loadComposeContext,
  providerReadsPdf,
  type UploadedDoc
} from '../services/ai-design/form-compose.js'
import { cleanMeaningRequest, suggestByMeaning } from '../services/ai-design/form-meaning.js'
import {
  planSlim,
  roleFieldChanges,
  SLIM_DAYS,
  SLIM_MIN_REVISIONS
} from '../services/ai-design/form-slim.js'
import { AiUnavailableError, cleanText, titleCase } from '../services/ai-design/model.js'
import { loadLayoutBundle } from '../services/layout-ops.js'

/**
 * AI form building (#2668 #2669 #2670 #2671 #2672) — registered inside
 * aiDesignRoutes, so admin only. Every route PROPOSES: the editor turns the
 * answer into layout ops on its draft and applies them as one undo step that
 * the admin still saves. Nothing here writes a layout.
 */

const COLLECTION_RE = /^[A-Za-z0-9_]{1,64}$/

function modelFailure(reply: FastifyReply, err: unknown, what: string) {
  if (err instanceof ComposeRefusal) return reply.code(422).send({ error: err.message })
  const status = (err as { statusCode?: number }).statusCode
  if (status === 503) return reply.code(503).send({ error: new AiUnavailableError().message })
  return reply
    .code(502)
    .send({ error: `The AI could not ${what}: ${(err as Error).message}`.slice(0, 400) })
}

async function composeContextFor(reply: FastifyReply, collection: unknown) {
  const col = typeof collection === 'string' ? collection : ''
  if (!COLLECTION_RE.test(col) || /^(nivaro|directus)_/i.test(col)) {
    reply.code(400).send({ error: 'collection is required' })
    return null
  }
  const ctx = await loadComposeContext(col)
  if (!ctx) {
    reply.code(404).send({ error: 'Collection not found' })
    return null
  }
  if (ctx.fields.length === 0) {
    reply.code(422).send({ error: 'This collection has no fields to build a form from' })
    return null
  }
  return ctx
}

export async function aiDesignFormRoutes(app: FastifyInstance) {
  // ── Form from a description (#2668) ────────────────────────────────────────

  app.post<{ Body: { collection?: string; text?: string } }>(
    '/layouts/compose',
    async (req, reply) => {
      const text = cleanText(req.body?.text, 2000)
      if (!text || text.length < 6)
        return reply.code(400).send({ error: 'Describe the form in a sentence or two' })
      const ctx = await composeContextFor(reply, req.body?.collection)
      if (!ctx) return
      const ask = await composeAsk('chat')
      if (!ask) return reply.code(503).send({ error: new AiUnavailableError().message })
      try {
        const form = await composeForm(ask, ctx, { mode: 'describe', text })
        return reply.send({ data: { form } })
      } catch (err) {
        return modelFailure(reply, err, 'build the form')
      }
    }
  )

  // ── Form from a picture / PDF (#2669) or a process document (#2670) ────────
  // multipart: collection, mode (picture | sop), note (optional), file. The
  // file is read in memory and never stored.

  app.post('/layouts/compose/file', async (req, reply) => {
    const fields: Record<string, string> = {}
    let doc: UploadedDoc | null = null
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value ?? '').trim()
          continue
        }
        const buffer = await part.toBuffer()
        if (doc) continue
        if (buffer.length > COMPOSE_MAX_BYTES)
          return reply.code(413).send({ error: 'The file is larger than 10 MB' })
        doc = { buffer, filename: part.filename || 'document', mimetype: part.mimetype || null }
      }
    } catch {
      return reply.code(400).send({ error: 'Could not read the upload' })
    }
    if (!doc) return reply.code(400).send({ error: 'Choose a file' })
    const name = doc.filename.toLowerCase()
    if (!COMPOSE_ACCEPT.some((ext) => name.endsWith(ext)))
      return reply
        .code(400)
        .send({ error: `Unsupported file type. Accepted: ${COMPOSE_ACCEPT.join(', ')}` })
    const mode: ComposeMode = fields.mode === 'sop' ? 'sop' : 'picture'
    const ctx = await composeContextFor(reply, fields.collection)
    if (!ctx) return
    const ask = await composeAsk('chat')
    if (!ask) return reply.code(503).send({ error: new AiUnavailableError().message })
    try {
      const content = await documentContent(doc, { pdfBlocks: await providerReadsPdf() })
      const form = await composeForm(ask, ctx, {
        mode,
        text: cleanText(fields.note, 500),
        doc: content.blocks
      })
      return reply.send({
        data: {
          form,
          read_as: content.method,
          states: mode === 'sop' ? ctx.states : undefined
        }
      })
    } catch (err) {
      return modelFailure(reply, err, 'read the document')
    } finally {
      doc = null
    }
  })

  // ── Lighter version for a role (#2671) ─────────────────────────────────────
  // Mined from revisions; no model call, so it works without AI configured.

  app.post<{ Params: { id: string }; Body: { role_id?: string } }>(
    '/layouts/:id/slim',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const roleId = typeof req.body?.role_id === 'string' ? req.body.role_id : ''
      if (!roleId) return reply.code(400).send({ error: 'Pick a role' })
      const bundle = await loadLayoutBundle(db, id)
      if (!bundle) return reply.code(404).send({ error: 'Layout not found' })
      const layout = bundle.layout as Record<string, unknown>
      if (layout.parent_layout_id)
        return reply.code(409).send({
          error:
            'This layout already inherits from another one. Make the lighter version from that one.'
        })
      if (layout.layout_type && layout.layout_type !== 'grouped')
        return reply.code(400).send({ error: 'Lighter versions are made from forms' })
      const role = (await db('nivaro_roles').where({ id: roleId }).first('id', 'name')) as
        | { id: string; name: string }
        | undefined
      if (!role) return reply.code(404).send({ error: 'Role not found' })
      const collection = bundle.layout.collection
      const [changes, fieldRows] = await Promise.all([
        roleFieldChanges(collection, String(role.id), req.user?.id),
        db('nivaro_fields').where({ collection }).select('field', 'label', 'required') as Promise<
          Array<{ field: string; label: string | null; required: unknown }>
        >
      ])
      const base = {
        role: { id: String(role.id), name: String(role.name) },
        parent: { id, name: String(layout.name ?? '') },
        days: SLIM_DAYS,
        revisions: changes.revisions,
        people: changes.people
      }
      if (changes.revisions < SLIM_MIN_REVISIONS)
        return reply.send({ data: { ...base, plan: null } })
      const labels = new Map(
        fieldRows.map((f) => [String(f.field), cleanText(f.label, 80) ?? titleCase(f.field)])
      )
      const required = new Set(
        fieldRows.filter((f) => f.required === true || f.required === 1).map((f) => f.field)
      )
      const plan = planSlim(bundle, changes, {
        labelOf: (f) => labels.get(f) ?? titleCase(f),
        required
      })
      return reply.send({
        data: {
          ...base,
          plan,
          name: `${String(layout.name ?? 'Form')} (${role.name})`.slice(0, 80)
        }
      })
    }
  )

  // ── Sections by meaning (#2672) ────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { groups?: unknown; fields?: unknown } }>(
    '/layouts/:id/sections-by-meaning',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const layout = (await db('nivaro_collection_layouts').where({ id }).first('collection')) as
        | { collection: string }
        | undefined
      if (!layout) return reply.code(404).send({ error: 'Layout not found' })
      const ctx = await loadComposeContext(layout.collection)
      if (!ctx) return reply.code(404).send({ error: 'Collection not found' })
      const { groups, fields } = cleanMeaningRequest(req.body as never, ctx)
      if (groups.length === 0)
        return reply.code(400).send({ error: 'The form has no sections to place fields in' })
      if (fields.length === 0) return reply.send({ data: { suggestions: [], dropped: 0 } })
      const ask = await composeAsk('chat')
      if (!ask) return reply.code(503).send({ error: new AiUnavailableError().message })
      try {
        return reply.send({ data: await suggestByMeaning(ask, ctx, groups, fields) })
      } catch (err) {
        return modelFailure(reply, err, 'place the fields')
      }
    }
  )
}
