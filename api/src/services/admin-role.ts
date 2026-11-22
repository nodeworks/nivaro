import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

/**
 * The Administrator role a brand-new install gets: admin access and app access. Inserted by
 * cloud provisioning (routes/admin/provision.ts) and by the Hub's first-admin call on an app
 * whose fresh database has no admin role yet (services/hub-link/first-admin.ts) — one definition
 * for both. Answers the new role's id.
 */
export const ADMINISTRATOR_ROLE_NAME = 'Administrator'

export async function insertAdministratorRole(
  k: Knex,
  opts: { workspace?: string | null; name?: string } = {}
): Promise<string> {
  const id = randomUUID()
  await k('nivaro_roles').insert({
    id,
    name: opts.name ?? ADMINISTRATOR_ROLE_NAME,
    admin_access: true,
    app_access: true,
    ...(opts.workspace ? { workspace: opts.workspace } : {})
  })
  return id
}
