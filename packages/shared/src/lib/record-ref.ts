// A record's readable id (#776 friendly id) for DISPLAY: "CM26-79811", never
// 371367. The collection names its human id column in
// `nivaro_collections.friendly_id_field` (on every GET /collections/:c
// payload); URL aliases (`url_alias_fields`) address records by the same kind
// of value. API payloads keep numeric ids — this is what people read.
//
// The server twin is api/src/services/record-display-ref.ts
// (`recordDisplayRef`, which also judges the RECIPIENT's read access).

import type { Command } from '@nivaro/sdk'
import { get } from './commands'

export interface RecordRefMeta {
  friendly_id_field?: string | null
  /** Parsed list on GET /collections/:c; JSON text on raw rows. */
  url_alias_fields?: string[] | string | null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The column that names a record to people, or null (none / not a plain column / `id`). */
export function friendlyIdFieldOf(meta: RecordRefMeta | null | undefined): string | null {
  const f = meta?.friendly_id_field
  return typeof f === 'string' && f !== 'id' && IDENT.test(f) ? f : null
}

function textOf(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'object') return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** The record's friendly id from a row that carries the column, else null. */
export function friendlyIdOf(
  meta: RecordRefMeta | null | undefined,
  row: Record<string, unknown> | null | undefined
): string | null {
  const f = friendlyIdFieldOf(meta)
  return f && row ? textOf(row[f]) : null
}

/** "CM26-79811" when the row names one, else "#371367". */
export function recordRefLabel(
  meta: RecordRefMeta | null | undefined,
  row: Record<string, unknown> | null | undefined,
  id: string | number | null | undefined
): string {
  return friendlyIdOf(meta, row) ?? (id == null || id === '' ? '' : `#${id}`)
}

function aliasFields(meta: RecordRefMeta | null | undefined): string[] {
  const raw = meta?.url_alias_fields
  let list: unknown = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch {
      list = []
    }
  }
  return Array.isArray(list)
    ? list.filter((f): f is string => typeof f === 'string' && IDENT.test(f))
    : []
}

/**
 * The URL segment the server's alias resolver (resolveAliasId) reads for this
 * row: the url_alias_fields values joined by '-', else the friendly id when the
 * collection lists no alias. Null when the row lacks any part, or the value
 * looks like a key (all digits / a uuid) — that would be read as an id.
 */
export function aliasSegmentOf(
  meta: RecordRefMeta | null | undefined,
  row: Record<string, unknown> | null | undefined
): string | null {
  if (!row) return null
  const fields = aliasFields(meta)
  let seg: string | null
  if (fields.length > 0) {
    const parts = fields.map((f) => textOf(row[f]))
    if (parts.some((p) => p == null)) return null
    seg = parts.join('-')
  } else {
    seg = friendlyIdOf(meta, row)
  }
  if (!seg) return null
  if (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || seg === 'new') return null
  if (seg.includes('/')) return null
  return seg
}

type RequestClient = {
  request<T>(cmd: Command<T>): Promise<T>
}

/**
 * The id a share / copy link should carry: the alias segment when it resolves
 * back to THIS record (aliases carry no uniqueness guarantee — legacy business
 * ids have duplicates, and the lowest id wins), else the numeric id. One read,
 * only when someone copies a link.
 */
export async function shareableRecordId(
  client: RequestClient,
  collection: string,
  meta: RecordRefMeta | null | undefined,
  row: Record<string, unknown> | null | undefined,
  id: string | number
): Promise<string> {
  const seg = aliasSegmentOf(meta, row)
  if (!seg) return String(id)
  try {
    const res = await client.request<{ data?: { id?: unknown } }>(
      get(`/items/${collection}/by-slug/${encodeURIComponent(seg)}`, { fields: 'id' })
    )
    return String(res?.data?.id ?? '') === String(id) ? seg : String(id)
  } catch {
    return String(id)
  }
}

/**
 * Copy text that is still being worked out (a share link waiting on
 * shareableRecordId) without losing the click's permission to write the
 * clipboard: a promised ClipboardItem where the browser has one, else the
 * plain write once the text is known.
 */
export async function copyWhenReady(text: Promise<string>): Promise<void> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (!clip) return
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
  if (Item && typeof clip.write === 'function') {
    try {
      await clip.write([
        new Item({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })
      ])
      return
    } catch {
      /* fall through to the plain write */
    }
  }
  await clip.writeText(await text)
}
