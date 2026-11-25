import type { Blueprint } from './blueprints.js'

/**
 * Hub enhancement 46 (app cloning): what a structure blueprint must never carry out of the app it
 * was exported from. A clone carries STRUCTURE, never values that talk to the outside world. Run on
 * the SOURCE, before the bundle leaves it (services/hub-link/clone-export.ts), and again on the Hub
 * as defence in depth (services/hub/lifecycle/clone.ts). Leaf module, pure.
 *
 * DENY BY DEFAULT (security review ruling) in the parts that call out: flow trigger options, flow
 * step options, workflow transition actions and rule actions that reach outside (webhook, HTTP,
 * external API, mail, chat…: a `type` that says so, or a `url` / `headers` / `endpoint` in them),
 * and payload templates. There EVERY string value becomes the visible placeholder FILL_IN, except
 * the values of a short allow-list of structural keys (field and collection names, keys, method,
 * operators, conditions, filters, mappings) — and those still pass the scans below. Every URL
 * there becomes FILL_IN. Each cloned flow names every placeholder it got in its description
 * ("Needs values: …"), and is inactive anyway.
 *
 * EVERYWHERE ELSE (defence in depth):
 *  - a key is split into tokens on camelCase, `_`, `-` and `.`; a string or number under a key
 *    with a token password / passwd / pwd / secret / token / key / sig / signature / code / auth /
 *    credential(s) / cert / private / bearer is emptied (a few structural names that only look like
 *    it — `key`, `group_key`, `upsert_keys` … — STRUCTURAL_KEYS — are scanned, not emptied);
 *  - every value under a `headers` key is emptied (the header names stay);
 *  - whole strings are scanned with unanchored patterns: an embedded URL loses its user info,
 *    fragment and every query value (names kept); an auth-scheme token (Bearer, Basic, Token,
 *    SharedAccessSignature, AWS4-HMAC-SHA256 …) anywhere in the text, a JWT, and `password=…` /
 *    `token: …` pairs lose their value;
 *  - JSON held as text is parsed, walked the same way and written back as text.
 * A body-secret placeholder `⟦nvr-secret:<name>⟧` is a name, never a value: kept. Every change is
 * reported by PATH only, never with the value.
 */

