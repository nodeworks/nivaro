import type { Blueprint } from './blueprints.js'

/**
 * Hub enhancement 46 (app cloning): what a structure blueprint must never carry out of the app it
 * was exported from. A clone carries STRUCTURE, never values that talk to the outside world. Run on
 * the SOURCE, before the bundle leaves it (services/hub-link/clone-export.ts), and again on the Hub
 * as defence in depth (services/hub/lifecycle/clone.ts). Leaf module, pure.
 *
 * Three modes, decided per part (security review rulings):
 *
 *  DENY (every string becomes the visible placeholder FILL_IN; only an action's `type` stays):
 *   - every transition action, rule action and flow step whose type is NOT on the in-app
 *     allow-list (IN_APP_ACTIONS / IN_APP_OPS) — erp_submit, external API, webhook, mail, script
 *     and every type this file does not know;
 *   - any object anywhere that reaches outside (an `external_api`, `endpoint_path`, `url`,
 *     `endpoint`, `webhook_url`, `base_url` or `payload_template_key` in it), however it is nested;
 *   - payload templates (but their key, label, API name, collection, mode and lookups).
 *
 *  STRUCTURE (deny by default; strings stay only under structural keys and only when they look
 *  like what those keys hold):
 *   - JSON settings of collections, fields, layouts, sections, field placements, transitions and
 *     states (options, display options, conditions …): field / collection / key names, operators,
 *     types and colours must be identifier-shaped (ID_KEYS); labels and texts (LABEL_KEYS) are
 *     kept as prose; anything else becomes FILL_IN;
 *   - in-app actions and flow steps on the allow-list, and flow trigger options: a narrower key
 *     set (no `key` / `id` / `name` there), and a webhook trigger's `secret` is always emptied
 *     (the installer gives a cloned webhook flow bearer auth with a fresh random secret).
 *   Every kept string still passes the scans below; every cloned action arrives `disabled`.
 *
 *  SCAN (defence in depth everywhere else):
 *   - key names split into tokens on camelCase, `_`, `-`, `.` (also German, Spanish, French
 *     credential words); a value under a credential-named key is emptied; object KEYS are scanned
 *     too (a map keyed by a URL or a token);
 *   - every value under a key ending in `headers`, and the value of a `[name, value]` pair whose
 *     name is a credential or which sits in headers, is emptied (names kept);
 *   - unanchored text scans: URLs (user info, fragment and every query value), `?code=` style query
 *     strings without a scheme, auth-scheme tokens, JWTs, PEM private keys, known key prefixes
 *     (sk_live_, ghp_, AKIA …), base64 blobs, `name=value` / `"name": "value"` pairs, XML
 *     `<Password>…</Password>` elements and string literals inside Liquid tags;
 *   - JSON held as text, also doubly encoded, is parsed and walked the same way.
 * A body-secret placeholder `⟦nvr-secret:<name>⟧` is a name, never a value: kept. Every change is
 * reported by PATH only (path segments taken from values are themselves scrubbed), never with the
 * value; the 500-path report never decides anything (an uncapped counter does).
 */

export const FILL_IN = '{{fill in on the new app}}'

/** Transition and rule action types that never leave the app. */
export const IN_APP_ACTIONS = new Set([
  'create_record',
  'create_task',
  'set_field',
  'cross_collection',
  'notify',
  'notify_in_app',
  'reject',
  'assign',
  'set_state',
  'clear_field'
])
/** Flow step types that never leave the app. */
export const IN_APP_OPS = new Set([
  'log',
  'condition',
  'notification',
  'run-flow',
  'item-read',
  'item-write',
  'task',
  'refresh-pages',
  'workflow-auto-sweep',
  'chat-post'
])

