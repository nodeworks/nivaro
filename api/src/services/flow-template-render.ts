/**
 * `{{path}}` placeholders in flow operation options, rendered for where the text goes (M26,
 * security audit 2026-10-27). A record value must never change the SHAPE of what it lands in:
 *
 *  - plain text (log lines, subjects, transform templates): the value as text — unchanged;
 *  - URLs: a value in the path / query / fragment is percent-encoded; a placeholder that
 *    supplies the scheme + host (at the very start, or inside `scheme://host`) stays as is;
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

/** A URL template: values in the path/query/fragment are percent-encoded. */
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
  return template.replace(PLACEHOLDER_RE, (match: string, path: string, offset: number) => {
    const value = text(getByPath(data, path.trim()))
    return offset + match.length <= rawUntil ? value : encodeURIComponent(value)
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

/** An HTML fragment (mail body): values HTML-escaped unless written `{{ path | raw }}`. */
export function resolveHtmlTemplate(template: string, data: FlowData): string {
  return template.replace(PLACEHOLDER_RE, (_, inner: string) => {
    const raw = /\|\s*raw\s*$/.exec(inner)
    const path = (raw ? inner.slice(0, raw.index) : inner).trim()
    const value = text(getByPath(data, path))
    return raw ? value : value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
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
