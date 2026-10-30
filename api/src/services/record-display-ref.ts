import { db } from '../db/index.js'
import type { User } from '../types.js'
import { selectInChunks } from './db-batch.js'

/**
 * How a record is NAMED to a person in text — notification subjects and
 * messages, email subjects and bodies, activity sentences: the collection's
 * friendly id ("CM26-79811", `nivaro_collections.friendly_id_field`, #776),
 * else `#371367`. Display only — payloads keep the numeric id.
 *
 * Where permissions matter pass the RECIPIENT: the value is then read through
 * the items service as that person (row filter, User Scopes, field list), so
 * a reader who may not see the record or its id column gets `#id`, never a
 * value they could not read. Without a recipient the value is read as the
 * system (use only where the text goes to someone already judged).
 *
 * Unlike resolveFriendlyId (workflow-transitions.ts) this never falls back to
 * the display label — a label can say more than the id does. Never throws.
 * The client twin is packages/shared/src/lib/record-ref.ts (recordRefLabel).
 */

export type DisplayRefRecipient = User | string | null | undefined

export interface DisplayRefOptions {
  /** The person who will read the text. A user id or a loaded user row. */
  recipient?: DisplayRefRecipient
}

/** The text used when nothing better can be shown. */
export function fallbackDisplayRef(id: string | number): string {
  return `#${id}`
}

async function recipientUser(r: DisplayRefRecipient): Promise<User | null> {
  if (!r) return null
  if (typeof r !== 'string') return r
  try {
    const { getUser } = await import('./users.js')
    return (await getUser(r)) ?? null
  } catch {
    return null
  }
}

async function fieldFor(collection: string): Promise<string | null> {
  try {
    const { friendlyIdField } = await import('./workflow-transitions.js')
    return await friendlyIdField(collection)
  } catch {
    return null
  }
}

function textOf(v: unknown): string | null {
  if (v == null || typeof v === 'object') return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * Batched: every requested id is in the answer (`#id` when unresolved). One
 * read per call, chunked under the bound-parameter cap.
 */
export async function recordDisplayRefs(
  collection: string,
  ids: Array<string | number>,
  opts: DisplayRefOptions = {}
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.map(String).filter((s) => s !== ''))]
  const out = new Map<string, string>()
  for (const id of unique) out.set(id, fallbackDisplayRef(id))
  if (unique.length === 0) return out
  const field = await fieldFor(collection)
  if (!field) return out
  // Ids compare case-insensitively (MSSQL hands uuids back upper-cased).
  const byKey = new Map(unique.map((id) => [id.toUpperCase(), id]))
  const take = (rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      const key = byKey.get(String(row.id).toUpperCase())
      const v = textOf(row[field])
      if (key && v) out.set(key, v)
    }
  }
  try {
    if (opts.recipient === undefined || opts.recipient === null) {
      take(
        (await selectInChunks(unique, 1000, (chunk) =>
          db(collection).whereIn('id', chunk).select('id', field)
        )) as Array<Record<string, unknown>>
      )
      return out
    }
    const user = await recipientUser(opts.recipient)
    // A recipient we cannot load is nobody: they read the bare id.
    if (!user) return out
    const { readItems } = await import('./items.js')
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500)
      const res = await readItems(user, collection, {
        fields: ['id', field],
        filter: { id: { _in: chunk } },
        limit: chunk.length
      })
      take((res.data ?? []) as Array<Record<string, unknown>>)
    }
  } catch {
    /* unresolved ids keep #id */
  }
  return out
}

/** One record's display ref ("CM26-79811" or "#371367"). */
export async function recordDisplayRef(
  collection: string,
  id: string | number,
  opts: DisplayRefOptions = {}
): Promise<string> {
  const key = String(id)
  return (await recordDisplayRefs(collection, [key], opts)).get(key) ?? fallbackDisplayRef(key)
}
