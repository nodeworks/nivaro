/**
 * Investigation actions (drill-down Task 8) — the pure parts: the stack context compactor
 * (#1210/#1212), the Markdown and HAR exporters (#1215, #1211), the live-tail matcher (#1214) and
 * the Explain answer parser. No React, no fetches, no query client.
 */
import type { InspectRef } from '../../registry/inspectables'
import type { TrafficEventWire } from '../../types'

/** The context Explain and the notebook receive is capped at this many characters of JSON. */
export const CONTEXT_CAP = 24 * 1024

export interface ContextLevelInput {
  ref: InspectRef
  title: string
  current: boolean
  /** The level's detail as its panel loaded it; undefined = not loaded (never opened, failed). */
  detail: unknown
}

export interface StackContext {
  anchor: string | null
  window_s: number
  levels: Array<{
    n: number
    kind: string
    id: string
    title: string
    at?: string
    current: boolean
    detail: unknown
    note?: string
  }>
}

export interface CompactResult {
  context: StackContext
  bytes: number
  /** What had to go to fit, in order: 'bodies', 'long text', 'long lists', 'older levels', … */
  trimmed: string[]
}

const BODY_KEY =
  /^(body|request_body|response_body|response|payload|raw|html|screenshot|events|chunks|post_data|captured_body)$/i
const MAX_DEPTH = 7

function iso(ms: number | null | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

function size(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** A JSON-safe copy, depth-limited (cycles and functions never reach the server). */
function plain(v: unknown, depth = 0): unknown {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v ?? null
  if (typeof v === 'string') return v
  if (typeof v === 'bigint') return String(v)
  if (typeof v !== 'object') return null
  if (depth >= MAX_DEPTH) return '[…]'
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'function' || x === undefined) continue
    out[k] = plain(x, depth + 1)
  }
  return out
}

/** `fn` applied to every value under a key, deep (returns a new tree). */
function mapDeep(v: unknown, fn: (key: string | null, val: unknown) => unknown): unknown {
  const walk = (key: string | null, x: unknown): unknown => {
    const y = fn(key, x)
    if (y !== x) return y
    if (Array.isArray(x)) return x.map((e) => walk(null, e))
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, e] of Object.entries(x as Record<string, unknown>)) out[k] = walk(k, e)
      return out
    }
    return x
  }
  return walk(null, v)
}

const dropBodies = (v: unknown) =>
  mapDeep(v, (k, x) =>
    k && BODY_KEY.test(k) && x != null && x !== ''
      ? `[${k} dropped: ${size(x).toLocaleString('en-US')} chars]`
      : x
  )
const cutStrings = (max: number) => (v: unknown) =>
  mapDeep(v, (_k, x) =>
    typeof x === 'string' && x.length > max ? `${x.slice(0, max)}… (+${x.length - max})` : x
  )
const cutLists = (max: number) => (v: unknown) =>
  mapDeep(v, (_k, x) =>
    Array.isArray(x) && x.length > max ? [...x.slice(0, max), `[+${x.length - max} more]`] : x
  )

/**
 * The stack as a compact JSON for Explain and the notebook. Trims, in order, until it fits `cap`:
 * bodies → long text → long lists → older levels' details (oldest first) → the current detail.
 * Titles, kinds and ids always survive.
 */
