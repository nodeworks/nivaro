/**
 * One gate for every path that STARTS or ADVANCES a pipeline instance.
 *
 * Before this, the REST start/transition routes, the GraphQL start/transition
 * mutations and bulk transitions only required a signed-in user: anyone could
 * start or move a pipeline on a record they had no update permission on, or
 * could not even see (row filters, User Scopes, tree permissions).
 *
 * The rule, everywhere:
 *   1. Admins pass.
 *   2. An addendum instance is judged on its PARENT record (that is what the
 *      record form shows and what every pipeline rule reads).
 *   3. Other system collections are admin-only.
 *   4. The caller holds `update` on the collection (403 otherwise).
 *   5. The caller can READ the record as themselves — readOne narrows by the
 *      row filter and User Scopes and answers null for an invisible row; an
 *      invisible record is a 404, never a 403 (no existence leak).
 */
import type { User } from '../types.js'
import { ADDENDUM_COLLECTION, resolvePipelineSubject } from './pipeline-subject.js'

export class InstanceAccessError extends Error {
  statusCode: 403 | 404
  constructor(statusCode: 403 | 404, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

export interface GuardDeps {
  can: (user: User, action: 'read' | 'update', collection: string) => Promise<boolean>
  readOne: (user: User, collection: string, id: string) => Promise<unknown>
  subject: (collection: string, item: string) => Promise<{ collection: string; itemId: string }>
}

async function defaultDeps(): Promise<GuardDeps> {
  const [{ can }, items] = await Promise.all([import('./permissions.js'), import('./items.js')])
  return {
    can: (u, a, c) => can(u, a, c),
    readOne: async (u, c, id) => {
      try {
        return await items.readOne(u, c, id, undefined, ['id'])
      } catch (err) {
        if (err instanceof items.ForbiddenError) throw new InstanceAccessError(403, FORBIDDEN)
        // Not found / unreadable collection → treat as invisible.
        return null
      }
    },
    subject: (c, i) => resolvePipelineSubject(c, i)
  }
}

const FORBIDDEN = 'You do not have permission to change this record'
const NOT_FOUND = 'Record not found'

/**
 * Throws InstanceAccessError unless `user` may start or move the pipeline on
 * (collection, item). `deps` exists for unit tests.
 */
export async function assertInstanceAccess(
  user: User | null | undefined,
  isAdmin: boolean,
  collection: string,
  item: string,
  deps?: GuardDeps,
  action: 'read' | 'update' = 'update'
): Promise<void> {
  if (isAdmin) return
  if (!user) throw new InstanceAccessError(403, FORBIDDEN)
  const d = deps ?? (await defaultDeps())
  let target = { collection, itemId: String(item) }
  if (collection === ADDENDUM_COLLECTION) {
    target = await d.subject(collection, String(item))
    // An addendum with no resolvable parent has nothing a non-admin can own.
    if (target.collection === ADDENDUM_COLLECTION) throw new InstanceAccessError(404, NOT_FOUND)
  }
  if (target.collection.startsWith('nivaro_') || target.collection.startsWith('directus_'))
    throw new InstanceAccessError(403, FORBIDDEN)
  if (!(await d.can(user, action, target.collection))) throw new InstanceAccessError(403, FORBIDDEN)
  const row = await d.readOne(user, target.collection, target.itemId)
  if (row == null) throw new InstanceAccessError(404, NOT_FOUND)
}

/** Boolean form for loops (bulk transitions): true = allowed. */
export async function instanceAccessAllowed(
  user: User | null | undefined,
  isAdmin: boolean,
  collection: string,
  item: string,
  action: 'read' | 'update' = 'update'
): Promise<boolean> {
  try {
    await assertInstanceAccess(user, isAdmin, collection, item, undefined, action)
    return true
  } catch (err) {
    if (err instanceof InstanceAccessError) return false
    throw err
  }
}
