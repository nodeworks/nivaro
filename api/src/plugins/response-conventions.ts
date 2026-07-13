import type { FastifyInstance } from 'fastify'

/**
 * Dev-only response convention checker.
 *
 * Watches every JSON response under /api and logs a warning when a route
 * violates the API's response conventions:
 *   1. camelCase keys — responses are snake_case everywhere; a camelCase key
 *      is almost always a service-layer object leaking through unmapped
 *      (the bug class behind the retention run-result crash).
 *   2. missing envelope — success bodies are `{ data: ... }` and error bodies
 *      `{ error: ... }`; bare shapes get an info-level note.
 *
 * Warnings are deduped per route+issue for the process lifetime, so a hot
 * route logs once, not per request. Registered only when NODE_ENV=development
 * — zero production overhead.
 */

// Routes with intentionally bare or externally-defined response shapes.
const ENVELOPE_EXEMPT: RegExp[] = [
  /^\/api\/health/,
  /^\/api\/auth\//,
  /^\/api\/graphql/,
  /^\/api\/analytics\/pageview/, // public tracker contract: bare { id }
  /^\/api\/widget/,
  /^\/api\/inngest/,
  /^\/api\/scim\//, // SCIM RFC shapes
  /^\/api\/dev-tools\//,
  /^\/api\/zapier\//,
  /^\/api\/flows\/registered-/,
  /\/stats$/, // dashboard/stat endpoints return bare aggregates
  /\/trends$/,
]

// Keys allowed to be camelCase (external contracts we don't control).
const KEY_ALLOWLIST = new Set(['statusCode', 'validationContext'])

const CAMEL = /[a-z][A-Z]/

function findCamelKeys(value: unknown, depth = 0, found: Set<string> = new Set()): Set<string> {
  if (depth > 2 || value == null || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    // Sample the first element — sibling rows share a shape
    if (value.length > 0) findCamelKeys(value[0], depth + 1, found)
    return found
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (CAMEL.test(k) && !KEY_ALLOWLIST.has(k)) found.add(k)
    findCamelKeys(v, depth + 1, found)
  }
  return found
}

export function registerResponseConventions(app: FastifyInstance) {
  const reported = new Set<string>()

  app.addHook('onSend', async (req, reply, payload) => {
    const url = req.routeOptions?.url ?? req.url
    if (!req.url.startsWith('/api/')) return payload
    const ct = String(reply.getHeader('content-type') ?? '')
    if (!ct.includes('application/json')) return payload
    if (typeof payload !== 'string' || payload.length > 500_000) return payload

    let body: unknown
    try {
      body = JSON.parse(payload)
    } catch {
      return payload
    }
    if (body == null || typeof body !== 'object' || Array.isArray(body)) return payload

    const routeKey = `${req.method} ${url}`

    const camel = findCamelKeys(body)
    if (camel.size > 0) {
      const key = `${routeKey}:camel`
      if (!reported.has(key)) {
        reported.add(key)
        app.log.warn(
          { route: routeKey, keys: [...camel] },
          'response-conventions: camelCase key(s) in API response — responses are snake_case'
        )
      }
    }

    const status = reply.statusCode
    const obj = body as Record<string, unknown>
    const exempt = ENVELOPE_EXEMPT.some((re) => re.test(url))
    if (!exempt) {
      const ok =
        (status < 400 && ('data' in obj || Object.keys(obj).length === 0)) ||
        (status >= 400 && ('error' in obj || 'message' in obj))
      if (!ok) {
        const key = `${routeKey}:envelope`
        if (!reported.has(key)) {
          reported.add(key)
          app.log.info(
            { route: routeKey, status, keys: Object.keys(obj).slice(0, 8) },
            'response-conventions: bare response body (expected { data } / { error } envelope)'
          )
        }
      }
    }

    return payload
  })
}
