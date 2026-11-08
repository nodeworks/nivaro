import type { FastifyRequest } from 'fastify'

/**
 * Batched GETs — `POST /api/batch-get {reads: [{key, path}]}`.
 *
 * A cold record page asks for ~20 small configuration and side-panel reads in
 * each of a dozen mount waves (layouts, field config, field rules, relations,
 * the header's last touch, SLA, comments counts…), one HTTP request each. The
 * shared client (packages/shared lib/request-gate.ts, `batchReads`) collects
 * the GETs of one wave whose path this list names and sends them here as one
 * request.
 *
 * Every read runs the REAL route in-process (`app.inject`) with the caller's
 * own request headers — their session cookie or bearer, View-as, workspace,
 * tenant host, forwarded address — so each part is authenticated, scoped,
 * rate-limited, gated, logged and answered exactly as the plain GET would be.
 * Nothing here judges access; nothing is cached across callers.
 *
 * Only cheap JSON reads are listed: never a stream (SSE), a file, a long
 * report, an identity read (`/auth/*`, `/users/me` — the signed-out gate owns
 * those) or a record read (`/items/<c>` rides `/items/batch-read`). The batch
 * answers when its slowest part does, so reads that take 0.5–3 s on a cold
 * record (pipeline instance + owners, provenance, related comments, the record
 * chat room, lineage, integration preflights) stay on their own requests.
 *
 * Twin: BATCHABLE_GET in packages/shared/src/lib/batch-gets.ts — keep the two
 * patterns byte-identical (a test compares them). A path the client sends that
 * this server does not list answers that part 400 and the client re-sends it
 * on its own.
 */
export const BATCHABLE_GET =
  /^\/(settings|roles|pinned|users|tasks|custom-actions|field-rules|notification-subscriptions|my-jobs|announcements\/active|notifications\/unread-count|session-recordings\/enabled|help-videos\/for|presence\/online|chaos\/(armed|status|gamedays\/active)|chat\/(rooms|room-types)|collection-layouts(\/active|\/why|\/summary\/[^/]+|\/\d+)?|field-config\/[^/]+|field-defaults\/mine|data-model\/(relations\/for\/[^/]+|resolve-cascade)|bulk-actions\/available|ai-settings\/[^/]+|item-actions\/registered|revisions(\/latest|\/field-touch|\/o2m-cell-provenance)?|comments(\/counts|\/machine-markers)?|(last-touch|drafts|addendums|erp-submissions|access-explain)\/[^/]+\/[^/]+|config-conformance\/record\/[^/]+\/[^/]+|integration-obligations\/record\/[^/]+\/[^/]+|record-views\/[^/]+\/[^/]+\/viewers|sla\/status\/[^/]+\/[^/]+|legal-holds\/check\/[^/]+\/[^/]+|layout-collab\/\d+\/whats-new|pipelines\/instances\/[^/]+|widgets-internal\/\d+|items\/[^/]+(\/[^/]+)?\/resolve-paths)$/

/** The most reads one batch carries. */
export const BATCH_GET_MAX = 20
/** Reads run at once per batch — about what a browser sends in parallel on its own. */
export const BATCH_GET_CONCURRENCY = 8
const MAX_PATH_LENGTH = 4096

/**
 * The path (under /api, with its query string) a batch part may run, or null.
 * Encoded slashes, dot segments and anything outside BATCHABLE_GET are refused.
 */
export function batchGetPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LENGTH) return null
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('#')) return null
  const q = raw.indexOf('?')
  const path = q === -1 ? raw : raw.slice(0, q)
  if (/%2f|%5c|\\|\/\.\.?(\/|$)|\/\//i.test(path)) return null
  return BATCHABLE_GET.test(path) ? raw : null
}

/**
 * Request headers a part must not inherit: the batch body's own framing, the
 * encoding the outer answer negotiates, and conditional headers (a part never
 * answers 304).
 */
const DROPPED_HEADERS = new Set([
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'expect',
  'te',
  'trailer',
  'upgrade',
  'accept-encoding',
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'if-range',
  'range'
])

/** The caller's own headers for an in-process GET made on their behalf. */
export function partHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROPPED_HEADERS.has(name) || value == null) continue
    out[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  out['accept-encoding'] = 'identity'
  return out
}

export interface BatchGetResult {
  key: string
  status: number
  /** The part's JSON body as the route serialized it (never re-encoded), when it sent JSON. */
  json?: string
  requestId?: string
  retryAfter?: string
  error?: string
}

interface InjectLike {
  inject(opts: {
    method: 'GET'
    url: string
    headers: Record<string, string>
    remoteAddress?: string
  }): PromiseLike<{
    statusCode: number
    body: string
    headers: Record<string, string | string[] | number | undefined>
  }>
}

function headerValue(v: string | string[] | number | undefined): string | undefined {
  if (v == null) return undefined
  return Array.isArray(v) ? v[0] : String(v)
}

/** Run one part as the caller and capture its answer. */
export async function runBatchGetPart(
  server: InjectLike,
  req: FastifyRequest,
  key: string,
  path: string,
  headers: Record<string, string>
): Promise<BatchGetResult> {
  const res = await server.inject({
    method: 'GET',
    url: `/api${path}`,
    headers,
    // The socket address the caller came from, so the part derives the same
    // client address (trust proxy, API-key IP lists, rate limits) as their GET.
    remoteAddress: req.socket?.remoteAddress ?? req.ip
  })
  const out: BatchGetResult = { key, status: res.statusCode }
  const requestId = headerValue(res.headers['x-nivaro-request-id'])
  if (requestId) out.requestId = requestId
  const retryAfter = headerValue(res.headers['retry-after'])
  if (retryAfter) out.retryAfter = retryAfter
  const type = headerValue(res.headers['content-type']) ?? ''
  if (type.includes('application/json') && res.body.length > 0) {
    try {
      JSON.parse(res.body)
      out.json = res.body
    } catch {
      // Not JSON after all: the client re-sends this part on its own.
    }
  }
  return out
}

/** The batch answer as text: each part's body is embedded exactly as its route serialized it. */
export function serializeBatchGet(results: BatchGetResult[]): string {
  const parts = results.map((r) => {
    let s = `{"key":${JSON.stringify(r.key)},"status":${r.status}`
    if (r.requestId) s += `,"request_id":${JSON.stringify(r.requestId)}`
    if (r.retryAfter) s += `,"retry_after":${JSON.stringify(r.retryAfter)}`
    if (r.error) s += `,"error":${JSON.stringify(r.error)}`
    if (r.json !== undefined) s += `,"body":${r.json}`
    return `${s}}`
  })
  return `{"results":[${parts.join(',')}]}`
}

/** Run every part (BATCH_GET_CONCURRENCY at a time); one failing part never fails the others. */
export async function runBatchGet(
  server: InjectLike,
  req: FastifyRequest,
  reads: Array<{ key: string; path: string | null }>
): Promise<BatchGetResult[]> {
  const headers = partHeaders(req)
  const results: BatchGetResult[] = new Array(reads.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(BATCH_GET_CONCURRENCY, reads.length) }, async () => {
      while (next < reads.length) {
        const i = next++
        const { key, path } = reads[i]
        if (path === null) {
          results[i] = { key, status: 400, error: 'This path cannot be batched' }
          continue
        }
        try {
          results[i] = await runBatchGetPart(server, req, key, path, headers)
        } catch (err) {
          req.log.warn({ err, path }, 'batch-get: a read failed')
          results[i] = { key, status: 500, error: 'The read failed' }
        }
      }
    })
  )
  return results
}
