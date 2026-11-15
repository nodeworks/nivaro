/**
 * Config change reach (rt8 #25): "This reaches 34 open forms, 12 people right now" in the save
 * step of a layout / field / rule / pipeline / owner-matrix editor.
 *
 * Read from the realtime board's record-room viewers (plugins/socketio.ts
 * getRecordViewerSnapshot: this process's sockets plus the other processes' from the board,
 * already limited to the caller's tenant) — in memory, no database read. An open form is one
 * socket in a record room of an affected collection; the editing administrator's own are left
 * out. Administrators only (the route): it names people and what they have open.
 */

export interface ReachViewer {
  id: string
  name: string
}

export interface ReachSnapshotRow {
  collection: string
  item: string
  viewers: ReachViewer[]
}

export interface ConfigReach {
  /** Open record forms of the affected collections (one per tab). */
  forms: number
  /** Distinct people with at least one of them open. */
  people: number
  by_collection: Array<{ collection: string; forms: number; people: number }>
  /** Most forms first, then by name; at most `cap`. */
  people_list: Array<{ id: string; name: string; forms: number; records: number }>
  /** people_list was cut at the cap. */
  more: number
}

const norm = (id: string) => String(id).toLowerCase()

/** Pure: the reach of a change to `collections`, leaving out `excludeUserId`. */
export function configReach(
  snapshot: ReachSnapshotRow[],
  collections: string[],
  excludeUserId?: string | null,
  cap = 50
): ConfigReach {
  const want = new Set(collections)
  const skip = excludeUserId ? norm(excludeUserId) : null
  const people = new Map<
    string,
    { id: string; name: string; forms: number; records: Set<string> }
  >()
  const byCol = new Map<string, { forms: number; people: Set<string> }>()
  let forms = 0
  for (const row of snapshot) {
    if (!want.has(row.collection)) continue
    for (const v of row.viewers ?? []) {
      if (!v?.id) continue
      const key = norm(v.id)
      if (key === skip) continue
      forms++
      const p = people.get(key) ?? {
        id: v.id,
        name: v.name || 'Someone',
        forms: 0,
        records: new Set()
      }
      p.forms++
      p.records.add(`${row.collection}:${row.item}`)
      people.set(key, p)
      const c = byCol.get(row.collection) ?? { forms: 0, people: new Set<string>() }
      c.forms++
      c.people.add(key)
      byCol.set(row.collection, c)
    }
  }
  const list = [...people.values()]
    .map((p) => ({ id: p.id, name: p.name, forms: p.forms, records: p.records.size }))
    .sort((a, b) => b.forms - a.forms || a.name.localeCompare(b.name))
  return {
    forms,
    people: people.size,
    by_collection: [...byCol]
      .map(([collection, c]) => ({ collection, forms: c.forms, people: c.people.size }))
      .sort((a, b) => b.forms - a.forms || a.collection.localeCompare(b.collection)),
    people_list: list.slice(0, cap),
    more: Math.max(0, list.length - cap)
  }
}

const NAME_RE = /^[A-Za-z0-9_]{1,64}$/

/** `?collections=a,b` → valid names, at most 20. */
export function parseReachCollections(raw: unknown): string[] {
  const parts = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => NAME_RE.test(s))
  return [...new Set(parts)].slice(0, 20)
}