export function compactStackContext(
  levels: ContextLevelInput[],
  opts: { anchor: number | null; windowSec: number; cap?: number }
): CompactResult {
  const cap = opts.cap ?? CONTEXT_CAP
  const context: StackContext = {
    anchor: iso(opts.anchor) ?? null,
    window_s: opts.windowSec,
    levels: levels.map((l, i) => {
      const at = iso(l.ref.at)
      return {
        n: i + 1,
        kind: l.ref.kind,
        id: l.ref.id,
        title: l.title,
        ...(at ? { at } : {}),
        current: l.current,
        detail: l.detail === undefined ? null : plain(l.detail),
        ...(l.detail === undefined ? { note: 'not loaded' } : {})
      }
    })
  }
  const trimmed: string[] = []
  const fits = () => size(context) <= cap
  if (fits()) return { context, bytes: size(context), trimmed }

  const steps: Array<[string, (v: unknown) => unknown]> = [
    ['bodies', dropBodies],
    ['long text', cutStrings(300)],
    ['long lists', cutLists(12)],
    ['shorter text', cutStrings(80)],
    ['shorter lists', cutLists(4)]
  ]
  for (const [label, fn] of steps) {
    for (const l of context.levels) l.detail = fn(l.detail)
    trimmed.push(label)
    if (fits()) return { context, bytes: size(context), trimmed }
  }
  // drop whole details: older levels first (oldest first), the current one last
  const order = context.levels
    .map((l, i) => ({ l, i }))
    .sort((a, b) => Number(a.l.current) - Number(b.l.current) || a.i - b.i)
  let dropped = false
  for (const { l } of order) {
    if (l.detail == null) continue
    l.detail = null
    l.note = 'detail dropped to fit'
    if (!dropped) {
      trimmed.push(l.current ? 'current level' : 'older levels')
      dropped = true
    } else if (l.current && !trimmed.includes('current level')) trimmed.push('current level')
    if (fits()) return { context, bytes: size(context), trimmed }
  }
  // titles alone still too big (very long labels): cut them
  for (const l of context.levels) l.title = l.title.slice(0, 120)
  return { context, bytes: size(context), trimmed: [...trimmed, 'titles'] }
}

// ── key facts (Markdown export, chat summary) ──

const SKIP_FACT = /^(id|uuid|_|password|token|secret|authorization|cookie)/i

function humanKey(k: string): string {
  const s = k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function factValue(v: unknown): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v.toLocaleString('en-US') : null
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'string') {
    const s = v.replace(/\s+/g, ' ').trim()
    if (!s) return null
    return s.length > 160 ? `${s.slice(0, 160)}…` : s
  }
  return null
}

/**
 * Up to `max` label/value facts of a detail: its own scalar fields, then those of one nested
 * object (`row`, `log`, `summary`, `request`…), skipping ids, secrets and bodies.
 */
export function keyFacts(detail: unknown, max = 10): Array<[string, string]> {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return []
  const out: Array<[string, string]> = []
  const seen = new Set<string>()
  const take = (obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      if (out.length >= max) return
      if (seen.has(k) || SKIP_FACT.test(k) || BODY_KEY.test(k)) continue
      const val = factValue(v)
      if (val == null) continue
      seen.add(k)
      out.push([humanKey(k), val])
    }
  }
  const d = detail as Record<string, unknown>
  take(d)
  for (const k of ['row', 'log', 'summary', 'request', 'record', 'trace']) {
    const nested = d[k]
    if (nested && typeof nested === 'object' && !Array.isArray(nested))
      take(nested as Record<string, unknown>)
  }
  return out
}

// ── Markdown (#1215, #1211) ──

export interface ExportLevel {
  ref: InspectRef
  title: string
  detail: unknown
  /** The inspect URL of the stack up to and including this level. */
  url: string
}

