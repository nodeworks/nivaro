/**
 * Link hrefs a rich-text editor may render (review 2026-11-14 L7). Co-edited text arrives from
 * other people's editors; a link mark whose href runs script (`javascript:`, `vbscript:`) or
 * embeds a document (`data:`, `file:`) is never rendered as one — on top of the server emptying
 * it (api services/coedit.ts scrubUnsafeUrls) and the Link extension's own protocol check.
 */

const BLOCKED_SCHEME = /^(?:javascript|data|vbscript|file):/i
/** Characters a browser skips inside a URL scheme ("java\tscript:"): controls, whitespace, the
 *  invisible separators. */
function ignoredInScheme(c: number): boolean {
  return (
    c <= 0x20 ||
    (c >= 0x7f && c <= 0xa0) ||
    c === 0x1680 ||
    c === 0x180e ||
    (c >= 0x2000 && c <= 0x200f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  )
}

function withoutIgnored(v: string): string {
  let out = ''
  for (const ch of v) if (!ignoredInScheme(ch.codePointAt(0) ?? 0)) out += ch
  return out
}

/** May this href be rendered on a link? Empty / missing = yes (a link being made). */
export function isSafeLinkHref(href: unknown): boolean {
  if (href == null || href === '') return true
  if (typeof href !== 'string') return false
  return !BLOCKED_SCHEME.test(withoutIgnored(href))
}
