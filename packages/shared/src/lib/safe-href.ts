// Link targets authored by people (chat channel pins, page-builder markdown)
// may be an http(s) URL or an in-app path. An in-app path starts with ONE
// slash: `//host` and `/\host` are scheme-relative links to another site
// (security audit 2026-10-27). Anything else (javascript:, data:, …) is no link.

/** True for an in-app path: one leading slash, no backslash, no whitespace. */
export function isInAppPath(href: string): boolean {
  return /^\/(?![/\\])/.test(href) && !/[\s\\]/.test(href)
}

/** 'internal' for an in-app path, 'external' for http(s), null for anything else. */
export function safeLinkKind(href: string): 'internal' | 'external' | null {
  if (/^https?:\/\/\S+$/i.test(href)) return 'external'
  if (isInAppPath(href)) return 'internal'
  return null
}