function mdEscape(s: string): string {
  return s.replace(/([\\`*_[\]|])/g, '\\$1')
}

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** The investigation as Markdown: each level with its key facts and an `inspect` link. */
export function buildMarkdown(
  levels: ExportLevel[],
  opts: { anchor: number | null; now: number; notes?: string | null }
): string {
  if (levels.length === 0) return ''
  const root = levels[0]
  const lines: string[] = [`# Investigation: ${mdEscape(root.title)}`, '']
  const anchored = opts.anchor != null ? ` · anchored at ${utc(opts.anchor)}` : ''
  lines.push(`_Exported from the Traffic Map ${utc(opts.now)}${anchored}._`, '')
  lines.push(`[Open the whole investigation](${levels[levels.length - 1].url})`, '')
  if (opts.notes?.trim()) lines.push('## Notes', '', opts.notes.trim(), '')
  levels.forEach((l, i) => {
    const at = l.ref.at != null && Number.isFinite(l.ref.at) ? ` · ${utc(l.ref.at)}` : ''
    lines.push(`## ${i + 1}. ${mdEscape(l.title)}`, '')
    lines.push(`${l.ref.kind} \`${l.ref.id}\`${at} · [open](${l.url})`, '')
    const facts = keyFacts(l.detail)
    if (l.detail === undefined) lines.push('_Not loaded when exported._', '')
    else if (facts.length === 0) lines.push('_No simple facts to list._', '')
    else {
      for (const [k, v] of facts) lines.push(`- **${mdEscape(k)}:** ${mdEscape(v)}`)
      lines.push('')
    }
  })
  return `${lines.join('\n').trimEnd()}\n`
}

/** A few lines for a chat message: the path, the current level's top facts and the link. */
export function buildChatSummary(levels: ExportLevel[]): string {
  if (levels.length === 0) return ''
  const cur = levels[levels.length - 1]
  const path = levels.map((l) => l.title).join(' › ')
  const facts = keyFacts(cur.detail, 3)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ')
  return [`Traffic Map investigation: ${path}`, facts, cur.url].filter(Boolean).join('\n')
}

// ── HAR (#1215) ──

export interface RequestFacts {
  method: string
  path: string
  query: string | null
  status: number | null
  ms: number | null
  at: number | null
  userAgent: string | null
  body: string | null
  error: string | null
  requestId: string | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}
function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
function time(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}
function first<T>(obj: Record<string, unknown>, keys: string[], pick: (v: unknown) => T | null) {
  for (const k of keys) {
    const v = pick(obj[k])
    if (v != null) return v
  }
  return null
}

/**
 * The HTTP facts of a request level's detail (an API log row, possibly nested under `row` /
 * `log` / `request`); null when it does not look like one.
 */
export function requestFacts(detail: unknown, ref?: InspectRef): RequestFacts | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  const d = detail as Record<string, unknown>
  const nested = ['row', 'log', 'request'].map((k) => d[k]).find((x) => x && typeof x === 'object')
  const src = { ...((nested as Record<string, unknown>) ?? {}), ...d }
  let method = first(src, ['method', 'http_method'], str)
  let path = first(src, ['path', 'url'], str)
  const route = first(src, ['route'], str) ?? ref?.label ?? null
  if ((!method || !path) && route) {
    const m = /^([A-Z]+)\s+(\S+)/.exec(route)
    if (m) {
      method = method ?? m[1]
      path = path ?? m[2]
    }
  }
  if (!method || !path) return null
  let query = first(src, ['query', 'query_string', 'querystring'], str)
  if (query?.startsWith('?')) query = query.slice(1)
  const rawBody = src.request_body ?? src.body ?? src.captured_body
  const body =
    rawBody == null || rawBody === ''
      ? null
      : typeof rawBody === 'string'
        ? rawBody
        : JSON.stringify(rawBody)
  return {
    method: method.toUpperCase(),
    path: path.startsWith('/') || /^https?:\/\//.test(path) ? path : `/${path}`,
    query,
    status: first(src, ['status', 'status_code', 'statusCode'], num),
    ms: first(src, ['latency_ms', 'duration_ms', 'ms', 'took_ms'], num),
    at: first(src, ['created_at', 'at', 'timestamp', 'started_at'], time) ?? ref?.at ?? null,
    userAgent: first(src, ['user_agent', 'userAgent'], str),
    body,
    error: first(src, ['error', 'error_text'], str),
    requestId: first(src, ['request_id', 'rid'], str) ?? (ref?.kind === 'request' ? ref.id : null)
  }
}

function queryPairs(q: string | null): Array<{ name: string; value: string }> {
  if (!q) return []
  try {
    return [...new URLSearchParams(q).entries()].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

/**
 * HAR 1.2 for the request levels that could be read. Only what the API log knows goes in —
 * response bodies and most headers are not kept, and the comment on each entry says so.
 */
export function buildHar(requests: RequestFacts[], origin: string): Record<string, unknown> {
  const entries = requests.map((r) => {
    const url = /^https?:\/\//.test(r.path)
      ? r.path
      : `${origin}${r.path}${r.query ? `?${r.query}` : ''}`
    const headers: Array<{ name: string; value: string }> = []
    if (r.userAgent) headers.push({ name: 'User-Agent', value: r.userAgent })
    if (r.requestId) headers.push({ name: 'x-nivaro-request-id', value: r.requestId })
    const request: Record<string, unknown> = {
      method: r.method,
      url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers,
      queryString: queryPairs(r.query),
      headersSize: -1,
      bodySize: r.body ? r.body.length : 0
    }
    if (r.body) request.postData = { mimeType: 'application/json', text: r.body }
    const ms = r.ms != null && r.ms >= 0 ? r.ms : 0
    return {
      startedDateTime: new Date(r.at ?? 0).toISOString(),
      time: ms,
      request,
      response: {
        status: r.status ?? 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [],
        content: r.error
          ? { size: r.error.length, mimeType: 'application/json', text: r.error }
          : { size: 0, mimeType: 'application/json' },
        redirectURL: '',
        headersSize: -1,
        bodySize: -1
      },
      cache: {},
      timings: { send: 0, wait: ms, receive: 0 },
      comment:
        'From the Nivaro API log: response bodies and most headers are not kept' +
        (r.body ? '' : '; the request body was not captured for this caller')
    }
  })
  return {
    log: {
      version: '1.2',
      creator: { name: 'Nivaro Traffic Map', version: '1' },
      pages: [],
      entries
    }
  }
}

// ── live tail (#1214) ──

export interface TailMatcher {
  label: string
  match(ev: TrafficEventWire): boolean
}

/** What a live tail on `ref` shows, or null when the ref has nothing to tail. */
export function tailMatcher(ref: InspectRef, detail?: unknown): TailMatcher | null {
  if (ref.kind === 'entity') {
    const cut = ref.id.indexOf('/')
    if (cut <= 0) return null
    const lane = ref.id.slice(0, cut)
    const entity = ref.id.slice(cut + 1)
    return { label: `${lane}/${entity}`, match: (ev) => ev.lane === lane && ev.entity === entity }
  }
  if (ref.kind === 'caller') {
    const id = ref.id
    return { label: id, match: (ev) => ev.caller === id || ev.run === id }
  }
  if (ref.kind === 'request') {
    const facts = requestFacts(detail, ref)
    const d = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {}
    const route =
      (typeof d.route === 'string' && d.route) ||
      (ref.label && /^[A-Z]+\s+\//.test(ref.label) ? ref.label : null) ||
      (facts ? `${facts.method} ${facts.path}` : null)
    if (!route) return null
    return { label: route, match: (ev) => ev.route === route }
  }
  return null
}

/** The newest `max` events the matcher accepts (events arrive newest first). */
export function tailEvents(
  events: readonly TrafficEventWire[],
  m: TailMatcher,
  max = 50
): TrafficEventWire[] {
  const out: TrafficEventWire[] = []
  for (const ev of events) {
    if (!m.match(ev)) continue
    out.push(ev)
    if (out.length >= max) break
  }
  return out
}

// ── Explain answer ──

export type ExplainPart = { text: string } | { level: number }

const SECTION_RE = /^\s*(What happened|Likely cause|Where to look next)\s*:\s*/i

/** The model's answer split into its three titled sections (one untitled block if it ignored them). */
export function parseExplain(text: string): Array<{ title: string | null; body: string }> {
  const out: Array<{ title: string | null; body: string }> = []
  for (const raw of text.split('\n')) {
    const m = SECTION_RE.exec(raw)
    if (m) {
      const t = m[1].toLowerCase()
      const title =
        t === 'what happened'
          ? 'What happened'
          : t === 'likely cause'
            ? 'Likely cause'
            : 'Where to look next'
      out.push({ title, body: raw.slice(m[0].length).trim() })
    } else if (raw.trim()) {
      if (out.length === 0) out.push({ title: null, body: raw.trim() })
      else out[out.length - 1].body = `${out[out.length - 1].body} ${raw.trim()}`.trim()
    }
  }
  return out
}

/** A section body with `[L2]` citations split out. */
export function citeParts(body: string): ExplainPart[] {
  const parts: ExplainPart[] = []
  const re = /\[L(\d{1,2})\]/g
  let last = 0
  let m: RegExpExecArray | null = re.exec(body)
  while (m) {
    if (m.index > last) parts.push({ text: body.slice(last, m.index) })
    parts.push({ level: Number(m[1]) })
    last = m.index + m[0].length
    m = re.exec(body)
  }
  if (last < body.length) parts.push({ text: body.slice(last) })
  return parts
}

/** `investigation-2026-10-01.har` (or .md). */
export function exportFileName(ext: 'har' | 'md', now: number): string {
  return `investigation-${new Date(now).toISOString().slice(0, 10)}.${ext}`
}
