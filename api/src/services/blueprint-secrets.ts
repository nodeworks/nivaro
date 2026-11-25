import type { Blueprint } from './blueprints.js'

/**
 * Hub enhancement 46 (app cloning): what a structure blueprint must never carry out of the app it
 * was exported from. Run on the SOURCE, before the bundle leaves it (services/hub-link/clone-export.ts),
 * and again on the Hub as defence in depth (services/hub/lifecycle/clone.ts). Leaf module, pure.
 *
 * A blueprint never reads nivaro_external_apis (partner credentials, body secrets) or the
 * settings, so those cannot leave. What CAN hold a credential is configuration people typed into
 * the parts a blueprint does carry — a flow's webhook step, a transition action, a rule action,
 * a field option, a payload template's text:
 *
 *  - every value under a `headers` key (object `{Authorization: …}` or list `[{header, value}]`)
 *    is emptied; the header NAMES stay so the clone shows what to fill in;
 *  - every value whose key names a credential (`password`, `token`, `api_key`, `client_secret`,
 *    `authorization`, `cookie`, … — SECRET_KEY_RE) is emptied;
 *  - a URL keeps its host and path: `user:password@` is removed and a query parameter whose
 *    name names a credential is emptied;
 *  - a bare `Bearer …` / `Basic …` / `token …` value is emptied wherever it sits.
 * JSON held as text (transition `actions`, flow `options`, …) is parsed, scrubbed and written back
 * as text. A body-secret placeholder `⟦nvr-secret:<name>⟧` is a name, never a value: kept.
 * Every change is reported by PATH only (`flows[Notify].operations[post].options.headers.Authorization`),
 * never with the value.
 */

export const SECRET_KEY_RE =
  /^(x-)?(api[-_]?key|apikey|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|token|password|passwd|pwd|pass|secret|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|webhook[-_]?secret|shared[-_]?secret|credentials?|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|basic[-_]?auth|session[-_]?(id|token)|sas[-_]?token|connection[-_]?string)$/i

const AUTH_VALUE_RE = /^\s*(bearer|basic|token|digest|negotiate|apikey)\s+\S+/i
const PLACEHOLDER_ONLY_RE = /^\s*⟦nvr-secret:[^⟧]*⟧\s*$/

export interface ScrubResult {
  blueprint: Blueprint
  /** Paths whose value was emptied (≤ 500, names only). */
  scrubbed: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A credential-named key (header names compared the same way). */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key.trim())
}

/** A URL with its userinfo removed and credential-named query values emptied (null: no URL). */
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
  for (const k of [...u.searchParams.keys()])
    if (isSecretKey(k) && u.searchParams.get(k)) {
      u.searchParams.set(k, '')
      changed = true
    }
  return changed ? u.toString() : raw
}

class Walker {
  scrubbed: string[] = []
  note(path: string) {
    if (this.scrubbed.length < 500) this.scrubbed.push(path.slice(0, 300))
  }

  /** A string value at `path`: a URL, an auth value, or JSON text to walk. */
  str(v: string, path: string, secretKey: boolean): string {
    if (PLACEHOLDER_ONLY_RE.test(v)) return v
    if (secretKey) {
      if (v === '') return v
      this.note(path)
      return ''
    }
    if (AUTH_VALUE_RE.test(v)) {
      this.note(path)
      return ''
    }
    const url = scrubUrl(v)
    if (url !== null && url !== v) {
      this.note(path)
      return url
    }
    const t = v.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      let parsed: unknown
      try {
        parsed = JSON.parse(t)
      } catch {
        return v
      }
      const before = this.scrubbed.length
      const out = this.any(parsed, path, false)
      return this.scrubbed.length === before ? v : JSON.stringify(out)
    }
    return v
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
        if (!isObj(h)) return this.any(h, `${path}[${i}]`, true)
        const name = String(h.header ?? h.name ?? h.key ?? i)
        const out: Record<string, unknown> = { ...h }
        for (const k of ['value', 'val', 'content'])
          if (k in out && out[k] !== '' && out[k] != null) {
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
        else if (typeof val === 'object') out[k] = this.any(val, `${path}.${k}`, true)
        else {
          this.note(`${path}.${k}`)
          out[k] = ''
        }
      }
      return out
    }
    return v
  }

  any(v: unknown, path: string, secretKey: boolean): unknown {
    if (typeof v === 'string') return this.str(v, path, secretKey)
    if (typeof v === 'number' && secretKey) {
      this.note(path)
      return ''
    }
    if (Array.isArray(v)) return v.map((x, i) => this.any(x, `${path}[${i}]`, secretKey))
    if (isObj(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        const p = `${path}.${k}`
        if (/^headers?$/i.test(k)) out[k] = this.headers(val, p)
        else out[k] = this.any(val, p, secretKey || isSecretKey(k))
      }
      return out
    }
    return v
  }
}

const label = (row: Record<string, unknown> | undefined, ...keys: string[]): string => {
  for (const k of keys) {
    const v = row?.[k]
    if (typeof v === 'string' && v) return v.slice(0, 60)
  }
  return '?'
}

/** Pure: a copy of the blueprint with every credential emptied, and where they were. */
export function scrubBlueprintSecrets(bp: Blueprint): ScrubResult {
  const w = new Walker()
  const row = (r: Record<string, unknown>, path: string) =>
    w.any(r, path, false) as Record<string, unknown>
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
          payload_templates: bp.payload_templates.map(
            (t) =>
              w.any(t, `payload_templates[${label(t as never, 'key')}]`, false) as NonNullable<
                Blueprint['payload_templates']
              >[number]
          )
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
            return {
              flow: row(f.flow, `flows[${name}]`),
              operations: f.operations.map((o) =>
                row(o, `flows[${name}].operations[${label(o, 'key', 'name')}]`)
              )
            }
          })
        }
      : {})
  }
  return { blueprint: out, scrubbed: w.scrubbed }
}
