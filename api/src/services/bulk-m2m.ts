/**
 * Bulk "Update field" on a MANY-TO-MANY field (2026-11-13): the bar's value for
 * a to-many alias is one of three intents over a picked set of related ids —
 *
 *   append   {create: ids}  each record gains the links it does not have yet
 *   replace  {set: ids}     each record's links become exactly these (empty = none)
 *   remove   {delete: ids}  each record loses these links
 *
 * The write itself is the items service's alias write (extractAliasM2MWrites /
 * applyAliasM2MWrites in items.ts), per record, as the person — createOne /
 * deleteOne on the junction, so permissions, hooks, activity (the junction
 * sentence "Added X to Y") and rollups all hold. This module only knows which
 * fields qualify, reads every record's current links in ONE batched read as the
 * person (never one read per record), and plans what each record would gain
 * and lose, for the preview and to skip records that would not change.
 *
 * Polymorphic (M2A) aliases are left out: a link there names its collection
 * too, and the bulk picker has no way to choose it.
 */
import type { User } from '../types.js'
import { aliasLinkIdKey } from './alias-links.js'
import { selectInChunks } from './db-batch.js'

export type M2MMode = 'append' | 'replace' | 'remove'

export interface M2MFieldInfo {
  field: string
  junction: string
  /** The junction column that points at the record being updated. */
  parentFk: string
  /** The junction column that points at the related record. */
  relatedFk: string
  /** The related collection the picker browses. */
  related: string
}

