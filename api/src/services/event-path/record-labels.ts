import { db } from '../../db/index.js'
import { getCollection } from '../collections.js'
import { getLabels } from '../queues.js'
import type { PathStep } from './types.js'

/**
 * Friendly labels for every record a path names.
 *
 * `getLabels` covers collections with a display template or a name-like
 * column. Everything it leaves blank is handled here:
 *  - a JUNCTION row (`workflows_project_sub_types 474752`) is described by
 *    what it links — "Project Sub Type: Fiber Split · on TP26-80366" — and
 *    its write verb becomes linked / unlinked;
 *  - a user row reads as the person's name;
 *  - anything else reads as "<Singular collection name> <id>" instead of the
 *    raw table name.
 */
export async function labelPathRecords(steps: PathStep[]): Promise<void> {
  const by = new Map<string, Set<string>>()
  for (const s of steps) {
    if (!s.record?.collection || !s.record.item || s.record.label) continue
    const set = by.get(s.record.collection) ?? new Set<string>()
    set.add(s.record.item)
    by.set(s.record.collection, set)
  }
  if (by.size === 0) return
  let labels: Record<string, string> = {}
  try {
    labels = await getLabels(by)
  } catch {
    // unlabelled records fall through to the collection-word fallback below
  }
  for (const s of steps) {
    if (s.record && !s.record.label) {
      s.record.label = labels[`${s.record.collection}:${s.record.item}`] ?? null
    }
  }

  const pending = steps.filter((s) => s.record?.collection && s.record.item && !s.record.label)
  if (pending.length === 0) return
  const known = new Set(steps.map((s) => s.record?.collection).filter((c): c is string => !!c))
  const words = new Map<string, Promise<string>>()
  const wordOf = (c: string) => {
    let p = words.get(c)
    if (!p) {
      p = collectionWord(c)
      words.set(c, p)
    }
    return p
  }

  const byCollection = new Map<string, PathStep[]>()
  for (const s of pending) {
    const c = s.record!.collection
    byCollection.set(c, [...(byCollection.get(c) ?? []), s])
  }
  for (const [collection, group] of byCollection) {
    try {
      const system = await systemLabels(
        collection,
        group.map((s) => s.record!.item)
      )
      if (system) {
        for (const s of group) {
          const label = system[`${collection}:${s.record!.item.toLowerCase()}`]
          if (label) s.record!.label = label
        }
        continue
      }
      const legs = await junctionLegs(collection)
      if (legs) {
        await labelJunctionRows(collection, legs, group, known, wordOf)
        continue
      }
      const word = await wordOf(collection)
      for (const s of group) s.record!.label = `${word} ${s.record!.item}`
    } catch {
      // a label is a nicety — the raw id still renders client-side
    }
  }
}

