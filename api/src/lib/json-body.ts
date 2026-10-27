import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * Body parsers for every API process.
 *
 * registerJsonBodyParser — application/json everywhere:
 * - An empty body is `undefined`, not an error (the SDK sends the JSON content type on
 *   bodyless DELETE/PUT/PATCH; Fastify v5 refuses empty JSON by default).
 * - Prototype poisoning is stripped: Fastify's own parser (secure-json-parse underneath) with
 *   `__proto__` and `constructor.prototype` keys REMOVED, so a body can never smuggle them into
 *   an object merge downstream. No new dependency — the parser ships with Fastify.
 *
 * registerRawCapturingParser — for routes that verify a signature over the exact bytes
 * (webhook flows): replaces the inherited parsers inside that plugin with ONE parser for every
 * content type that keeps the received text on `req.rawBody`. JSON bodies are parsed the same
 * safe way; anything else arrives as the raw string. The signature is then checked against
 * exactly the bytes the handler consumes.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** The exact body text received — set only by registerRawCapturingParser. */
    rawBody?: string
  }
}

type Secure = ReturnType<FastifyInstance['getDefaultJsonParser']>

function parseJsonText(
  secure: Secure,
  req: FastifyRequest,
  text: string,
  done: (err: Error | null, body?: unknown) => void
): void {
  if (text.trim() === '') {
    done(null, undefined)
    return
  }
  secure(req, text, done)
}

function isJsonType(contentType: string | undefined): boolean {
  const t = String(contentType ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase()
  return t === 'application/json' || !!t?.endsWith('+json')
}

export function registerJsonBodyParser(app: FastifyInstance): void {
  const secure = app.getDefaultJsonParser('remove', 'remove')
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req: FastifyRequest, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8')
      parseJsonText(secure, req, text, done)
    }
  )
}

/** Call inside an encapsulated plugin: every content type, raw text kept on req.rawBody. */
export function registerRawCapturingParser(app: FastifyInstance): void {
  const secure = app.getDefaultJsonParser('remove', 'remove')
  app.removeAllContentTypeParsers()
  app.addContentTypeParser(
    '*',
    { parseAs: 'string' },
    (req: FastifyRequest, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8')
      req.rawBody = text
      if (isJsonType(req.headers['content-type'])) {
        parseJsonText(secure, req, text, done)
        return
      }
      done(null, text === '' ? undefined : text)
    }
  )
}
