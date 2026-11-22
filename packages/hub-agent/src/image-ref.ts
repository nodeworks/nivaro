/**
 * Image references the agent takes (ruling P4-34): `<repo>[:<tag>]@sha256:<64 hex>`. The digest
 * pins the image; a tag next to it is informational and never decides anything — every check
 * (the allow-list, a registry's credentials, a pull) reads the repository without it.
 */
const PINNED_RE = /^([^@\s]+)@sha256:([a-f0-9]{64})$/
/** A Docker tag. */
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

export interface PinnedImage {
  /** The repository, without tag or digest. */
  repo: string
  /** The informational tag, or null. */
  tag: string | null
  /** The 64 hex characters of the sha256 digest. */
  hex: string
  /** `<repo>@sha256:<hex>`: what pulls and inspects use. */
  canonical: string
}

/** The parts of a pinned reference, or null when it carries no (well-formed) sha256 digest. */
export function parsePinned(ref: unknown): PinnedImage | null {
  if (typeof ref !== 'string') return null
  const m = PINNED_RE.exec(ref)
  if (!m) return null
  let repo = m[1]
  let tag: string | null = null
  // A tag is the part after the last ':' that follows the last '/' (a registry port comes before).
  const colon = repo.lastIndexOf(':')
  if (colon > repo.lastIndexOf('/')) {
    tag = repo.slice(colon + 1)
    if (!TAG_RE.test(tag)) return null
    repo = repo.slice(0, colon)
  }
  if (!repo) return null
  return { repo, tag, hex: m[2], canonical: `${repo}@sha256:${m[2]}` }
}
