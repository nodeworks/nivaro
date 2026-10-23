import { m2aWriteMeta } from './M2MCombobox'
import type { CMSRelation } from './types'

/**
 * Staged many-to-many picks ride INSIDE the record's own create / update body.
 *
 * The form used to write the record first and the junction rows after, in a
 * separate "Update relationships" step keyed on the id the write answered
 * with. Anything that went wrong between the two lost the person's picks while
 * the record itself stayed — a Zone-scoped user's new workflow had no Zone yet,
 * so the create's own read-back came back empty, the follow-up step never ran,
 * and the record was saved without the Zone / Region / Sub-type they chose
 * (2026-10-23, workflows 372777/372778). The items service writes alias links
 * from the body BEFORE its read-back, so sending them there makes the record
 * and its links one write — and the record is visible the moment it exists.
 *
 * Shapes (api/src/services/items.ts extractAliasM2MWrites):
 *   create  `alias: [relatedId, …]` (M2A: `[{collection, id}]`)
 *   update  `alias: {create: [...], delete: [relatedId, …]}`
 *
 * A key is left for the follow-up step only when it cannot be said in the
 * body: no alias field on this collection names that junction, or (update) a
 * staged unlink whose junction row is not in the committed rows we know.
 */

export interface FoldInput {
  collection: string
  relations: CMSRelation[]
  /** Staging key → related ids to link. */
  links: Map<string, unknown[]>
  /** Staging key → junction row ids to unlink (existing records only). */
  unlinks: Map<string, Set<unknown>>
  /** The body being built — alias keys are written into it. */
  payload: Record<string, unknown>
  isNew: boolean
  /** Existing record: the committed junction rows for a staging key, if known. */
  committed?: (key: string) => Array<Record<string, unknown>> | undefined
}

interface AliasTarget {
  field: string
  junctionField: string
  m2aCollection: string | null
}

function aliasFor(collection: string, relations: CMSRelation[], key: string): AliasTarget | null {
  let rel = relations.find((r) => r.one_collection === collection && r.one_field === key)
  if (!rel && key.includes('.')) {
    // `<junction>.<related fk>` staging keys (no alias name was known when
    // the picker staged) — the alias is the relation into that junction.
    const mc = key.slice(0, key.indexOf('.'))
    rel = relations.find(
      (r) => r.one_collection === collection && r.many_collection === mc && !!r.one_field
    )
  }
  if (!rel?.one_field || !rel.many_collection) return null
  const junctionField =
    rel.junction_field ??
    relations.find((c) => c.many_collection === rel!.many_collection && c.id !== rel!.id)
      ?.many_field ??
    null
  if (!junctionField) return null
  const companion = relations.find(
    (c) =>
      c.many_collection === rel!.many_collection &&
      c.many_field === junctionField &&
      c.id !== rel!.id
  )
  const m2a = m2aWriteMeta(companion)
  return { field: rel.one_field, junctionField, m2aCollection: m2a?.value ?? null }
}

/** What the draft already holds for an alias (a seeded or server-shaped value), as link entries. */
function existingEntries(v: unknown): unknown[] {
  if (v == null || v === '') return []
  if (Array.isArray(v)) return v
  if (typeof v === 'object') return []
  return [v]
}

const entryKey = (e: unknown): string =>
  e && typeof e === 'object'
    ? `${String((e as { collection?: unknown }).collection ?? '')}:${String((e as { id?: unknown }).id ?? '')}`
    : `:${String(e)}`

/**
 * Write every staged link the body can carry into `payload`; returns the
 * staging keys it carried (the follow-up step skips those).
 */
