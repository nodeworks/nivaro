import type { FastifyInstance } from 'fastify'
import { installHubTemplate } from '../services/hub-link/template-install.js'

/** A template bundle (an App Blueprint package) is JSON; 24 MB covers a large schema. */
export const HUB_TEMPLATE_BODY_LIMIT = 24 * 1024 * 1024

/**
 * POST /api/hub-link/template (Hub enhancement 24) — registered by hubLinkRoutes inside its
 * plugin, so the HUB_TOKEN bearer check (and the 429 brake) of that plugin applies; never
 * mounted where hub link routes are not (no HUB_TOKEN, cloud, a shared deployment).
 *
 *   {bundle, digest, template?: {name, version}}
 *   → 200 {installed: true, report, collections}
 *   | 400 BAD_BUNDLE / BAD_DIGEST | 409 APP_NOT_EMPTY {collections: [...]} | 500 TEMPLATE_FAILED
 *
 * A failure answers a generic 500 (no driver text). The install report's own `errors` list is
 * the blueprint installer's (names of what failed, already short).
 */
export function hubLinkTemplateRoute(app: FastifyInstance): void {
  app.post('/template', { bodyLimit: HUB_TEMPLATE_BODY_LIMIT }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const out = await installHubTemplate(req.body)
      if (!out.ok)
        return reply.code(out.status).send({
          statusCode: out.status,
          error: out.message,
          message: out.message,
          code: out.code,
          ...(out.extra ? { collections: out.extra } : {})
        })
      return reply.send({ installed: true, report: out.report, collections: out.collections })
    } catch (err) {
      app.log.error(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: installing the template failed'
      )
      const message = 'The template could not be installed'
      return reply
        .code(500)
        .send({ statusCode: 500, error: message, message, code: 'TEMPLATE_FAILED' })
    }
  })
}
