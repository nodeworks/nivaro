import { type DockerDriverRow, DriverMisconfiguredError, STACK_NAME_RE } from '../drivers.js'
import { openSecret } from '../secrets.js'
import {
  AGENT_API_VERSION,
  type AgentFieldError,
  type AgentHealth,
  type StackApplyResult,
  type StackRemoveResult,
  type StackRestartResult,
  type StackSpec,
  type StackStatus
} from './agent-types.js'
import { agentOrigin } from './driver-config.js'

/**
 * The Hub's client for the Hub agent (phase 4, plan "Wire contract"). The agent is the only
 * process that writes to a Docker engine; the API only ever talks to it over this client.
 *
 * Every call: the driver's agent token, opened here for that one call and sent only in the
 * Authorization header; `redirect: 'error'`; a bounded timeout. Errors are AgentError with a
 * code, the HTTP status and the agent's field list — never the token, the URL's query or the
 * agent's body text.
 */

export const AGENT_TIMEOUTS = {
  health: 5_000,
  stack: 10_000,
  apply: 300_000,
  restart: 30_000,
  remove: 120_000
} as const

/** Longest answer body the client reads (a status of a large stack stays far below it). */
const MAX_BODY_BYTES = 4 * 1024 * 1024

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/

export type AgentErrorCode =
  | 'AGENT_UNREACHABLE'
  | 'AGENT_REFUSED'
  | 'AGENT_REDIRECT'
  | 'AGENT_INCOMPATIBLE'
  | 'BAD_STACK_NAME'
  | (string & {})

export class AgentError extends Error {
  code: AgentErrorCode
  /** HTTP status of the agent's answer; 0 when there was none. */
  status: number
  fields?: AgentFieldError[]
  constructor(code: AgentErrorCode, status: number, message: string, fields?: AgentFieldError[]) {
    super(message)
    this.name = 'AgentError'
    this.code = code
    this.status = status
    if (fields?.length) this.fields = fields
  }
  toJSON() {
    return { code: this.code, status: this.status, message: this.message, fields: this.fields }
  }
}

/** What the client needs of a driver: its config and sealed token. */
export type AgentDriver = Pick<DockerDriverRow, 'config' | 'secret'>

type Call = {
  /** For messages: what was asked ("health", "apply efp-prod"). */
  what: string
  method: 'GET' | 'PUT' | 'POST' | 'DELETE'
  path: string
  query?: Record<string, string>
  body?: unknown
  timeoutMs: number
}

function stackPath(name: string): string {
  if (typeof name !== 'string' || !STACK_NAME_RE.test(name))
    throw new AgentError('BAD_STACK_NAME', 0, 'The stack name is not one the Hub agent accepts')
  return `/v1/stacks/${name}`
}

/** Only `{ field, code }` text pairs survive, at most 50 — no other agent text. */
function cleanFields(raw: unknown): AgentFieldError[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: AgentFieldError[] = []
  for (const f of raw.slice(0, 50)) {
    const field = (f as { field?: unknown } | null)?.field
    const code = (f as { code?: unknown } | null)?.code
    if (typeof field === 'string' && typeof code === 'string')
      out.push({ field: field.slice(0, 200), code: code.slice(0, 64) })
  }
  return out.length ? out : undefined
}

function isRedirectError(err: unknown): boolean {
  const seen = new Set<unknown>()
  let e: unknown = err
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e)
    const msg = (e as { message?: unknown }).message
    if (typeof msg === 'string' && /redirect/i.test(msg)) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

const isAbort = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * The answer's JSON, read with a byte count: past MAX_BODY_BYTES the read stops and the body
 * counts as unreadable (undefined), as does a body that is not JSON. A timeout while reading
 * throws (the caller turns it into AGENT_UNREACHABLE).
 */
async function readBody(res: Response): Promise<unknown> {
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!res.body) return undefined
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(value)
    }
  } catch (err) {
    if (isAbort(err)) throw err
    return undefined
  }
  if (!bytes) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** One agent call; resolves the parsed 2xx body, or null for a 404 when `notFoundNull`. */
