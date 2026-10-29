/**
 * Readable integration errors: a failed outbound call → one plain sentence, the
 * likely cause and a "Fix it" target (the record field, the external API's
 * config, the partner page) instead of a raw body or stack.
 *
 * Rule-based and PURE (no database, no imports with side effects): the route
 * side (integration-error-context.ts) gathers the facts — partner name, HTTP
 * status, the stored error text, the response body, the record and its field
 * list — and asks here. Partner rules registered by extensions
 * (`ctx.integrations.registerErrorExplainers`) run before the core rules.
 *
 * What a sentence may quote: the partner's own message, trimmed to a short
 * excerpt with anything token-shaped masked. Never request bodies, headers or
 * query strings.
 */

export type IntegrationErrorCause =
  | 'credentials'
  | 'not_found'
  | 'validation'
  | 'body_rejection'
  | 'conflict'
  | 'timeout'
  | 'unreachable'
  | 'rate_limited'
  | 'partner_down'
  | 'unknown'

/** What a "Fix it" link points at. Hosts map it onto their own routes. */
export type IntegrationFixTarget =
  | { kind: 'record'; collection: string; item: string; field?: string | null }
  | {
      kind: 'external_api'
      id: number
      section?: 'auth' | 'endpoints' | 'connection' | 'response' | null
    }
  | { kind: 'partner'; id: number }
  | { kind: 'payload_template'; api_id: number; key: string }

export interface IntegrationErrorInput {
  /** The external API's name ("Fusion"). */
  partner?: string | null
  apiId?: number | null
  /** The HTTP status the partner answered; null = none (network error, timeout). */
  httpStatus?: number | null
  /** The stored error text (last_error, call log error). */
  error?: string | null
  /** The partner's response body (parsed JSON or text). */
  body?: unknown
  collection?: string | null
  item?: string | null
  /** The record's human id ("CR26-80361"), when the caller has it. */
  recordLabel?: string | null
  /** The endpoint path the call went to (no query string). */
  endpoint?: string | null
  /** The record collection's fields, for naming the field a validation error is about. */
  fields?: Array<{ field: string; label?: string | null }> | null
  /** The payload template that built the body, when known. */
  payloadTemplateKey?: string | null
}

export interface IntegrationErrorExplanation {
  sentence: string
  cause: IntegrationErrorCause
  /** "Open the record", "Check the credentials" — the Fix it button's words. */
  fix_label: string | null
  fix: IntegrationFixTarget | null
  /** The admin path for `fix` (hosts may map `fix` instead). */
  fix_link: string | null
  /** The record field the error is about, when one was named. */
  field: string | null
  /** The partner's own message, short and masked (null when it sent none). */
  detail: string | null
  /** Which rule spoke: `core:credentials`, `ext:efp-ops:fusion-supplier-site`. */
  rule: string
}

/** Facts every rule may read — computed once per explanation. */
export interface IntegrationErrorFacts {
  status: number | null
  partner: string
  /** "Workflow CR26-80361" / "this record" */
  record: string
  hasRecord: boolean
  /** The partner's own message (masked, ≤ 180 chars), or null. */
  message: string | null
  /** Lower-cased error text + body text, for pattern rules. */
  text: string
  /** A 2xx whose body says no (status ERROR / success false / errors[]). */
  bodyRejected: boolean
  /** The record field the message names, or null. */
  field: { field: string; label: string } | null
}

export type IntegrationErrorRuleResult = Partial<
  Omit<IntegrationErrorExplanation, 'rule' | 'fix_link'>
> & {
  sentence: string
}

export interface IntegrationErrorRule {
  /** Stable id; registering the same id again replaces it. */
  id: string
  /** Only for this partner (name match, case-insensitive) — absent = every partner. */
  partner?: string | RegExp
  match(
    input: IntegrationErrorInput,
    facts: IntegrationErrorFacts
  ): IntegrationErrorRuleResult | null
}

// ─── Text helpers ────────────────────────────────────────────────────────────

const MESSAGE_MAX = 180

/** Mask anything token-shaped (bearer values, long hex/base64 runs, emails' local parts stay). */
export function maskSecretsInText(text: string): string {
  return text
    .replace(/\b(bearer|basic|token|apikey|api_key|password|secret)\b\s*[:=]?\s*\S+/gi, '$1 ••••')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '••••')
}

function clip(text: string, max = MESSAGE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body
  const t = body.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return body
  try {
    return JSON.parse(t)
  } catch {
    return body
  }
}

