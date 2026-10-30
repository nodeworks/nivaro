import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import type { User } from '../types.js'

/**
 * Field comments (#3232, migration 521): a normal record comment tagged with the
 * field it was left on (`nivaro_comments.field`), plus `resolved_at` so a field's
 * badge counts only open ones. One comment system — the comments routes read and
 * write these; nothing here forks a second thread.
 */

const MISS_TTL_MS = 60_000
const probes = new Map<string, { hit: boolean; at: number; inflight: Promise<boolean> | null }>()

/** Does this database have the field-comment columns yet? Cached per tenant (a miss for a minute). */
export async function hasFieldCommentColumns(): Promise<boolean> {
  const key = getTenantId() ?? ''
  const state = probes.get(key)
  if (state?.hit) return true
  if (state?.inflight) return state.inflight
  if (state && Date.now() - state.at < MISS_TTL_MS) return false
  const inflight = (async () => {
    try {
      return (
        (await db.schema.hasColumn('nivaro_comments', 'field')) &&
        (await db.schema.hasColumn('nivaro_comments', 'resolved_at'))
      )
    } catch {
      return false
    }
  })()
  probes.set(key, { hit: false, at: state?.at ?? 0, inflight })
  const hit = await inflight
  probes.set(key, { hit, at: Date.now(), inflight: null })
  return hit
}

export function resetFieldCommentProbe(): void {
  probes.clear()
}

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/

/**
 * The `field` a comment body names: null = a whole-record comment, 'invalid' =
 * refuse (not a plain column name — never a path, sentinel or system key).
 */
export function cleanCommentField(raw: unknown): string | null | 'invalid' {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string') return 'invalid'
  const f = raw.trim()
  if (!FIELD_NAME_RE.test(f) || f.startsWith('__')) return 'invalid'
  return f
}

/** The deep link a field-comment notification opens: the record, scrolled to the field. */
export function fieldCommentQuery(field: string): string {
  return `field=${encodeURIComponent(field)}`
}

/** "Amount" for amount_total-ish keys when the client sent no label. */
export function plainFieldLabel(field: string, sent?: unknown): string {
  if (typeof sent === 'string') {
    const s = sent.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (s) return s
  }
  return field
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * May `user` leave a comment on `field` of `collection`? The field must exist
 * (field metadata or a real column) and be one the caller may read — a comment
 * thread must never confirm a field the caller cannot see.
 */
export async function fieldMayBeCommented(
  user: User,
  isAdmin: boolean,
  collection: string,
  field: string
): Promise<boolean> {
  if (collection.startsWith('nivaro_') || collection.startsWith('directus_')) return false
  const known =
    !!(await db('nivaro_fields')
      .where({ collection, field })
      .first('id')
      .catch(() => undefined)) || (await db.schema.hasColumn(collection, field).catch(() => false))
  if (!known) return false
  if (isAdmin) return true
  const { getAllowedFields } = await import('./permissions.js')
  const allowed = await getAllowedFields(user, 'read', collection)
  return allowed === null || allowed.includes('*') || allowed.includes(field)
}
