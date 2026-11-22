import type { DeploymentAppStatus, DeploymentStatus } from '../../tenancy/app-status.js'
import { scrubDbError } from '../db/connection.js'
import {
  deploymentLinkBearer,
  linkUrlOrigin,
  openSharedPrevToken,
  openSharedToken,
  type SharedDeployment
} from './store.js'

/**
 * Nivaro Hub phase 6: the Hub's client for a shared deployment's link
 * (routes/hub-deployment-link.ts on the deployment, Task 7).
 *
 *   GET  {link}/api/hub-deployment/status                        → DeploymentStatus
 *   GET  {link}/api/hub-deployment/apps/:id/status               → DeploymentAppStatus
 *   POST {link}/api/hub-deployment/apps/:id/first-admin          → {user_id, created}
 *   POST {link}/api/hub-deployment/refresh                       → 202
 *   POST {link}/api/hub-deployment/db-check {client, connection} → {reachable, ledger, db_identity, error}
 *   POST {link}/api/hub-deployment/apps/:id/files/ticket         → {ticket, expires_at}   (Task 10)
 *   POST {link}/api/hub-deployment/apps/:id/files/pull           → {run_id}               (Task 10)
 *   GET  {link}/api/hub-deployment/apps/:id/files/pull/:runId    → PullStatus             (Task 10)
 *
 * Auth (ruling R7): `Authorization: Bearer <deploymentLinkBearer(token)>`, the HMAC of the
 * deployment token; the token itself never travels to the link. After a rotation the deployment
 * may still hold the previous token (up to 24 h, or until a Docker stack is applied again), so a
 * 401 is tried once more with the previous token's bearer while its grace lasts.
 *
 * Every call: base = the deployment's `link_url` (https, or plain http to loopback / RFC 1918
 * outside production — store.ts linkUrlOrigin), 8 s timeout with an outer bound, `redirect:
 * 'error'` (a bearer never follows a redirect), answers capped at 2 MB and checked for shape.
 * Never logs. A refusal is a DeploymentLinkError with a code and a plain sentence; it never holds
 * a token, a bearer, a ticket, a database connection or the deployment's own message text (only
 * a code-shaped `reason` is passed on).
 */

export type { DeploymentAppStatus, DeploymentStatus } from '../../tenancy/app-status.js'

export const DEPLOYMENT_LINK_TIMEOUT_MS = 8_000
/** First-admin and a database check may wait on a cold connection; the deployment bounds its own
 *  db-check at 10 s, so the client waits a little longer than that. */
const SLOW_CALL_TIMEOUT_MS = 15_000
/** No answer from the deployment link is bigger than this. */
const MAX_ANSWER_BYTES = 2 * 1024 * 1024

export type DeploymentLinkCode =
  | 'LINK_UNREACHABLE'
  | 'LINK_REFUSED'
  | 'LINK_BAD_ANSWER'
  | 'LINK_MISSING'
  | 'UNKNOWN_APP'
  // The deployment link's own refusals (Task 7), passed on as they are.
  | 'APP_UNREACHABLE'
  | 'REGISTRY_NOT_READY'
  | 'BAD_DB_CLIENT'
  | 'BAD_DB_CONNECTION'
  | 'MAINTENANCE'
  | 'FIRST_ADMIN_FAILED'
  /** The app refused to seed its first admin: `reason` = BAD_EMAIL, HAS_ADMIN, NO_ADMIN_ROLE … */
  | 'FIRST_ADMIN_REFUSED'
  /** A file transfer route refused (Task 10): `reason` = its code. */
  | 'TRANSFER_REFUSED'

/** Codes the link answers with that are passed on as the client's own code. */
const PASSED_ON = new Set<DeploymentLinkCode>([
  'UNKNOWN_APP',
  'APP_UNREACHABLE',
  'REGISTRY_NOT_READY',
  'BAD_DB_CLIENT',
  'BAD_DB_CONNECTION',
  'MAINTENANCE',
  'FIRST_ADMIN_FAILED'
])

const MESSAGES: Record<DeploymentLinkCode, string> = {
  LINK_UNREACHABLE: 'The shared deployment did not answer on its link address.',
  LINK_REFUSED:
    'The shared deployment refused the Hub. Check that it runs with the token this Hub holds (rotate the token and set it there if not).',
  LINK_BAD_ANSWER: 'The shared deployment answered with something the Hub cannot read.',
  LINK_MISSING:
    'The address answers but has no deployment link. Check the link address, and that the deployment runs as a Hub shared deployment on a version that has the link.',
  UNKNOWN_APP: 'The shared deployment does not serve that app.',
  APP_UNREACHABLE: "The shared deployment could not read the app's database.",
  REGISTRY_NOT_READY: 'The shared deployment has not loaded its list of apps yet.',
  BAD_DB_CLIENT: 'The shared deployment does not know that database engine.',
  BAD_DB_CONNECTION: 'The database connection was refused as given.',
  MAINTENANCE: 'The app is in maintenance mode.',
  FIRST_ADMIN_FAILED: 'The app could not save its first administrator.',
  FIRST_ADMIN_REFUSED: 'The app refused to seed that first administrator.',
  TRANSFER_REFUSED: 'The shared deployment refused the file transfer.'
}

