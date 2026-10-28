/**
 * `{{path}}` placeholders in flow operation options, rendered for where the text goes (M26,
 * security audit 2026-10-27). A record value must never change the SHAPE of what it lands in:
 *
 *  - plain text (log lines, subjects, transform templates): the value as text — unchanged;
 *  - URLs: a value inside one path segment / query key or value / the fragment is
 *    percent-encoded; a placeholder that fills a whole part (origin, whole path, whole query)
 *    stays usable — see `resolveUrlTemplate`; `{{ path | raw }}` opts one placeholder out;
 *  - JSON bodies: inside a string literal the value is JSON-escaped; outside one it becomes
 *    exactly ONE JSON value (a string that already is a JSON value — `12`, `true`, `{"a":1}` —
 *    is kept, so templates that build whole objects from a value keep working);
 *  - form bodies: the value is percent-encoded;
 *  - HTML mail bodies: the value is HTML-escaped; `{{ path | raw }}` opts one placeholder out.
 *
 * The placeholder grammar is the executor's original one: `{{` + one or more non-`}` chars +
 * `}}`; a path that resolves to null/undefined renders empty (JSON: `null`).
 */

type FlowData = Record<string, unknown>

export function getByPath(obj: unknown, path: string): unknown {
  const keys = path.split('.')
  let cur: unknown = obj
  for (let i = 0; i < keys.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    // Literal dotted keys win — item-read results store relation paths flat
    // ('creator.email'), so check the remaining path as one key first.
    const rest = keys.slice(i).join('.')
    if (rest in (cur as Record<string, unknown>)) return (cur as Record<string, unknown>)[rest]
    cur = (cur as Record<string, unknown>)[keys[i]]
  }
  return cur
}

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g

const text = (val: unknown): string => (val !== undefined && val !== null ? String(val) : '')

/** Plain text: the value as text. */
export function resolveTemplate(template: string, data: FlowData): string {
  return template.replace(PLACEHOLDER_RE, (_, path: string) => text(getByPath(data, path.trim())))
}

/** `{{ path | raw }}` → { path, raw: true }. */
function splitRaw(inner: string): { path: string; raw: boolean } {
  const m = /\|\s*raw\s*$/.exec(inner)
  return { path: (m ? inner.slice(0, m.index) : inner).trim(), raw: Boolean(m) }
}

/** A value that is a whole path: each segment percent-encoded, the slashes kept. */
const encodePath = (value: string): string => value.split('/').map(encodeURIComponent).join('/')

/**
 * A URL template. A value lands percent-encoded where it fills part of the URL — one path
 * segment, a query key or value, the fragment — so it can never add a segment or a parameter.
 * A placeholder that fills a whole part keeps working (review A4, 2026-10-27):
 *
 *  - the scheme + host, or the whole origin (`https://{{host}}/…`, `{{base}}/…`): as is;
 *  - right after the origin with nothing between (`{{base}}{{path}}`): as is;
 *  - the whole query (`?{{qs}}`, `&{{more}}` up to the next `&`/`#`/end): as is;
 *  - the whole path after the root slash (`https://h/{{path}}`, `/{{path}}`): slashes kept,
 *    each segment encoded;
 *  - `{{ path | raw }}` anywhere: as is.
 */
