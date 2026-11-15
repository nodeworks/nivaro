import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * Public submission status pages (realtime round 9, item 22).
 *
 * A form whose owner switched the status page on hands each submitter a link to a page that
 * says where their request stands — Received → In review → Decided — and updates while open.
 * Only what the owner mapped as public ever shows: the record's pipeline state (or one field's
 * value) is matched against the owner's list; an unmapped value reads as a plain "In review",
 * never as the internal name. No record values, no names, no ids.
 *
 * The link: `<PUBLIC_URL>/form-status/<token>`. The token is signed (HMAC, this feature's own
 * key derived from SESSION_SECRET), expires (`ttl_days`, default 90) and is bound to ONE
 * submission: its body names the submission id and its SHA-256 is stored on that submission, so
 * a token is only good for the submission that minted it (a forged or swapped body fails the
 * signature; a valid token of another submission fails the stored hash). The token is never
 * stored or logged whole — the request logger masks the path segment (services/secret-mask.ts).
 *
 * Storage without a migration: the form's settings ride `nivaro_submission_forms.form_config`
 * (`status_page`), the per-submission binding rides `nivaro_submissions.data` under the
 * reserved key `__nvr_status` ({ item, hash, exp }), stripped from every admin read.
 */

export type PublicStage = 'received' | 'in_review' | 'decided'

export interface StatusMapEntry {
  /** A pipeline state key, or the field's value. */
  value: string
  stage: PublicStage
  /** What the submitter reads; empty = the state's external label, else the stage name. */
  label?: string | null
}

export interface StatusPageConfig {
  enabled: boolean
  source: 'pipeline' | 'field'
  field: string | null
  map: StatusMapEntry[]
  /** A field of the form holding the submitter's email address: the link is emailed too. */
  email_field: string | null
  ttl_days: number
}

export const STATUS_META_KEY = '__nvr_status'

export interface StatusMeta {
  item: string
  hash: string
  exp: number
}

const STAGES: PublicStage[] = ['received', 'in_review', 'decided']
export const STAGE_LABELS: Record<PublicStage, string> = {
  received: 'Received',
  in_review: 'In review',
  decided: 'Decided'
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** `form_config.status_page` → a clean config; junk reads as off. Pure. */
export function parseStatusPageConfig(formConfig: unknown): StatusPageConfig {
  const off: StatusPageConfig = {
    enabled: false,
    source: 'pipeline',
    field: null,
    map: [],
    email_field: null,
    ttl_days: 90
  }
  let cfg: unknown = formConfig
  if (typeof cfg === 'string') {
    try {
      cfg = JSON.parse(cfg)
    } catch {
      return off
    }
  }
  const raw = (cfg as { status_page?: unknown } | null)?.status_page
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return off
  const r = raw as Record<string, unknown>
  const source = r.source === 'field' ? 'field' : 'pipeline'
  const field = typeof r.field === 'string' && FIELD_RE.test(r.field) ? r.field : null
  const map: StatusMapEntry[] = []
  for (const e of Array.isArray(r.map) ? r.map.slice(0, 50) : []) {
    if (!e || typeof e !== 'object') continue
    const m = e as Record<string, unknown>
    const value = typeof m.value === 'string' || typeof m.value === 'number' ? String(m.value) : ''
    const stage = STAGES.includes(m.stage as PublicStage) ? (m.stage as PublicStage) : null
    if (!value || !stage) continue
    const label = typeof m.label === 'string' ? m.label.trim().slice(0, 80) : ''
    map.push({ value: value.slice(0, 120), stage, label: label || null })
  }
  const email =
    typeof r.email_field === 'string' && FIELD_RE.test(r.email_field) ? r.email_field : null
  const ttl = Math.round(Number(r.ttl_days))
  return {
    enabled: r.enabled === true && (source === 'pipeline' || !!field),
    source,
    field,
    map,
    email_field: email,
    ttl_days: Number.isFinite(ttl) && ttl >= 1 && ttl <= 365 ? ttl : 90
  }
}

// ── Tokens ─────────────────────────────────────────────────────────────────

function statusKey(): Buffer {
  return createHmac('sha256', config.SESSION_SECRET).update('nivaro:submission-status:v1').digest()
}

const sig = (body: string) => createHmac('sha256', statusKey()).update(body).digest()

export const hashStatusToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex')

/** A fresh token for one submission + what to store on it. */
export function mintStatusToken(
  submissionId: string,
  item: string,
  ttlDays: number,
  now = Date.now()
): { token: string; meta: StatusMeta } {
  const exp = Math.floor(now / 1000) + ttlDays * 86_400
  const body = Buffer.from(
    JSON.stringify({ s: submissionId, e: exp, n: randomBytes(12).toString('base64url') }),
    'utf8'
  ).toString('base64url')
  const token = `${body}.${sig(body).toString('base64url')}`
  return { token, meta: { item: String(item), hash: hashStatusToken(token), exp } }
}

/** Signature + expiry only (no database): the submission id the token names, or null. */
export function readStatusToken(token: string, now = Date.now()): { s: string; e: number } | null {
  if (typeof token !== 'string' || token.length > 400) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  let given: Buffer
  try {
    given = Buffer.from(token.slice(dot + 1), 'base64url')
  } catch {
    return null
  }
  const expected = sig(body)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      s?: unknown
      e?: unknown
    }
    if (typeof p.s !== 'string' || typeof p.e !== 'number') return null
    if (p.e < Math.floor(now / 1000)) return null
    return { s: p.s, e: p.e }
  } catch {
    return null
  }
}

