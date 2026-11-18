/** Leaf module: no imports (services/users.ts re-exports it). */

/** Credentials and identity-provider links that never leave the server on a user's own row. */
export const USER_CREDENTIAL_FIELDS = [
  'static_token',
  'password_hash',
  'totp_secret',
  'external_id'
] as const

/**
 * A user row as the API answers it about a person (security audit H6): no static token,
 * password hash, TOTP secret or IdP subject. A token in a response survives sign-out and is one
 * XSS away from theft, a narrow API key must not read its owner's full token, and a View-as
 * admin must not receive the target's hash. `has_static_token` says whether a token exists;
 * clients that used it for sockets mint a one-time ws token instead.
 */
export function withoutCredentials<T extends Record<string, unknown>>(
  user: T
): Omit<T, (typeof USER_CREDENTIAL_FIELDS)[number]> & { has_static_token: boolean } {
  const out: Record<string, unknown> = { ...user }
  for (const f of USER_CREDENTIAL_FIELDS) delete out[f]
  // A row that was already stripped keeps the answer it carries (idempotent).
  out.has_static_token =
    'static_token' in user ? !!user.static_token : user.has_static_token === true
  return out as Omit<T, (typeof USER_CREDENTIAL_FIELDS)[number]> & { has_static_token: boolean }
}