export const FILL_IN = '{{fill in on the new app}}'
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
  'connectionstring'
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
  'session_field'
])
/** In a deny-by-default part, the keys whose string values are structure (kept, then scanned). */
const SAFE_KEYS = new Set([
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
  'name',
  'label',
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
  'from_state',
  'to_state',
  'payload_template_key',
  'external_api',
  'flow',
  'flow_id',
  'resolve',
  'reject',
  'sort',
  'direction',
  'format',
  'id',
  'locked_keys'
])
/** In a deny-by-default part, a container under one of these keys is structure as a whole. */
const SAFE_CONTAINERS = new Set([
  'conditions',
  'condition',
  'condition_rules',
  'filter',
  'filters',
  'mapping',
  'map',
  'field_map',
  'fields_map',
  'lookups',
  'sort'
])
const OUTBOUND_TYPE_RE =
  /webhook|http|request|external|api|fetch|call|push|mail|email|sms|teams|slack|notify|post|send/i

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`)\]]+/gi
const AUTH_RE =
  /\b(Bearer|Basic|Token|Digest|Negotiate|ApiKey|SharedAccessSignature|AWS4-HMAC-SHA256|Signature)(\s+|=)([A-Za-z0-9._~+/=:%-]{8,})/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g
const PAIR_RE =
  /\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|signature|sig|credential)[A-Za-z0-9_-]*)(\s*[:=]\s*)("?)([^\s"&;,]+)/gi
const PLACEHOLDER_ONLY_RE = /^\s*⟦nvr-secret:[^⟧]*⟧\s*$/

export interface ScrubResult {
  blueprint: Blueprint
  /** Paths whose value was emptied or replaced (≤ 500, names only). */
  scrubbed: string[]
}

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
  const tokens = keyTokens(k)
  if (tokens.some((t) => SECRET_TOKENS.has(t))) return true
  // Run-together names: apikey, clientsecret, accesstoken, xapikey …
  return /(apikey|secret|password|passwd|token|signature|credential|bearer)/i.test(tokens.join(''))
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

class Walker {
  scrubbed: string[] = []
  /** Paths given FILL_IN, for the flow being walked (its "Needs values" line). */
  filled: string[] = []
  note(path: string) {
    if (this.scrubbed.length < 500) this.scrubbed.push(path.slice(0, 300))
  }
  fill(path: string): string {
    this.note(path)
    this.filled.push(path)
    return FILL_IN
  }

  /** Unanchored scans of one string; `deny` = URLs become FILL_IN. */
  scanText(v: string, path: string, deny: boolean): string {
    let out = v
    let hit = false
    out = out.replace(URL_RE, (url) => {
      if (deny) {
        hit = true
        return FILL_IN
      }
      const clean = scrubUrl(url)
      if (clean !== null && clean !== url) {
        hit = true
        return clean
      }
      return url
    })
    out = out.replace(AUTH_RE, (m, scheme: string, sep: string, tok: string) => {
      // Only what looks like a credential ("Basic details" is a label, not a password).
      if (!credentialLike(tok)) return m
      hit = true
      return `${scheme}${sep}`
    })
    out = out.replace(JWT_RE, () => {
      hit = true
      return ''
    })
    out = out.replace(PAIR_RE, (m, name: string, sep: string, q: string, value: string) => {
      if (/^⟦nvr-secret:/.test(value) || value === FILL_IN) return m
      hit = true
      return `${name}${sep}${q}`
    })
    if (hit) {
      if (deny) this.filled.push(path)
      this.note(path)
    }
    return out
  }

  /** A string value at `path`. */
  str(v: string, path: string, o: { secret: boolean; deny: boolean; safe: boolean }): string {
    if (PLACEHOLDER_ONLY_RE.test(v) || v === FILL_IN) return v
    if (v === '') return v
    if (o.secret) {
      if (o.deny) return this.fill(path)
      this.note(path)
      return ''
    }
    const t = v.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      let parsed: unknown
      try {
        parsed = JSON.parse(t)
      } catch {
        parsed = undefined
      }
      if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
        const before = this.scrubbed.length
        const out = this.any(parsed, path, o)
        return this.scrubbed.length === before ? v : JSON.stringify(out)
      }
    }
    if (o.deny && !o.safe) return this.fill(path)
    return this.scanText(v, path, o.deny)
  }

  /** Every value under a `headers` key: names kept, values emptied. */
  headers(v: unknown, path: string): unknown {
    if (typeof v === 'string') {
      const t = v.trim()
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          return JSON.stringify(this.headers(JSON.parse(t), path))
        } catch {
          /* not JSON: a raw header block */
        }
      }
      if (t === '') return v
      this.note(path)
      return ''
    }
    if (Array.isArray(v))
      return v.map((h, i) => {
        if (!isObj(h)) return this.headers(h, `${path}[${i}]`)
        const name = String(h.header ?? h.name ?? h.key ?? i)
        const out: Record<string, unknown> = { ...h }
        for (const k of Object.keys(out))
          if (!['header', 'name', 'key'].includes(k) && out[k] !== '' && out[k] != null) {
            this.note(`${path}.${name}`)
            out[k] = ''
          }
        return out
      })
    if (isObj(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'string' && PLACEHOLDER_ONLY_RE.test(val)) out[k] = val
        else if (val === '' || val == null) out[k] = val
        else if (typeof val === 'object') out[k] = this.headers(val, `${path}.${k}`)
        else {
          this.note(`${path}.${k}`)
          out[k] = ''
        }
      }
      return out
    }
    return v
  }

  any(
    v: unknown,
    path: string,
    o: { secret: boolean; deny: boolean; safe: boolean } = {
      secret: false,
      deny: false,
      safe: false
    }
  ): unknown {
    if (typeof v === 'string') return this.str(v, path, o)
    if (typeof v === 'number' && o.secret) {
      this.note(path)
      return ''
    }
    if (Array.isArray(v)) return v.map((x, i) => this.any(x, `${path}[${i}]`, o))
    if (isObj(v)) {
      // Inside an otherwise structural part, an action that reaches outside is denied by default.
      const deny = o.deny || (!o.safe && isOutbound(v))
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        const p = `${path}.${k}`
        if (/^headers?$/i.test(k)) {
          out[k] = this.headers(val, p)
          continue
        }
        const lower = k.toLowerCase()
        out[k] = this.any(val, p, {
          secret: o.secret || isSecretKey(k),
          deny,
          safe: o.safe || SAFE_CONTAINERS.has(lower) || (deny && SAFE_KEYS.has(lower))
        })
      }
      return out
    }
    return v
  }

  /** A part that is denied by default as a whole (flow options, payload templates). */
  deny(v: unknown, path: string): unknown {
    return this.any(v, path, { secret: false, deny: true, safe: false })
  }
}

/** A token that looks like a credential: 8+ characters with a digit, mixed case or a symbol. */
function credentialLike(tok: string): boolean {
  return (
    tok.length >= 8 &&
    (/\d/.test(tok) || (/[a-z]/.test(tok) && /[A-Z]/.test(tok)) || /[._~+/=:%-]/.test(tok))
  )
}

/** An action object that reaches outside the app (webhook, HTTP, external API, mail, chat …). */
function isOutbound(v: Record<string, unknown>): boolean {
  const type = typeof v.type === 'string' ? v.type : typeof v.op === 'string' ? v.op : ''
  if (type && OUTBOUND_TYPE_RE.test(type)) return true
  return 'url' in v || 'endpoint' in v || 'webhook_url' in v || 'base_url' in v
}

const label = (row: Record<string, unknown> | undefined, ...keys: string[]): string => {
  for (const k of keys) {
    const v = row?.[k]
    if (typeof v === 'string' && v) return v.slice(0, 60)
  }
  return '?'
}

const NEEDS = 'Needs values (fill in on the new app):'

/** Pure: a copy of the blueprint with every credential emptied, and where they were. */
export function scrubBlueprintSecrets(bp: Blueprint): ScrubResult {
  const w = new Walker()
  const row = (r: Record<string, unknown>, path: string) =>
    w.any(r, path) as Record<string, unknown>
  /** Payload templates: denied as a whole except their names and references. */
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
      const name = label(c.meta, 'collection')
      return {
        meta: row(c.meta, `collections[${name}]`),
        fields: c.fields.map((f) => row(f, `collections[${name}].fields[${label(f, 'field')}]`))
      }
    }),
    relations: bp.relations.map((r, i) => row(r, `relations[${i}]`)),
    workflows: bp.workflows.map((wf) => {
      const name = label(wf.template, 'name', 'id')
      return {
        ...wf,
        template: row(wf.template, `workflows[${name}]`),
        states: wf.states.map((s) => row(s, `workflows[${name}].states[${label(s, 'key')}]`)),
        transitions: wf.transitions.map((t) =>
          row(t, `workflows[${name}].transitions[${label(t, 'label', 'id')}]`)
        ),
        bindings: wf.bindings.map((b) => row(b, `workflows[${name}].bindings`)),
        ...(wf.dimensions
          ? { dimensions: wf.dimensions.map((d) => row(d, `workflows[${name}].dimensions`)) }
          : {})
      }
    }),
    layouts: bp.layouts.map((l) => {
      const name = `${label(l.layout, 'collection')}/${label(l.layout, 'name')}`
      return {
        layout: row(l.layout, `layouts[${name}]`),
        groups: l.groups.map((g) => row(g, `layouts[${name}].groups`)),
        assignments: l.assignments.map((a) => row(a, `layouts[${name}].fields`))
      }
    }),
    queues: bp.queues.map((q) => {
      const name = label(q.queue, 'name', 'id')
      return {
        queue: row(q.queue, `queues[${name}]`),
        sources: q.sources.map((s) => row(s, `queues[${name}].sources`))
      }
    }),
    rules: bp.rules.map((r) => row(r, `rules[${label(r, 'name')}]`)),
    ...(bp.payload_templates
      ? {
          payload_templates: bp.payload_templates.map((t) => {
            const rec = t as unknown as Record<string, unknown>
            const path = `payload_templates[${label(rec, 'key')}]`
            const kept: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(rec))
              kept[k] =
                PAYLOAD_SAFE.has(k) || k === 'lookups'
                  ? w.any(v, `${path}.${k}`, { secret: false, deny: false, safe: k === 'lookups' })
                  : w.deny(v, `${path}.${k}`)
            return kept as unknown as NonNullable<Blueprint['payload_templates']>[number]
          })
        }
      : {}),
    ...(bp.roles
      ? {
          roles: bp.roles.map((r) => {
            const name = label(r.role, 'name')
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
            const name = label(f.flow, 'name', 'id')
            w.filled = []
            const flow: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(f.flow))
              flow[k] =
                k === 'trigger_options'
                  ? w.deny(v, `flows[${name}].trigger_options`)
                  : w.any(v, `flows[${name}].${k}`)
            const operations = f.operations.map((op) => {
              const key = label(op, 'key', 'name')
              const o: Record<string, unknown> = {}
              for (const [k, v] of Object.entries(op))
                o[k] =
                  k === 'options'
                    ? w.deny(v, `flows[${name}].operations[${key}].options`)
                    : w.any(v, `flows[${name}].operations[${key}].${k}`)
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
