/**
 * Request story — the pure parts: ids, leaf keys (the `?leaf=` URL state), status words, the
 * template of a raw path, effect nesting and sentences, and where each leaf opens.
 */
import type { EffectKind, Labels, Story, StoryEffect } from './types'

export const RID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A pasted id → the dashed lower-case request id (the 32-hex trace spelling too), else null. */
export function normalizeRid(raw: string): string | null {
  const t = raw.trim().toLowerCase()
  if (UUID_SEG.test(t)) return t
  if (/^[0-9a-f]{32}$/.test(t))
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`
  return null
}

/** "12 ms", "1.24 s", "—". Sub-millisecond phases read "<1 ms". */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1 && ms > 0) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`
  return `${(ms / 1000).toFixed(1)} s`
}

/** "Nov 19, 2026, 8:02:11.123 AM" in the viewer's zone. */
export function fmtClock(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const base = d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  // "8:02:11 AM" → "8:02:11.123 AM"
  return base.replace(/(\d{1,2}:\d{2}:\d{2})/, `$1.${ms}`)
}

/** "+120 ms" offsets on a timeline. */
export function fmtOffset(ms: number | null | undefined): string {
  return ms == null ? '' : `+${fmtMs(ms)}`
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
  301: 'Moved',
  302: 'Found',
  304: 'Not modified',
  400: 'Bad request',
  401: 'Not signed in',
  403: 'Refused',
  404: 'Not found',
  405: 'Method not allowed',
  408: 'Timed out',
  409: 'Conflict',
  410: 'Gone',
  413: 'Too large',
  422: 'Not accepted',
  423: 'Locked',
  429: 'Too many requests',
  500: 'Server error',
  502: 'Bad gateway',
  503: 'Unavailable',
  504: 'Gateway timed out'
}

export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'muted'

export function statusTone(status: number | null | undefined): Tone {
  if (status == null || status === 0) return 'muted'
  if (status >= 500) return 'bad'
  if (status >= 400) return 'warn'
  if (status >= 300) return 'info'
  return 'ok'
}

export function statusText(status: number | null | undefined): string {
  if (status == null || status === 0) return 'No answer'
  return STATUS_TEXT[status] ?? (status >= 500 ? 'Server error' : status >= 400 ? 'Refused' : 'OK')
}

/** What a status means for the person who sent it — the verdict's second sentence. */
export function statusMeaning(status: number | null | undefined): string | null {
  if (status == null) return null
  if (status === 401) return 'The caller was not signed in, or their sign-in had ended.'
  if (status === 403) return 'The caller was signed in but not allowed to do this.'
  if (status === 404) return 'What it asked for does not exist, or the caller cannot see it.'
  if (status === 409)
    return 'It clashed with the current state (someone else’s change, a lock, a duplicate).'
  if (status === 422) return 'The input was refused by a rule or a required field.'
  if (status === 423) return 'The record was locked for editing.'
  if (status === 429) return 'The caller was slowed down by a rate limit.'
  if (status >= 500)
    return 'Something failed on the server — this is ours to fix, not the caller’s.'
  if (status >= 400) return 'The request was refused.'
  return null
}

/**
 * The answer's stored first line, read for a person: a JSON error body becomes its message and
 * hint ("Not found — It may have been deleted…"); anything else stays as it is.
 */
export function readableError(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const t = raw.trim()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>
      const head = [j.error, j.message].find((v) => typeof v === 'string' && v.trim()) as
        | string
        | undefined
      const hint = typeof j.hint === 'string' && j.hint.trim() ? j.hint.trim() : null
      const code = typeof j.code === 'string' ? j.code : null
      if (head) return [head.trim(), hint, code ? `(${code})` : null].filter(Boolean).join(' — ')
    } catch {
      // A cut-off JSON body: pull the message out by hand.
      const m = /"(?:error|message)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t)
      if (m) return m[1]
    }
  }
  return t
}

/**
 * A raw path as its route template: uuid / numeric / long hex segments become `:id`, and the
 * `/api/items/:collection/:id` family keeps its collection. The id the template hid is returned
 * too, so a list can still show it, quietly.
 */
export function pathTemplate(path: string): { template: string; ids: string[] } {
  const clean = path.split('?')[0]
  const ids: string[] = []
  const parts = clean.split('/').map((seg) => {
    if (!seg) return seg
    if (UUID_SEG.test(seg) || /^\d+$/.test(seg) || /^[0-9a-f]{24,}$/i.test(seg)) {
      ids.push(seg)
      return ':id'
    }
    return seg
  })
  return { template: parts.join('/'), ids }
}

