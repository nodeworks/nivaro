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

/** roleAllowsSignIn for a user row, reading the role. */
export async function signInAllowedByRole(
  user: Pick<User, 'role'> & { account_kind?: string | null }
): Promise<boolean> {
  if (!user.role) return true
  const role = (await db('nivaro_roles').where({ id: user.role }).first('app_access')) as
    | { app_access?: unknown }
    | undefined
  return roleAllowsSignIn(role, user)
}
