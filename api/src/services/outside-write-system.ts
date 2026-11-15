import type { RecordAspect } from './record-events.js'
import {
  isFileCollection,
  isSystemCollection,
  junctionParentAspects,
  type RelLike,
  relatedParentsOf
} from './related-announce.js'

/**
 * The outside-write watcher's "dependents" (realtime): tables whose rows belong to ANOTHER record.
 * An outside write to one of them (a procedure that moves a pipeline step, a script that adds a
 * comment or links a file) never names its owner, so the plain collection announcement would
 * reach nobody. Read through SQL Server change tracking, each row is mapped to the aspect of the
 * record it belongs to — never a "system collection" event:
 *
 *   nivaro_workflow_instances / _history → `$state` + `$owners` on (collection, item);
 *                                          an addendum's instance also `$addendums` on its parent
 *   nivaro_tasks                         → `$tasks` on (collection, item); kind support → the
 *                                          support topic instead; every task → my-work
 *   nivaro_comments                      → `$comments` on (collection, item) (field comments too)
 *   nivaro_files                         → `$files` on every record carrying the file
 *   nivaro_users                         → people:changed (directory columns only)
 *   nivaro_addendums / _approvals        → `$addendums` on the parent (and the addendum's `$state`)
 *   registered child / junction tables   → `$related` on the records their many-to-one fields
 *   of a watched collection                point at; a file junction also `$files`; a child
 *                                          collection named like an addendum also `$addendums`
 *
 * Only ids and aspect names leave: owners are read server-side and never broadcast. A row whose
 * owner cannot be read (deleted since) is dropped. Pure here; the reads and emits live in
 * outside-write-watch.ts.
 */

/** The system tables the watcher maps (and change-tracking-setup.ts may track). */
export const SYSTEM_TABLES = [
  'nivaro_workflow_instances',
  'nivaro_workflow_history',
  'nivaro_tasks',
  'nivaro_comments',
  'nivaro_files',
  'nivaro_users',
  'nivaro_addendums',
  'nivaro_addendum_approvals'
] as const
export type SystemTable = (typeof SYSTEM_TABLES)[number]

/** System tables tracked WITH their changed columns (only directory changes count for people). */
export const COLUMN_TRACKED = new Set<string>(['nivaro_users'])

/** People directory columns whose change is a people:changed (never credentials). */
export const PEOPLE_DIRECTORY_COLUMNS = [
  'first_name',
  'last_name',
  'email',
  'title',
  'department',
  'company',
  'office_location',
  'status',
  'is_out_of_office',
  'ooo_end',
  'delegate_id',
  'avatar',
  'account_kind',
  'is_redacted'
]

const VERSION_RE = /^\d{1,20}$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const q = (s: string) => `[${s.replace(/]/g, ']]')}]`
const lit = (s: string) => `N'${s.replace(/'/g, "''")}'`

function changes(table: string, from: string, to: string): string {
  if (!VERSION_RE.test(from) || !VERSION_RE.test(to)) throw new Error('bad version')
  if (!IDENT_RE.test(table)) throw new Error('bad table')
  return `CHANGETABLE(CHANGES [dbo].${q(table)}, ${from}) AS ct`
}
const upTo = (to: string) => `ct.SYS_CHANGE_VERSION <= ${to}`

/** The addendum an instance / approval belongs to → its parent (columns pc, pi). */
const ADDENDUM_PARENT = (col: string) =>
  `LEFT JOIN [dbo].[nivaro_addendums] a ON a.id = TRY_CONVERT(UNIQUEIDENTIFIER, ${col})`