/** The stored binding on a submission's data, or null. Pure. */
export function statusMetaOf(data: unknown): StatusMeta | null {
  let d: unknown = data
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d)
    } catch {
      return null
    }
  }
  const m = (d as Record<string, unknown> | null)?.[STATUS_META_KEY] as
    | Record<string, unknown>
    | undefined
  if (!m || typeof m.hash !== 'string' || typeof m.item !== 'string' || typeof m.exp !== 'number')
    return null
  return { item: m.item, hash: m.hash, exp: m.exp }
}

/** A submission's data for an admin read: the status binding is never shown. Pure. */
export function withoutStatusMeta(data: Record<string, unknown>): Record<string, unknown> {
  if (!data || !(STATUS_META_KEY in data)) return data
  const { [STATUS_META_KEY]: _m, ...rest } = data
  return rest
}

/** Does this token's hash equal the stored one (constant time)? Pure. */
export function tokenMatches(token: string, meta: StatusMeta | null): boolean {
  if (!meta) return false
  const a = Buffer.from(hashStatusToken(token), 'hex')
  const b = Buffer.from(meta.hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface ResolvedStatusLink {
  submissionId: string
  createdAt: string
  formName: string
  collection: string
  item: string
  formId: string
  createdBy: string | null
  cfg: StatusPageConfig
}

/**
 * Token → the submission it is bound to, or null for anything wrong: tampered, expired, another
 * submission's token, a form switched off / removed / expired, a status page turned off.
 */
export async function resolveStatusLink(token: string): Promise<ResolvedStatusLink | null> {
  const t = readStatusToken(token)
  if (!t) return null
  const sub = (await db('nivaro_submissions')
    .where({ id: t.s })
    .first('id', 'form', 'data', 'created_at')) as
    | { id: string; form: string; data: string | null; created_at: Date | string }
    | undefined
  if (!sub) return null
  const meta = statusMetaOf(sub.data)
  if (!tokenMatches(token, meta) || !meta || meta.exp < Math.floor(Date.now() / 1000)) return null
  const form = (await db('nivaro_submission_forms')
    .where({ id: sub.form })
    .first('id', 'name', 'collection', 'form_config', 'is_active', 'created_by')) as
    | {
        id: string
        name: string
        collection: string
        form_config: string | null
        is_active: boolean | number
        created_by: string | null
      }
    | undefined
  if (!form) return null
  const cfg = parseStatusPageConfig(form.form_config)
  if (!cfg.enabled) return null
  return {
    submissionId: String(sub.id),
    createdAt: new Date(sub.created_at).toISOString(),
    formName: String(form.name ?? ''),
    collection: String(form.collection),
    item: meta.item,
    formId: String(form.id),
    createdBy: form.created_by ?? null,
    cfg
  }
}

export interface PublicStatus {
  stage: PublicStage
  label: string
  /** The request is no longer there (deleted, or out of the form owner's reach). */
  gone: boolean
}

/** A record's raw status value → what the submitter may read. Pure. */
export function publicStatusOf(
  cfg: StatusPageConfig,
  value: string | null,
  externalLabel?: string | null
): PublicStatus {
  if (value == null || value === '') return { stage: 'received', label: 'Received', gone: false }
  const hit = cfg.map.find((m) => m.value.toLowerCase() === value.toLowerCase())
  if (!hit) return { stage: 'in_review', label: 'In review', gone: false }
  const label = hit.label || externalLabel?.trim() || STAGE_LABELS[hit.stage]
  return { stage: hit.stage, label, gone: false }
}

/**
 * Where the request stands now, read as the FORM'S CREATOR (the same rule as the submission
 * itself and share links): the page never shows more than they could see, and only the mapped
 * stage + label leave this function.
 */
export async function loadPublicStatus(link: ResolvedStatusLink): Promise<PublicStatus> {
  const gone: PublicStatus = { stage: 'received', label: '', gone: true }
  if (!link.createdBy) return gone
  const creator = (await db('nivaro_users')
    .where({ id: link.createdBy, status: 'active' })
    .first()) as User | undefined
  if (!creator) return gone
  const { readOne } = await import('./items.js')
  const fields = ['id', ...(link.cfg.source === 'field' && link.cfg.field ? [link.cfg.field] : [])]
  let rec: Record<string, unknown> | null = null
  try {
    rec = (await readOne(creator, link.collection, link.item, undefined, fields)) as Record<
      string,
      unknown
    > | null
  } catch {
    rec = null
  }
  if (!rec) return gone
  if (link.cfg.source === 'field') {
    const v = link.cfg.field ? rec[link.cfg.field] : null
    return publicStatusOf(link.cfg, v == null ? null : String(v))
  }
  const { attachRecordState } = await import('./record-state.js')
  const row: Record<string, unknown> = { id: rec.id ?? link.item }
  await attachRecordState(link.collection, [row])
  const st = row.$state as { key?: string; external_label?: string | null } | null
  return publicStatusOf(link.cfg, st?.key ?? null, st?.external_label ?? null)
}

/** The submitter's email from the submitted values, when the form collects one. Pure. */
export function submitterEmail(
  cfg: StatusPageConfig,
  data: Record<string, unknown>
): string | null {
  if (!cfg.email_field) return null
  const v = data[cfg.email_field]
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(s)
    ? s
    : null
}

export function statusPageUrl(token: string): string {
  return `${config.PUBLIC_URL.replace(/\/$/, '')}/form-status/${token}`
}
