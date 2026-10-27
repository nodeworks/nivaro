import type { User } from '../types.js'
import { can, getAllowedFields } from './permissions.js'

/**
 * Field-level reads for history (H2, security audit 2026-10-27).
 *
 * A revision snapshot holds EVERY column the row had, so a reader who may
 * open the record but not every field of it must get the snapshot cut to the
 * fields their read policy lists — the same list a record read projects to.
 * `null` = no cut (an admin role, or a policy with every field).
 */
export async function readableFieldSet(
  user: User,
  collection: string
): Promise<Set<string> | null> {
  const allowed = await getAllowedFields(user, 'read', collection)
  if (allowed === null || allowed.includes('*')) return null
  return new Set(['id', ...allowed])
}

/** The object with only the keys in `fields` (null = unchanged). */
export function pickFields<T extends Record<string, unknown> | null | undefined>(
  obj: T,
  fields: Set<string> | null
): T {
  if (!fields || obj == null || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (fields.has(k)) out[k] = v
  return out as T
}

/** Field NAMES the caller may read, in the given order. */
export function keepReadable(names: string[], fields: Set<string> | null): string[] {
  return fields ? names.filter((n) => fields.has(n)) : names
}

interface RevisionLike {
  data?: Record<string, unknown> | null
  delta?: Record<string, unknown> | null
  comment?: string | null
  action?: string | null
}

/**
 * A record's history as `user` may read it: every snapshot and delta cut to
 * the record collection's readable fields, and the child snapshot an
 * `o2m-*` activity row carries in its comment cut to the CHILD collection's
 * (dropped when the child collection is not readable at all).
 */
export async function revisionsForReader<T extends RevisionLike>(
  user: User,
  collection: string,
  revisions: T[]
): Promise<T[]> {
  const own = await readableFieldSet(user, collection)
  const childSets = new Map<string, Promise<Set<string> | null | false>>()
  const childFields = (child: string) => {
    let hit = childSets.get(child)
    if (!hit) {
      hit = (async () => {
        if (!(await can(user, 'read', child))) return false as const
        return readableFieldSet(user, child)
      })()
      childSets.set(child, hit)
    }
    return hit
  }
  const out: T[] = []
  for (const rev of revisions) {
    const next = { ...rev }
    if (rev.data != null) next.data = pickFields(rev.data, own)
    if (rev.delta != null) next.delta = pickFields(rev.delta, own)
    if (typeof rev.comment === 'string' && /^o2m-/.test(String(rev.action ?? ''))) {
      next.comment = await o2mCommentForReader(rev.comment, childFields)
    }
    out.push(next)
  }
  return out
}

async function o2mCommentForReader(
  comment: string,
  childFields: (child: string) => Promise<Set<string> | null | false>
): Promise<string> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(comment) as Record<string, unknown>
  } catch {
    return comment
  }
  if (!parsed || typeof parsed !== 'object' || !('snapshot' in parsed)) return comment
  const child = typeof parsed.child_collection === 'string' ? parsed.child_collection : ''
  const fields = child ? await childFields(child) : false
  if (fields === false) {
    const { snapshot: _drop, ...rest } = parsed
    return JSON.stringify(rest)
  }
  return JSON.stringify({
    ...parsed,
    snapshot: pickFields(parsed.snapshot as Record<string, unknown> | null, fields)
  })
}
