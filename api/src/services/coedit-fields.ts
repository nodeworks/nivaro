import type { CMSField } from '../types.js'

/**
 * Shared text (realtime round 3, item 8): the rich-text fields people write together. Rob,
 * 2026-11-14: they stay shared even on a record someone holds the edit lock on — everyone who
 * may write such a field co-types it live, and a save that changes ONLY shared text fields is
 * not refused by the held lock (every other field still is). The step's own edit locks
 * (post-approval, admin-only) still win: they are judged by the write itself (updateOne).
 *
 * A shared text field is a plain rich-text field of the collection: never encrypted, a
 * credential, computed, or one whose interface/special says password/hash/secret/conceal.
 */

const SHARED_IFACES = new Set(['input-rich-text-html', 'rich_text', 'extension-editorjs'])
const CONCEALED = /password|hash|secret|conceal/i

/** Pure: is this field row a shared text field? (`secret` = the column name reads as one). */
export function sharedTextFieldRow(f: CMSField | null | undefined, secret = false): boolean {
  if (!f || secret) return false
  const any = f as unknown as Record<string, unknown>
  if (any.is_encrypted || any.computed_type || any.computed_formula) return false
  if (!SHARED_IFACES.has(String(f.interface ?? '')) && f.type !== 'rich_text') return false
  const special = Array.isArray(f.special) ? f.special.join(' ') : ''
  return !CONCEALED.test(`${f.interface ?? ''} ${special}`)
}

export async function isSharedTextField(collection: string, field: string): Promise<boolean> {
  if (/^(nivaro_|directus_|chat_)/i.test(collection)) return false
  const { getFields } = await import('./collections.js')
  const { isSecretColumn } = await import('./system-collections.js')
  const f = (await getFields(collection)).find((x) => x.field === field)
  return sharedTextFieldRow(f, isSecretColumn(field))
}

/**
 * Does this update body change shared text fields and nothing else? Then the record's held
 * edit lock does not refuse it (the PATCH route). Any other key — a plain field, a relation,
 * anything unknown — and the lock applies as always.
 */
export async function onlySharedText(
  collection: string,
  body: unknown,
  isShared: (collection: string, field: string) => Promise<boolean> = isSharedTextField
): Promise<boolean> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const keys = Object.keys(body)
  if (keys.length === 0 || keys.length > 20) return false
  for (const k of keys) if (!(await isShared(collection, k).catch(() => false))) return false
  return true
}
