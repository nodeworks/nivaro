/**
 * How a record is NAMED to a person when a notification, bundle or digest
 * line points at it — the friendly id ("CM26-80332"), else the display label
 * ("PRB1"), else the trash snapshot's label when the record has since been
 * deleted, else "<Singular> #<id>". A bare internal id never reaches a bell
 * row: it tells nobody anything, and a vanished record would otherwise read
 * exactly like a live one.
 */
import { db } from '../db/index.js'
import { getCollection } from './collections.js'
import { selectInChunks } from './db-batch.js'
import { collectionWord } from './event-path/record-labels.js'
import { resolveFriendlyIds } from './workflow-transitions.js'

export { collectionWord }

export interface RecordHeadline {
  label: string
  /** The record no longer exists — the label came from its trash snapshot
   *  (or is the "<Singular> #<id>" fallback). */
  deleted: boolean
  /** "Region" — the collection's singular name, for a chip beside the label. */
  collection_label: string
}

const NAME_COLUMNS = ['name', 'title', 'label', 'subject', 'display_name', 'short_name', 'code', 'email']

/**
 * Render a display template over a plain row (a trash snapshot, a hook's
 * previousData). Plain `{{col}}` tokens only — a dotted token's parent is a
 * bare FK on a snapshot and would render as a number, so it renders empty.
 * No template, or a template that renders to nothing → the first non-empty
 * name-ish column. Pure.
 */
export function headlineFromSnapshot(
  template: string | null | undefined,
  row: Record<string, unknown> | null | undefined
): string | null {
  if (!row) return null
  if (template) {
    const rendered = template
      .replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, token: string) => {
        if (token.includes('.')) return ''
        const v = row[token]
        return v === null || v === undefined ? '' : String(v)
      })
      .replace(/\s+/g, ' ')
      .replace(/^[\s·,\-–—:|/]+|[\s·,\-–—:|/]+$/g, '')
      .trim()
    if (rendered) return rendered
  }
  for (const col of NAME_COLUMNS) {
    const v = row[col]
    if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim()
  }
  return null
}

/** The label a snapshot of this collection's record would carry. */
export async function labelFromSnapshot(
  collection: string,
  row: Record<string, unknown> | null | undefined
): Promise<string | null> {
  let template: string | null = null
  try {
    template = (await getCollection(collection))?.display_template ?? null
  } catch {
    /* unregistered — name columns still apply */
  }
  return headlineFromSnapshot(template, row)
}

/**
 * Headlines for a set of records of one collection. Ids the friendly-id /
 * display-label resolvers leave bare are checked for existence; a missing
 * record is named from its newest trash snapshot and flagged deleted.
 * Never throws — every requested id comes back.
 */
export async function recordHeadlines(
  collection: string,
  ids: string[]
): Promise<Map<string, RecordHeadline>> {
  const wanted = [...new Set(ids.map(String))]
  const word = await collectionWord(collection).catch(() => collection)
  const out = new Map<string, RecordHeadline>()
  for (const id of wanted)
    out.set(id, { label: `${word} #${id}`, deleted: false, collection_label: word })
  if (wanted.length === 0) return out

  let bare = wanted
  try {
    const resolved = await resolveFriendlyIds(collection, wanted)
    bare = []
    for (const id of wanted) {
      const label = resolved.get(id)
      if (label && label !== id) out.set(id, { label, deleted: false, collection_label: word })
      else bare.push(id)
    }
  } catch {
    /* every id stays bare */
  }
  if (bare.length === 0) return out

  // A bare label is either a live record nothing names, or a deleted one.
  // Existence decides — the trash may hold an older copy of an id that was
  // later restored.
  let live = new Set<string>()
  try {
    const rows = (await selectInChunks(bare, 1000, (chunk) =>
      db(collection).whereIn('id', chunk).select('id')
    )) as Array<{ id: unknown }>
    live = new Set(rows.map((r) => String(r.id).toUpperCase()))
  } catch {
    // an unqueryable table — treat every bare id as live, never claim "deleted"
    live = new Set(bare.map((id) => id.toUpperCase()))
  }
  const gone = bare.filter((id) => !live.has(id.toUpperCase()))
  if (gone.length === 0) return out

  try {
    const template = (await getCollection(collection))?.display_template ?? null
    const trashRows = (await selectInChunks(gone, 1000, (chunk) =>
      db('nivaro_trash')
        .where({ collection })
        .whereIn('item_id', chunk)
        .orderBy('id', 'desc')
        .select('item_id', 'data')
    )) as Array<{ item_id: unknown; data: unknown }>
    const seen = new Set<string>()
    for (const t of trashRows) {
      const id = String(t.item_id)
      const key = gone.find((g) => g.toUpperCase() === id.toUpperCase())
      if (!key || seen.has(key)) continue
      seen.add(key)
      let snapshot: Record<string, unknown> | null = null
      try {
        snapshot =
          typeof t.data === 'string' ? JSON.parse(t.data) : (t.data as Record<string, unknown>)
      } catch {
        snapshot = null
      }
      const label = headlineFromSnapshot(template, snapshot)
      out.set(key, { label: label ?? `${word} #${key}`, deleted: true, collection_label: word })
    }
    for (const id of gone) {
      if (!seen.has(id))
        out.set(id, { label: `${word} #${id}`, deleted: true, collection_label: word })
    }
  } catch {
    for (const id of gone)
      out.set(id, { label: `${word} #${id}`, deleted: true, collection_label: word })
  }
  return out
}
