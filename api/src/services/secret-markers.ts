/**
 * The ONE implementation of the secret-placeholder defence. Record, trigger and response data
 * must never be able to forge a body-secret placeholder `⟦nvr-secret:<name>⟧`; only
 * ADMIN-AUTHORED template text (a `secret` source, `secrets.<name>` / `| secret`, a literal placeholder in a
 * JSON body template) may produce a real one. Pure module (no db / config imports) so the payload
 * evaluator, the code-mode render and body-secrets.ts all share it and cannot drift.
 */
import { randomBytes } from 'node:crypto'

/** The placeholder a body secret renders as; the sender swaps in the value. */
export const SECRET_PLACEHOLDER = (name: string): string => `⟦nvr-secret:${name}⟧`

/** Matches one placeholder; group 1 = the secret name. */
export const PLACEHOLDER_RE = /⟦nvr-secret:([^⟧]*)⟧/g
/** A body-secret name: what the editor offers, `secrets.<name>` and `| secret` accept. */
export const SECRET_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export const MARKER = '⟦nvr-secret:'
/** The marker with a zero-width space after "secret": reads the same, never matches. */
const NEUTRAL_MARKER = '⟦nvr-secret\u200b:'

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** One string with every marker made inert. */
export const neutralString = (s: string): string =>
  s.includes(MARKER) ? s.split(MARKER).join(NEUTRAL_MARKER) : s

/**
 * Deep copy with `valueFn` applied to every string value and `keyFn` to every object key — the
 * same walk as the payload evaluator's (Task 3): Dates are copied, Map / Set / ArrayBuffer and
 * typed-array views (Buffer) are opaque, plain records AND class instances become plain copies of
 * their own enumerable keys, cycles keep their shape, `__proto__` stays an own key.
 */
export function mapStrings(
  value: unknown,
  valueFn: (s: string) => string,
  keyFn: (s: string) => string = valueFn
): unknown {
  const seen = new WeakMap<object, unknown>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return valueFn(v)
    if (v === null || typeof v !== 'object') return v
    if (v instanceof Date) return new Date(v.getTime())
    if (v instanceof Map || v instanceof Set || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      return v
    }
    const hit = seen.get(v)
    if (hit !== undefined) return hit
    if (Array.isArray(v)) {
      const out: unknown[] = []
      seen.set(v, out)
      for (const x of v) out.push(walk(x))
      return out
    }
    const out: Record<string, unknown> =
      Object.getPrototypeOf(v) === null ? Object.create(null) : {}
    seen.set(v, out)
    for (const k of Object.keys(v)) {
      const key = keyFn(k)
      const x = walk((v as Record<string, unknown>)[k])
      if (key === '__proto__') {
        Object.defineProperty(out, key, {
          value: x,
          enumerable: true,
          writable: true,
          configurable: true
        })
      } else out[key] = x
    }
    return out
  }
  return walk(value)
}

/**
 * A deep copy of `value` in which no string — value or object key — can pass for a secret
 * placeholder: every `⟦nvr-secret:` becomes `⟦nvr-secret<ZWSP>:`. Walk semantics: mapStrings.
 * Use it on record / trigger / response data that becomes (part of) a body.
 */
export function neutralizeSecretMarkers(value: unknown): unknown {
  return mapStrings(value, neutralString)
}

/**
 * A per-call, unforgeable token factory for the places that must emit a real placeholder while
 * data is still flowing through. `token(name)` returns a private token (underscore-wrapped random
 * digits: not a number, case filters leave it alone, JSON text carries it unescaped, data cannot guess it). `finish(value)`
 * is the ONE final pass: neutralize every string value and key (so record text, JSON text decoded
 * along the way, fixed text and formula output can never forge a marker), and only then swap the
 * tokens for the real placeholders — in string VALUES; a token in an object key comes back
 * neutral (placeholders are honoured in values only). `used()` = names that landed in a value.
 */