/** The read for one system table's changes in (from, to] (pure; validated). */
export function systemDetailQuery(
  table: SystemTable,
  from: string,
  to: string,
  cap = 2000
): string {
  const top = `SELECT TOP (${cap})`
  const op = 'ct.SYS_CHANGE_OPERATION AS op'
  const where = `WHERE ${upTo(to)}`
  switch (table) {
    case 'nivaro_workflow_instances':
      return `${top} ${op}, b.collection AS c, b.item AS i, a.parent_collection AS pc, a.parent_id AS pi
  FROM ${changes(table, from, to)}
  LEFT JOIN [dbo].[nivaro_workflow_instances] b ON b.id = ct.id
  ${ADDENDUM_PARENT("CASE WHEN b.collection = N'nivaro_addendums' THEN b.item END")}
 ${where}`
    case 'nivaro_workflow_history':
      return `${top} ${op}, wi.collection AS c, wi.item AS i, a.parent_collection AS pc, a.parent_id AS pi
  FROM ${changes(table, from, to)}
  LEFT JOIN [dbo].[nivaro_workflow_history] b ON b.id = ct.id
  LEFT JOIN [dbo].[nivaro_workflow_instances] wi ON wi.id = b.instance
  ${ADDENDUM_PARENT("CASE WHEN wi.collection = N'nivaro_addendums' THEN wi.item END")}
 ${where}`
    case 'nivaro_tasks':
      return `${top} ${op}, CAST(ct.id AS NVARCHAR(255)) AS id, b.collection AS c, b.item AS i, b.kind AS kind
  FROM ${changes(table, from, to)}
  LEFT JOIN [dbo].[nivaro_tasks] b ON b.id = ct.id
 ${where}`
    case 'nivaro_comments':
      return `${top} ${op}, b.collection AS c, b.item AS i
  FROM ${changes(table, from, to)}
  LEFT JOIN [dbo].[nivaro_comments] b ON b.id = ct.id
 ${where}`
    case 'nivaro_files':
      return `${top} ${op}, CAST(ct.id AS NVARCHAR(255)) AS id
  FROM ${changes(table, from, to)}
 ${where}`
    case 'nivaro_users': {
      const cols = PEOPLE_DIRECTORY_COLUMNS.map(
        (c) =>
          `CHANGE_TRACKING_IS_COLUMN_IN_MASK(COLUMNPROPERTY(OBJECT_ID(N'dbo.nivaro_users'), ${lit(c)}, 'ColumnId'), ct.SYS_CHANGE_COLUMNS) = 1`
      ).join(' OR ')
      return `${top} ${op}, CAST(ct.id AS NVARCHAR(255)) AS id,
       CASE WHEN ct.SYS_CHANGE_OPERATION <> 'U' OR ct.SYS_CHANGE_COLUMNS IS NULL OR ${cols}
            THEN 1 ELSE 0 END AS dir
  FROM ${changes(table, from, to)}
 ${where}`
    }
    case 'nivaro_addendums':
      return `${top} ${op}, CAST(ct.id AS NVARCHAR(255)) AS id, b.parent_collection AS pc, b.parent_id AS pi
  FROM ${changes(table, from, to)}
  LEFT JOIN [dbo].[nivaro_addendums] b ON b.id = ct.id
 ${where}`
    case 'nivaro_addendum_approvals':
      return `${top} ${op}, CAST(b.addendum_id AS NVARCHAR(255)) AS aid, b.parent_collection AS pc, b.parent_id AS pi
  FROM ${changes(table, from, to)}
  LEFT JOIN [dbo].[nivaro_addendum_approvals] b ON b.id = ct.id
 ${where}`
  }
}

export interface Notice {
  collection: string
  item: string
  aspects: string[]
}

export interface DependentPlan {
  notices: Notice[]
  /** people:changed: who (null = anyone) and whether someone is new. */
  people: { ids: string[]; created: boolean } | null
  /** Ops topics to poke (support desk, my work). */
  ops: Array<'support' | 'my-work'>
  /** Files whose carriers hear `$files` (resolved by the caller). */
  files: string[]
}

const str = (v: unknown): string | null =>
  v == null || String(v).trim() === '' ? null : String(v).trim()

