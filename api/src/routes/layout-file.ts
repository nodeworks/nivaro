import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { getFields } from '../services/collections.js'
import { markConfigRead } from '../services/config-live.js'
import {
  fileToTarget,
  LAYOUT_FILE_MAX,
  LayoutFileError,
  layoutFileName,
  layoutToFile,
  layoutToYaml,
  parseLayoutYaml
} from '../services/layout-file.js'
import { loadLayoutBundle } from '../services/layout-ops.js'
import { isRowId } from '../services/layout-patch.js'

/**
 * Layout as a file (#3189), under /collection-layouts (admin, like the editor):
 *  - GET  /:id/file           { data: { filename, text } } — the saved layout as YAML;
 *                             ?download=1 answers the YAML itself as an attachment (curl into git)
 *  - POST /:id/file/parse     { text } → { data: { target, warnings, source } } — read-only:
 *                             the layout the file describes, for the editor to preview and apply
 *                             as one draft step (saved through POST /:id/ops with base_rev)
 */

type Row = Record<string, unknown>

async function widgetNames(): Promise<Map<number, string>> {
  try {
    if (!(await db.schema.hasTable('nivaro_widgets'))) return new Map()
    const rows = (await db('nivaro_widgets').select('id', 'name')) as Row[]
    return new Map(rows.map((r) => [Number(r.id), String(r.name ?? '')]))
  } catch {
    return new Map()
  }
}

async function collectionLayouts(collection: string) {
  const rows = (await db('nivaro_collection_layouts')
    .where({ collection })
    .select('id', 'name', 'slug')) as Row[]
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name == null ? null : String(r.name),
    slug: r.slug == null ? null : String(r.slug)
  }))
}

export async function registerLayoutFileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id/file', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { download } = req.query as { download?: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    const bundle = await loadLayoutBundle(db, Number(id))
    if (!bundle) return reply.code(404).send({ error: 'Not found' })
    const collection = String(bundle.layout.collection)
    const [layouts, widgets] = await Promise.all([collectionLayouts(collection), widgetNames()])
    const doc = layoutToFile(bundle, {
      layouts: new Map(layouts.map((l) => [l.id, l.name ?? ''])),
      widgets
    })
    const text = layoutToYaml(doc)
    const filename = layoutFileName(bundle.layout)
    if (download === '1' || download === 'true')
      return reply
        .header('Content-Type', 'application/yaml; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(text)
    return reply.send({ data: { filename, text, rev: bundle.rev } })
  })

  app.post(
    '/:id/file/parse',
    { preHandler: requireAdmin, bodyLimit: LAYOUT_FILE_MAX * 2 },
    async (req, reply) => {
      // Reads only: never flush metadata caches or push config:update.
      markConfigRead(req)
      const { id } = req.params as { id: string }
      if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
      const { text } = (req.body ?? {}) as { text?: unknown }
      if (typeof text !== 'string') return reply.code(400).send({ error: 'text is required' })
      const current = await loadLayoutBundle(db, Number(id))
      if (!current) return reply.code(404).send({ error: 'Not found' })
      const collection = String(current.layout.collection)
      try {
        const doc = parseLayoutYaml(text)
        const [layouts, widgets, fields] = await Promise.all([
          collectionLayouts(collection),
          widgetNames(),
          getFields(collection).catch(() => [])
        ])
        const result = fileToTarget(doc, {
          current,
          layouts,
          widgets,
          fields: new Set(fields.map((f) => String(f.field)))
        })
        return reply.send({ data: result })
      } catch (err) {
        if (err instanceof LayoutFileError)
          return reply.code(400).send({ error: err.message, problems: err.problems })
        throw err
      }
    }
  )
}
