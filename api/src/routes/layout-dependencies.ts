import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import {
  DEPENDENCY_GROUPS,
  declaringExtensions,
  dependencyNodes,
  extensionDependenciesOf
} from '../services/layout-dependencies.js'
import { isRowId } from '../services/layout-patch.js'
import { findLayoutReferences } from '../services/layout-references.js'

/**
 * GET /collection-layouts/:id/dependencies (#2613) — what relies on one layout,
 * with what each reference finds it by and which change (link name, kind,
 * delete) would break it. Drawn as a diagram before rename / retype / delete.
 */
export async function layoutDependencyRoutes(app: FastifyInstance) {
  app.get('/:id/dependencies', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    const layout = (await db('nivaro_collection_layouts')
      .where({ id: Number(id) })
      .first('id', 'collection', 'name', 'slug', 'layout_type')) as
      | {
          id: number
          collection: string
          name: string
          slug: string | null
          layout_type: string | null
        }
      | undefined
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    const refs = (await findLayoutReferences(layout.collection)).get(Number(layout.id)) ?? []
    const ext = extensionDependenciesOf({
      id: Number(layout.id),
      collection: layout.collection,
      slug: layout.slug
    })
    const declaring = declaringExtensions()
    return reply.send({
      data: {
        layout: {
          id: Number(layout.id),
          collection: layout.collection,
          name: layout.name,
          slug: layout.slug,
          layout_type: layout.layout_type ?? 'grouped'
        },
        groups: DEPENDENCY_GROUPS.map(({ id: gid, label }) => ({ id: gid, label })),
        nodes: dependencyNodes(refs, ext),
        extensions: {
          declaring: declaring.length,
          // Honest: code that never declared what it opens cannot be checked.
          note: declaring.length
            ? `Extensions are checked only for layouts they declare (${declaring.length} declare some).`
            : 'Extension code is not checked: no loaded extension declares the layouts it opens.'
        }
      }
    })
  })
}