const SECRET_TOKENS = new Set([
  'password',
  'passwd',
  'pwd',
  'pass',
  'secret',
  'secrets',
  'token',
  'tokens',
  'key',
  'keys',
  'apikey',
  'sig',
  'signature',
  'code',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'cert',
  'certificate',
  'private',
  'bearer',
  'cookie',
  'session',
  'sas',
  'pem',
  'connectionstring',
  // German, Spanish, French
  'passwort',
  'kennwort',
  'geheim',
  'schluessel',
  'schlüssel',
  'zugangsdaten',
  'contrasena',
  'contraseña',
  'clave',
  'secreto',
  'motdepasse',
  'jeton',
  'cle',
  'clé'
])
/** Names that tokenise like a credential but name structure (their values are scanned). */
const STRUCTURAL_KEYS = new Set([
  'key',
  'keys',
  'group_key',
  'upsert_keys',
  'locked_keys',
  'payload_template_key',
  'key_field',
  'primary_key',
  'sort_key',
  'session_field',
  'auth_type'
])
/** STRUCTURE mode, settings: keys whose values are identifiers (identifier-shaped values only). */
const ID_KEYS = new Set([
  'columns',
  'column',
  'visible_columns',
  'sort_by',
  'group_by',
  'order_by',
  'display_field',
  'display_fields',
  'template_fields',
  'view',
  'size',
  'variant',
  'tab',
  'tabs',
  'section',
  'sections',
  'position',
  'hidden_fields',
  'required_fields',
  'readonly_fields',
  'target',
  'related_field',
  'junction_field',
  'one_field',
  'many_field',
  'field',
  'fields',
  'field_name',
  'target_field',
  'source_field',
  'value_field',
  'collection',
  'collections',
  'related_collection',
  'key',
  'keys',
  'id',
  'type',
  'kind',
  'method',
  'operator',
  'op',
  'mode',
  'event',
  'events',
  'scope',
  'action',
  'trigger',
  'state',
  'states',
  'from_state',
  'to_state',
  'flow',
  'flow_id',
  'resolve',
  'reject',
  'sort',
  'direction',
  'format',
  'interface',
  'display',
  'icon',
  'color',
  'align',
  'width',
  'group',
  'value',
  'role',
  'roles',
  'status',
  'auth_type',
  'cron',
  'locked_keys'
])
/** STRUCTURE mode, in-app actions / flow steps / triggers: the narrower identifier set. */
const OPTS_ID_KEYS = new Set([
  'field',
  'fields',
  'target_field',
  'source_field',
  'collection',
  'collections',
  'type',
  'method',
  'operator',
  'op',
  'mode',
  'event',
  'events',
  'scope',
  'state',
  'from_state',
  'to_state',
  'flow',
  'flow_id',
  'auth_type',
  'cron',
  'status',
  'role',
  'roles',
  'value'
])
/** STRUCTURE mode: keys whose values are prose for people (kept, scanned). */
const LABEL_KEYS = new Set([
  'label',
  'text',
  'name',
  'title',
  'placeholder',
  'description',
  'note',
  'hint',
  'display_name',
  'singular',
  'plural',
  'message',
  'subject',
  'help'
])
/** STRUCTURE mode: containers of conditions — their leaves are operators and values. */
const FILTER_KEYS = new Set([
  'conditions',
  'condition',
  'condition_rules',
  'filter',
  'filters',
  'rules',
  'where',
  'choices'
])
const ID_RE = /^[A-Za-z0-9_.:/-]{1,80}$/
const CRON_RE = /^[\d*/,?LW#\- ]{1,64}$/
/** A filter value or a choice value: short, no quotes, braces, `=` or `?`. */
const VALUE_RE = /^[\p{L}\p{N} _.,:/@#&()+-]{0,120}$/u
const OUTBOUND_KEYS = [
  'url',
  'endpoint',
  'endpoint_path',
  'webhook_url',
  'base_url',
  'external_api',
  'payload_template_key'
]

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`)\]]+/gi
/** A query string without a scheme (`/api/x?code=…&sig=…`): every value goes. */
const QUERY_RE = /([?&][A-Za-z0-9_.[\]-]{1,64}=)([^&#\s"'<>]*)/g
/** An auth scheme and the token after it (quoted: up to its closing quote). */
const AUTH_RE =
  /\b(Bearer|Token|ApiKey|SharedAccessSignature|AWS4-HMAC-SHA256|Signature|Negotiate|Basic|Digest)(\s+|=)(?:"([^"]*)"|'([^']*)'|([^\s"',;]+))/gi
/** Schemes whose next word may be plain prose ("Basic details"): scrubbed only from 8 characters. */
const WEAK_SCHEMES = new Set(['basic', 'digest'])
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g
const PEM_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g
/** Well-known credential shapes, wherever they sit. */
const KNOWN_TOKEN_RE =
  /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,})/g
/** A base64 blob: 16+ characters with digits or padding or + /, and mixed case. */
const BASE64_RE = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/=])/g
const SECRET_NAME =
  '[A-Za-z0-9_\\-\\u00C0-\\u017F]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|signature|sig|credential|account[_-]?key|shared[_-]?access[_-]?key|access[_-]?key|connection[_-]?string|client[_-]?secret|private[_-]?key|passwort|kennwort|contrase(?:n|ñ)a|clave|mot[_-]?de[_-]?passe|motdepasse|geheim)[A-Za-z0-9_\\-\\u00C0-\\u017F]*'
/** `name=value` / `name: value` with a credential name (quoted: to the closing quote; else to a
 *  delimiter or the end of the line). */
const PAIR_RE = new RegExp(
  `\\b(${SECRET_NAME})(\\s*[:=]\\s*)(?:"([^"]*)"|'([^']*)'|([^;&,\\r\\n]*))`,
  'gi'
)
/** `"name": "value"` / `'name' = value` with a quoted credential name inside plain text. */
const QUOTED_PAIR_RE = new RegExp(
  `(["'])(${SECRET_NAME})\\1(\\s*[:=]\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s,;}\\]]+))`,
  'gi'
)
/** XML / SOAP elements: `<wsse:Password>…</wsse:Password>`. */
const XML_RE = /<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(\s[^>]*)?>([^<]*)<\/\1?\2\s*>/g
/** Liquid tags: their string literals go (`{% assign k = "sk_live_…" %}`). */
const LIQUID_RE = /\{%-?[\s\S]*?-?%\}|\{\{-?[\s\S]*?-?\}\}/g
const LIQUID_LITERAL_RE = /"[^"]*"|'[^']*'/g
/** The exact-name rule of the first version, kept as an extra OR. */
const SECRET_KEY_RE =
  /^(x-)?(api[-_]?key|apikey|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|token|password|passwd|pwd|pass|secret|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|webhook[-_]?secret|shared[-_]?secret|credentials?|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|basic[-_]?auth|session[-_]?(id|token)|sas[-_]?token|connection[-_]?string)$/i
