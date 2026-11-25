import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam } from '../services/hub/apps.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import {
  deleteTemplate,
  listTemplates,
  patchTemplate,
  readTemplate,
  readTemplateBundle,
  TEMPLATE_MAX_BYTES,
  TEMPLATES,
  TemplateError,
  uploadTemplate
} from '../services/hub/templates/library.js'

/**
 * Hub app templates (enhancement 24), /api/hub/templates — administrators only, Hub mode only.
 *
 *   GET    /templates[?archived=1]   the library (manifest + counts, never the bundle)
 *   GET    /templates/:id            one template
 *   GET    /templates/:id/bundle     the stored package as a download (to install it by hand)
 *   POST   /templates                {bundle, name?, description?, version?} → 201 the template
 *   PATCH  /templates/:id            {name?, description?, archived?}
 *   DELETE /templates/:id            only while no creation used it (409 TEMPLATE_IN_USE)
 *
 * Every write is logged (hub-template-upload|update|delete). A template is picked on Create app
 * (template_id) and installed by the creation's last step (services/hub/create/template-step.ts).
 * The library belongs to the Hub, not to an environment: MOVE_OPEN never applies to it.
 */

const UPLOAD_BODY_LIMIT = TEMPLATE_MAX_BYTES + 2 * 1024 * 1024

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (err) {
    if (err instanceof TemplateError) return fail(reply, err.status, err.code, err.message)
    throw err
  }
}

export async function hubTemplateRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  app.get('/templates', { preHandler: requireAdmin }, async (req) => {
    const archived = (req.query as { archived?: string } | undefined)?.archived === '1'
    return { data: await listTemplates({ archived }) }
  })

  app.get('/templates/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const t = id === null ? null : await readTemplate(id)
    if (!t) return fail(reply, 404, 'NOT_FOUND', 'No such template.')
    return { data: t }
  })

  app.get('/templates/:id/bundle', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const t = id === null ? null : await readTemplateBundle(id)
      if (!t) return fail(reply, 404, 'NOT_FOUND', 'No such template.')
      const file = `${t.name}-${t.version}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100)
      reply.header('Content-Disposition', `attachment; filename="${file}.blueprint.json"`)
      reply.header('Cache-Control', 'no-store')
      return reply.type('application/json').send(JSON.stringify(t.bundle))
    })
  )

  app.post(
    '/templates',
    { preHandler: requireAdmin, bodyLimit: UPLOAD_BODY_LIMIT },
    async (req, reply) =>
      guarded(reply, async () => {
        const b = body(req)
        const t = await uploadTemplate(
          { bundle: b.bundle, name: b.name, description: b.description, version: b.version },
          userId(req)
        )
        await logActivity({
          action: 'hub-template-upload',
          user: userId(req),
          collection: TEMPLATES,
          item: String(t.id),
          comment: `${t.name} ${t.version}`.slice(0, 400),
          req
        })
        return reply.code(201).send({ data: t })
      })
  )

  app.patch('/templates/:id', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      if (id === null) return fail(reply, 404, 'NOT_FOUND', 'No such template.')
      const b = body(req)
      const t = await patchTemplate(id, {
        name: b.name,
        description: b.description,
        archived: b.archived
      })
      await logActivity({
        action: 'hub-template-update',
        user: userId(req),
        collection: TEMPLATES,
        item: String(id),
        comment: ['name', 'description', 'archived']
          .filter((k) => b[k] !== undefined)
          .join(', ')
          .slice(0, 400),
        req
      })
      return { data: t }
    })
  )

  app.delete('/templates/:id', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      if (id === null) return fail(reply, 404, 'NOT_FOUND', 'No such template.')
      const t = await readTemplate(id)
      await deleteTemplate(id)
      await logActivity({
        action: 'hub-template-delete',
        user: userId(req),
        collection: TEMPLATES,
        item: String(id),
        comment: t ? `${t.name} ${t.version}` : undefined,
        req
      })
      return reply.code(204).send()
    })
  )
}