/** A refusal from the deployment link. `reason` is the link's own code when it sent one. */
export class DeploymentLinkError extends Error {
  code: DeploymentLinkCode
  /** The HTTP status the link answered with; 0 when it never answered. */
  status: number
  reason: string | null
  constructor(
    code: DeploymentLinkCode,
    status = 0,
    reason: string | null = null,
    message?: string
  ) {
    super(message ?? MESSAGES[code])
    this.name = 'DeploymentLinkError'
    this.code = code
    this.status = status
    this.reason = reason
  }
}

// ─── wire types the Hub sends / reads (Task 10 serves them) ────────────────────────────────

export interface PullRequest {
  /** The source's file route: origin + '/api/hub-transfer/files'. */
  source: string
  /** A transfer ticket the source minted ('nvt_…'). Never logged or answered back. */
  ticket: string
  mode: 'full' | 'delta'
}

export interface PullStatus {
  state: 'running' | 'done' | 'failed'
  total: number
  copied: number
  skipped: number
  failed: number
  /** At most 50 file ids. */
  missing: string[]
  bytes: number
  error: string | null
}

export interface DbCheckAnswer {
  reachable: boolean
  ledger: { count: number; latest: string | null } | null
  /** `engine|server|port|database` (ruling R2); null when it could not be read. */
  db_identity: string | null
  error: string | null
}

export interface DeploymentClientDeps {
  fetch?: typeof fetch
  /** The deployment token now, and the previous one while its grace lasts (tests pass them). */
  tokens?: () => Promise<{ current: string | null; previous: string | null }>
  timeoutMs?: number
}

export interface DeploymentClient {
  status(): Promise<DeploymentStatus>
  appStatus(tenantId: string): Promise<DeploymentAppStatus>
  firstAdmin(tenantId: string, body: unknown): Promise<{ user_id: string; created: boolean }>
  refresh(): Promise<void>
  dbCheck(db: { client: string; connection: string }): Promise<DbCheckAnswer>
  fileTicket(tenantId: string): Promise<{ ticket: string; expires_at: string }>
  pullFiles(tenantId: string, body: PullRequest): Promise<{ run_id: string }>
  pullStatus(tenantId: string, runId: string): Promise<PullStatus>
}

// ─── the call ───────────────────────────────────────────────────────────────────────────────

/** A tenant id as the Hub makes them (tenantIdFor): lower-case letters, digits, hyphens. */
const TENANT_ID_RE = /^[a-z0-9-]{1,64}$/
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

class Deadline extends Error {
  constructor() {
    super('deadline')
    this.name = 'AbortError'
  }
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Deadline()), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function isRedirectError(err: unknown): boolean {
  const cause = (err as { cause?: { message?: unknown } } | null)?.cause
  return /redirect/i.test(String(cause?.message ?? ''))
}

