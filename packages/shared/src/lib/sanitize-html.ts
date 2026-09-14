/**
 * Strip anything executable from stored rich text before it is rendered as
 * HTML. Allowlist posture: only a fixed set of formatting tags survive, URL
 * attributes must carry an http(s)/mailto/tel/relative scheme (checked after
 * control characters and whitespace are removed — `java\tscript:` is the
 * classic bypass), and every other attribute is dropped except a handful of
 * inert ones. Rich-text fields store Tiptap output, which needs nothing more.
 */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'a',
  'span',
  'div',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption'
])
const DROP_WITH_CHILDREN = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'link',
  'meta',
  'svg',
  'math',
  'template',
  'base',
  'noscript'
])
const ALLOWED_ATTRS = new Set(['href', 'title', 'colspan', 'rowspan', 'start', 'type'])
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i

const safeUrl = (raw: string): boolean => {
  // Control characters and whitespace are removed BEFORE the scheme check —
  // browsers ignore them inside a scheme, so `java\tscript:` executes.
  let v = ''
  for (const ch of raw) if (ch.charCodeAt(0) > 32) v += ch
  v = v.toLowerCase()
  if (!v) return true
  if (SAFE_SCHEME.test(v)) return true
  // Relative and fragment links carry no scheme at all.
  return !/^[a-z][a-z0-9+.-]*:/.test(v)
}

export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const walk = (node: Element) => {
    for (const el of [...node.children]) {
      const tag = el.tagName.toLowerCase()
      if (!ALLOWED_TAGS.has(tag)) {
        if (DROP_WITH_CHILDREN.has(tag)) {
          el.remove()
          continue
        }
        // Unknown formatting is unwrapped, its text kept.
        const parent = el.parentNode
        if (parent) {
          while (el.firstChild) parent.insertBefore(el.firstChild, el)
          parent.removeChild(el)
        }
        continue
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase()
        if (!ALLOWED_ATTRS.has(name) || (name === 'href' && !safeUrl(attr.value))) {
          el.removeAttribute(attr.name)
        }
      }
      if (tag === 'a') {
        el.setAttribute('rel', 'noopener noreferrer')
        el.setAttribute('target', '_blank')
      }
      walk(el)
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}
