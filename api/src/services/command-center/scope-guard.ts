import type { User } from '../../types.js'
import { readableRegions, resolveRegionSource } from './regions.js'

/**
 * The region ids (upper-cased) this person may focus the board on. A `region` outside it is
 * dropped by ccReadAuth, so a free-form value never fans out into per-region work.
 */
/**
 * The region ids `user` may focus on. An empty set = this instance has no regions (or the
 * person may read none); null = the lookup failed, which a caller that must not widen (a
 * wallboard pinned to one region) treats as a refusal.
 */
export async function readableRegionIds(user: User): Promise<Set<string> | null> {
  try {
    const source = await resolveRegionSource()
    if (!source) return new Set()
    return new Set((await readableRegions(user, source)).map((r) => r.id.toUpperCase()))
  } catch {
    return null
  }
}