/** "Mozilla/5.0 (Macintosh…) … Chrome/131…" → "Chrome 131 on macOS". Unknown = null. */
export function browserOf(ua: string | null | undefined): string | null {
  if (!ua) return null
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iOS/i.test(ua)
      ? 'iOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : null
  const m =
    /Edg\/(\d+)/.exec(ua) ??
    /Firefox\/(\d+)/.exec(ua) ??
    /Chrome\/(\d+)/.exec(ua) ??
    /Version\/(\d+)[^ ]* Safari/.exec(ua)
  const name = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null
  if (!name) {
    const tool = /^([A-Za-z][\w.-]*)\/([\d.]+)/.exec(ua)
    return tool ? `${tool[1]} ${tool[2]}` : null
  }
  return `${name}${m ? ` ${m[1]}` : ''}${os ? ` on ${os}` : ''}`
}

const AUTH_WORDS: Record<string, string> = {
  session: 'Browser session',
  token: 'Static token',
  api_key: 'API key',
  masquerade: 'View as (an admin viewing as this person)',
  oauth: 'Connected app (OAuth)',
  device: 'Phone app',
  none: 'Not signed in'
}

export function authWords(auth: string | null | undefined): string | null {
  return auth ? (AUTH_WORDS[auth] ?? auth) : null
}

// ─── Leaves (the ?leaf= URL state) ───────────────────────────────────────────

export type Leaf =
  | { type: 'request' }
  | { type: 'caller' }
  | { type: 'error' }
  | { type: 'phase'; seq: number }
  | { type: 'sql'; index: number }
  | { type: 'effect'; key: string }
  | { type: 'emit'; event: string }

export function leafKey(l: Leaf): string {
  switch (l.type) {
    case 'phase':
      return `phase:${l.seq}`
    case 'sql':
      return `sql:${l.index}`
    case 'effect':
      return `effect:${l.key}`
    case 'emit':
      return `emit:${l.event}`
    default:
      return l.type
  }
}

export function parseLeaf(raw: string | null | undefined): Leaf | null {
  if (!raw) return null
  if (raw === 'request' || raw === 'caller' || raw === 'error') return { type: raw }
  const cut = raw.indexOf(':')
  if (cut < 0) return null
  const head = raw.slice(0, cut)
  const rest = raw.slice(cut + 1)
  if (!rest) return null
  if (head === 'phase' && /^\d+$/.test(rest)) return { type: 'phase', seq: Number(rest) }
  if (head === 'sql' && /^\d+$/.test(rest)) return { type: 'sql', index: Number(rest) }
  if (head === 'effect' && /^[a-z_]+:[\w.-]+$/i.test(rest)) return { type: 'effect', key: rest }
  if (head === 'emit') return { type: 'emit', event: rest }
  return null
}

/** Is the leaf still part of this story (a link from an older id may name one that is not)? */
export function leafExists(story: Story, l: Leaf): boolean {
  switch (l.type) {
    case 'request':
      return true
    case 'caller':
      return !!story.caller
    case 'error':
      return (story.status ?? 0) >= 400
    case 'phase':
      return !!story.trace?.phases.some((p) => p.seq === l.seq)
    case 'sql':
      return !!story.trace?.statements.some((s) => s.index === l.index)
    case 'effect':
      return !!story.effects?.some((e) => e.key === l.key)
    case 'emit':
      return story.emits.some((e) => e.event === l.event)
  }
}

// ─── Effects ─────────────────────────────────────────────────────────────────

export interface EffectNode {
  effect: StoryEffect
  depth: number
}

/**
 * Effects in time order, each followed by the ones that sit under it (attempts under their push,
 * a notification's email under the notification). A parent that is not part of the story
 * (`request:…`, another chain's step) leaves the effect at the top.
 */
