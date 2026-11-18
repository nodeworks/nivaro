type Row = Record<string, unknown>

/**
 * GitLab text brought into Nivaro (notes, imported issue descriptions): relative links made
 * absolute. A leaf module so inbound.ts and import.ts share it without importing each other.
 */

/** The GitLab project's own page (`https://host/group/project`) for a link. */
export function projectWebUrl(link: Row, conn: { base_url: string }): string {
  const web = String(link.web_url ?? '')
  const cut = web.indexOf('/-/')
  if (/^https?:\/\//i.test(web) && cut > 0) return web.slice(0, cut)
  const path = String(link.project_path ?? '').replace(/^\/+|\/+$/g, '')
  return path ? `${conn.base_url.replace(/\/+$/, '')}/${path}` : ''
}

/**
 * GitLab writes uploads and its own pages as relative links (`![x](/uploads/…)`, `](uploads/…)`,
 * `](/group/project/-/issues/3)`); stored in Nivaro they would point at Nivaro. Uploads become
 * absolute under the project's page, other root-relative paths under the GitLab host, other
 * relative paths under the project. Absolute URLs, `#anchors` and `mailto:` stay. Final review X4.
 */
export function absoluteGitlabLinks(text: string, projectUrl: string): string {
  if (!projectUrl) return text
  let origin = ''
  try {
    origin = new URL(projectUrl).origin
  } catch {
    return text
  }
  const project = projectUrl.replace(/\/+$/, '')
  const resolve = (target: string): string => {
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return target
    if (target.startsWith('//')) return target
    if (/^\/?uploads\//.test(target)) return `${project}/${target.replace(/^\//, '')}`
    if (target.startsWith('/')) return `${origin}${target}`
    return `${project}/${target.replace(/^\.\//, '')}`
  }
  return text
    .replace(/(\]\(\s*)([^)\s]+)/g, (_m, open: string, target: string) => open + resolve(target))
    .replace(
      /(\b(?:src|href)\s*=\s*["'])([^"']*)/gi,
      (_m, open: string, target: string) => open + resolve(target)
    )
}
