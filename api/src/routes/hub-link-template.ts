import type { FastifyInstance } from 'fastify'
import { readTemplateRun, startTemplateInstall } from '../services/hub-link/template-install.js'

/** A template bundle (an App Blueprint package) is JSON; the Hub keeps them under 8 MB. */
export const HUB_TEMPLATE_BODY_LIMIT = 10 * 1024 * 1024

/**
 * The template install over the hub link (Hub enhancement 24) — registered by hubLinkRoutes inside
 * its plugin, so the HUB_TOKEN bearer check (and the 429 brake) of that plugin applies; never
 * mounted where hub link routes are not (no HUB_TOKEN, cloud, a shared deployment). Frozen by
 * maintenance and refused once retired (retire.ts isHubLinkAppWrite).
 *
 *   POST /template {bundle, digest, template?: {name, version}}
 *     → 202 {install_id, status: 'running', joined}
 *     | 400 BAD_BUNDLE / BAD_DIGEST / BAD_SHAPE / TOO_MANY_PARTS
 *     | 409 APP_NOT_EMPTY {collections} / TEMPLATE_INSTALLING | 503 REDIS_UNAVAILABLE
 *   GET  /template/:id → {install_id, status, report?, parts?, review?, code?} | 404 UNKNOWN_INSTALL
 *
 * Nothing answered carries driver text (services/hub-link/template-install.ts publicReport).
 */
export function hubLinkTemplateRoute(app: FastifyInstance): void {
  app.post('/template', { bodyLimit: HUB_TEMPLATE_BODY_LIMIT }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const out = await startTemplateInstall(req.body, app.log)
      if (!out.ok)
        return reply.code(out.status).send({
          statusCode: out.status,
          error: out.message,
          message: out.message,
          code: out.code,
          ...(out.extra ? { collections: out.extra } : {})
        })
      return reply
        .code(202)
        .send({ install_id: out.run.install_id, status: out.run.status, joined: out.joined })
    } catch (err) {
      app.log.error(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: starting the template install failed'
      )
      const message = 'The template could not be installed'
      return reply
        .code(500)
        .send({ statusCode: 500, error: message, message, code: 'TEMPLATE_FAILED' })
    }
  })

  app.get<{ Params: { id: string } }>('/template/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const run = await readTemplateRun(req.params.id).catch(() => null)
    if (!run) {
      const message = 'No template install with that id here'
      return reply
        .code(404)
        .send({ statusCode: 404, error: message, message, code: 'UNKNOWN_INSTALL' })
    }
    const { digest: _digest, ...rest } = run
    return reply.send(rest)
  })
}
