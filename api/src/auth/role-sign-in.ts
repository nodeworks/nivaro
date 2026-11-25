import { db } from '../db/index.js'
import type { User } from '../types.js'
/**
 * A role with app access off (nivaro_roles.app_access = false) keeps every
 * PERSON in it out — identity-provider sign-in, password, tokens, sessions
 * and View-as alike (EFP's Vendor role). Machine accounts (account_kind set:
 * integrations, bots, services) are what such a role is for, and still
 * authenticate with their own credential. No role = not judged here.
 */
export function roleAllowsSignIn(
  role: { app_access?: unknown } | null | undefined,
  user: { account_kind?: string | null }
): boolean {
  if (!role) return true
  if (role.app_access !== false && role.app_access !== 0) return true
  return !!user.account_kind
}

/**
 * The Hub smoke identity's own account kind (services/hub-link/verify.ts makes the only such row;
 * it is not one of the kinds an administrator may set, ACCOUNT_KINDS). An account of this kind
 * is never signed in interactively — no session, password, identity-provider or token sign-in, no
 * password setup, no View-as, no OAuth/device grant, no SCIM change. It acts only through the
 * temporary API key its own code mints, which this gate never judges. Every other kind
 * (service logins included) signs in exactly as before.
 */
export const HUB_SMOKE_KIND = 'hub_smoke'

export function isHubSmokeAccount(
  user: { account_kind?: string | null } | null | undefined
): boolean {
  return String(user?.account_kind ?? '').toLowerCase() === HUB_SMOKE_KIND
}

/** roleAllowsSignIn for a user row, reading the role; the Hub smoke identity never signs in. */
export async function signInAllowedByRole(
  user: Pick<User, 'role'> & { account_kind?: string | null }
): Promise<boolean> {
  if (isHubSmokeAccount(user)) return false
  if (!user.role) return true
  const role = (await db('nivaro_roles').where({ id: user.role }).first('app_access')) as
    | { app_access?: unknown }
    | undefined
  return roleAllowsSignIn(role, user)
}