interface Leg {
  fk: string
  /** The collection the FK points at — for an M2A leg, the column naming it per row. */
  target: string
  discriminator?: string
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The two FK legs of a junction table, or null when the collection is not one. */
async function junctionLegs(collection: string): Promise<Leg[] | null> {
  const rows = (await db('nivaro_relations')
    .where({ many_collection: collection })
    .whereNotNull('junction_field')
    .select('many_field', 'one_collection', 'one_collection_field')) as Array<{
    many_field: string
    one_collection: string | null
    one_collection_field: string | null
  }>
  const legs: Leg[] = []
  for (const r of rows) {
    if (!IDENT.test(r.many_field) || legs.some((l) => l.fk === r.many_field)) continue
    if (r.one_collection && IDENT.test(r.one_collection)) {
      legs.push({ fk: r.many_field, target: r.one_collection })
    } else if (r.one_collection_field && IDENT.test(r.one_collection_field)) {
      // M2A: the row's own discriminator column names the target collection.
      legs.push({ fk: r.many_field, target: '', discriminator: r.one_collection_field })
    }
  }
  return legs.length >= 2 ? legs.slice(0, 2) : null
}

async function labelJunctionRows(
  collection: string,
  legs: Leg[],
  group: PathStep[],
  known: Set<string>,
  wordOf: (c: string) => Promise<string>
): Promise<void> {
  const ids = [...new Set(group.map((s) => s.record!.item))]
  const cols = new Set(['id', ...legs.map((l) => l.fk)])
  for (const l of legs) if (l.discriminator) cols.add(l.discriminator)
  const rows = (await db(collection)
    .whereIn('id', ids)
    .select(...cols)) as Array<Record<string, unknown>>
  // A link that has since been removed still names what it linked: the
  // newest revision snapshot carries the row as it was.
  const gone = new Set<string>()
  const live = new Set(rows.map((r) => String(r.id)))
  const missing = ids.filter((id) => !live.has(id))
  if (missing.length) {
    const snaps = (await db('nivaro_revisions')
      .where('collection', collection)
      .whereIn('item', missing)
      .whereNotNull('data')
      .orderBy('id', 'desc')
      .select('item', 'data')) as Array<{ item: string; data: string }>
    for (const snap of snaps) {
      const id = String(snap.item)
      if (gone.has(id)) continue
      try {
        const row = JSON.parse(snap.data) as Record<string, unknown>
        rows.push({ ...row, id })
        gone.add(id)
      } catch {
        // an unparseable snapshot = nothing to name
      }
    }
  }
  if (rows.length === 0) return
  // A row's target collection: fixed for an M2M leg, per row for an M2A leg.
  const targetOf = (leg: Leg, row: Record<string, unknown>): string | null => {
    if (!leg.discriminator) return leg.target
    const raw = row[leg.discriminator] == null ? '' : String(row[leg.discriminator])
    if (!IDENT.test(raw)) return null
    return raw === 'directus_users' ? 'nivaro_users' : raw
  }

  // The parent leg is the record the path is about (already named elsewhere
  // in the path), else the collection the junction's name starts with.
  const parentLeg =
    legs.find((l) => l.target && known.has(l.target) && !known.has(other(legs, l).target)) ??
    legs.find((l) => l.target && collection.startsWith(`${l.target}_`)) ??
    legs.find((l) => !l.discriminator) ??
    legs[0]
  const targetLeg = other(legs, parentLeg)

  const wanted = new Map<string, Set<string>>()
  for (const leg of legs) {
    for (const r of rows) {
      const c = targetOf(leg, r)
      if (!c || r[leg.fk] == null) continue
      const set = wanted.get(c) ?? new Set<string>()
      set.add(String(r[leg.fk]))
      wanted.set(c, set)
    }
  }
  const empty: Record<string, string> = {}
  const targetLabels = wanted.size ? await getLabels(wanted).catch(() => empty) : empty
  // Users and files are not registered collections — name them here.
  for (const [c, ids] of wanted) {
    const system = await systemLabels(c, [...ids])
    if (system) Object.assign(targetLabels, system)
  }
  const byId = new Map(rows.map((r) => [String(r.id), r]))
  for (const s of group) {
    const row = byId.get(s.record!.item)
    if (!row) continue
    const targetCol = targetOf(targetLeg, row)
    const parentCol = targetOf(parentLeg, row)
    const targetId = row[targetLeg.fk] == null ? null : String(row[targetLeg.fk])
    const parentId = row[parentLeg.fk] == null ? null : String(row[parentLeg.fk])
    const find = (c: string | null, id: string | null) =>
      c && id ? (targetLabels[`${c}:${id}`] ?? targetLabels[`${c}:${id.toLowerCase()}`]) : undefined
    const target = targetCol && targetId ? (find(targetCol, targetId) ?? `#${targetId}`) : null
    const parent = find(parentCol, parentId) ?? null
    if (!target || !targetCol) continue
    const targetWord = await wordOf(targetCol)
    const since = gone.has(s.record!.item) ? ' (since removed)' : ''
    s.record!.label = `${targetWord}: ${target}${parent ? ` · on ${parent}` : ''}${since}`
    s.record!.link = true
    if (s.summary === 'created') s.summary = 'linked'
    else if (s.summary === 'deleted') s.summary = 'unlinked'
  }
}

function other(legs: Leg[], leg: Leg): Leg {
  return legs.find((l) => l !== leg) ?? leg
}

/**
 * Labels for the system collections `getLabels` does not cover, keyed
 * `<collection>:<lower-cased id>`; null when the collection is not one.
 */
async function systemLabels(
  collection: string,
  ids: string[]
): Promise<Record<string, string> | null> {
  const unique = [...new Set(ids)]
  if (collection === 'nivaro_users') {
    const rows = (await db('nivaro_users')
      .whereIn('id', unique)
      .select('id', 'first_name', 'last_name', 'email')) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    const out: Record<string, string> = {}
    for (const r of rows) {
      out[`nivaro_users:${String(r.id).toLowerCase()}`] =
        [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email || String(r.id)
    }
    return out
  }
  if (collection === 'nivaro_files') {
    const rows = (await db('nivaro_files')
      .whereIn('id', unique)
      .select('id', 'title', 'filename_download')) as Array<{
      id: string
      title: string | null
      filename_download: string | null
    }>
    const out: Record<string, string> = {}
    for (const r of rows) {
      out[`nivaro_files:${String(r.id).toLowerCase()}`] =
        r.title || r.filename_download || String(r.id)
    }
    return out
  }
  return null
}

/** "Project Sub Type" for `project_sub_types` — the registered singular when set. */
async function collectionWord(collection: string): Promise<string> {
  try {
    const meta = await getCollection(collection)
    if (meta?.singular) return meta.singular
    if (meta?.display_name) return singularize(meta.display_name)
  } catch {
    // unregistered table — derive from its name
  }
  return singularize(
    collection
      .replace(/^nivaro_/, '')
      .split('_')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )
}

function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y')
  if (/(ss|us|is)$/i.test(word)) return word
  if (/s$/i.test(word)) return word.slice(0, -1)
  return word
}