const MESSAGE_KEYS = [
  'message',
  'detail',
  'error_description',
  'statusMessage',
  'detailMessage',
  'lineDetailedMessage',
  'title',
  'error',
  'reason',
  'description'
]
const FIELD_KEYS = ['field', 'path', 'attribute', 'property', 'param', 'name', 'source']

/** The partner's own words from a body: the first message-like string, walked shallowly. */
export function partnerMessageOf(body: unknown, depth = 0): string | null {
  const b = parseBody(body)
  if (b == null || depth > 4) return null
  if (typeof b === 'string') {
    const flat = b
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return flat ? flat : null
  }
  if (Array.isArray(b)) {
    for (const v of b.slice(0, 5)) {
      const m = partnerMessageOf(v, depth + 1)
      if (m) return m
    }
    return null
  }
  if (typeof b !== 'object') return null
  const obj = b as Record<string, unknown>
  for (const k of MESSAGE_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (v && typeof v === 'object') {
      const m = partnerMessageOf(v, depth + 1)
      if (m) return m
    }
  }
  for (const k of ['errors', 'error', 'details', 'messages', 'problems', 'violations']) {
    const v = obj[k]
    if (v && typeof v === 'object') {
      const m = partnerMessageOf(v, depth + 1)
      if (m) return m
    }
  }
  return null
}

/** Field names a body names on its own (`errors[].field`, `{path: 'SupplierSite'}`). */
function bodyFieldNames(body: unknown, depth = 0, out: string[] = []): string[] {
  const b = parseBody(body)
  if (b == null || typeof b !== 'object' || depth > 4 || out.length > 20) return out
  if (Array.isArray(b)) {
    for (const v of b.slice(0, 20)) bodyFieldNames(v, depth + 1, out)
    return out
  }
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (FIELD_KEYS.includes(k) && typeof v === 'string' && v.length <= 80) out.push(v)
    else if (v && typeof v === 'object') bodyFieldNames(v, depth + 1, out)
  }
  return out
}

const REJECT_VALUES = new Set([
  'ERROR',
  'ERRORS',
  'FAIL',
  'FAILED',
  'FAILURE',
  'REJECTED',
  'DENIED',
  'INVALID'
])

/** A body that says no, whatever the HTTP status said. */
export function bodySaysNo(body: unknown): boolean {
  const b = parseBody(body)
  if (b == null || typeof b !== 'object' || Array.isArray(b)) return false
  const obj = b as Record<string, unknown>
  for (const k of ['status', 'api_status', 'result', 'ReturnStatus', 'returnStatus', 'outcome']) {
    const v = obj[k]
    if (typeof v === 'string' && REJECT_VALUES.has(v.trim().toUpperCase())) return true
  }
  for (const k of ['success', 'ok', 'status']) if (obj[k] === false) return true
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return true
  return false
}