type Rel = {
  many_collection: string
  many_field: string
  one_collection?: string | null
  one_field?: string | null
  junction_field?: string | null
  one_allowed_collections?: unknown
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The to-many alias `field` of `collection`, or null (not one, polymorphic, or malformed). Pure. */
export function m2mFieldInfo(collection: string, field: string, rels: Rel[]): M2MFieldInfo | null {
  const leg = rels.find(
    (r) => r.one_collection === collection && r.one_field === field && r.junction_field != null
  )
  if (!leg) return null
  const jf = String(leg.junction_field)
  // The junction's OTHER leg (junction_field only marks the pairing): it names the far side.
  const far = rels.find(
    (r) => r.many_collection === leg.many_collection && r.many_field === jf && r !== leg
  )
  const allowed = far?.one_allowed_collections ?? leg.one_allowed_collections
  const polymorphic =
    (Array.isArray(allowed) && allowed.length > 0) ||
    (typeof allowed === 'string' && allowed.trim() !== '')
  if (polymorphic || !far?.one_collection) return null
  if (![leg.many_collection, leg.many_field, jf].every((x) => IDENT.test(String(x)))) return null
  return {
    field,
    junction: leg.many_collection,
    parentFk: leg.many_field,
    relatedFk: jf,
    related: far.one_collection
  }
}

/** Every plain to-many alias of `collection`. Pure. */
export function m2mFields(collection: string, rels: Rel[]): M2MFieldInfo[] {
  const out: M2MFieldInfo[] = []
  for (const r of rels) {
    if (r.one_collection !== collection || !r.one_field || r.junction_field == null) continue
    const info = m2mFieldInfo(collection, r.one_field, rels)
    if (info && !out.some((o) => o.field === info.field)) out.push(info)
  }
  return out
}

const idOf = (e: unknown): string | number | null => {
  if (typeof e === 'string' || typeof e === 'number') return e === '' ? null : e
  if (e && typeof e === 'object') {
    const id = (e as Record<string, unknown>).id
    if (typeof id === 'string' || typeof id === 'number') return id === '' ? null : id
  }
  return null
}

const dedupe = (ids: Array<string | number>) => {
  const seen = new Set<string>()
  return ids.filter((id) => {
    const k = aliasLinkIdKey(id)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * The bulk intent a value carries for a to-many alias, or null when it is not
 * one the bar sends. A bare array is an append (the items service's alias
 * write is additive for arrays too).
 */
export function m2mIntent(value: unknown): { mode: M2MMode; ids: Array<string | number> } | null {
  const ids = (list: unknown[]) =>
    dedupe(list.map(idOf).filter((x): x is string | number => x != null))
  if (Array.isArray(value)) return { mode: 'append', ids: ids(value) }
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (Array.isArray(o.set)) return { mode: 'replace', ids: ids(o.set) }
  if (Array.isArray(o.create) && !Array.isArray(o.delete))
    return { mode: 'append', ids: ids(o.create) }
  if (Array.isArray(o.delete) && !Array.isArray(o.create))
    return { mode: 'remove', ids: ids(o.delete) }
  return null
}

/** The alias payload for an intent (what the client sends and the items service reads). */
export function m2mPayload(mode: M2MMode, ids: Array<string | number>): Record<string, unknown> {
  const list = dedupe(ids)
  return mode === 'replace'
    ? { set: list }
    : mode === 'remove'
      ? { delete: list }
      : { create: list }
}

/** What one record would gain and lose. `current` = its related ids now. Pure. */
export function planM2MRow(
  mode: M2MMode,
  picked: Array<string | number>,
  current: Array<string | number>
): { adds: Array<string | number>; removes: Array<string | number> } {
  const have = new Set(current.map(aliasLinkIdKey))
  const want = new Set(picked.map(aliasLinkIdKey))
  if (mode === 'append')
    return { adds: dedupe(picked).filter((id) => !have.has(aliasLinkIdKey(id))), removes: [] }
  if (mode === 'remove')
    return { adds: [], removes: dedupe(current).filter((id) => want.has(aliasLinkIdKey(id))) }
  return {
    adds: dedupe(picked).filter((id) => !have.has(aliasLinkIdKey(id))),
    removes: dedupe(current).filter((id) => !want.has(aliasLinkIdKey(id)))
  }
}

export interface M2MPlanSummary {
  /** Records that would gain or lose at least one link. */
  changing: number
  /** Records that already hold the asked-for links (nothing to do). */
  unchanged: number
  links_added: number
  links_removed: number
}

/** Plan every record. `current` maps a lower-cased record id → its related ids. Pure. */
export function planM2M(
  mode: M2MMode,
  picked: Array<string | number>,
  ids: Array<string | number>,
  current: Map<string, Array<string | number>>
): {
  rows: Map<string, { adds: Array<string | number>; removes: Array<string | number> }>
  summary: M2MPlanSummary
} {
  const rows = new Map<string, { adds: Array<string | number>; removes: Array<string | number> }>()
  const summary: M2MPlanSummary = { changing: 0, unchanged: 0, links_added: 0, links_removed: 0 }
  for (const id of ids) {
    const k = aliasLinkIdKey(id)
    const plan = planM2MRow(mode, picked, current.get(k) ?? [])
    rows.set(k, plan)
    if (plan.adds.length === 0 && plan.removes.length === 0) summary.unchanged++
    else {
      summary.changing++
      summary.links_added += plan.adds.length
      summary.links_removed += plan.removes.length
    }
  }
  return { rows, summary }
}

/** The list reader (items.readItems), injectable so tests run on fakes. */
export type ListReader = (
  user: User,
  collection: string,
  query: Record<string, unknown>,
  req: undefined,
  workspaceId?: string
) => Promise<unknown>

const PAGE = 1000
const ID_CHUNK = 200

/**
 * Every record's current links (lower-cased record id → related ids), read
 * from the junction AS the person — their row filters, scopes and field list
 * apply — in chunks of records and pages of links. Never one read per record.
 * Throws when the person may not read the junction: the caller then cannot
 * tell what the records hold and says so.
 */
export async function currentLinks(
  user: User,
  info: M2MFieldInfo,
  ids: Array<string | number>,
  read: ListReader,
  workspaceId?: string
): Promise<Map<string, Array<string | number>>> {
  const out = new Map<string, Array<string | number>>()
  const rows = await selectInChunks(ids, ID_CHUNK, async (chunk) => {
    const got: Array<Record<string, unknown>> = []
    for (let page = 1; page < 50; page++) {
      const res = (await read(
        user,
        info.junction,
        {
          fields: [info.parentFk, info.relatedFk],
          filter: { [info.parentFk]: { _in: chunk } },
          limit: PAGE,
          page,
          sort: ['id'],
          count: false
        },
        undefined,
        workspaceId
      )) as { data?: Array<Record<string, unknown>> }
      const data = res.data ?? []
      got.push(...data)
      if (data.length < PAGE) break
    }
    return got
  })
  for (const r of rows) {
    const parent = r[info.parentFk]
    const rel = idOf(r[info.relatedFk])
    if (parent == null || rel == null) continue
    const k = aliasLinkIdKey(idOf(parent) ?? parent)
    const list = out.get(k) ?? []
    list.push(rel)
    out.set(k, list)
  }
  return out
}
