import { db } from '../../../db/index.js'
import { hubLinkOrigin } from '../move/link-client.js'
import { openSecret } from '../secrets.js'
import {
  deploymentLinkBearer,
  getShared,
  linkUrlOrigin,
  openSharedPrevToken,
  openSharedToken,
  tenantIdFor
} from '../shared/store.js'

/**
 * Hub side of the people calls (services/hub-link/people.ts on the app):
 *
 *   dedicated  POST {base_url}/api/hub-link/people/{lookup|suspend}          bearer = hub token
 *   shared     POST {link_url}/api/hub-deployment/apps/<tenant>/people/{op}  bearer = HMAC of the
 *              deployment token (the previous token is tried once on a 401 while its grace lasts)
 *
 * The bearer travels only in the Authorization header (https, or plain http to this machine /
 * a private link address — the same rules as every other Hub call), never follows a redirect,
 * each call is bounded (PEOPLE_CALL_TIMEOUT_MS) and an answer is read up to 256 KB. A refusal is
 * a short code (the app's own when it sent one), never the app's message text or a token.
 */

export const PEOPLE_CALL_TIMEOUT_MS = 15_000
const MAX_ANSWER_BYTES = 256 * 1024
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export type PeopleOp = 'lookup' | 'suspend'

/** Where the Hub reaches an environment's people routes. */
export type PeopleTarget =
  | { kind: 'dedicated'; envId: number; base_url: string; token: string | null }
  | {
      kind: 'shared'
      envId: number
      sharedId: number
      link_url: string
      tenantId: string
    }

export interface PeopleAccount {
  user_id: string
  status: string
  role: string | null
  admin: boolean
  matched_by: 'entra' | 'email'
}

export type PeopleCallResult =
  | { ok: true; state?: 'suspended' | 'already' | 'none'; accounts: PeopleAccount[] }
  | { ok: false; code: string; status: number }

export interface PeopleCallDeps {
  fetch?: typeof fetch
  timeoutMs?: number
  /** The shared deployment's token now / previous (tests). */
  sharedTokens?: (id: number) => Promise<{ current: string | null; previous: string | null }>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The environment's people target, or null when the Hub has no link to it. */
export async function peopleTargetOf(env: {
  id: number
  app_id: number
  base_url: string
  hub_token?: string | null
  placement_id?: number | null
}): Promise<PeopleTarget | null> {
  if (env.placement_id != null) {
    const p = (await db('nivaro_hub_placements')
      .where({ id: env.placement_id })
      .first('kind', 'shared_deployment_id')) as
      | { kind: string; shared_deployment_id: number | null }
      | undefined
    if (p?.kind === 'shared' && p.shared_deployment_id != null) {
      const shared = await getShared(Number(p.shared_deployment_id))
      const app = (await db('nivaro_hub_apps').where({ id: env.app_id }).first('key')) as
        | { key: string }
        | undefined
      if (!shared || !app) return null
      return {
        kind: 'shared',
        envId: env.id,
        sharedId: shared.id,
        link_url: shared.link_url,
        tenantId: tenantIdFor({ key: String(app.key) }, { id: env.id })
      }
    }
  }
  if (!env.hub_token) return null
  return { kind: 'dedicated', envId: env.id, base_url: env.base_url, token: env.hub_token }
}

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

async function postOnce(
  doFetch: typeof fetch,
  url: string,
  bearer: string,
  body: unknown,
  ms: number
): Promise<{ status: number; body: unknown } | { error: string }> {
  const ctl = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const run = async () => {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
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

function readAccounts(v: unknown): PeopleAccount[] | null {
  if (!Array.isArray(v) || v.length > 50) return null
  const out: PeopleAccount[] = []
  for (const a of v) {
    if (!isObj(a) || typeof a.user_id !== 'string' || typeof a.status !== 'string') return null
    out.push({
      user_id: a.user_id.slice(0, 64),
      status: a.status.slice(0, 32),
      role: typeof a.role === 'string' ? a.role.slice(0, 200) : null,
      admin: a.admin === true,
      matched_by: a.matched_by === 'entra' ? 'entra' : 'email'
    })
  }
  return out
}

/** One people call to one environment. Never throws. */
export async function callPeople(
  target: PeopleTarget,
  op: PeopleOp,
  body: { emails: string[]; entra: Array<{ oid: string; tid: string | null }> },
  deps: PeopleCallDeps = {}
): Promise<PeopleCallResult> {
  const doFetch = deps.fetch ?? fetch
  const ms = deps.timeoutMs ?? PEOPLE_CALL_TIMEOUT_MS
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
      answer = await postOnce(doFetch, `${base}/api/hub-link/people/${op}`, token, body, ms)
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
      const url = `${base}/api/hub-deployment/apps/${encodeURIComponent(target.tenantId)}/people/${op}`
      answer = await postOnce(doFetch, url, deploymentLinkBearer(tokens.current), body, ms)
      if (
        'status' in answer &&
        answer.status === 401 &&
        tokens.previous &&
        tokens.previous !== tokens.current
      )
        answer = await postOnce(doFetch, url, deploymentLinkBearer(tokens.previous), body, ms)
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
      // No HUB_TOKEN there, or a Nivaro version without the people routes (before 0.3.215).
      return { ok: false, code: 'LINK_MISSING', status: 404 }
    return { ok: false, code: code ?? `HTTP_${answer.status}`, status: answer.status }
  }
  const accounts = isObj(b) ? readAccounts(b.accounts) : null
  if (!accounts) return { ok: false, code: 'LINK_BAD_ANSWER', status: answer.status }
  if (op === 'suspend') {
    const state = isObj(b) ? b.state : null
    if (state !== 'suspended' && state !== 'already' && state !== 'none')
      return { ok: false, code: 'LINK_BAD_ANSWER', status: answer.status }
    return { ok: true, state, accounts }
  }
  return { ok: true, accounts }
}
