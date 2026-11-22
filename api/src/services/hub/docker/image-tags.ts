import { fetchJson } from '../../gitlab-client.js'
import { compareVersions } from '../promote-plan.js'

/**
 * Published release tags of the Nivaro image (Hub phase 4, Decision 11): the first environment of
 * an all-Docker app may take any published x.y.z tag, since nothing before it ran one. Docker Hub's
 * public tags list, read without a token; `-slim` and every other non-x.y.z tag are dropped.
 */

const RELEASE_TAG_RE = /^\d+\.\d+\.\d+$/
const REPO_PART_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/
const TIMEOUT_MS = 15_000

/** Docker Hub's tag list URL for `namespace/name` (one path segment each), else null. */
function tagsUrl(image: string): string | null {
  const parts = image.split('/')
  if (parts.length !== 2 || !parts.every((p) => REPO_PART_RE.test(p))) return null
  return `https://hub.docker.com/v2/repositories/${parts[0]}/${parts[1]}/tags?page_size=100&ordering=last_updated`
}

/** x.y.z tags only, each once, newest (highest) first, at most `limit`. */
export function releaseTags(names: unknown[], limit = 30): string[] {
  const tags = new Set<string>()
  for (const n of names) if (typeof n === 'string' && RELEASE_TAG_RE.test(n)) tags.add(n)
  return [...tags].sort((a, b) => compareVersions(b, a)).slice(0, Math.max(0, limit))
}

/** The image's published x.y.z tags, newest first; [] on any error (never throws). */
export async function listImageVersions(image: string, limit = 30): Promise<string[]> {
  const url = tagsUrl(image)
  if (!url) return []
  try {
    const res = await fetchJson(url, { Accept: 'application/json' }, TIMEOUT_MS)
    if (res.status !== 200) return []
    const results = (res.body as { results?: unknown } | null)?.results
    if (!Array.isArray(results)) return []
    return releaseTags(
      results.map((r) => (r as { name?: unknown } | null)?.name),
      limit
    )
  } catch {
    return []
  }
}