/** Merge notices by record, uniting their aspects. */
export function mergeNotices(list: Notice[]): Notice[] {
  const map = new Map<string, Notice>()
  for (const n of list) {
    const key = `${n.collection.toLowerCase()}\u0001${n.item}`
    const cur = map.get(key)
    if (cur) {
      for (const a of n.aspects) if (!cur.aspects.includes(a)) cur.aspects.push(a)
    } else map.set(key, { collection: n.collection, item: n.item, aspects: [...n.aspects] })
  }
  return [...map.values()]
}

/** One system table's change rows → what to announce (pure). Unresolvable rows are dropped. */
export function mapSystemRows(
  table: SystemTable,
  rows: Array<Record<string, unknown>>
): DependentPlan {
  const plan: DependentPlan = { notices: [], people: null, ops: [], files: [] }
  const ops = new Set<'support' | 'my-work'>()
  const add = (c: unknown, i: unknown, aspects: RecordAspect[]) => {
    const collection = str(c)
    const item = str(i)
    if (collection && item && IDENT_RE.test(collection))
      plan.notices.push({ collection, item, aspects })
  }
  const people = { ids: [] as string[], created: false, any: false }
  for (const r of rows) {
    switch (table) {
      case 'nivaro_workflow_instances':
      case 'nivaro_workflow_history':
        add(r.c, r.i, ['$state', '$owners'])
        if (str(r.c) === 'nivaro_addendums') add(r.pc, r.pi, ['$addendums'])
        break
      case 'nivaro_tasks':
        if (r.c == null && r.kind == null) break // deleted: nothing left to name
        ops.add('my-work')
        if (str(r.kind) === 'support') ops.add('support')
        else add(r.c, r.i, ['$tasks'])
        break
      case 'nivaro_comments':
        add(r.c, r.i, ['$comments'])
        break
      case 'nivaro_files': {
        const id = str(r.id)
        if (id && !plan.files.includes(id)) plan.files.push(id)
        break
      }
      case 'nivaro_users':
        if (Number(r.dir) !== 1) break
        if (String(r.op).toUpperCase() === 'I') {
          people.created = true
          people.any = true
        }
        if (str(r.id)) people.ids.push(String(r.id).toUpperCase())
        break
      case 'nivaro_addendums':
        add(r.pc, r.pi, ['$addendums'])
        if (r.pc != null) add('nivaro_addendums', r.id, ['$addendums'])
        break
      case 'nivaro_addendum_approvals':
        add(r.pc, r.pi, ['$addendums'])
        add('nivaro_addendums', r.aid, ['$addendums', '$state'])
        break
    }
  }
  if (people.ids.length || people.created)
    plan.people = { ids: people.any ? [] : [...new Set(people.ids)], created: people.created }
  plan.ops = [...ops]
  plan.notices = mergeNotices(plan.notices)
  return plan
}

/** The read for a registered child / junction table's changed rows (pure; validated). */
export function childDetailQuery(table: string, pk: string, from: string, to: string, cap = 2000) {
  if (!IDENT_RE.test(pk)) throw new Error('bad key')
  return `SELECT TOP (${cap}) ct.SYS_CHANGE_OPERATION AS op, b.*
  FROM ${changes(table, from, to)}
  LEFT JOIN [dbo].${q(table)} b ON b.${q(pk)} = ct.${q(pk)}
 WHERE ${upTo(to)}`
}

/**
 * A registered child or junction table's changed rows → the records they belong to (pure):
 * many-to-one parents hear `$related` (+ `$addendums` when the child is an addendum collection);
 * a junction's parents hear what a junction write tells them (`$related`, + `$files` for a file
 * junction). Deleted rows (no current values) are dropped.
 */
export function mapChildRows(
  table: string,
  rels: RelLike[],
  rows: Array<Record<string, unknown>>
): Notice[] {
  const live = rows.filter((r) => Object.keys(r).some((k) => k !== 'op' && r[k] != null))
  if (!live.length) return []
  const out: Notice[] = []
  const addendum = /addendum/i.test(table)
  for (const p of relatedParentsOf(table, rels, live))
    out.push({
      collection: p.collection,
      item: p.id,
      aspects: addendum ? ['$related', '$addendums'] : ['$related']
    })
  for (const leg of rels) {
    if (leg.many_collection !== table || !leg.junction_field || !leg.many_field) continue
    if (!leg.one_collection || isSystemCollection(leg.one_collection)) continue
    const aspects = junctionParentAspects(table, leg, rels)
    for (const r of live) {
      const id = str(r[leg.many_field])
      if (id) out.push({ collection: leg.one_collection, item: id, aspects })
    }
  }
  return mergeNotices(out)
}

