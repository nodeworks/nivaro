/**
 * PDF template CRUD + render.
 *
 * Registration (routes/index.ts):
 *   await app.register(pdfTemplatesRoutes, { prefix: '/pdf-templates' });
 *
 * ItemEdit contract:
 *   GET  /api/pdf-templates?collection=X       → { data: PdfTemplate[] } (templates for X or global)
 *   POST /api/pdf-templates/:id/render         → body { collection, item_id } → application/pdf
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { generatePdf } from '../services/pdf.js'
import { can } from '../services/permissions.js'

interface PdfTemplate {
  id: string
  name: string
  collection: string | null
  template: string
  created_by: string | null
  created_at: Date
  updated_at: Date | null
}

export async function pdfTemplatesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List — available to any authenticated user (ItemEdit needs it).
  app.get('/', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Unauthorized' })
    const { collection } = req.query as { collection?: string }
    const q = db<PdfTemplate>('nivaro_pdf_templates').orderBy('name', 'asc')
    if (collection) {
      q.where((qb) => {
        qb.where({ collection }).orWhereNull('collection')
      })
    }
    return reply.send({ data: await q })
  })

  app.get('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db<PdfTemplate>('nivaro_pdf_templates').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: row })
  })

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<PdfTemplate>
    if (!body.name || !body.template) {
      return reply.code(400).send({ error: 'name and template are required' })
    }
    const [id] = (await db('nivaro_pdf_templates')
      .insert({
        name: body.name,
        collection: body.collection ?? null,
        template: body.template,
        designer_config: (body as Record<string, unknown>).designer_config
          ? JSON.stringify((body as Record<string, unknown>).designer_config)
          : null,
        created_by: req.user?.id ?? null,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id')) as unknown as [string | { id: string }]
    const newId = typeof id === 'object' && id !== null ? (id as { id: string }).id : id
    const row = await db<PdfTemplate>('nivaro_pdf_templates').where({ id: newId }).first()
    await logActivity({
      action: 'create',
      collection: 'nivaro_pdf_templates',
      item: String(newId),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: row })
  })

  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as Partial<PdfTemplate>
    const existing = await db<PdfTemplate>('nivaro_pdf_templates').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if ('name' in body) patch.name = body.name
    if ('collection' in body) patch.collection = body.collection ?? null
    if ('template' in body) patch.template = body.template
    if ('designer_config' in (body as Record<string, unknown>)) {
      const dc = (body as Record<string, unknown>).designer_config
      patch.designer_config = dc ? JSON.stringify(dc) : null
    }
    await db('nivaro_pdf_templates').where({ id }).update(patch)

    const row = await db<PdfTemplate>('nivaro_pdf_templates').where({ id }).first()
    await logActivity({
      action: 'update',
      collection: 'nivaro_pdf_templates',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.send({ data: row })
  })

  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await db('nivaro_pdf_templates').where({ id }).delete()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_pdf_templates',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // Render a template against an item row → application/pdf
  app.post('/:id/render', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Unauthorized' })
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { collection?: string; item_id?: string | number }

    const tpl = await db<PdfTemplate>('nivaro_pdf_templates').where({ id }).first()
    if (!tpl) return reply.code(404).send({ error: 'Template not found' })

    const collection = tpl.collection ?? body.collection
    if (!collection || body.item_id === undefined || body.item_id === null || body.item_id === '') {
      return reply.code(400).send({ error: 'collection and item_id are required' })
    }
    if (collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'System collections cannot be rendered' })
    }
    if (tpl.collection && body.collection && body.collection !== tpl.collection) {
      return reply.code(400).send({ error: `Template is bound to collection "${tpl.collection}"` })
    }

    const allowed = await can(req.user, 'read', collection)
    if (!allowed) return reply.code(403).send({ error: 'Forbidden' })

    const item = (await db(collection)
      .where({ id: body.item_id })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (!item) return reply.code(404).send({ error: 'Item not found' })

    // Designer table blocks loop `children.<alias>` — fetch child rows only
    // when the template actually references them.
    const children: Record<string, Array<Record<string, unknown>>> = {}
    if (String(tpl.template).includes('children.')) {
      try {
        const rels = (await db('nivaro_relations')
          .where({ one_collection: collection })
          .whereNull('junction_field')
          .whereNotNull('many_collection')
          .select('one_field', 'many_collection', 'many_field')) as Array<{
          one_field: string | null
          many_collection: string
          many_field: string
        }>
        for (const rel of rels) {
          const alias = rel.one_field ?? rel.many_collection
          if (!alias || !String(tpl.template).includes(`children.${alias}`)) continue
          children[alias] = (await db(rel.many_collection)
            .where(rel.many_field, body.item_id)
            .limit(200)
            .select('*')
            .catch(() => [])) as Array<Record<string, unknown>>
        }
      } catch {
        /* a broken relation renders an empty table, never a 500 */
      }
    }

    const pdf = await generatePdf(tpl.template, {
      ...item,
      item,
      children,
      collection,
      generated_at: new Date().toISOString()
    })

    // Document generation is a data egress event — same audit class as the
    // backup/content exports.
    await logActivity({
      action: 'pdf-render',
      collection,
      item: String(body.item_id),
      user: req.user.id,
      req,
      comment: tpl.name
    })

    const safeName = tpl.name.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || 'document'
    return reply
      .header('Content-Type', 'application/pdf')
      .header(
        'Content-Disposition',
        `attachment; filename="${safeName}-${String(body.item_id)}.pdf"`
      )
      .send(pdf)
  })
}