export function resolveUrlTemplate(template: string, data: FlowData): string {
  let rawUntil = 0
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(template)
  if (scheme) {
    const rest = template.slice(scheme[0].length).search(/[/?#]/)
    rawUntil = rest < 0 ? template.length : scheme[0].length + rest
  } else if (template.startsWith('{{')) {
    // The whole origin (or the whole URL) comes from the data.
    const close = template.indexOf('}}')
    rawUntil = close < 0 ? 0 : close + 2
  }
  const queryAt = template.indexOf('?', rawUntil)
  const hashAt = template.indexOf('#', rawUntil)
  const endsPart = (ch: string | undefined, chars: string) => ch === undefined || chars.includes(ch)
  return template.replace(PLACEHOLDER_RE, (match: string, inner: string, offset: number) => {
    const { path, raw } = splitRaw(inner)
    const value = text(getByPath(data, path))
    const end = offset + match.length
    if (raw || end <= rawUntil) return value
    // Right after the origin: the data supplies the whole path (and maybe the query).
    if (offset === rawUntil && rawUntil > 0) return value
    const before = template[offset - 1]
    const after = template[end]
    const beforeHash = hashAt < 0 || offset < hashAt
    const inQuery = queryAt >= 0 && offset > queryAt && beforeHash
    if (inQuery && (before === '?' || before === '&') && endsPart(after, '&#')) return value
    const inPath = (queryAt < 0 || offset < queryAt) && beforeHash
    if (inPath && offset === rawUntil + 1 && template[rawUntil] === '/' && endsPart(after, '?#')) {
      return encodePath(value)
    }
    return encodeURIComponent(value)
  })
}

/** `a=1&b=2` bodies: every value percent-encoded. */
export function resolveFormTemplate(template: string, data: FlowData): string {
  return template.replace(PLACEHOLDER_RE, (_, path: string) =>
    encodeURIComponent(text(getByPath(data, path.trim())))
  )
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])

// Rich-text allow-list — the server twin of packages/shared lib/sanitize-html.ts (which needs a
// DOMParser). Tags outside the list are dropped (text kept), the DROP list loses its content
// too, and every attribute is dropped except href (http/https/mailto/tel/relative) and a few
// inert ones. Text between tags is re-escaped, so a half-written tag can never open one.
const RICH_TAGS = new Set([
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
const RICH_DROP_RE =
  /<(script|style|iframe|object|embed|form|svg|math|template|noscript|textarea|title)\b[\s\S]*?<\/\1\s*>/gi
const RICH_ATTRS = new Set(['href', 'title', 'colspan', 'rowspan', 'start', 'type'])
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

const NAMED_REFS: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  nbsp: ' '
}

/** An attribute value as the browser reads it (character references decoded). */
function decodeRefs(v: string): string {
  return v.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ref: string) => {
    const r = ref.toLowerCase()
    if (r.startsWith('#x')) return String.fromCodePoint(Number.parseInt(r.slice(2), 16) || 0)
    if (r.startsWith('#')) return String.fromCodePoint(Number(r.slice(1)) || 0)
    return NAMED_REFS[r] ?? m
  })
}

function safeHref(raw: string): boolean {
  const decoded = decodeRefs(raw)
  // An unknown reference could hide a scheme: refuse rather than guess.
  if (/&[a-z]+;/i.test(decoded)) return false
  let v = ''
  for (const ch of decoded) if (ch.charCodeAt(0) > 32) v += ch
  v = v.toLowerCase()
  if (!v) return true
  if (/^(https?:|mailto:|tel:)/.test(v)) return true
  return !/^[a-z][a-z0-9+.-]*:/.test(v)
}

/** Escape text between tags, but leave existing character references (`&amp;`) alone. */
const escapeText = (t: string): string =>
  t
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
    .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