async function call<T>(driver: AgentDriver, c: Call, notFoundNull = false): Promise<T | null> {
  const origin = agentOrigin(driver?.config?.agent_url)
  if (!origin) throw new DriverMisconfiguredError('The Docker driver has no usable agent address.')
  const url = new URL(c.path, `${origin}/`)
  for (const [k, v] of Object.entries(c.query ?? {})) url.searchParams.set(k, v)
  const at = `the Hub agent at ${origin}`
  const unreachable = (err: unknown, status: number) =>
    new AgentError(
      'AGENT_UNREACHABLE',
      status,
      isAbort(err)
        ? `${at} did not answer ${c.what} within ${Math.round(c.timeoutMs / 1000)} s`
        : `${at} could not be reached for ${c.what}`
    )

  let res: Response
  try {
    const token = openSecret(driver.secret)
    if (!token) throw new DriverMisconfiguredError('The Docker driver has no agent token.')
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json'
    }
    if (c.body !== undefined) headers['content-type'] = 'application/json'
    res = await fetch(url, {
      method: c.method,
      headers,
      body: c.body === undefined ? undefined : JSON.stringify(c.body),
      redirect: 'error',
      signal: AbortSignal.timeout(c.timeoutMs)
    })
  } catch (err) {
    // Our own refusals (no token, unreadable seal) pass through; they carry no token either.
    const code = (err as { code?: unknown } | null)?.code
    if (
      err instanceof DriverMisconfiguredError ||
      (typeof code === 'string' && code.startsWith('HUB_SECRET')) ||
      code === 'HUB_NEEDS_ENCRYPTION_KEY'
    )
      throw err
    if (isRedirectError(err))
      throw new AgentError('AGENT_REDIRECT', 0, `${at} answered ${c.what} with a redirect`)
    throw unreachable(err, 0)
  }

  const status = res.status
  if (status >= 300 && status < 400) {
    await res.body?.cancel().catch(() => undefined)
    throw new AgentError('AGENT_REDIRECT', status, `${at} answered ${c.what} with a redirect`)
  }
  let body: unknown
  try {
    body = await readBody(res)
  } catch (err) {
    throw unreachable(err, status)
  }
  if (status === 401 || status === 429)
    throw new AgentError(
      'AGENT_REFUSED',
      status,
      status === 401
        ? `${at} refused the Hub's token (${c.what})`
        : `${at} is refusing the Hub for now: too many bad tokens (${c.what})`
    )
  if (status === 404 && notFoundNull) return null
  if (status < 200 || status >= 300) {
    const raw = (body as { code?: unknown } | null)?.code
    const code = typeof raw === 'string' && CODE_RE.test(raw) ? raw : 'AGENT_ERROR'
    const fields = cleanFields((body as { fields?: unknown } | null)?.fields)
    throw new AgentError(code, status, `${at} refused ${c.what}: ${code} (${status})`, fields)
  }
  if (body === undefined || body === null || typeof body !== 'object')
    throw new AgentError(
      'AGENT_INCOMPATIBLE',
      status,
      `${at} answered ${c.what} with something other than the agent's JSON`
    )
  return body as T
}

/** `GET /v1/health` (5 s). Refuses an agent speaking another API version. */
export async function agentHealth(
  driver: AgentDriver,
  opts: { timeoutMs?: number } = {}
): Promise<AgentHealth> {
  const h = (await call<AgentHealth>(driver, {
    what: 'health',
    method: 'GET',
    path: '/v1/health',
    timeoutMs: opts.timeoutMs ?? AGENT_TIMEOUTS.health
  })) as AgentHealth
  if (h.api !== AGENT_API_VERSION) {
    const api = typeof h.api === 'number' || typeof h.api === 'string' ? String(h.api) : 'none'
    throw new AgentError(
      'AGENT_INCOMPATIBLE',
      200,
      `The Hub agent speaks API ${api.slice(0, 16)}; this Hub needs API ${AGENT_API_VERSION}`
    )
  }
  return h
}

/** `GET /v1/stacks/:name` (10 s); null when the agent has no such stack (404). */
export async function agentStack(
  driver: AgentDriver,
  name: string,
  expect?: string
): Promise<StackStatus | null> {
  return call<StackStatus>(
    driver,
    {
      what: `the status of ${name}`,
      method: 'GET',
      path: stackPath(name),
      query: expect ? { expect } : undefined,
      timeoutMs: AGENT_TIMEOUTS.stack
    },
    true
  )
}

/** `PUT /v1/stacks/:name` (300 s): the agent pulls, validates and applies; answers at once (202). */
export async function agentApply(
  driver: AgentDriver,
  name: string,
  spec: StackSpec
): Promise<StackApplyResult> {
  return (await call<StackApplyResult>(driver, {
    what: `apply ${name}`,
    method: 'PUT',
    path: stackPath(name),
    body: spec,
    timeoutMs: AGENT_TIMEOUTS.apply
  })) as StackApplyResult
}

/** `POST /v1/stacks/:name/restart` (30 s). */
export async function agentRestart(driver: AgentDriver, name: string): Promise<StackRestartResult> {
  return (await call<StackRestartResult>(driver, {
    what: `restart ${name}`,
    method: 'POST',
    path: `${stackPath(name)}/restart`,
    timeoutMs: AGENT_TIMEOUTS.restart
  })) as StackRestartResult
}

/** `DELETE /v1/stacks/:name?confirm=<name>` (120 s); volumes only with `removeVolumes`. */
export async function agentRemove(
  driver: AgentDriver,
  name: string,
  opts: { removeVolumes: boolean }
): Promise<StackRemoveResult> {
  const query: Record<string, string> = { confirm: name }
  if (opts.removeVolumes) query.remove_volumes = '1'
  return (await call<StackRemoveResult>(driver, {
    what: `remove ${name}`,
    method: 'DELETE',
    path: stackPath(name),
    query,
    timeoutMs: AGENT_TIMEOUTS.remove
  })) as StackRemoveResult
}
