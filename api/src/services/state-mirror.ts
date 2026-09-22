/**
 * Does a record's mirrored state column agree with its pipeline instance? (#520)
 *
 * "Is this record canceled" had two answers: the pipeline instance's state key
 * (what Nivaro decides) and the binding's `state_field` column — a raw mirror
 * written through `state_field_map` on every transition (what legacy readers,
 * procs and several extension queries read). They agree only while every
 * write path keeps them in step; a transition applied by a script, a restore,
 * or a map edit after the fact leaves the mirror stale and the two readers
 * disagree about the same record without anyone noticing.
 *
 * This compares them — for EVERY state, not just canceled — per bound
 * collection, set-based: one grouped read of (current key, column value).
 * The repair re-runs `syncStateField` for the drifted records, i.e. makes the
 * mirror say what the instance says (the instance is the source of truth).
 */
import { db } from '../db/index.js'

function parseJson<T>(v: string | null | undefined): T | null {
  if (v == null || v === '') return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface MirrorDrift {
  collection: string
  state_field: string
  checked: number
  drifted: number
  /** Per state key: how many records disagree, and what the column says instead. */
  by_state: Array<{ key: string; label: string; expected: string; found: string; count: number }>
  samples: Array<{ item: string; key: string; expected: string; found: string | null }>
  /**
   * Map entries whose value is not a row of the column's FK target — the
   * mirror can never be written for those states (the FK refuses it, and
   * syncStateField swallows the error). Repair skips them; the MAP is wrong.
   */
  map_errors: Array<{ key: string; value: string; target: string }>
}

/** For an FK state column: map keys whose value is not a row of the target. */
async function invalidMapEntries(
  collection: string,
  field: string,
  map: Record<string, unknown>
): Promise<Array<{ key: string; value: string; target: string }>> {
  const rel = (await db('nivaro_relations')
    .where({ many_collection: collection, many_field: field })
    .whereNotNull('one_collection')
    .first('one_collection')
    .catch(() => undefined)) as { one_collection: string } | undefined
  const target = rel?.one_collection
  if (!target || !IDENT.test(target)) return []
  const values = [...new Set(Object.values(map).map((v) => String(v)))]
  if (values.length === 0) return []
  const found = new Set(
    (
      (await db(target)
        .whereIn('id', values as never)
        .select('id')
        .catch(() => [])) as Array<{ id: unknown }>
    ).map((r) => String(r.id))
  )
  return Object.entries(map)
    .filter(([, v]) => !found.has(String(v)))
    .map(([key, v]) => ({ key, value: String(v), target }))
}

function norm(v: unknown): string {
  return v == null ? '' : String(v).trim().toLowerCase()
}

export async function stateMirrorDrift(onlyCollection?: string): Promise<MirrorDrift[]> {
  const bindings = (await db('nivaro_workflow_bindings')
    .whereNotNull('state_field')
    .modify((q) => {
      if (onlyCollection) void q.where({ collection: onlyCollection })
    })
    .select('collection', 'state_field', 'state_field_map', 'template')) as Array<{
    collection: string
    state_field: string
    state_field_map: string | null
    template: string
  }>
  const out: MirrorDrift[] = []
  for (const b of bindings) {
    if (!IDENT.test(b.collection) || !IDENT.test(b.state_field)) continue
    const map = parseJson<Record<string, unknown>>(b.state_field_map) ?? {}
    const expectedFor = (key: string) => (key in map ? map[key] : key)
    let rows: Array<{ item: string; key: string; label: string; val: unknown }>
    try {
      rows = (await db('nivaro_workflow_instances as i')
        .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
        .joinRaw(`JOIN [${b.collection}] AS r ON CAST(r.id AS NVARCHAR(50)) = i.item`)
        .where('i.collection', b.collection)
        .where('i.template', b.template)
        .select(
          'i.item as item',
          's.key as key',
          's.label as label',
          db.raw(`r.[${b.state_field}] as val`)
        )) as Array<{ item: string; key: string; label: string; val: unknown }>
    } catch {
      continue
    }
    const byState = new Map<string, MirrorDrift['by_state'][number]>()
    const samples: MirrorDrift['samples'] = []
    let drifted = 0
    for (const r of rows) {
      const expected = expectedFor(r.key)
      if (norm(expected) === norm(r.val)) continue
      drifted++
      const found = r.val == null ? '(empty)' : String(r.val)
      const k = `${r.key}|${found}`
      const agg = byState.get(k) ?? {
        key: r.key,
        label: r.label,
        expected: String(expected ?? ''),
        found,
        count: 0
      }
      agg.count++
      byState.set(k, agg)
      if (samples.length < 25)
        samples.push({
          item: String(r.item),
          key: r.key,
          expected: String(expected ?? ''),
          found: r.val == null ? null : String(r.val)
        })
    }
    out.push({
      collection: b.collection,
      state_field: b.state_field,
      checked: rows.length,
      drifted,
      by_state: [...byState.values()].sort((a, b2) => b2.count - a.count),
      samples,
      map_errors: await invalidMapEntries(b.collection, b.state_field, map)
    })
  }
  return out
}

/** Make every drifted mirror say what its instance says. */
export async function repairStateMirror(onlyCollection?: string): Promise<{ repaired: number }> {
  const { syncStateField } = await import('./workflow-transitions.js')
  const bindings = (await db('nivaro_workflow_bindings')
    .whereNotNull('state_field')
    .modify((q) => {
      if (onlyCollection) void q.where({ collection: onlyCollection })
    })
    .select('collection', 'state_field', 'state_field_map', 'template')) as Array<{
    collection: string
    state_field: string
    state_field_map: string | null
    template: string
  }>
  let repaired = 0
  for (const b of bindings) {
    if (!IDENT.test(b.collection) || !IDENT.test(b.state_field)) continue
    const map = parseJson<Record<string, unknown>>(b.state_field_map) ?? {}
    // A map value the FK target does not hold cannot be written — and writing
    // the raw key instead would be wrong too. Leave those records alone.
    const invalid = new Set(
      (await invalidMapEntries(b.collection, b.state_field, map)).map((e) => e.key)
    )
    const rows = (await db('nivaro_workflow_instances as i')
      .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
      .joinRaw(`JOIN [${b.collection}] AS r ON CAST(r.id AS NVARCHAR(50)) = i.item`)
      .where('i.collection', b.collection)
      .where('i.template', b.template)
      .select('i.item as item', 's.key as key', db.raw(`r.[${b.state_field}] as val`))
      .catch(() => [])) as Array<{ item: string; key: string; val: unknown }>
    for (const r of rows) {
      if (invalid.has(r.key)) continue
      const expected = r.key in map ? map[r.key] : r.key
      if (norm(expected) === norm(r.val)) continue
      await syncStateField(b.collection, r.item, { key: r.key })
      repaired++
    }
  }
  return { repaired }
}
