import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'

/**
 * A comment mirrored in from GitLab carries `meta = {"tracker":{link, note_id, author}}` (written
 * by inbound.ts as the GitLab machine user). The comment list shows it with a GitLab badge and
 * the GitLab author's name — only the name leaves the server, never the link or note ids.
 * The badge stays when GitLab sync is later turned off: the comment still came from GitLab.
 */

export interface CommentTrackerBadge {
  provider: 'gitlab'
  author: string | null
}

export function trackerBadgeOf(meta: unknown): CommentTrackerBadge | null {
  if (meta == null || meta === '') return null
  let parsed: unknown = meta
  if (typeof meta === 'string') {
    try {
      parsed = JSON.parse(meta)
    } catch {
      return null
    }
  }
  const t = (parsed as { tracker?: unknown } | null)?.tracker
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null
  const author = (t as { author?: unknown }).author
  return {
    provider: 'gitlab',
    author: typeof author === 'string' && author.trim() ? author.trim().slice(0, 200) : null
  }
}

const MISS_TTL_MS = 60_000
const probes = new Map<string, { hit: boolean; at: number }>()

/** Does nivaro_comments have the `meta` column (migration 532)? A hit is kept; a miss for 60 s. */
export async function hasCommentMetaColumn(): Promise<boolean> {
  const key = getTenantId() ?? ''
  const state = probes.get(key)
  if (state?.hit) return true
  if (state && Date.now() - state.at < MISS_TTL_MS) return false
  let hit = false
  try {
    hit = await db.schema.hasColumn('nivaro_comments', 'meta')
  } catch {
    hit = false
  }
  probes.set(key, { hit, at: Date.now() })
  return hit
}