/** "PurchaseOrderNumber" / "supplier_site" → "purchase order number" / "supplier site". */
export function spacedWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.\-[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** The record field a message (or the body's own field keys) names. Longest match wins. */
export function matchField(
  message: string,
  bodyFields: string[],
  fields: Array<{ field: string; label?: string | null }> | null | undefined
): { field: string; label: string } | null {
  if (!fields || fields.length === 0) return null
  const hay = ` ${spacedWords(message).replace(/[^a-z0-9 ]+/g, ' ')} `
  const named = bodyFields.map((f) => spacedWords(f))
  let best: { field: string; label: string; len: number } | null = null
  for (const f of fields) {
    const label = (f.label ?? '').trim() || titleCaseWords(spacedWords(f.field))
    const candidates = new Set([spacedWords(f.field), spacedWords(label)])
    for (const c of candidates) {
      if (c.length < 4 || c === 'id') continue
      const hit = named.includes(c) || hay.includes(` ${c} `)
      if (hit && (!best || c.length > best.len)) best = { field: f.field, label, len: c.length }
    }
  }
  return best ? { field: best.field, label: best.label } : null
}

function titleCaseWords(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

/** "purchase_orders" → "Purchase order". */
export function singularNoun(collection: string): string {
  const words = spacedWords(collection)
  const singular = words.endsWith('ies')
    ? `${words.slice(0, -3)}y`
    : words.endsWith('sses')
      ? words.slice(0, -2)
      : words.endsWith('s') && !words.endsWith('ss')
        ? words.slice(0, -1)
        : words
  return singular.charAt(0).toUpperCase() + singular.slice(1)
}

/** The status a stored error text carries ("HTTP 422: …"), when the row has none. */
export function statusFromText(text: string | null | undefined): number | null {
  const m = /\bHTTP\s+(\d{3})\b/i.exec(String(text ?? ''))
  return m ? Number(m[1]) : null
}

/** The text after "HTTP nnn:" — the stored excerpt of the body. */
function textAfterStatus(text: string): string {
  return text.replace(/^\s*HTTP\s+\d{3}\s*:?\s*/i, '')
}

export function factsFor(input: IntegrationErrorInput): IntegrationErrorFacts {
  const error = String(input.error ?? '')
  const status = input.httpStatus ?? statusFromText(error)
  const partner = String(input.partner ?? '').trim() || 'The partner'
  const hasRecord = !!(input.collection && input.item)
  const id = String(input.recordLabel ?? '').trim() || String(input.item ?? '')
  const record = hasRecord ? `${singularNoun(String(input.collection))} ${id}` : 'the request'
  const fromBody = partnerMessageOf(input.body)
  const fromError = error ? partnerMessageOf(textAfterStatus(error)) : null
  const raw = fromBody ?? fromError
  const message = raw ? clip(maskSecretsInText(raw)) : null
  const bodyText = typeof input.body === 'string' ? input.body : safeJson(input.body)
  const text = `${error} ${bodyText}`.toLowerCase()
  const bodyRejected =
    status != null && status >= 200 && status < 300 && (bodySaysNo(input.body) || !!error)
  const field = matchField(
    `${raw ?? ''} ${error}`,
    bodyFieldNames(input.body).concat(bodyFieldNames(textAfterStatus(error))),
    input.fields
  )
  return { status, partner, record, hasRecord, message, text, bodyRejected, field }
}

function safeJson(v: unknown): string {
  if (v == null) return ''
  try {
    return JSON.stringify(v).slice(0, 4000)
  } catch {
    return ''
  }
}

// ─── Fix links ───────────────────────────────────────────────────────────────

/** The admin path for a fix target. */
export function fixLinkFor(fix: IntegrationFixTarget | null | undefined): string | null {
  if (!fix) return null
  switch (fix.kind) {
    case 'record': {
      const base = `/collections/${encodeURIComponent(fix.collection)}/${encodeURIComponent(fix.item)}`
      return fix.field ? `${base}?focus=${encodeURIComponent(fix.field)}` : base
    }
    case 'external_api':
      return `/external-apis/${fix.id}`
    case 'partner':
      return '/integration-health?tab=partners'
    case 'payload_template':
      return `/external-apis/${fix.api_id}/payloads/${encodeURIComponent(fix.key)}`
  }
}

function recordFix(
  input: IntegrationErrorInput,
  field: string | null
): IntegrationFixTarget | null {
  return input.collection && input.item
    ? { kind: 'record', collection: input.collection, item: String(input.item), field }
    : null
}

function apiFix(
  input: IntegrationErrorInput,
  section: 'auth' | 'endpoints' | 'connection' | 'response'
): IntegrationFixTarget | null {
  return input.apiId ? { kind: 'external_api', id: input.apiId, section } : null
}

// ─── Core rules ──────────────────────────────────────────────────────────────

const TIMEOUT_RE =
  /\btime[d ]?\s?out\b|timeout|aborted due to timeout|operation was aborted|etimedout|und_err_(headers|body)_timeout|esockettimedout/
const UNREACHABLE_RE =
  /econnrefused|enotfound|eai_again|econnreset|ehostunreach|enetunreach|fetch failed|socket hang up|getaddrinfo|self[- ]signed|certificate|unable to verify|ssrf|blocked address/
const CREDENTIAL_TEXT_RE =
  /unauthori[sz]ed|invalid[_ ](token|client|grant|credentials)|expired[_ ]token|token (has )?expired|authentication failed|access denied|not authenticated/

function unreachableWhy(text: string): string {
  if (/econnrefused/.test(text)) return 'it refused the connection'
  if (/enotfound|getaddrinfo|eai_again/.test(text)) return 'its address could not be found'
  if (/certificate|self[- ]signed|unable to verify/.test(text))
    return 'its security certificate was not accepted'
  if (/ssrf|blocked address/.test(text)) return 'its address is not allowed from this server'
  if (/econnreset|socket hang up/.test(text)) return 'it dropped the connection'
  return 'the network call failed'
}

function withMessage(base: string, message: string | null): string {
  return message ? `${base}: ${message.replace(/[.\s]+$/, '')}` : base
}

export const CORE_RULES: IntegrationErrorRule[] = [
  {
    id: 'core:timeout',
    match: (input, f) =>
      f.status === 408 || f.status === 504 || (f.status == null && TIMEOUT_RE.test(f.text))
        ? {
            cause: 'timeout',
            sentence: `${f.partner} did not answer in time${f.hasRecord ? ` for ${f.record}` : ''}. It may still have done the work — check before sending again.`,
            fix: apiFix(input, 'connection'),
            fix_label: input.apiId ? `Check the timeout on ${f.partner}` : null
          }
        : null
  },
  {
    id: 'core:unreachable',
    match: (input, f) =>
      f.status == null && UNREACHABLE_RE.test(f.text)
        ? {
            cause: 'unreachable',
            sentence: `Could not reach ${f.partner}: ${unreachableWhy(f.text)}.`,
            fix: apiFix(input, 'connection'),
            fix_label: input.apiId ? `Check the address of ${f.partner}` : null
          }
        : null
  },
  {
    id: 'core:rate-limited',
    match: (input, f) =>
      f.status === 429
        ? {
            cause: 'rate_limited',
            sentence: `${f.partner} asked Nivaro to slow down (too many requests). Sending again a little later usually works.`,
            fix: input.apiId ? { kind: 'partner', id: input.apiId } : null,
            fix_label: input.apiId ? 'See the partner' : null
          }
        : null
  },
  {
    id: 'core:credentials',
    match: (input, f) => {
      const byStatus = f.status === 401 || f.status === 403
      const byText =
        (f.status == null || f.status >= 400) && CREDENTIAL_TEXT_RE.test(f.text) && f.status !== 404
      if (!byStatus && !byText) return null
      const forbidden = f.status === 403
      return {
        cause: 'credentials',
        sentence: forbidden
          ? `${f.partner} says the account Nivaro signs in with is not allowed to do this (HTTP 403).`
          : `${f.partner} did not accept Nivaro's credentials${f.status ? ` (HTTP ${f.status})` : ''} — the key, password or token may have expired or changed.`,
        fix: apiFix(input, 'auth'),
        fix_label: input.apiId ? `Check the credentials for ${f.partner}` : null,
        detail: f.message
      }
    }
  },
  {
    id: 'core:not-found',
    match: (input, f) =>
      f.status === 404
        ? {
            cause: 'not_found',
            sentence: input.endpoint
              ? `${f.partner} has nothing at ${input.endpoint} — the endpoint path may be wrong, or ${f.record} does not exist on their side.`
              : `${f.partner} could not find what Nivaro asked for — the endpoint path may be wrong, or ${f.record} does not exist on their side.`,
            fix: apiFix(input, 'endpoints'),
            fix_label: input.apiId ? 'Check the endpoint path' : null,
            detail: f.message
          }
        : null
  },
  {
    id: 'core:conflict',
    match: (input, f) =>
      f.status === 409
        ? {
            cause: 'conflict',
            sentence: withMessage(`${f.partner} already has ${f.record} (conflict)`, f.message),
            fix: recordFix(input, f.field?.field ?? null),
            fix_label: f.hasRecord ? 'Open the record' : null,
            field: f.field?.field ?? null,
            detail: f.message
          }
        : null
  },
  {
    id: 'core:body-rejection',
    match: (input, f) => {
      if (!f.bodyRejected) return null
      const fix = f.field ? recordFix(input, f.field.field) : recordFix(input, null)
      return {
        cause: 'body_rejection',
        sentence: withMessage(
          `${f.partner} answered OK (HTTP ${f.status}) but rejected ${f.record} inside its reply`,
          f.message
        ),
        fix: fix ?? apiFix(input, 'response'),
        fix_label: f.field
          ? `Fix ${f.field.label} on the record`
          : fix
            ? 'Open the record'
            : input.apiId
              ? 'Check how replies are read'
              : null,
        field: f.field?.field ?? null,
        detail: f.message
      }
    }
  },
  {
    id: 'core:validation',
    match: (input, f) => {
      if (f.status == null || f.status < 400 || f.status >= 500) return null
      // Name the field only when the partner's words do not already say it.
      const said = f.field && spacedWords(f.message ?? '').includes(spacedWords(f.field.label))
      const named = f.field && !said ? ` (${f.field.label})` : ''
      return {
        cause: 'validation',
        sentence: withMessage(`${f.partner} rejected ${f.record}${named}`, f.message),
        fix: recordFix(input, f.field?.field ?? null) ?? apiFix(input, 'endpoints'),
        fix_label: f.field
          ? `Fix ${f.field.label} on the record`
          : f.hasRecord
            ? 'Open the record'
            : input.apiId
              ? `Open ${f.partner}`
              : null,
        field: f.field?.field ?? null,
        detail: f.message
      }
    }
  },
  {
    id: 'core:partner-down',
    match: (input, f) =>
      f.status != null && f.status >= 500
        ? {
            cause: 'partner_down',
            sentence: `${f.partner} had a problem on its side (HTTP ${f.status}). Nothing is wrong with ${f.record}; sending again later usually works.`,
            fix: input.apiId ? { kind: 'partner', id: input.apiId } : null,
            fix_label: input.apiId ? 'See the partner' : null,
            detail: f.message
          }
        : null
  },
  {
    id: 'core:unknown',
    match: (input, f) =>
      input.error || f.message
        ? {
            cause: 'unknown',
            sentence: withMessage(`The call to ${f.partner} failed`, f.message),
            fix: recordFix(input, f.field?.field ?? null) ?? apiFix(input, 'connection'),
            fix_label: f.hasRecord ? 'Open the record' : input.apiId ? `Open ${f.partner}` : null,
            field: f.field?.field ?? null,
            detail: f.message
          }
        : null
  }
]

// ─── Registry ────────────────────────────────────────────────────────────────

interface RegisteredRule extends IntegrationErrorRule {
  source: string
}

/** Partner rules from extensions, in registration order (module state, same in every tenant —
 *  rules are code, never tenant data). */
const extensionRules: RegisteredRule[] = []

/**
 * Register partner rules (`ctx.integrations.registerErrorExplainers`). `source` = the extension
 * id; a rule id registered again replaces the old one. Throws nothing: a malformed rule is skipped.
 */
export function registerIntegrationErrorExplainers(
  rules: IntegrationErrorRule[],
  source = 'extension'
): number {
  let n = 0
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || typeof r.id !== 'string' || !r.id || typeof r.match !== 'function') continue
    const id = r.id.startsWith('ext:') ? r.id : `ext:${source}:${r.id}`
    const at = extensionRules.findIndex((x) => x.id === id)
    const entry: RegisteredRule = { ...r, id, source }
    if (at >= 0) extensionRules[at] = entry
    else extensionRules.push(entry)
    n++
  }
  return n
}

/** Drop every rule a source registered (extension unload) — or all of them (tests). */
export function clearIntegrationErrorExplainers(source?: string): void {
  for (let i = extensionRules.length - 1; i >= 0; i--) {
    if (source == null || extensionRules[i].source === source) extensionRules.splice(i, 1)
  }
}

export function listIntegrationErrorExplainers(): Array<{ id: string; source: string }> {
  return [
    ...extensionRules.map((r) => ({ id: r.id, source: r.source })),
    ...CORE_RULES.map((r) => ({ id: r.id, source: 'core' }))
  ]
}

function partnerMatches(rule: IntegrationErrorRule, partner: string | null | undefined): boolean {
  if (!rule.partner) return true
  const name = String(partner ?? '')
  return rule.partner instanceof RegExp
    ? rule.partner.test(name)
    : rule.partner.trim().toLowerCase() === name.trim().toLowerCase()
}

/** Did this call fail at all? (2xx without a rejection = nothing to explain.) */
export function looksFailed(input: IntegrationErrorInput, f: IntegrationErrorFacts): boolean {
  if (f.status != null && (f.status < 200 || f.status >= 300)) return true
  if (f.bodyRejected) return true
  return f.status == null && !!String(input.error ?? '').trim()
}

/**
 * The explanation of one failed call, or null when it did not fail. Extension rules first (in
 * registration order, partner-filtered), then the core rules; the first that answers wins. A rule
 * that throws is skipped.
 */
export function explainIntegrationError(
  input: IntegrationErrorInput
): IntegrationErrorExplanation | null {
  const facts = factsFor(input)
  if (!looksFailed(input, facts)) return null
  for (const rule of [...extensionRules, ...CORE_RULES]) {
    if (!partnerMatches(rule, input.partner)) continue
    let out: IntegrationErrorRuleResult | null = null
    try {
      out = rule.match(input, facts)
    } catch {
      out = null
    }
    if (!out || typeof out.sentence !== 'string' || !out.sentence.trim()) continue
    const fix = out.fix ?? null
    return {
      sentence: clip(maskSecretsInText(out.sentence), 400),
      cause: out.cause ?? 'unknown',
      fix_label: fix ? (out.fix_label ?? 'Fix it') : null,
      fix,
      fix_link: fixLinkFor(fix),
      field: out.field ?? facts.field?.field ?? null,
      detail: out.detail === undefined ? facts.message : out.detail,
      rule: rule.id
    }
  }
  return null
}
