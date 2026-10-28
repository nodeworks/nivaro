import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { systemReadableColumns } from './system-collections.js'
import { applyDirectoryListingRules } from './user-directory-cols.js'

/**
 * People extras for global search (search program item 17): every person hit
 * gains `role_name`, `zones` (restrict-mode User Scope labels — the same
 * org-visible line the people page and the online list print) and `title`; and
 * a search that names a role and/or a zone ("planners zone 3", "zone 3",
 * "buyers") finds the people holding them.
 *
 * Same rules as the main people search: a non-admin gets directory columns
 * only and the directory listing rules (no suspended, redacted, placeholder or
 * machine account); name words are matched only on columns they may read.
 * Role names are the contact-card field everyone already sees (/users/:id/card).
 */

export const PEOPLE_EXTRA_CAP = 8
const MAX_ZONE_USERS = 2000

export interface PersonBase {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  title: string | null
  department?: string | null
  status?: string | null
  account_kind?: string | null
}

export type PersonWithExtras = PersonBase & {
  role_name?: string | null
  zones?: string[]
  title: string | null
}

export interface ZoneMatch {
  dimension: string
  id: string
  label: string
}

export interface PeopleDeps {
  roles(): Promise<Array<{ id: string; name: string }>>
  /** Scope targets (any active dimension) whose label equals one of `phrases`. */
  zoneMatches(phrases: string[]): Promise<ZoneMatch[]>
  /** Users holding a restrict scope on one of `ids` of `dimension`. */
  usersInZone(dimension: string, ids: string[]): Promise<string[]>
  facetPeople(opts: {
    roleIds: string[] | null
    userIds: string[] | null
    terms: string[]
    isAdmin: boolean
  }): Promise<PersonBase[]>
  roleNamesOf(userIds: string[]): Promise<Map<string, string>>
  zonesOf(userIds: string[]): Promise<Map<string, string[]>>
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** "planners" → "planner", "buyers" → "buyer", "boxes" → "box". */
export function singular(w: string): string {
  if (w.length > 4 && /(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Word runs of 1–3 words, longest first — candidate zone labels. */
export function phraseRuns(
  words: string[],
  max = 3
): Array<{ text: string; at: number; n: number }> {
  const out: Array<{ text: string; at: number; n: number }> = []
  for (let n = Math.min(max, words.length); n >= 1; n--) {
    for (let at = 0; at + n <= words.length; at++) {
      const text = words.slice(at, at + n).join(' ')
      // A lone short token ("3", "of") is never a zone on its own.
      if (n === 1 && text.length < 3) continue
      out.push({ text, at, n })
    }
  }
  return out
}

/** Which roles the words name: a role matches when one of its words is the
 *  singular of a typed word (≥3 letters). Returns the role ids and the word
 *  positions used. Exported for tests. */
export function matchRoles(
  words: string[],
  roles: Array<{ id: string; name: string }>
): { ids: string[]; used: Set<number> } {
  const used = new Set<number>()
  const ids: string[] = []
  words.forEach((w, i) => {
    if (w.length < 3 || /\d/.test(w)) return
    const s = singular(w)
    for (const r of roles) {
      const rw = norm(r.name).split(' ').map(singular)
      if (rw.includes(s) || norm(r.name) === w) {
        if (!ids.includes(r.id)) ids.push(r.id)
        used.add(i)
      }
    }
  })
  return { ids, used }
}

/** The facets in a people query: matched roles, zones and the leftover name
 *  words. null = the query names no role or zone (plain people search). */
export async function parsePeopleFacets(
  q: string,
  deps: Pick<PeopleDeps, 'roles' | 'zoneMatches'>
): Promise<{ roleIds: string[]; zones: ZoneMatch[]; terms: string[] } | null> {
  const words = norm(q).split(' ').filter(Boolean).slice(0, 8)
  if (words.length === 0) return null
  const runs = phraseRuns(words)
  const [roles, zoneHits] = await Promise.all([
    deps.roles().catch(() => []),
    deps.zoneMatches(runs.map((r) => r.text)).catch(() => [] as ZoneMatch[])
  ])
  const used = new Set<number>()
  // Zones first, longest run wins ("zone 3" over "zone").
  const zones: ZoneMatch[] = []
  for (const run of runs) {
    const hit = zoneHits.filter((z) => norm(z.label) === run.text)
    if (hit.length === 0) continue
    const span = Array.from({ length: run.n }, (_, k) => run.at + k)
    if (span.some((i) => used.has(i))) continue
    for (const i of span) used.add(i)
    zones.push(...hit)
  }
  const left = words.map((w, i) => (used.has(i) ? '' : w))
  const role = matchRoles(left, roles)
  for (const i of role.used) used.add(i)
  if (zones.length === 0 && role.ids.length === 0) return null
  const terms = words.filter((_, i) => !used.has(i) && !/^(in|of|at|for|the|and)$/.test(words[i]))
  return { roleIds: role.ids, zones, terms }
}

// ─── Default dependencies ───────────────────────────────────────────────────

const DIRECTORY_COLS = ['id', 'first_name', 'last_name', 'email', 'title', 'department']
const ADMIN_COLS = [...DIRECTORY_COLS, 'status', 'account_kind']
const NAME_COLS = ['first_name', 'last_name', 'email', 'title']

function escapeLike(v: string): string {
  return v.replace(/[\\%_[]/g, (m) => `\\${m}`)
}

/** The facet query, exported for tests: role/zone filter + name words, as the caller. */
export function facetPeopleQuery(
  knex: Knex,
  opts: { roleIds: string[] | null; userIds: string[] | null; terms: string[]; isAdmin: boolean },
  readable: readonly string[] | null = systemReadableColumns('nivaro_users')
): Knex.QueryBuilder | null {
  const allowed = new Set(readable ?? [])
  if (!opts.isAdmin && !allowed.has('id')) return null
  const may = (c: string) => opts.isAdmin || allowed.has(c)
  if (opts.userIds && opts.userIds.length === 0) return null
  if (opts.roleIds && opts.roleIds.length === 0) return null
  const qb = knex('nivaro_users')
    .select((opts.isAdmin ? ADMIN_COLS : DIRECTORY_COLS).filter(may))
    .limit(PEOPLE_EXTRA_CAP)
  if (opts.isAdmin) {
    qb.where('is_redacted', false)
      .whereRaw(`email not like 'legacy-%'`)
      .whereRaw(`email not like 'Redacted\\_%' escape '\\'`)
  } else {
    applyDirectoryListingRules(qb)
  }
  if (opts.roleIds) qb.whereIn('role', opts.roleIds)
  if (opts.userIds) qb.whereIn('id', opts.userIds.slice(0, MAX_ZONE_USERS))
  const searchable = NAME_COLS.filter(may)
  for (const term of opts.terms.slice(0, 4)) {
    if (searchable.length === 0) return null
    const like = `%${escapeLike(term)}%`
    qb.where((inner) => {
      for (const c of searchable) inner.orWhereRaw(`[${c}] LIKE ? ESCAPE '\\'`, [like])
    })
  }
  qb.orderBy([
    { column: 'last_name', order: 'asc' },
    { column: 'first_name', order: 'asc' }
  ])
  return qb
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

export const defaultPeopleDeps: PeopleDeps = {
  async roles() {
    return (await db('nivaro_roles').select('id', 'name')) as Array<{ id: string; name: string }>
  },
  async zoneMatches(phrases) {
    if (phrases.length === 0) return []
    const { listScopeDimensions } = await import('./user-scopes.js')
    const dims = await listScopeDimensions()
    const out: ZoneMatch[] = []
    await Promise.all(
      dims.slice(0, 6).map(async (d) => {
        const field = d.display_field ?? 'name'
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return
        try {
          // Case-insensitive collation: equality on the label.
          const rows = (await db(d.target_collection)
            .whereIn(field, phrases.slice(0, 40))
            .limit(20)
            .select('id', field)) as Array<Record<string, unknown>>
          for (const r of rows)
            out.push({ dimension: d.name, id: String(r.id), label: String(r[field] ?? '') })
        } catch {
          /* a renamed display column — that dimension sits out */
        }
      })
    )
    return out
  },
  async usersInZone(dimension, ids) {
    const want = new Set(ids.map((i) => i.toLowerCase()))
    const rows = (await db('nivaro_user_scopes')
      .where({ dimension, mode: 'restrict' })
      .limit(20000)
      .select('user', 'values')) as Array<{ user: string; values: unknown }>
    const out: string[] = []
    for (const r of rows) {
      let vals: unknown[] = []
      try {
        vals = typeof r.values === 'string' ? JSON.parse(r.values) : ((r.values as unknown[]) ?? [])
      } catch {
        vals = []
      }
      if (Array.isArray(vals) && vals.some((v) => want.has(String(v).toLowerCase())))
        out.push(String(r.user))
    }
    return out
  },
  async facetPeople(opts) {
    const qb = facetPeopleQuery(db as unknown as Knex, opts)
    return qb ? ((await qb) as PersonBase[]) : []
  },
  async roleNamesOf(userIds) {
    if (userIds.length === 0) return new Map()
    const rows = (await db('nivaro_users as u')
      .leftJoin('nivaro_roles as r', 'u.role', 'r.id')
      .whereIn('u.id', userIds)
      .select('u.id', 'r.name as role_name')) as Array<{ id: string; role_name: string | null }>
    return new Map(rows.filter((r) => r.role_name).map((r) => [r.id.toUpperCase(), r.role_name!]))
  },
  async zonesOf(userIds) {
    const out = new Map<string, string[]>()
    if (userIds.length === 0) return out
    const { listScopeDimensions, resolveScopeLabelsForUsers } = await import('./user-scopes.js')
    const dims = (await listScopeDimensions()).map((d) => d.name)
    if (dims.length === 0) return out
    const resolved = await resolveScopeLabelsForUsers(userIds, dims)
    for (const [uid, perDim] of resolved) {
      const labels = [...perDim.values()].flat()
      if (labels.length) out.set(uid.toUpperCase(), [...new Set(labels)].sort(byName))
    }
    return out
  }
}

/**
 * The people block for one search: hits for a role/zone query first, then the
 * main search's people (deduped), each with role_name / zones / title. Never
 * throws — on any failure the given people come back undecorated.
 */
export async function searchPeopleExtras(
  _user: User,
  q: string,
  people: PersonBase[],
  opts: { isAdmin: boolean; deps?: PeopleDeps }
): Promise<PersonWithExtras[]> {
  const deps = opts.deps ?? defaultPeopleDeps
  let list: PersonBase[] = [...people]
  try {
    const facets = await parsePeopleFacets(q, deps)
    if (facets) {
      let userIds: string[] | null = null
      for (const dim of new Set(facets.zones.map((z) => z.dimension))) {
        const ids = facets.zones.filter((z) => z.dimension === dim).map((z) => z.id)
        const holders = await deps.usersInZone(dim, ids)
        // Two zone facets on different dimensions: people in both.
        userIds = userIds
          ? userIds.filter((u) => holders.some((h) => h.toUpperCase() === u.toUpperCase()))
          : holders
      }
      const found = await deps.facetPeople({
        roleIds: facets.roleIds.length ? facets.roleIds : null,
        userIds,
        terms: facets.terms,
        isAdmin: opts.isAdmin
      })
      const seen = new Set(found.map((p) => String(p.id).toUpperCase()))
      list = [...found, ...people.filter((p) => !seen.has(String(p.id).toUpperCase()))]
    }
  } catch {
    list = [...people]
  }
  list = list.slice(0, PEOPLE_EXTRA_CAP)
  const ids = list.map((p) => String(p.id))
  const [roles, zones] = await Promise.all([
    deps.roleNamesOf(ids).catch(() => new Map<string, string>()),
    deps.zonesOf(ids).catch(() => new Map<string, string[]>())
  ])
  return list.map((p) => {
    const key = String(p.id).toUpperCase()
    const z = zones.get(key)
    return {
      ...p,
      title: p.title ?? null,
      role_name: roles.get(key) ?? null,
      ...(z?.length ? { zones: z } : {})
    }
  })
}
