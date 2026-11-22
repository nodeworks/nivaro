import { clientUsable, type HubOidcClient } from './clients.js'

/**
 * Nivaro Hub phase 7: the authorize request check (pure; plan Task 4, Review Focus 2).
 *
 * Order:
 *  1. the client is known                            else an error PAGE
 *  2. redirect_uri is EXACTLY one of its derived URIs else an error PAGE (no normalisation: case,
 *     encoding, a trailing slash or an explicit port all miss)
 *  Only now is redirect_uri trusted, so every later error goes back to it as a redirect:
 *  3. response_type = code                            unsupported_response_type
 *  4. scope contains openid                           invalid_scope
 *  5. PKCE: method S256, challenge 43 base64url chars invalid_request
 *  6. state (≤ 512) and nonce (≤ 256) present         invalid_request
 *  7. the client may be used (clientUsable)          unauthorized_client
 *
 * A parameter sent twice arrives as an array and reads as missing (RFC 6749 §3.1).
 */

export interface AuthorizeParams {
  client_id: string
  redirect_uri: string
  response_type: string
  scope: string
  /** Empty when missing or too long, so it is never echoed back. */
  state: string
  nonce: string
  code_challenge: string
  code_challenge_method: string
  prompt: string
}

export type AuthorizeCheck =
  | { ok: true; p: AuthorizeParams }
  | { ok: false; redirect: false; message: string }
  | { ok: false; redirect: true; error: string; description: string; p: AuthorizeParams }

const MAX_STATE = 512
const MAX_NONCE = 256
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/

const str = (v: unknown, max = 2048): string => (typeof v === 'string' && v.length <= max ? v : '')

export function readAuthorizeParams(q: Record<string, unknown>): AuthorizeParams {
  return {
    client_id: str(q.client_id, 64),
    redirect_uri: str(q.redirect_uri),
    response_type: str(q.response_type, 64),
    scope: str(q.scope, 512),
    state: str(q.state, MAX_STATE),
    nonce: str(q.nonce, MAX_NONCE),
    code_challenge: str(q.code_challenge, 128),
    code_challenge_method: str(q.code_challenge_method, 16),
    prompt: str(q.prompt, 128)
  }
}

export function checkAuthorizeRequest(
  q: Record<string, unknown>,
  client: HubOidcClient | null
): AuthorizeCheck {
  const p = readAuthorizeParams(q ?? {})
  if (!client || !p.client_id || client.client_id !== p.client_id)
    return {
      ok: false,
      redirect: false,
      message: 'This app is not registered with the Hub for sign-in.'
    }
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri))
    return {
      ok: false,
      redirect: false,
      message: "The app's return address is not one the Hub knows for it."
    }

  const fail = (error: string, description: string): AuthorizeCheck => ({
    ok: false,
    redirect: true,
    error,
    description,
    p
  })
  if (p.response_type !== 'code')
    return fail('unsupported_response_type', 'Only response_type=code is supported.')
  if (!p.scope.split(/\s+/).includes('openid'))
    return fail('invalid_scope', 'The openid scope is required.')
  if (p.code_challenge_method !== 'S256' || !CHALLENGE_RE.test(p.code_challenge))
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.')
  if (!p.state) return fail('invalid_request', 'state is required (at most 512 characters).')
  if (!p.nonce) return fail('invalid_request', 'nonce is required (at most 256 characters).')
  if (!clientUsable(client))
    return fail('unauthorized_client', 'This app does not sign in through the Hub right now.')
  return { ok: true, p }
}
