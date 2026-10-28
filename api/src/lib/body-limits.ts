/**
 * Request body ceilings (M20, security audit 2026-10-27).
 *
 * Every route used to accept the file ceiling + 8 MB of JSON (~58 MB), parsed on the main
 * thread before any auth check ran. Now:
 *
 *   - core routes default to BODY_LIMIT_MB (1 MB unless set);
 *   - core route groups that legitimately receive large JSON (imports, bundles, layouts,
 *     payload templates, MCP, screenshots, rich-text records, help videos…) keep the old
 *     large ceiling;
 *   - a route that declares its own `bodyLimit` keeps it, whatever the group;
 *   - extension routes (registered after the core routes, often lazily) keep the large
 *     ceiling — what they receive is not known here;
 *   - multipart uploads are streamed by @fastify/multipart under its own fileSize limit and
 *     never read through bodyLimit.
 *
 * Above the global default, a request must carry a credential (a signed-in session or an
 * Authorization header) — an anonymous caller never gets a large body parsed. Webhook flows
 * (`SELF_AUTHENTICATING_BODY_PREFIXES`) sign the body itself and are exempt.
 *
 * Leaf module.
 */

import { Transform } from 'node:stream'

const MB = 1024 * 1024

/** The global JSON/text body ceiling in bytes (BODY_LIMIT_MB, default 1). */
export function defaultBodyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BODY_LIMIT_MB)
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 1
  return Math.floor(mb * MB)
}

/** The large ceiling: the configured file size + 8 MB of envelope, never below the default. */
export function largeBodyLimit(fileSizeMb: number, env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(Math.floor((fileSizeMb + 8) * MB), defaultBodyLimit(env))
}

/**
 * /api route groups that receive large bodies. A prefix matches the segment exactly or a
 * segment boundary after it ('/api/ai' matches '/api/ai/extract-record', not '/api/aim').
 */
export const LARGE_BODY_PREFIXES: readonly string[] = [
  // uploads, imports, bundles moved between instances
  '/api/files',
  '/api/help-videos',
  '/api/imports',
  '/api/import-templates',
  '/api/staged-imports',
  '/api/inbound',
  '/api/inbound-mappings',
  '/api/promotion',
  '/api/record-promotion',
  '/api/blueprints',
  '/api/schema-snapshot',
  '/api/collection-snapshots',
  '/api/collection-presets',
  '/api/config-seeds',
  '/api/change-sets',
  '/api/environments',
  '/api/backups',
  '/api/scim/v2',
  // layout + payload editors (whole bundles / ops batches / previews)
  '/api/payload-templates',
  '/api/collection-layouts',
  '/api/layout-change-requests',
  '/api/layout-collab',
  '/api/layout-usage',
  '/api/form-preview',
  '/api/layout-inspect',
  '/api/ai-design',
  '/api/data-model',
  '/api/field-config',
  '/api/collections',
  // AI (documents for autofill, chat context), MCP tool calls
  '/api/ai',
  '/api/mcp',
  '/api/mcp-console',
  '/api/mcp-tools',
  // screenshots on Report a problem / issues, traffic-map snapshots
  '/api/issues',
  '/api/support',
  '/api/traffic-map',
  // configuration that may carry big documents (specs, templates, flow/pipeline exports)
  '/api/external-apis',
  '/api/pipelines',
  '/api/workflows',
  '/api/flows',
  '/api/dashboards',
  '/api/report-studio',
  '/api/reports',
  '/api/pdf-templates',
  '/api/mail-templates',
  '/api/notification-templates',
  '/api/pages',
  '/api/extensions',
  '/api/custom-queries',
  '/api/procedures',
  '/api/sql-scratchpad',
  '/api/virtual-collections',
  '/api/automation-tests',
  '/api/sync-jobs',
  '/api/chaos',
  '/api/telemetry',
  '/api/realtime',
  // record writes: batch/bulk saves, rich text, inline grids, drafts of big forms
  '/api/items',
  '/api/sub-rows',
  '/api/drafts',
  '/api/addendums',
  '/api/comments',
  '/api/bulk-recipes',
  '/api/find-replace',
  '/api/record-merge',
  '/api/merge',
  '/api/graphql'
]

export function isLargeBodyRoute(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  for (const p of LARGE_BODY_PREFIXES) {
    if (path === p || path.startsWith(`${p}/`)) return true
  }
  return false
}

/**
 * A route's bodyLimit under this policy, for a server whose GLOBAL bodyLimit is the large
 * ceiling: undefined = keep the global (large) one.
 */
export function routeBodyLimit(
  route: { url: string; bodyLimit?: number },
  opts: { core: boolean; small: number }
): number | undefined {
  if (typeof route.bodyLimit === 'number') return route.bodyLimit
  if (!opts.core || isLargeBodyRoute(route.url)) return undefined
  return opts.small
}

type CredReq = {
  headers: Record<string, string | string[] | undefined>
  session?: { userId?: unknown } | null
  url?: string
}

/**
 * Routes whose callers authenticate the BODY itself instead of sending a credential header:
 * webhook flows (HMAC signature over the body / shared secret, checked by the route). They keep
 * their route ceiling without a session or Authorization header (review A6, 2026-10-27).
 */
export const SELF_AUTHENTICATING_BODY_PREFIXES: readonly string[] = ['/api/flows/webhook/']

export function isSelfAuthenticatingBodyRoute(url: string | undefined): boolean {
  const path = String(url ?? '').split('?')[0] ?? ''
  return SELF_AUTHENTICATING_BODY_PREFIXES.some((p) => path.startsWith(p))
}

function hasCredential(req: CredReq): boolean {
  return (
    !!req.headers.authorization || !!req.session?.userId || isSelfAuthenticatingBodyRoute(req.url)
  )
}

/** A Content-Length header that is a plain non-negative integer, else null (unknown). */
function declaredLength(req: CredReq): number | null {
  const raw = req.headers['content-length']
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null
  return Number(raw)
}

/**
 * May this request's body pass the default ceiling? Only with a credential — a verified
 * session or an Authorization header (checked by the route's own authenticate later).
 * True = refuse now (a declared length over the ceiling, no credential).
 */
export function anonymousBodyTooLarge(req: CredReq, small: number): boolean {
  if (hasCredential(req)) return false
  const len = declaredLength(req)
  return len !== null && len > small
}

/**
 * An anonymous body whose size is not declared (chunked transfer, a missing or malformed
 * Content-Length) is counted while it streams and cut off past the ceiling.
 */
export function needsStreamingCap(req: CredReq & { method?: string }, small: number): boolean {
  if (hasCredential(req)) return false
  const m = String(req.method ?? '').toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false
  const len = declaredLength(req)
  return len === null || len > small
}

export class BodyTooLargeError extends Error {
  statusCode = 413
  code = 'FST_ERR_CTP_BODY_TOO_LARGE'
  constructor() {
    super('Sign in to send a request this large.')
    this.name = 'BodyTooLargeError'
  }
}

/** A pass-through stream that errors with 413 once more than `limit` bytes went by. */
export function capStream(limit: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length
      if (seen > limit) cb(new BodyTooLargeError())
      else cb(null, chunk)
    }
  })
}