/** Reads at most `max` bytes of a body; null when it is bigger (the rest is cancelled). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function codeOf(body: unknown): string | null {
  const c = (body as { code?: unknown } | null)?.code
  return typeof c === 'string' && CODE_RE.test(c) ? c : null
}

interface Answer {
  status: number
  body: unknown
}

type Fetch = typeof fetch

async function once(
  doFetch: Fetch,
  url: string,
  bearer: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  timeoutMs: number
): Promise<Answer> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const run = async (): Promise<Answer> => {
      const hasBody = init.body !== undefined
      const res = await doFetch(url, {
        method: init.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${bearer}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {})
        },
        ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'error',
        signal: ctl.signal
      })
      // A fetch that hands back a redirect instead of refusing it: never follow it.
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel().catch(() => {})
        throw new DeploymentLinkError(
          'LINK_REFUSED',
          res.status,
          null,
          'The shared deployment answered with a redirect; the Hub never follows one with its token.'
        )
      }
      const text = await readCapped(res, MAX_ANSWER_BYTES)
      if (text === null) throw new DeploymentLinkError('LINK_BAD_ANSWER', res.status)
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = undefined
        }
      }
      return { status: res.status, body }
    }
    return await within(run(), timeoutMs)
  } catch (err) {
    if (err instanceof DeploymentLinkError) throw err
    if (isRedirectError(err))
      throw new DeploymentLinkError(
        'LINK_REFUSED',
        0,
        null,
        'The shared deployment answered with a redirect; the Hub never follows one with its token.'
      )
    throw new DeploymentLinkError('LINK_UNREACHABLE')
  } finally {
    clearTimeout(timer)
  }
}

/** A non-2xx answer as a refusal: the link's code when it is one we pass on, else by status. */
function refusalOf(
  a: Answer,
  mapCode?: (code: string | null, status: number) => DeploymentLinkError | null
): DeploymentLinkError {
  const code = codeOf(a.body)
  const own = mapCode?.(code, a.status)
  if (own) return own
  if (a.status === 401 || a.status === 403 || a.status === 429)
    return new DeploymentLinkError('LINK_REFUSED', a.status, code)
  if (code && PASSED_ON.has(code as DeploymentLinkCode))
    return new DeploymentLinkError(code as DeploymentLinkCode, a.status)
  if (a.status === 404) return new DeploymentLinkError('LINK_MISSING', a.status, code)
  return new DeploymentLinkError('LINK_BAD_ANSWER', a.status, code)
}

async function defaultTokens(id: number) {
  const [current, previous] = await Promise.all([openSharedToken(id), openSharedPrevToken(id)])
  return { current, previous }
}

// ─── shape checks ───────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v)
const SCHEMA_STATES = new Set(['pending', 'running', 'ok', 'failed'])

function isDeploymentStatus(v: unknown): v is DeploymentStatus {
  if (!isObj(v) || !isStr(v.version) || !isStr(v.instance)) return false
  const r = v.registry
  if (
    !isObj(r) ||
    !isNum(r.count) ||
    !isStrOrNull(r.loaded_at) ||
    !isStrOrNull(r.etag) ||
    typeof r.stale !== 'boolean' ||
    !Array.isArray(r.dropped) ||
    !r.dropped.every((d) => isObj(d) && isStr(d.id) && isStr(d.why))
  )
    return false
  if (
    !Array.isArray(v.apps) ||
    !v.apps.every(
      (a) =>
        isObj(a) &&
        isStr(a.id) &&
        isObj(a.schema) &&
        SCHEMA_STATES.has(String(a.schema.state)) &&
        isStrOrNull(a.schema.version) &&
        isStrOrNull(a.schema.error)
    )
  )
    return false
  if (!Array.isArray(v.extensions) || !v.extensions.every(isStr)) return false
  if (
    v.oidc !== null &&
    !(isObj(v.oidc) && isStr(v.oidc.issuer_host) && isStrOrNull(v.oidc.tenant))
  )
    return false
  return isObj(v.process)
}

function isAppStatus(v: unknown): v is DeploymentAppStatus {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.version)) return false
  const p = v.preflight
  if (!isObj(p) || !isStr(p.status) || !Array.isArray(p.failing) || !p.failing.every(isStr))
    return false
  const b = v.busy
  const f = v.files
  return (
    isNumOrNull(v.readiness_score) &&
    isObj(b) &&
    isNum(b.imports) &&
    isNum(b.exports) &&
    isNum(b.renders) &&
    isObj(f) &&
    isNum(f.count) &&
    isNum(f.bytes) &&
    isNum(f.local) &&
    isStrOrNull(v.key_fp) &&
    typeof v.maintenance === 'boolean'
  )
}

const PULL_STATES = new Set(['running', 'done', 'failed'])

function isPullStatus(v: unknown): v is PullStatus {
  return (
    isObj(v) &&
    PULL_STATES.has(String(v.state)) &&
    isNum(v.total) &&
    isNum(v.copied) &&
    isNum(v.skipped) &&
    isNum(v.failed) &&
    Array.isArray(v.missing) &&
    v.missing.every(isStr) &&
    isNum(v.bytes) &&
    isStrOrNull(v.error)
  )
}

/** The password of a connection (URL form or `Password=`), for the scrub; null when none. */
function passwordOf(connection: string): string | null {
  try {
    const p = new URL(connection).password
    if (p) return decodeURIComponent(p)
  } catch {
    // not a URL
  }
  const m = /(?:^|;)\s*(?:password|pwd)\s*=\s*(\{[^}]*\}|[^;]*)/i.exec(connection)
  const v = m?.[1]?.trim().replace(/^\{(.*)\}$/, '$1')
  return v || null
}

// ─── the client ─────────────────────────────────────────────────────────────────────────────