export function foldStagedLinks(input: FoldInput): Set<string> {
  const { collection, relations, links, unlinks, payload, isNew } = input
  const folded = new Set<string>()
  const keys = new Set([...links.keys(), ...unlinks.keys()])
  for (const key of keys) {
    const add = links.get(key) ?? []
    const drop = unlinks.get(key) ?? new Set<unknown>()
    if (add.length === 0 && drop.size === 0) continue
    const target = aliasFor(collection, relations, key)
    if (!target) continue
    const entry = (id: unknown) =>
      target.m2aCollection ? { collection: target.m2aCollection, id } : id
    if (isNew) {
      if (drop.size > 0) continue // nothing committed to unlink on a new record
      const merged: unknown[] = []
      const seen = new Set<string>()
      for (const e of [...existingEntries(payload[target.field]), ...add.map(entry)]) {
        const k = entryKey(e)
        if (seen.has(k)) continue
        seen.add(k)
        merged.push(e)
      }
      payload[target.field] = merged
      folded.add(key)
      continue
    }
    // Existing record: removals name the RELATED id the junction row holds.
    const rows = input.committed?.(key)
    let removals: unknown[] = []
    if (drop.size > 0) {
      if (!rows) continue
      const byId = new Map(rows.map((r) => [String(r.id), r]))
      const mapped = [...drop].map((jid) => byId.get(String(jid))?.[target.junctionField])
      if (mapped.some((v) => v == null)) continue
      removals = mapped.map(entry)
    }
    // The links that stay ride along too (the server skips pairs that exist),
    // so rules and validation on the server read the record's whole resulting
    // set — not just the newly added ids.
    const kept = (rows ?? [])
      .filter((r) => !drop.has(r.id) && !drop.has(String(r.id)))
      .map((r) => r[target.junctionField])
      .filter((v) => v != null)
    const create: unknown[] = []
    const seen = new Set<string>()
    for (const e of [...kept.map(entry), ...add.map(entry)]) {
      const k = entryKey(e)
      if (seen.has(k)) continue
      seen.add(k)
      create.push(e)
    }
    // A value already in the body for this alias (a draft that carried it)
    // would be read as "add these" — the staged sets are the whole intent.
    payload[target.field] = {
      ...(create.length ? { create } : {}),
      ...(removals.length ? { delete: removals } : {})
    }
    folded.add(key)
  }
  return folded
}

/** Most rows the items service takes in one nested set (NESTED_O2M_ROW_CAP). */
const NESTED_ROW_CAP = 500

/**
 * A NEW record's staged child rows (lines, forecasts…) ride in its create body
 * as nested one-to-many sets — the items service writes them with the record
 * and takes the record back out if a set fails, so a record never lands
 * without the rows the person entered. Keys are `<child collection>.<fk>`.
 * Left for the follow-up step: no alias field on this collection names the
 * set, a row carries its own staged children (`__o2m_*`, which need the child
 * id), the set breaks the grid's unique-by rule (the step names that), or it
 * is bigger than one nested write takes.
 */
export function foldStagedRows(input: {
  collection: string
  relations: CMSRelation[]
  rows: Map<string, Record<string, unknown>[]>
  payload: Record<string, unknown>
  /** Keys whose rows must stay out (e.g. a duplicate unique-by key). */
  skip?: Set<string>
}): Set<string> {
  const folded = new Set<string>()
  for (const [key, list] of input.rows) {
    if (list.length === 0 || input.skip?.has(key)) continue
    const dot = key.indexOf('.')
    if (dot < 0) continue
    const rc = key.slice(0, dot)
    const mf = key.slice(dot + 1)
    const rel = input.relations.find(
      (r) =>
        r.one_collection === input.collection &&
        r.many_collection === rc &&
        r.many_field === mf &&
        !!r.one_field &&
        r.junction_field == null
    )
    if (!rel?.one_field) continue
    if (list.length > NESTED_ROW_CAP) continue
    if (list.some((row) => Object.keys(row).some((k) => k.startsWith('__o2m_')))) continue
    // The staged rows ARE the set (a draft value under the alias name means
    // nothing on a new record). A staged row never carries an id — rows WITH
    // one are read as updates.
    input.payload[rel.one_field] = list.map((row) => {
      const { id: _id, ...rest } = row
      return rest
    })
    folded.add(key)
  }
  return folded
}