/**
 * Registered tables whose rows belong to a record of a watched collection: many-to-one children
 * and junctions with a leg on it, change-tracked, at most `cap` (pure).
 */
export function dependentTables(
  watched: string[],
  rels: RelLike[],
  tracked: Set<string>,
  cap = 40
): string[] {
  const want = new Set(watched.map((w) => w.toLowerCase()))
  const out: string[] = []
  for (const r of rels) {
    const t = r.many_collection
    if (!t || !r.one_collection || !want.has(r.one_collection.toLowerCase())) continue
    if (isSystemCollection(t) || isFileCollection(t) || !tracked.has(t.toLowerCase())) continue
    if (!out.includes(t)) out.push(t)
    if (out.length >= cap) break
  }
  return out
}

/** Which of these tables changed in (from, to] — one round trip (pure; validated). */
export function probeQuery(tables: string[], from: string, to: string): string {
  if (!VERSION_RE.test(from) || !VERSION_RE.test(to)) throw new Error('bad version')
  return tables
    .filter((t) => IDENT_RE.test(t))
    .map(
      (t) =>
        `SELECT ${lit(t)} AS t WHERE CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(${lit(`dbo.${t}`)})) <= ${from} AND EXISTS (SELECT 1 FROM ${changes(t, from, to)} WHERE ${upTo(to)})`
    )
    .join('\nUNION ALL\n')
}

/** Record notices more than this for one collection and aspect set go out collection-wide. */
export const NOTICE_ID_CAP = 50
const FOREIGN = new Set(['$related', '$files'])

/**
 * Notices → emits (pure): drops records the app announced a moment ago (`recent`, the same
 * journal dedupe as rows), sends `$related` / `$files` through the coalesced foreign path and the
 * other aspects as record aspects, collection-wide past NOTICE_ID_CAP records.
 */
export function planEmits(
  notices: Notice[],
  recent: Map<string, { ids: Map<string, number>; wholeAt: number }>,
  now: number,
  recentMs: number
): {
  foreign: Array<{ collection: string; item: string; aspect: '$related' | '$files' }>
  record: Array<{ collection: string; item: string; aspects: string[] }>
  deduped: number
} {
  const foreign: Array<{ collection: string; item: string; aspect: '$related' | '$files' }> = []
  const groups = new Map<string, { collection: string; aspects: string[]; items: string[] }>()
  let deduped = 0
  for (const n of notices) {
    const r = recent.get(n.collection.toLowerCase())
    const told =
      !!r && (now - r.wholeAt <= recentMs || now - (r.ids.get(n.item) ?? -Infinity) <= recentMs)
    if (told) {
      deduped++
      continue
    }
    for (const a of n.aspects)
      if (FOREIGN.has(a))
        foreign.push({ collection: n.collection, item: n.item, aspect: a as '$related' | '$files' })
    const own = n.aspects.filter((a) => !FOREIGN.has(a)).sort()
    if (!own.length) continue
    const key = `${n.collection.toLowerCase()}\u0001${own.join(',')}`
    const g = groups.get(key) ?? { collection: n.collection, aspects: own, items: [] }
    if (!g.items.includes(n.item)) g.items.push(n.item)
    groups.set(key, g)
  }
  const record: Array<{ collection: string; item: string; aspects: string[] }> = []
  for (const g of groups.values()) {
    if (g.items.length > NOTICE_ID_CAP)
      record.push({ collection: g.collection, item: '*', aspects: g.aspects })
    else
      for (const item of g.items)
        record.push({ collection: g.collection, item, aspects: g.aspects })
  }
  return { foreign, record, deduped }
}