export function makeSecretTokens(): {
  token: (name: string) => string
  finish: (value: unknown) => unknown
  used: () => Set<string>
} {
  const nonce = Array.from(randomBytes(24), (b) => String(b % 10)).join('')
  const names: string[] = []
  const used = new Set<string>()
  const tokenRe = new RegExp(`_${nonce}(\\d{6})_`, 'g')
  const back = (s: string, inKey: boolean): string =>
    names.length === 0 || !s.includes(nonce)
      ? s
      : s.replace(tokenRe, (m, idx: string) => {
          const name = names[Number(idx)]
          if (name === undefined) return m
          const ph = SECRET_PLACEHOLDER(name)
          if (inKey) return neutralString(ph)
          used.add(name)
          return ph
        })
  return {
    token: (name) => {
      // Not a real name (e.g. `{{ __secret_token.token }}` called with nothing): no token.
      if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) return ''
      names.push(name)
      return `_${nonce}${String(names.length - 1).padStart(6, '0')}_`
    },
    finish: (value) =>
      mapStrings(
        value,
        (s) => back(neutralString(s), false),
        (k) => back(neutralString(k), true)
      ),
    used: () => used
  }
}

/**
 * Protects the placeholders an ADMIN wrote in a JSON body template from everything data can do
 * while it is rendered into that template — including JSON-escaped markers (`\u27e6nvr-secret:`)
 * that JSON.parse would decode into a real one, and adjacent interpolations that only form a
 * marker together. Every exact placeholder in the template text is swapped for a makeSecretTokens
 * token before the render; `finish(parsed)` neutralizes the PARSED body and then restores them.
 *
 *   const p = protectTemplatePlaceholders(template)
 *   const body = p.finish(JSON.parse(render(p.text, data)))
 */
export function protectTemplatePlaceholders(templateText: string): {
  text: string
  finish: (parsed: unknown) => unknown
} {
  const t = makeSecretTokens()
  // A name outside SECRET_NAME_RE gets no token: it stays text and finish() neutralizes it.
  const text = templateText.replace(PLACEHOLDER_RE, (m, name: string) =>
    SECRET_NAME_RE.test(name) ? t.token(name) : m
  )
  return { text, finish: t.finish }
}

/** JSON Pointer (RFC 6901) of one path segment. */
const pointerSeg = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1')

function hasPlaceholder(s: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0
  const hit = PLACEHOLDER_RE.test(s)
  PLACEHOLDER_RE.lastIndex = 0
  return hit
}

/**
 * JSON Pointers of every string value in `body` that holds a real placeholder. Run it on the
 * FINAL sanitized body (after protectTemplatePlaceholders / neutralizeSecretMarkers) — only the
 * template's own placeholders remain there — and store the list beside the body, so a later
 * resend honours exactly those (restrictPlaceholders). A top-level string body is pointer "".
 */
export function secretPathsOf(body: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown, at: string, depth: number): void => {
    if (depth > 200) return
    if (typeof v === 'string') {
      if (hasPlaceholder(v)) out.push(at)
      return
    }
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${at}/${i}`, depth + 1)
      return
    }
    if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, `${at}/${pointerSeg(k)}`, depth + 1)
    }
  }
  walk(body, '', 0)
  return out
}

/**
 * A stored body made safe to resend with bodySecrets: true — every placeholder NOT at one of
 * `secretPaths` (and every one in an object key) is neutralized. No list (a row stored before
 * secret_paths existed, or written by something that did not record them) = every placeholder is
 * neutralized: fail closed, nothing is substituted.
 */
export function restrictPlaceholders(body: unknown, secretPaths: unknown): unknown {
  if (!Array.isArray(secretPaths)) return neutralizeSecretMarkers(body)
  const allowed = new Set(secretPaths.filter((p): p is string => typeof p === 'string'))
  if (allowed.size === 0) return neutralizeSecretMarkers(body)
  const walk = (v: unknown, at: string): unknown => {
    if (typeof v === 'string') return allowed.has(at) ? v : neutralString(v)
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}/${i}`))
    if (v !== null && typeof v === 'object') {
      if (!isPlainObject(v)) return neutralizeSecretMarkers(v)
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) {
        const key = neutralString(k)
        const val = walk(x, `${at}/${pointerSeg(k)}`)
        if (key === '__proto__') {
          Object.defineProperty(out, key, {
            value: val,
            enumerable: true,
            writable: true,
            configurable: true
          })
        } else out[key] = val
      }
      return out
    }
    return v
  }
  return walk(body, '')
}
