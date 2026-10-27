import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * The application/json body parser for every API process.
 *
 * - An empty body is `undefined`, not an error (the SDK sends the JSON content type on
 *   bodyless DELETE/PUT/PATCH; Fastify v5 refuses empty JSON by default).
 * - Prototype poisoning is stripped: Fastify's own parser (secure-json-parse underneath) with
 *   `__proto__` and `constructor.prototype` keys REMOVED, so a body can never smuggle them into
 *   an object merge downstream. No new dependency — the parser ships with Fastify.
 * - Routes that verify a signature over the exact bytes (webhook flows) get the raw text on
 *   `req.rawBody`; nothing else keeps it.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** The exact JSON text received — set only for RAW_BODY_PATHS. */
    rawBody?: string
  }
}

/** Paths whose handlers verify a signature over the raw body. */
export const RAW_BODY_PATHS: readonly RegExp[] = [/^\/api\/flows\/webhook\//]

export function wantsRawBody(url: string | undefined): boolean {
  const path = String(url ?? '').split('?')[0] ?? ''
  return RAW_BODY_PATHS.some((re) => re.test(path))
}

export function registerJsonBodyParser(app: FastifyInstance): void {
  const secure = app.getDefaultJsonParser('remove', 'remove')
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req: FastifyRequest, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8')
      if (text.trim() === '') {
        done(null, undefined)
        return
      }
      if (wantsRawBody(req.url)) req.rawBody = text
      secure(req, text, done)
    }
  )
}