export function deploymentClient(
  shared: Pick<SharedDeployment, 'id' | 'link_url'>,
  deps: DeploymentClientDeps = {}
): DeploymentClient {
  const doFetch: Fetch = deps.fetch ?? fetch
  const tokens = deps.tokens ?? (() => defaultTokens(shared.id))
  const timeout = deps.timeoutMs ?? DEPLOYMENT_LINK_TIMEOUT_MS

  /** One call; a 401 is tried once more with the previous token inside its grace. */
  async function call(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    opts: { timeoutMs?: number } = {}
  ): Promise<Answer> {
    const base = linkUrlOrigin(shared.link_url)
    if (!base)
      throw new DeploymentLinkError(
        'LINK_UNREACHABLE',
        0,
        null,
        "The shared deployment's link address is not one the Hub may call (https, or plain http only to a private address)."
      )
    const { current, previous } = await tokens()
    if (!current)
      throw new DeploymentLinkError(
        'LINK_REFUSED',
        0,
        null,
        'The Hub holds no token for this shared deployment — rotate the token and set it there.'
      )
    const url = `${base}/api/hub-deployment${path}`
    const ms = deps.timeoutMs ?? opts.timeoutMs ?? timeout
    const first = await once(doFetch, url, deploymentLinkBearer(current), init, ms)
    if (first.status === 401 && previous && previous !== current)
      return once(doFetch, url, deploymentLinkBearer(previous), init, ms)
    return first
  }

  const tenantPath = (tenantId: string): string => {
    if (typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId))
      throw new DeploymentLinkError('UNKNOWN_APP')
    return `/apps/${tenantId}`
  }

  const ok = (a: Answer) => a.status >= 200 && a.status < 300

  const transferRefusal = (code: string | null, status: number) =>
    status === 400 || status === 409 || (status === 404 && code !== 'UNKNOWN_APP' && code !== null)
      ? new DeploymentLinkError('TRANSFER_REFUSED', status, code)
      : null

  return {
    async status() {
      const a = await call('/status', { method: 'GET' })
      if (!ok(a)) throw refusalOf(a)
      if (!isDeploymentStatus(a.body)) throw new DeploymentLinkError('LINK_BAD_ANSWER', a.status)
      return a.body
    },

    async appStatus(tenantId) {
      const a = await call(`${tenantPath(tenantId)}/status`, { method: 'GET' })
      if (!ok(a)) throw refusalOf(a)
      if (!isAppStatus(a.body)) throw new DeploymentLinkError('LINK_BAD_ANSWER', a.status)
      return a.body
    },

    async firstAdmin(tenantId, body) {
      const a = await call(
        `${tenantPath(tenantId)}/first-admin`,
        { method: 'POST', body: body ?? {} },
        { timeoutMs: SLOW_CALL_TIMEOUT_MS }
      )
      if (!ok(a))
        throw refusalOf(a, (code, status) =>
          code && !PASSED_ON.has(code as DeploymentLinkCode) && (status === 400 || status === 409)
            ? new DeploymentLinkError('FIRST_ADMIN_REFUSED', status, code)
            : null
        )
      const b = a.body as { user_id?: unknown; created?: unknown } | null
      if (!isObj(b) || !isStr(b.user_id) || typeof b.created !== 'boolean')
        throw new DeploymentLinkError('LINK_BAD_ANSWER', a.status)
      return { user_id: b.user_id, created: b.created }
    },

    async refresh() {
      const a = await call('/refresh', { method: 'POST', body: {} })
      if (!ok(a)) throw refusalOf(a)
    },

    async dbCheck(target) {
      const connection = String(target?.connection ?? '')
      const secrets = [connection, passwordOf(connection)]
      let a: Answer
      try {
        a = await call(
          '/db-check',
          { method: 'POST', body: { client: String(target?.client ?? ''), connection } },
          { timeoutMs: SLOW_CALL_TIMEOUT_MS }
        )
      } catch (err) {
        // Our own errors never hold the connection; anything else is not passed on.
        if (err instanceof DeploymentLinkError) throw err
        throw new DeploymentLinkError('LINK_UNREACHABLE')
      }
      if (!ok(a)) throw refusalOf(a)
      const b = a.body
      if (
        !isObj(b) ||
        typeof b.reachable !== 'boolean' ||
        !isStrOrNull(b.error) ||
        (b.ledger !== null &&
          !(isObj(b.ledger) && isNum(b.ledger.count) && isStrOrNull(b.ledger.latest)))
      )
        throw new DeploymentLinkError('LINK_BAD_ANSWER', a.status)
      const ledger = b.ledger as DbCheckAnswer['ledger']
      return {
        reachable: b.reachable,
        ledger: ledger ? { count: ledger.count, latest: ledger.latest } : null,
        db_identity: isStr(b.db_identity) && b.db_identity.length <= 600 ? b.db_identity : null,
        // The deployment scrubs it already; an old or broken one might not.
        error: b.error === null ? null : scrubDbError(b.error, secrets)
      }
    },

    async fileTicket(tenantId) {
      const a = await call(`${tenantPath(tenantId)}/files/ticket`, { method: 'POST', body: {} })
      if (!ok(a)) throw refusalOf(a, transferRefusal)
      const b = a.body
      if (!isObj(b) || !isStr(b.ticket) || !isStr(b.expires_at))
        throw new DeploymentLinkError('LINK_BAD_ANSWER', a.status)
      return { ticket: b.ticket, expires_at: b.expires_at }
    },

    async pullFiles(tenantId, req) {
      const a = await call(`${tenantPath(tenantId)}/files/pull`, {
        method: 'POST',
        body: { source: req.source, ticket: req.ticket, mode: req.mode }
      })
      if (!ok(a)) throw refusalOf(a, transferRefusal)
      const b = a.body
      if (!isObj(b) || !isStr(b.run_id)) throw new DeploymentLinkError('LINK_BAD_ANSWER', a.status)
      return { run_id: b.run_id }
    },

    async pullStatus(tenantId, runId) {
      if (typeof runId !== 'string' || !RUN_ID_RE.test(runId))
        throw new DeploymentLinkError('TRANSFER_REFUSED', 0, 'BAD_RUN_ID')
      const a = await call(`${tenantPath(tenantId)}/files/pull/${runId}`, { method: 'GET' })
      if (!ok(a)) throw refusalOf(a, transferRefusal)
      if (!isPullStatus(a.body)) throw new DeploymentLinkError('LINK_BAD_ANSWER', a.status)
      return {
        ...a.body,
        missing: a.body.missing.slice(0, 50),
        error: a.body.error === null ? null : a.body.error.slice(0, 300)
      }
    }
  }
}