export function nestEffects(effects: StoryEffect[]): EffectNode[] {
  const keys = new Set(effects.map((e) => e.key))
  const children = new Map<string, StoryEffect[]>()
  const roots: StoryEffect[] = []
  for (const e of effects) {
    if (e.parent && e.parent !== e.key && keys.has(e.parent)) {
      const list = children.get(e.parent) ?? []
      list.push(e)
      children.set(e.parent, list)
    } else roots.push(e)
  }
  const out: EffectNode[] = []
  const seen = new Set<string>()
  const walk = (e: StoryEffect, depth: number) => {
    if (seen.has(e.key)) return
    seen.add(e.key)
    out.push({ effect: e, depth })
    for (const c of children.get(e.key) ?? []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  // A cycle leaves nodes unvisited — show them flat rather than lose them.
  for (const e of effects) if (!seen.has(e.key)) walk(e, 0)
  return out
}

export const EFFECT_LABEL: Record<EffectKind, string> = {
  write: 'Write',
  transition: 'Pipeline',
  flow: 'Flow',
  push: 'Push',
  attempt: 'Attempt',
  call: 'Partner call',
  notify: 'Notified',
  mail: 'Email',
  other: 'Step'
}

export const EFFECT_GROUP_LABEL: Record<EffectKind, string> = {
  write: 'Records written',
  transition: 'Pipeline moves',
  flow: 'Flows',
  push: 'Partner pushes',
  attempt: 'Push attempts',
  call: 'Partner calls',
  notify: 'People notified',
  mail: 'Emails',
  other: 'Other steps'
}

/** Kind → count, in a fixed reading order, zero kinds left out. */
export function effectCounts(effects: StoryEffect[]): Array<{ kind: EffectKind; n: number }> {
  const order: EffectKind[] = [
    'write',
    'transition',
    'flow',
    'push',
    'attempt',
    'call',
    'notify',
    'mail',
    'other'
  ]
  const n = new Map<EffectKind, number>()
  for (const e of effects) n.set(e.kind, (n.get(e.kind) ?? 0) + 1)
  return order.filter((k) => n.get(k)).map((k) => ({ kind: k, n: n.get(k) ?? 0 }))
}

/** "purchase_orders" → "Purchase order" (when the labels call has no name for it). */
export function collectionNoun(collection: string, labels?: Labels | null): string {
  const named = labels?.collections?.[collection]
  if (typeof named === 'string' && named.trim()) return named
  if (named && typeof named === 'object' && named.singular) return named.singular
  const w = collection.replace(/[_-]+/g, ' ').trim()
  const one = w.endsWith('ies')
    ? `${w.slice(0, -3)}y`
    : w.endsWith('s') && !w.endsWith('ss')
      ? w.slice(0, -1)
      : w
  return one.charAt(0).toUpperCase() + one.slice(1)
}

/** "Workflow CR26-80329", or "Workflow 85607" before (or without) a label. */
export function recordName(
  record: { collection: string; item: string; label?: string | null },
  labels?: Labels | null
): string {
  const key = `${record.collection}:${record.item}`
  const label = record.label ?? labels?.records?.[key]
  return `${collectionNoun(record.collection, labels)} ${label?.trim() ? label : record.item}`
}

/** The effect in words, labels applied. Field NAMES only. */
export function effectSentence(e: StoryEffect, labels?: Labels | null): string {
  const rec = e.record ? recordName(e.record, labels) : null
  switch (e.kind) {
    case 'write': {
      const verb =
        e.facts.action === 'create'
          ? 'Created'
          : e.facts.action === 'delete'
            ? 'Deleted'
            : 'Updated'
      return rec ? `${verb} ${rec}` : `${verb} a record`
    }
    case 'transition': {
      const to = e.facts.to ? ` → ${e.facts.to}` : ''
      const from = e.facts.from ? `${e.facts.from}` : 'Started'
      return rec ? `${rec}: ${from}${to}` : e.summary
    }
    case 'notify':
      return e.facts.recipient ? `Told ${e.facts.recipient}` : e.summary
    case 'flow':
    case 'push':
    case 'mail': {
      // The status rides its own pill beside the sentence.
      const st = e.facts.status
      return st && e.summary.endsWith(` · ${st}`) ? e.summary.slice(0, -(st.length + 3)) : e.summary
    }
    default:
      return e.summary
  }
}

/** Where an effect opens: the page that owns its row, and the record it touched. */
export function effectLinks(e: StoryEffect): Array<{ label: string; to: string }> {
  const out: Array<{ label: string; to: string }> = []
  const f = e.facts
  const rec = e.record
  const recPath = rec
    ? `/collections/${encodeURIComponent(rec.collection)}/${encodeURIComponent(rec.item)}`
    : null
  switch (e.kind) {
    case 'write':
      if (f.id != null) out.push({ label: 'Open the activity entry', to: `/activity/${f.id}` })
      break
    case 'flow':
      if (f.flow_id)
        out.push({ label: 'Open the flow', to: `/flows/${encodeURIComponent(f.flow_id)}` })
      break
    case 'push':
    case 'attempt': {
      const q = new URLSearchParams({ tab: 'erp' })
      if (rec) {
        q.set('collection', rec.collection)
        q.set('item', rec.item)
      }
      if (f.submission_id != null) q.set('submission', String(f.submission_id))
      out.push({ label: 'Open the ERP submission', to: `/integration-health?${q}` })
      if (f.api_id != null)
        out.push({ label: 'Open the partner API', to: `/external-apis/${f.api_id}` })
      break
    }
    case 'call':
      if (f.api_id != null)
        out.push({ label: 'Open the partner API', to: `/external-apis/${f.api_id}` })
      break
    case 'notify':
      if (f.id != null)
        out.push({
          label: 'Open the notification',
          to: `/delivery/analytics?window=30d&leaf=n:${f.id}`
        })
      if (f.recipient_id)
        out.push({ label: `Open ${f.recipient ?? 'the person'}`, to: `/users/${f.recipient_id}` })
      break
    case 'mail':
      if (f.id != null) out.push({ label: 'Open in the mail log', to: `/delivery?id=${f.id}` })
      break
  }
  if (recPath) out.unshift({ label: 'Open the record', to: recPath })
  return out
}

/** Where a related-rail ref opens inside the admin (null = handled by the page, or nowhere). */
export function relatedRefPath(ref: { kind: string; id: string }): string | null {
  switch (ref.kind) {
    case 'issue':
      return /^\d+$/.test(ref.id) ? `/issues/${ref.id}` : null
    case 'record': {
      const cut = ref.id.indexOf(':')
      if (cut <= 0) return null
      return `/collections/${encodeURIComponent(ref.id.slice(0, cut))}/${encodeURIComponent(ref.id.slice(cut + 1))}`
    }
    case 'caller':
      if (/^u./i.test(ref.id)) return `/users/${ref.id.slice(1).toLowerCase()}`
      if (/^k\d+$/.test(ref.id)) return `/api-keys?key=${ref.id.slice(1)}`
      return null
    case 'write':
      return /^\d+$/.test(ref.id) ? `/activity/${ref.id}` : null
    case 'load':
    case 'statement':
    case 'flow':
    case 'job':
    case 'submission':
      return `/traffic-map?inspect=${encodeURIComponent(`${ref.kind}:${ref.id}`)}`
    default:
      return null
  }
}

/** The Traffic Map inspector opened on this request (and, optionally, one level under it). */
export function trafficMapPath(rid: string, under?: { kind: string; id: string }): string {
  const stack = [`request:${rid}`]
  if (under) stack.push(`${under.kind}:${under.id}`)
  return `/traffic-map?inspect=${encodeURIComponent(stack.join('/'))}`
}

/** "+4 s" / "−12 s" / "+300 ms" from `base` (epoch ms) to `at`. */
export function signedOffset(at: number, base: number): string {
  const d = at - base
  const abs = Math.abs(d)
  const txt =
    abs < 1000
      ? `${Math.round(abs)} ms`
      : abs < 60_000
        ? `${Math.round(abs / 1000)} s`
        : abs < 3_600_000
          ? `${Math.round(abs / 60_000)} min`
          : `${Math.round(abs / 3_600_000)} h`
  return `${d < 0 ? '−' : '+'}${txt}`
}

/** Percent position of `ms` on a 0..total axis, clamped. */
export function pct(ms: number, total: number): number {
  if (!(total > 0)) return 0
  return Math.max(0, Math.min(100, (ms / total) * 100))
}

/** Round axis ticks for a waterfall of `total` ms (4–6 ticks, never 0 apart). */
export function axisTicks(total: number): number[] {
  if (!(total > 0)) return [0]
  const raw = total / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => total / s <= 5) ?? raw
  const out: number[] = []
  for (let t = 0; t <= total + 1e-9; t += step) out.push(Math.round(t * 1000) / 1000)
  return out
}

/** Record refs and collections the labels call should name (deduped, capped). */
export function labelRequestOf(story: Story): {
  refs: Array<{ collection: string; id: string }>
  collections: string[]
} {
  const refs = new Map<string, { collection: string; id: string }>()
  const cols = new Set<string>()
  const add = (r: { collection: string; item: string } | null | undefined) => {
    if (!r?.collection || r.item == null || r.item === '') return
    cols.add(r.collection)
    refs.set(`${r.collection}:${r.item}`, { collection: r.collection, id: String(r.item) })
  }
  for (const e of story.effects ?? []) add(e.record)
  for (const t of story.timeline) add(t.record)
  return { refs: [...refs.values()].slice(0, 200), collections: [...cols].slice(0, 100) }
}