/** Compound credential names, judged on the joined tokens (clientSecret → clientsecret). */
const COMPOUND_RE =
  /(apikey|secret|password|passwd|token|signature|credential|bearer|connectionstring|accountkey|sharedaccesskey|accesskey|privatekey|clientsecret|refreshtoken|passwort|kennwort|contrasena|contraseña|motdepasse|geheim)/i
const PLACEHOLDER_ONLY_RE = /^\s*⟦nvr-secret:[^⟧]*⟧\s*$/

export interface ScrubResult {
  blueprint: Blueprint
  /** Paths whose value was emptied or replaced (≤ 500, names only). */
  scrubbed: string[]
}

type Mode = 'scan' | 'config' | 'opts' | 'deny'

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A key's tokens: split on camelCase, `_`, `-`, `.` and spaces, lower-cased. */
export function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
}

/** A credential-named key (header names compared the same way). */
export function isSecretKey(key: string): boolean {
  const k = key.trim()
  if (STRUCTURAL_KEYS.has(k.toLowerCase())) return false
  if (SECRET_KEY_RE.test(k)) return true
  const tokens = keyTokens(k)
  if (tokens.some((t) => SECRET_TOKENS.has(t))) return true
  // Run-together names: apikey, clientsecret, accountkey, motdepasse, xapikey …
  return COMPOUND_RE.test(tokens.join(''))
}

