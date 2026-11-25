import { hubLinkOrigin } from '../move/link-client.js'
import type { PeopleTarget } from '../people/link-calls.js'
import { openSecret } from '../secrets.js'
import {
  deploymentLinkBearer,
  linkUrlOrigin,
  openSharedPrevToken,
  openSharedToken
} from '../shared/store.js'

/**
 * Hub side of the security calls (routes/hub-link-security.ts on the app):
 *
 *   dedicated  {base_url}/api/hub-link/security/<op>                   bearer = hub token
 *   shared     {link_url}/api/hub-deployment/apps/<tenant>/security/<op>   bearer = HMAC of the
 *              deployment token (the previous one is tried once on a 401)
 *
 * The same rules as every other Hub call (services/hub/people/link-calls.ts): the bearer only in
 * the Authorization header, https (or plain http to this machine / a private link address), no
 * redirects, each call bounded, the answer read up to MAX_ANSWER_BYTES, a refusal reduced to a
 * short code — never the app's message text or a token. The target is the people target
 * (peopleTargetOf): one place decides how the Hub reaches an environment.
 */

export const SECURITY_CALL_TIMEOUT_MS = 20_000
/** 5 000 role holders at ~400 bytes each, with room. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export type SecurityOp = 'role-holders' | 'break-glass' | 'break-glass/revoke'

export type SecurityCallResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; code: string; status: number }

export interface SecurityCallDeps {
  fetch?: typeof fetch
  timeoutMs?: number
  sharedTokens?: (id: number) => Promise<{ current: string | null; previous: string | null }>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ANSWER_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function once(
  doFetch: typeof fetch,
  method: 'GET' | 'POST',
  url: string,
  bearer: string,
  body: unknown,
  ms: number
): Promise<{ status: number; body: unknown } | { error: string }> {
  const ctl = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const run = async () => {
    const res = await doFetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${bearer}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      redirect: 'error',
      signal: ctl.signal
    })
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel().catch(() => {})
      return { error: 'LINK_REDIRECT' }
    }
    const text = await readCapped(res)
    if (text === null) return { error: 'LINK_BAD_ANSWER' }
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = undefined
    }
    return { status: res.status, body: parsed }
  }
  try {
    return await Promise.race([
      run(),
      new Promise<{ error: string }>((resolve) => {
        timer = setTimeout(() => {
          ctl.abort()
          resolve({ error: 'TIMEOUT' })
        }, ms)
      })
    ])
  } catch {
    return { error: 'LINK_UNREACHABLE' }
  } finally {
    clearTimeout(timer)
  }
}

/** One security call to one environment. Never throws. */
export async function callSecurity(
  target: PeopleTarget,
  method: 'GET' | 'POST',
  op: SecurityOp,
  body: unknown = undefined,
  deps: SecurityCallDeps = {}
): Promise<SecurityCallResult> {
  const doFetch = deps.fetch ?? fetch
  const ms = deps.timeoutMs ?? SECURITY_CALL_TIMEOUT_MS
  let answer: { status: number; body: unknown } | { error: string }
  try {
    if (target.kind === 'dedicated') {
      const base = hubLinkOrigin(target.base_url)
      if (!base) return { ok: false, code: 'BAD_BASE_URL', status: 0 }
      let token: string | null
      try {
        token = openSecret(target.token)
      } catch (err) {
        return { ok: false, code: String((err as { code?: unknown }).code), status: 0 }
      }
      if (!token) return { ok: false, code: 'HUB_TOKEN_MISSING', status: 0 }
      answer = await once(doFetch, method, `${base}/api/hub-link/security/${op}`, token, body, ms)
    } else {
      const base = linkUrlOrigin(target.link_url)
      if (!base) return { ok: false, code: 'BAD_LINK_URL', status: 0 }
      const tokens = deps.sharedTokens
        ? await deps.sharedTokens(target.sharedId)
        : {
            current: await openSharedToken(target.sharedId),
            previous: await openSharedPrevToken(target.sharedId)
          }
      if (!tokens.current) return { ok: false, code: 'DEPLOYMENT_TOKEN_MISSING', status: 0 }
      const url = `${base}/api/hub-deployment/apps/${encodeURIComponent(target.tenantId)}/security/${op}`
      answer = await once(doFetch, method, url, deploymentLinkBearer(tokens.current), body, ms)
      if (
        'status' in answer &&
        answer.status === 401 &&
        tokens.previous &&
        tokens.previous !== tokens.current
      )
        answer = await once(doFetch, method, url, deploymentLinkBearer(tokens.previous), body, ms)
    }
  } catch {
    return { ok: false, code: 'LINK_UNREACHABLE', status: 0 }
  }
  if ('error' in answer) return { ok: false, code: answer.error, status: 0 }
  const b = answer.body
  const code = isObj(b) && typeof b.code === 'string' && CODE_RE.test(b.code) ? b.code : null
  if (answer.status < 200 || answer.status >= 300) {
    if (answer.status === 401 || answer.status === 403 || answer.status === 429)
      return { ok: false, code: 'LINK_REFUSED', status: answer.status }
    if (answer.status === 404 && (!code || code === 'NOT_FOUND'))
      // No HUB_TOKEN there, or a Nivaro version without the security routes (before 0.3.215).
      return { ok: false, code: 'LINK_MISSING', status: 404 }
    return { ok: false, code: code ?? `HTTP_${answer.status}`, status: answer.status }
  }
  if (!isObj(b)) return { ok: false, code: 'LINK_BAD_ANSWER', status: answer.status }
  return { ok: true, status: answer.status, body: b }
}