// ─── a dedicated app's key fingerprint over its hub link (app key check) ───────────────────

/**
 * What a dedicated app says its ENCRYPTION_KEY is: `key_fp` from
 * `GET {base_url}/api/hub-link/shared-readiness` (Task 9) with the environment's hub token.
 * Never throws; not ok = cannot tell (`HUB_LINK_MISSING` for an app older than the route).
 */
export async function linkedKeyFingerprint(
  env: { base_url: string },
  hubToken: string,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<{ ok: true; fp: string | null } | { ok: false; code: string }> {
  let base: string
  try {
    const u = new URL(String(env.base_url ?? '').trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      return { ok: false, code: 'BAD_BASE_URL' }
    if (u.username || u.password) return { ok: false, code: 'BAD_BASE_URL' }
    // The hub token goes in clear over http: only to this machine or a .test / .localhost name
    // (the phase-3 link-client rule).
    const h = u.hostname.toLowerCase()
    if (
      u.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(h) &&
      !h.endsWith('.localhost') &&
      !h.endsWith('.test')
    )
      return { ok: false, code: 'BAD_BASE_URL' }
    base = u.origin
  } catch {
    return { ok: false, code: 'BAD_BASE_URL' }
  }
  let a: Answer
  try {
    a = await once(
      deps.fetch ?? fetch,
      `${base}/api/hub-link/shared-readiness`,
      hubToken,
      { method: 'GET' },
      deps.timeoutMs ?? DEPLOYMENT_LINK_TIMEOUT_MS
    )
  } catch (err) {
    if (err instanceof DeploymentLinkError && err.code === 'LINK_REFUSED')
      return { ok: false, code: 'HUB_LINK_REDIRECT' }
    if (err instanceof DeploymentLinkError && err.code === 'LINK_BAD_ANSWER')
      return { ok: false, code: 'BAD_ANSWER' }
    return { ok: false, code: 'UNREACHABLE' }
  }
  if (a.status === 401 || a.status === 403 || a.status === 429)
    return { ok: false, code: 'HUB_LINK_REFUSED' }
  if (a.status === 404) return { ok: false, code: 'HUB_LINK_MISSING' }
  if (a.status < 200 || a.status >= 300) return { ok: false, code: `HTTP_${a.status}` }
  const fp = (a.body as { key_fp?: unknown } | null)?.key_fp
  if (fp === null || fp === undefined) return { ok: true, fp: null }
  if (typeof fp !== 'string' || !/^[0-9a-f]{32}$/.test(fp)) return { ok: false, code: 'BAD_ANSWER' }
  return { ok: true, fp }
}
