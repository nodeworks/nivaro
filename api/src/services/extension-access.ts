import type { Knex } from 'knex'
import type { User } from '../types.js'
import { applyRowFilter, can, getRowFilter } from './permissions.js'

/**
 * The role half of "may this person read these rows", for an extension's own
 * raw-SQL read model (`ctx.access.readFilter`): whether the role reads the
 * collection at all, and its row filter applied to a query whose rows of that
 * collection sit under `alias`. User Scopes are NOT included — the extension
 * applies its own dimensions. Admins read everything, unfiltered.
 */
export async function readFilterFor(
  user: unknown,
  collection: string
): Promise<{ allowed: boolean; apply(qb: Knex.QueryBuilder, alias: string): void }> {
  const u = user as User | null | undefined
  const none = { allowed: false, apply: () => {} }
  if (!u?.id) return none
  if (!(await can(u, 'read', collection))) return none
  const conditions = await getRowFilter(u, 'read', collection)
  if (!conditions?.length) return { allowed: true, apply: () => {} }
  return {
    allowed: true,
    apply: (qb, alias) =>
      applyRowFilter(
        qb,
        conditions.map((c) => ({ ...c, field: `${alias}.${c.field}` })),
        u
      )
  }
}