const escapeAttr = (t: string): string => escapeText(t).replace(/"/g, '&quot;')

/** Stored rich text (WYSIWYG / markdown fields) made safe to place in an HTML mail body. */
export function sanitizeRichHtml(html: string): string {
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(RICH_DROP_RE, '')
  let out = ''
  let last = 0
  for (const m of src.matchAll(TAG_RE)) {
    out += escapeText(src.slice(last, m.index))
    last = (m.index ?? 0) + m[0].length
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (!RICH_TAGS.has(tag)) continue
    if (closing) {
      out += `</${tag}>`
      continue
    }
    let attrs = ''
    for (const a of (m[3] ?? '').matchAll(ATTR_RE)) {
      const name = a[1].toLowerCase()
      const value = a[2] ?? a[3] ?? a[4] ?? ''
      if (!RICH_ATTRS.has(name) || (name === 'href' && !safeHref(value))) continue
      attrs += ` ${name}="${escapeAttr(value)}"`
    }
    if (tag === 'a') attrs += ' rel="noopener noreferrer" target="_blank"'
    out += `<${tag}${attrs}>`
  }
  return out + escapeText(src.slice(last))
}

/** Field `type` / `interface` values that store rich text (HTML or markdown). */
const RICH_INTERFACES = new Set([
  'input-rich-text-html',
  'input-rich-text-md',
  'rich_text',
  'rich-text',
  'rich-text-html',
  'richtext',
  'wysiwyg',
  'markdown'
])

/** Is this field (by its type / interface) a rich-text field? */
export function isRichTextField(field: {
  type?: string | null
  interface?: string | null
}): boolean {
  return (
    RICH_INTERFACES.has(String(field.interface ?? '')) ||
    RICH_INTERFACES.has(String(field.type ?? ''))
  )
}

export interface HtmlTemplateOptions {
  /** Rich-text field names: a placeholder whose path ends in one is sanitized, not escaped. */
  richFields?: ReadonlySet<string>
}

/**
 * An HTML fragment (mail body): values HTML-escaped unless written `{{ path | raw }}`. A value
 * from a rich-text field (`richFields`, matched on the path's last segment) is passed through
 * the rich-text allow-list instead, so its formatting shows (review A5, 2026-10-27).
 */
export function resolveHtmlTemplate(
  template: string,
  data: FlowData,
  opts: HtmlTemplateOptions = {}
): string {
  return template.replace(PLACEHOLDER_RE, (_, inner: string) => {
    const { path, raw } = splitRaw(inner)
    const value = text(getByPath(data, path))
    if (raw) return value
    const leaf = path.slice(path.lastIndexOf('.') + 1)
    if (opts.richFields?.has(leaf)) return sanitizeRichHtml(value)
    return escapeHtml(value)
  })
}

function safeJson(val: unknown): string | undefined {
  try {
    return JSON.stringify(val, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  } catch {
    return undefined
  }
}

/** A value placed OUTSIDE a JSON string literal — always exactly one JSON value. */
function jsonValueText(val: unknown): string {
  if (val === undefined || val === null) return 'null'
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'null'
  if (typeof val === 'boolean') return String(val)
  if (typeof val === 'bigint') return val.toString()
  if (typeof val === 'string') {
    const t = val.trim()
    if (t !== '') {
      try {
        JSON.parse(t)
        return t
      } catch {
        /* not a JSON value: quoted below */
      }
    }
    return JSON.stringify(val)
  }
  return safeJson(val) ?? 'null'
}

/** A value placed INSIDE a JSON string literal — escaped string content, no quotes. */
function jsonStringContent(val: unknown): string {
  if (val === undefined || val === null) return ''
  const s = typeof val === 'object' && !(val instanceof Date) ? (safeJson(val) ?? '') : String(val)
  return JSON.stringify(s).slice(1, -1)
}

/** A JSON body template: tracks string literals so each value lands as data, never syntax. */
export function resolveJsonTemplate(template: string, data: FlowData): string {
  let out = ''
  let inString = false
  let i = 0
  while (i < template.length) {
    if (template.startsWith('{{', i)) {
      const close = template.indexOf('}}', i + 2)
      const path = close >= 0 ? template.slice(i + 2, close) : ''
      if (path.length > 0 && !path.includes('}')) {
        const val = getByPath(data, path.trim())
        out += inString ? jsonStringContent(val) : jsonValueText(val)
        i = close + 2
        continue
      }
    }
    const ch = template[i]
    if (inString && ch === '\\') {
      out += template.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === '"') inString = !inString
    out += ch
    i++
  }
  return out
}

/** A request body by its content type: JSON (the default), form, XML/HTML (entity-escaped),
 *  or as text otherwise. */
export function resolveBodyTemplate(
  template: string,
  data: FlowData,
  contentType: string | null | undefined
): string {
  const type = (contentType ?? '').toLowerCase()
  if (!type || type.includes('json')) return resolveJsonTemplate(template, data)
  if (type.includes('x-www-form-urlencoded')) return resolveFormTemplate(template, data)
  if (type.includes('xml') || type.includes('html')) return resolveHtmlTemplate(template, data)
  return resolveTemplate(template, data)
}