/** One URL with its user info, fragment and every query value removed (names kept). */
export function scrubUrl(raw: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim())) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  let changed = false
  if (u.username || u.password) {
    u.username = ''
    u.password = ''
    changed = true
  }
  if (u.hash) {
    u.hash = ''
    changed = true
  }
  for (const k of [...new Set(u.searchParams.keys())])
    if (u.searchParams.getAll(k).some((v) => v !== '')) {
      u.searchParams.set(k, '')
      changed = true
    }
  return changed ? u.toString() : raw
}

/** A token that looks like a credential: 8+ characters with a digit, mixed case or a symbol. */
function credentialLike(tok: string): boolean {
  return (
    tok.length >= 8 &&
    (/\d/.test(tok) || (/[a-z]/.test(tok) && /[A-Z]/.test(tok)) || /[._~+/=:%-]/.test(tok))
  )
}

/** A base64-looking blob (not a plain word or an identifier). */
function blobLike(s: string): boolean {
  if (s.length < 16) return false
  const mixed = /[a-z]/.test(s) && /[A-Z]/.test(s)
  return (mixed && /\d/.test(s)) || /[+/]/.test(s) || (/=$/.test(s) && mixed)
}

/** The unanchored scans of one text. `deny` = every URL becomes FILL_IN. Pure. */
export function scanText(v: string, o: { deny?: boolean; identifier?: boolean } = {}): string {
  // Escaped JSON inside a text (`{\"apiKey\":\"…\"}`, doubly encoded): judged unescaped; when
  // that finds something, the unescaped, scrubbed text is what stays.
  if (/\\["']/.test(v)) {
    const plain = v.replace(/\\+(["'])/g, '$1')
    const scrubbed = scanText(plain, o)
    if (scrubbed !== plain) return scrubbed
  }
  let out = v
  out = out.replace(PEM_RE, '')
  out = out.replace(URL_RE, (url) => {
    if (o.deny) return FILL_IN
    const clean = scrubUrl(url)
    return clean ?? url
  })
  out = out.replace(QUERY_RE, (_m, name: string) => name)
  out = out.replace(
    AUTH_RE,
    (m, scheme: string, sep: string, dq?: string, sq?: string, bare?: string) => {
      const tok = dq ?? sq ?? bare ?? ''
      // Bearer, Token, ApiKey …: the token always goes. Basic / Digest followed by a short plain
      // word is prose ("Basic details"); from 8 characters it is a credential.
      if (!tok) return m
      if (WEAK_SCHEMES.has(scheme.toLowerCase()) && tok.length < 8 && !credentialLike(tok)) return m
      return `${scheme}${sep}${dq !== undefined ? '""' : sq !== undefined ? "''" : ''}`
    }
  )
  out = out.replace(JWT_RE, '')
  out = out.replace(KNOWN_TOKEN_RE, '')
  out = out.replace(
    XML_RE,
    (m, ns: string | undefined, name: string, attrs: string | undefined, inner: string) =>
      isSecretKey(name) && inner.trim()
        ? `<${ns ?? ''}${name}${attrs ?? ''}></${ns ?? ''}${name}>`
        : m
  )
  out = out.replace(
    QUOTED_PAIR_RE,
    (m, q: string, name: string, sep: string, dq?: string, sq?: string, bare?: string) => {
      const value = (dq ?? sq ?? bare ?? '').trim()
      if (!value || /^⟦nvr-secret:[^⟧]*⟧$/.test(value) || value === FILL_IN) return m
      return `${q}${name}${q}${sep}${dq !== undefined ? '""' : sq !== undefined ? "''" : ''}`
    }
  )
  out = out.replace(
    PAIR_RE,
    (m, name: string, sep: string, dq?: string, sq?: string, bare?: string) => {
      const value = (dq ?? sq ?? bare ?? '').trim()
      if (!value || /^⟦nvr-secret:[^⟧]*⟧$/.test(value) || value === FILL_IN) return m
      return `${name}${sep}${dq !== undefined ? '""' : sq !== undefined ? "''" : ''}`
    }
  )
  out = out.replace(LIQUID_RE, (tag) =>
    tag === FILL_IN ? tag : tag.replace(LIQUID_LITERAL_RE, (lit) => `${lit[0]}${lit[0]}`)
  )
  if (!o.identifier) out = out.replace(BASE64_RE, (b) => (blobLike(b) ? '' : b))
  return out
}

interface Ctx {
  mode: Mode
  /** The key this value sits under (lower-case), '' at a part's top. */
  key: string
  secret: boolean
  /** Inside a conditions container (STRUCTURE modes). */
  filter: boolean
  /** Under a key ending in `headers`. */
  headers: boolean
}

class Walker {
  /** The report (capped). Never used to decide whether a value changed: `changes` is. */
  scrubbed: string[] = []
  /** Every change made, uncapped. */
  changes = 0
  /** Paths given FILL_IN, for the flow being walked (its "Needs values" line). */
  filled: string[] = []

  note(path: string) {
    this.changes++
    if (this.scrubbed.length < 500) this.scrubbed.push(path.slice(0, 300))
  }
  fill(path: string): string {
    this.note(path)
    this.filled.push(path)
    return FILL_IN
  }
  emptied(path: string, c: Ctx): string {
    if (c.mode === 'scan') {
      this.note(path)
      return ''
    }
    return this.fill(path)
  }

  /** Whether a STRUCTURE-mode string may stay (before the scans). */
  structural(v: string, c: Ctx): 'id' | 'prose' | null {
    const ids = c.mode === 'opts' ? OPTS_ID_KEYS : ID_KEYS
    if (c.key === 'cron') return CRON_RE.test(v) ? 'id' : null
    if (c.filter) {
      if (ID_RE.test(v)) return 'id'
      return VALUE_RE.test(v) ? 'prose' : null
    }
    if (ids.has(c.key)) return ID_RE.test(v) ? 'id' : null
    if (LABEL_KEYS.has(c.key) && (c.mode === 'config' || c.key !== 'name')) return 'prose'
    return null
  }

  str(v: string, path: string, c: Ctx): string {
    if (v === '' || v === FILL_IN || PLACEHOLDER_ONLY_RE.test(v)) return v
    if (c.secret || c.headers) return this.emptied(path, c)
    const t = v.trim()
    const jsonish =
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']')) ||
      (t.startsWith('"') && t.endsWith('"') && t.length > 1)
    if (jsonish) {
      let parsed: unknown
      try {
        parsed = JSON.parse(t)
      } catch {
        parsed = undefined
      }
      if (parsed !== undefined && parsed !== null && typeof parsed !== 'number') {
        // The uncapped counter decides (the report stops at 500 paths; changes never do).
        const before = this.changes
        const out = this.any(parsed, path, c)
        return this.changes === before ? v : JSON.stringify(out)
      }
    }
    if (c.mode === 'deny') return this.fill(path)
    let kind: 'id' | 'prose' | null = 'prose'
    if (c.mode !== 'scan') {
      kind = this.structural(v, c)
      if (!kind) return this.fill(path)
    }
    const out = scanText(v, { deny: c.mode !== 'scan', identifier: kind === 'id' })
    if (out !== v) {
      if (c.mode !== 'scan') this.filled.push(path)
      this.note(path)
    }
    return out
  }

  /** An object key: scanned like a text (a map keyed by a URL or a token). */
  objKey(k: string, path: string): string {
    const out = scanText(k, { identifier: ID_RE.test(k) })
    if (out === k) return k
    this.note(`${path}.<key>`)
    return out || '<key>'
  }

  any(v: unknown, path: string, c: Ctx): unknown {
    if (typeof v === 'string') return this.str(v, path, c)
    if (typeof v === 'number' && (c.secret || c.headers)) {
      this.note(path)
      return c.mode === 'scan' ? '' : FILL_IN
    }
    if (Array.isArray(v)) {
      // A `[name, value]` pair: the value goes when the name is a credential or it is a header.
      if (v.length === 2 && typeof v[0] === 'string' && (c.headers || isSecretKey(v[0]))) {
        if (v[1] === '' || v[1] == null) return v
        this.note(`${path}.${this.seg(v[0])}`)
        return [v[0], '']
      }
      return v.map((x, i) => this.any(x, `${path}[${i}]`, c))
    }
    if (isObj(v)) {
      // Anything that reaches outside is denied, wherever it sits.
      const mode: Mode = c.mode === 'deny' || outboundObject(v) ? 'deny' : c.mode
      const out: Record<string, unknown> = {}
      for (const [rawK, val] of Object.entries(v)) {
        const k = this.objKey(rawK, path)
        const p = `${path}.${this.seg(k)}`
        const lower = k.toLowerCase()
        if (mode === 'deny' && lower === 'type' && typeof val === 'string' && ID_RE.test(val)) {
          out[k] = val
          continue
        }
        const headers = c.headers || /headers?$/i.test(k)
        if (headers && isObj(val) && !c.headers) {
          // Header maps: names kept, every value emptied.
          const h: Record<string, unknown> = {}
          for (const [hk, hv] of Object.entries(val)) {
            const name = this.objKey(hk, p)
            h[name] =
              typeof hv === 'string' && (hv === '' || PLACEHOLDER_ONLY_RE.test(hv))
                ? hv
                : hv == null
                  ? hv
                  : typeof hv === 'object'
                    ? this.any(hv, `${p}.${this.seg(name)}`, { ...c, mode, headers: true, key: '' })
                    : (this.note(`${p}.${this.seg(name)}`), '')
          }
          out[k] = h
          continue
        }
        if (headers && Array.isArray(val) && !c.headers) {
          out[k] = val.map((hv, i) => {
            if (isObj(hv)) {
              const name = this.seg(String(hv.header ?? hv.name ?? hv.key ?? i))
              const o2: Record<string, unknown> = {}
              for (const [hk, hvv] of Object.entries(hv)) {
                if (['header', 'name', 'key'].includes(hk) || hvv === '' || hvv == null)
                  o2[hk] = hvv
                else {
                  this.note(`${p}.${name}`)
                  o2[hk] = ''
                }
              }
              return o2
            }
            return this.any(hv, `${p}[${i}]`, { ...c, mode, headers: true, key: '' })
          })
          continue
        }
        out[k] = this.any(val, p, {
          mode,
          key: lower,
          secret: c.secret || isSecretKey(k),
          filter: c.filter || FILTER_KEYS.has(lower),
          headers
        })
      }
      return out
    }
    return v
  }

  /** A path segment taken from a value or a key: never a secret in the stored report. */
  seg(s: string): string {
    const short = s.slice(0, 60)
    return scanText(short, { identifier: ID_RE.test(short) }) === short && !isSecretValue(short)
      ? short
      : '?'
  }

  /** A part's value under its column / option name `key` (the name itself is judged too). */
  walk(v: unknown, path: string, mode: Mode, key = ''): unknown {
    return this.any(v, path, {
      mode,
      key: key.toLowerCase(),
      secret: !!key && isSecretKey(key),
      filter: FILTER_KEYS.has(key.toLowerCase()),
      headers: !!key && /headers?$/i.test(key)
    })
  }
}

/** A segment that looks like a credential itself (a key prefix, a blob). */
function isSecretValue(s: string): boolean {
  KNOWN_TOKEN_RE.lastIndex = 0
  return KNOWN_TOKEN_RE.test(s) || blobLike(s)
}

/** An object that reaches outside the app (whatever its type says). */
export function outboundObject(v: Record<string, unknown>): boolean {
  return OUTBOUND_KEYS.some((k) => k in v && v[k] != null && v[k] !== '')
}

const label = (row: Record<string, unknown> | undefined, ...keys: string[]): string => {
  for (const k of keys) {
    const v = row?.[k]
    if (typeof v === 'string' && v) return v.slice(0, 60)
  }
  return '?'
}

const NEEDS = 'Needs values (fill in on the new app):'

function parseMaybe(v: unknown): { value: unknown; text: boolean } {
  if (typeof v !== 'string') return { value: v, text: false }
  try {
    return { value: JSON.parse(v), text: true }
  } catch {
    return { value: v, text: false }
  }
}

export function scrubBlueprintSecrets(bp: Blueprint): ScrubResult {
  const w = new Walker()
  const seg = (s: string) => w.seg(s)

  /** A row: its JSON settings in `jsonMode`, its plain columns scanned. */
  const row = (r: Record<string, unknown>, path: string, jsonMode: Mode = 'scan') => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      const p = `${path}.${k}`
      const json =
        (v !== null && typeof v === 'object') ||
        (typeof v === 'string' && /^\s*[[{]/.test(v) && parseMaybe(v).text)
      out[k] = w.walk(v, p, json && jsonMode !== 'scan' ? jsonMode : 'scan', k)
    }
    return out
  }

  /** An action list (transition / rule `actions`): allow-listed in-app types in STRUCTURE, every
   *  other type fully denied; each one arrives disabled. */
  const actions = (v: unknown, path: string): unknown => {
    const { value, text } = parseMaybe(v)
    if (!Array.isArray(value)) return w.walk(v, path, 'deny')
    const out = value.map((a, i) => {
      if (!isObj(a)) return w.walk(a, `${path}[${i}]`, 'deny')
      const type = typeof a.type === 'string' ? a.type : ''
      const inApp = IN_APP_ACTIONS.has(type) && !outboundObject(a)
      const walked = w.walk(a, `${path}[${i}]`, inApp ? 'opts' : 'deny') as Record<string, unknown>
      return { ...walked, disabled: true }
    })
    w.changes++ // every action is marked disabled
    return text ? JSON.stringify(out) : out
  }

  const transition = (t: Record<string, unknown>, path: string) => {
    const out = row({ ...t, actions: undefined }, path, 'config')
    delete out.actions
    if (t.actions !== undefined) out.actions = actions(t.actions, `${path}.actions`)
    return out
  }

  const PAYLOAD_SAFE = new Set([
    'key',
    'label',
    'external_api',
    'collection',
    'mode',
    'locked_keys'
  ])
  const out: Blueprint = {
    ...bp,
    collections: bp.collections.map((c) => {
      const name = seg(label(c.meta, 'collection'))
      return {
        meta: row(c.meta, `collections[${name}]`, 'config'),
        fields: c.fields.map((f) =>
          row(f, `collections[${name}].fields[${seg(label(f, 'field'))}]`, 'config')
        )
      }
    }),
    relations: bp.relations.map((r, i) => row(r, `relations[${i}]`)),
    workflows: bp.workflows.map((wf) => {
      const name = seg(label(wf.template, 'name', 'id'))
      return {
        ...wf,
        template: row(wf.template, `workflows[${name}]`),
        states: wf.states.map((s) =>
          row(s, `workflows[${name}].states[${seg(label(s, 'key'))}]`, 'config')
        ),
        transitions: wf.transitions.map((t) =>
          transition(t, `workflows[${name}].transitions[${seg(label(t, 'label', 'id'))}]`)
        ),
        bindings: wf.bindings.map((b) => row(b, `workflows[${name}].bindings`)),
        ...(wf.dimensions
          ? { dimensions: wf.dimensions.map((d) => row(d, `workflows[${name}].dimensions`)) }
          : {})
      }
    }),
    layouts: bp.layouts.map((l) => {
      const name = `${seg(label(l.layout, 'collection'))}/${seg(label(l.layout, 'name'))}`
      return {
        layout: row(l.layout, `layouts[${name}]`, 'config'),
        groups: l.groups.map((g) => row(g, `layouts[${name}].groups`, 'config')),
        assignments: l.assignments.map((a) => row(a, `layouts[${name}].fields`, 'config'))
      }
    }),
    queues: bp.queues.map((q) => {
      const name = seg(label(q.queue, 'name', 'id'))
      return {
        queue: row(q.queue, `queues[${name}]`),
        sources: q.sources.map((s) => row(s, `queues[${name}].sources`))
      }
    }),
    rules: bp.rules.map((r) => {
      const path = `rules[${seg(label(r, 'name'))}]`
      const o = row({ ...r, actions: undefined }, path, 'config')
      delete o.actions
      if (r.actions !== undefined) o.actions = actions(r.actions, `${path}.actions`)
      return o
    }),
    ...(bp.payload_templates
      ? {
          payload_templates: bp.payload_templates.map((t) => {
            const rec = t as unknown as Record<string, unknown>
            const path = `payload_templates[${seg(label(rec, 'key'))}]`
            const kept: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(rec))
              kept[k] = PAYLOAD_SAFE.has(k)
                ? w.walk(v, `${path}.${k}`, 'scan', k)
                : k === 'lookups'
                  ? w.walk(v, `${path}.${k}`, 'config', k)
                  : w.walk(v, `${path}.${k}`, 'deny', k)
            return kept as unknown as NonNullable<Blueprint['payload_templates']>[number]
          })
        }
      : {}),
    ...(bp.roles
      ? {
          roles: bp.roles.map((r) => {
            const name = seg(label(r.role, 'name'))
            return {
              role: row(r.role, `roles[${name}]`),
              policies: r.policies.map((p) => row(p, `roles[${name}].policies`))
            }
          })
        }
      : {}),
    ...(bp.flows
      ? {
          flows: bp.flows.map((f) => {
            const name = seg(label(f.flow, 'name', 'id'))
            w.filled = []
            const flow: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(f.flow)) {
              if (k !== 'trigger_options') {
                flow[k] = w.walk(v, `flows[${name}].${k}`, 'scan', k)
                continue
              }
              const { value, text } = parseMaybe(v)
              const walked = w.walk(value, `flows[${name}].trigger_options`, 'opts')
              // A webhook trigger's secret is never carried (the installer makes a fresh one).
              if (isObj(walked) && 'secret' in walked) walked.secret = ''
              flow[k] = text ? JSON.stringify(walked) : walked
            }
            const operations = f.operations.map((op) => {
              const key = seg(label(op, 'key', 'name'))
              const type = typeof op.type === 'string' ? op.type : ''
              const o: Record<string, unknown> = {}
              for (const [k, v] of Object.entries(op))
                o[k] =
                  k === 'options'
                    ? w.walk(
                        v,
                        `flows[${name}].operations[${key}].options`,
                        IN_APP_OPS.has(type) ? 'opts' : 'deny'
                      )
                    : w.walk(v, `flows[${name}].operations[${key}].${k}`, 'scan', k)
              return o
            })
            const needs = [...new Set(w.filled)].map((p) =>
              p.replace(`flows[${name}].`, '').slice(0, 120)
            )
            if (needs.length) {
              const desc = typeof flow.description === 'string' ? flow.description.trim() : ''
              flow.description = `${desc ? `${desc}\n\n` : ''}${NEEDS} ${needs.join(', ')}`.slice(
                0,
                4000
              )
            }
            w.filled = []
            return { flow, operations }
          })
        }
      : {})
  }
  return { blueprint: out, scrubbed: w.scrubbed }
}
