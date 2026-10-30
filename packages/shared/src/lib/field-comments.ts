/**
 * #3232 — comments left on one field of a record. They are normal record
 * comments (GET/POST /comments) tagged with `field`; these helpers are the
 * pure parts the record form and its tests share.
 */

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/

/**
 * The field a record link asks to open on (`?field=<name>`, a field-comment
 * notification). Null when absent or not a plain field name.
 */
export function parseFieldDeepLink(search: string | null | undefined): string | null {
  if (!search) return null
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('field')
  const f = raw?.trim() ?? ''
  return FIELD_RE.test(f) && !f.startsWith('__') ? f : null
}

/** The query a link to one field carries (the API builds the same: services/field-comments.ts). */
export function fieldDeepLinkQuery(field: string): string {
  return `field=${encodeURIComponent(field)}`
}

export interface FieldCommentLike {
  field?: string | null
  resolved_at?: string | null
  deleted?: boolean
}

/** Open field comments (not resolved, not deleted) per field — the badge on each label. */
export function openFieldCommentCounts(comments: FieldCommentLike[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of comments) {
    if (!c.field || c.resolved_at || c.deleted) continue
    out[c.field] = (out[c.field] ?? 0) + 1
  }
  return out
}

/** One field's thread: open comments first (oldest first), then resolved ones. */
export function fieldThread<T extends FieldCommentLike & { created_at?: string }>(
  comments: T[],
  field: string
): { open: T[]; resolved: T[] } {
  const mine = comments.filter((c) => c.field === field && !c.deleted)
  const at = (c: T) => (c.created_at ? new Date(c.created_at).getTime() : 0)
  mine.sort((a, b) => at(a) - at(b))
  return { open: mine.filter((c) => !c.resolved_at), resolved: mine.filter((c) => !!c.resolved_at) }
}
