import type { User } from '../../types.js'
import { readableRegions, resolveRegionSource } from './regions.js'

/**
 * The region ids (upper-cased) this person may focus the board on. A `region` outside it is
 * dropped by ccReadAuth, so a free-form value never fans out into per-region work.
 */
export async function readableRegionIds(user: User): Promise<Set<string>> {
  try {
    const source = await resolveRegionSource()
    if (!source) return new Set()
    return new Set((await readableRegions(user, source)).map((r) => r.id.toUpperCase()))
  } catch {
    return new Set()
  }
}
