import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { announcePrefsChanged } from '../user-sync.js'
import {
  pinKey,
  pinnable,
  shortId,
  TEAM_LISTS_OWNED_MAX,
  TEAM_MEMBERS_MAX,
  TEAM_REFS_MAX,
  type TeamList,
  type TeamPin,
  WATCH_PINS_MAX,
  type WatchListPrefs,
  type WatchPin
} from './store.js'
import { loadWatchList, updateWatchList, WATCH_KEY } from './user-store.js'

/**
 * Shared watch lists for a team (rt6 #1). A list lives on its OWNER's row
 * (`preferences.watch_list.teams`); each member's row holds a reference (`team_refs`), so a
 * member's dock finds their lists with one read per owner and no table, no migration.
 *
 *   - anyone may make a list for a team they are on (they are a member of it); an administrator
 *     or a manager (someone with direct reports) may make one without being on it
 *   - the owner and administrators rename it, change its people, delete it
 *   - members add and remove records and may leave; each person only ever sees the rows they may
 *     read (rows.ts reads every list as the viewer)
 *
 * A change tells every member's tabs (`prefs:changed`), so the tab appears, disappears or
 * refreshes in place.
 */

export const teamOwnerOf = (teamId: string): string => teamId.split('~')[0] ?? ''

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

export function isMember(team: TeamList, userId: string): boolean {
  return team.members.some((m) => sameId(m.u, userId))
}

export function mayManage(team: TeamList, userId: string, isAdmin: boolean): boolean {
  return isAdmin || sameId(team.owner, userId)
}

/** Who may see a list at all: its people, its owner, administrators. */
export function maySee(team: TeamList, userId: string, isAdmin: boolean): boolean {
  return isAdmin || sameId(team.owner, userId) || isMember(team, userId)
}

/** Clean a requested name. */
export function teamName(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 60) : ''
  return s || null
}

/** The members a request names, cleaned and capped (dupes and junk dropped). Pure. */
export function memberIds(raw: unknown): string[] {
  const out: string[] = []
  for (const v of Array.isArray(raw) ? raw : []) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(v)) continue
    if (out.some((x) => sameId(x, v))) continue
    out.push(v)
    if (out.length >= TEAM_MEMBERS_MAX) break
  }
  return out
}

/** A new list. Pure; `creatorMayStayOff` = admin or manager. */
export function newTeam(args: {
  owner: string
  name: string
  members: string[]
  creatorMayStayOff: boolean
  now: Date
}): TeamList {
  const at = args.now.toISOString()
  const ids = [...args.members]
  if (!args.creatorMayStayOff && !ids.some((m) => sameId(m, args.owner))) ids.unshift(args.owner)
  return {
    id: `${args.owner}~${shortId(8)}`,
    name: args.name,
    owner: args.owner,
    members: ids.slice(0, TEAM_MEMBERS_MAX).map((u) => ({ u, at })),
    pins: [],
    at
  }
}

/** New people get `now` as their join time; people who stay keep theirs. Pure. */
export function withMembers(team: TeamList, ids: string[], now: Date): TeamList {
  const at = now.toISOString()
  return {
    ...team,
    members: ids.slice(0, TEAM_MEMBERS_MAX).map((u) => {
      const kept = team.members.find((m) => sameId(m.u, u))
      return kept ?? { u, at }
    })
  }
}

export function teamAddPin(
  team: TeamList,
  c: string,
  id: string,
  by: string,
  now: Date
): { ok: true; team: TeamList; changed: boolean } | { ok: false; code: string; message: string } {
  if (!pinnable(c, id))
    return { ok: false, code: 'NOT_PINNABLE', message: 'This record cannot be watched' }
  const k = pinKey(c, id)
  if (team.pins.some((p) => pinKey(p.c, p.id) === k)) return { ok: true, team, changed: false }
  if (team.pins.length >= WATCH_PINS_MAX)
    return {
      ok: false,
      code: 'WATCH_LIST_FULL',
      message: `A shared list holds ${WATCH_PINS_MAX} records. Remove one to add another.`
    }
  const pin: TeamPin = { c, id, at: now.toISOString(), by }
  return { ok: true, changed: true, team: { ...team, pins: [pin, ...team.pins] } }
}

export function teamRemovePin(team: TeamList, c: string, id: string): TeamList {
  const k = pinKey(c, id)
  return { ...team, pins: team.pins.filter((p) => pinKey(p.c, p.id) !== k) }
}

/**
 * The list as a watch list the rows reader understands, for ONE viewer: a record counts as
 * "pinned" for them from when it was added or when they joined, whichever is later, and their
 * own seen marks for this list apply. Pure.
 */
export function teamAsWatchList(
  team: TeamList,
  viewerId: string,
  viewer: WatchListPrefs
): WatchListPrefs {
  const joined = team.members.find((m) => sameId(m.u, viewerId))?.at ?? team.at
  const pins: WatchPin[] = team.pins.map((p) => ({
    c: p.c,
    id: p.id,
    at: p.at > joined ? p.at : joined
  }))
  const seen: Record<string, string> = {}
  for (const p of team.pins) {
    const s = viewer.team_seen[`${team.id}|${pinKey(p.c, p.id)}`]
    if (s) seen[pinKey(p.c, p.id)] = s
  }
  return { ...viewer, pins, seen, alerts: [] }
}

/** Mark records on a list seen for the viewer (no keys = every record on it). Pure. */
export function markTeamSeen(
  viewer: WatchListPrefs,
  team: TeamList,
  keys: string[] | null,
  at: Date
): WatchListPrefs {
  const stamp = at.toISOString()
  const wanted = new Set(keys ?? team.pins.map((p) => pinKey(p.c, p.id)))
  const next = { ...viewer.team_seen }
  for (const p of team.pins) {
    const k = pinKey(p.c, p.id)
    if (wanted.has(k)) next[`${team.id}|${k}`] = stamp
  }
  return { ...viewer, team_seen: next }
}

// ── Storage ─────────────────────────────────────────────────────────────────────

/** One list, read from its owner's row. */
export async function loadTeam(teamId: string): Promise<TeamList | null> {
  const owner = teamOwnerOf(teamId)
  if (!owner) return null
  const { list } = await loadWatchList(owner).catch(() => ({ list: null }))
  return list?.teams.find((t) => t.id === teamId) ?? null
}

/** Write a list back to its owner's row (null = delete it). */
async function storeTeam(teamId: string, team: TeamList | null): Promise<void> {
  await updateWatchList(
    teamOwnerOf(teamId),
    (l) => ({
      ...l,
      teams: team
        ? l.teams.some((t) => t.id === teamId)
          ? l.teams.map((t) => (t.id === teamId ? team : t))
          : [...l.teams, team]
        : l.teams.filter((t) => t.id !== teamId)
    }),
    { announce: false }
  )
}

/** Tell everyone on (or just taken off) a list that it changed. */
function announceTeam(ids: Iterable<string>): void {
  const seen = new Set<string>()
  for (const id of ids) {
    const k = id.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    try {
      announcePrefsChanged(id, [WATCH_KEY])
    } catch {
      /* a tab that misses it reads the list on its next open */
    }
  }
}

/** Save a list and keep every member's reference in step with it. */
export async function saveTeam(before: TeamList | null, after: TeamList | null): Promise<void> {
  const id = (after ?? before)?.id
  if (!id) return
  await storeTeam(id, after)
  const was = new Set((before?.members ?? []).map((m) => m.u.toLowerCase()))
  const now = new Set((after?.members ?? []).map((m) => m.u.toLowerCase()))
  const added = (after?.members ?? []).filter((m) => !was.has(m.u.toLowerCase())).map((m) => m.u)
  const removed = (before?.members ?? []).filter((m) => !now.has(m.u.toLowerCase())).map((m) => m.u)
  const owner = teamOwnerOf(id)
  for (const u of added) {
    if (sameId(u, owner)) continue
    await updateWatchList(
      u,
      (l) =>
        l.team_refs.includes(id) || l.team_refs.length >= TEAM_REFS_MAX
          ? null
          : { ...l, team_refs: [...l.team_refs, id] },
      { announce: false }
    ).catch(() => null)
  }
  for (const u of removed) {
    if (sameId(u, owner)) continue
    await updateWatchList(
      u,
      (l) => {
        if (!l.team_refs.includes(id)) return null
        const team_seen = Object.fromEntries(
          Object.entries(l.team_seen).filter(([k]) => !k.startsWith(`${id}|`))
        )
        const tab = l.dock.tab === `team:${id}` ? 'watching' : l.dock.tab
        return {
          ...l,
          team_refs: l.team_refs.filter((r) => r !== id),
          team_seen,
          dock: { ...l.dock, tab }
        }
      },
      { announce: false }
    ).catch(() => null)
  }
  announceTeam([
    owner,
    ...(after?.members ?? []).map((m) => m.u),
    ...(before?.members ?? []).map((m) => m.u)
  ])
}

/** Create a list owned by `owner`; refuses past the owner's cap. */
export async function createTeam(team: TeamList): Promise<{ ok: boolean; message?: string }> {
  const { list } = await loadWatchList(team.owner)
  if (list.teams.length >= TEAM_LISTS_OWNED_MAX)
    return {
      ok: false,
      message: `You can keep ${TEAM_LISTS_OWNED_MAX} shared lists. Delete one to make another.`
    }
  await saveTeam(null, team)
  return { ok: true }
}

/** Every list a person sees: the ones they own and the ones they were added to. */
export async function teamsFor(userId: string, own: WatchListPrefs): Promise<TeamList[]> {
  const out = [...own.teams]
  const byOwner = new Map<string, string[]>()
  for (const ref of own.team_refs) {
    if (out.some((t) => t.id === ref)) continue
    const o = teamOwnerOf(ref)
    const arr = byOwner.get(o)
    if (arr) arr.push(ref)
    else byOwner.set(o, [ref])
  }
  for (const [owner, refs] of byOwner) {
    const { list } = await loadWatchList(owner).catch(() => ({ list: null }))
    for (const ref of refs) {
      const t = list?.teams.find((x) => x.id === ref)
      // Taken off meanwhile (or the list is gone): not theirs to see.
      if (t && isMember(t, userId)) out.push(t)
    }
  }
  return out
}

/** Which of these ids are people who may be on a list: active, not machine accounts. */
export async function listablePeople(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = (await db('nivaro_users')
    .whereIn('id', ids)
    .select('id', 'status', 'account_kind', 'is_redacted')
    .catch(() => [])) as Array<{
    id: string
    status: string | null
    account_kind?: string | null
    is_redacted?: unknown
  }>
  const ok = new Set(
    rows
      // A machine or placeholder account is not a person and never joins a list.
      .filter((r) => (!r.status || r.status === 'active') && !r.is_redacted && !r.account_kind)
      .map((r) => String(r.id).toLowerCase())
  )
  return ids.filter((i) => ok.has(i.toLowerCase()))
}

/** A person's active direct reports (a manager may add their team in one go). */
export async function directReports(userId: string): Promise<string[]> {
  const rows = (await db('nivaro_users')
    .where({ manager_id: userId })
    .limit(TEAM_MEMBERS_MAX)
    .select('id', 'status')
    .catch(() => [])) as Array<{ id: string; status: string | null }>
  return rows.filter((r) => !r.status || r.status === 'active').map((r) => String(r.id))
}

// ── Owner gone (suspended, redacted, a machine account, or no longer there) ─────────────

export interface PersonInfo {
  name: string
  /** Cannot sign in any more: suspended, redacted, a machine account or gone. */
  gone: boolean
}

/** Names + "gone" for the people named on lists. A missing row reads as gone. */
export async function peopleInfo(ids: string[]): Promise<Record<string, PersonInfo>> {
  const out: Record<string, PersonInfo> = {}
  const uniq = [...new Set(ids.map((i) => i.toLowerCase()))]
  if (uniq.length === 0) return out
  for (const id of uniq) out[id] = { name: 'Someone', gone: true }
  const rows = (await db('nivaro_users')
    .whereIn('id', uniq.slice(0, 500))
    .select('id', 'first_name', 'last_name', 'email', 'is_redacted', 'status', 'account_kind')
    .catch(() => [])) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    is_redacted: unknown
    status: string | null
    account_kind?: string | null
  }>
  for (const r of rows)
    out[String(r.id).toLowerCase()] = {
      name: r.is_redacted
        ? 'Former user'
        : `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email || 'Someone',
      gone: !!r.is_redacted || (!!r.status && r.status !== 'active') || !!r.account_kind
    }
  return out
}

export async function ownerGone(team: TeamList): Promise<boolean> {
  const info = await peopleInfo([team.owner]).catch(() => ({}) as Record<string, PersonInfo>)
  return info[team.owner.toLowerCase()]?.gone ?? true
}

/** The same list, now owned by `newOwner` (a new id: the id names its owner). Pure. */
export function takenOver(team: TeamList, newOwner: string): TeamList {
  return { ...team, id: `${newOwner}~${shortId(8)}`, owner: newOwner }
}

/** A member's list after a move: reference, seen marks and open tab follow the new id. Pure. */
export function followMove(l: WatchListPrefs, fromId: string, toId: string): WatchListPrefs {
  const refs = l.team_refs.filter((r) => r !== fromId)
  if (!refs.includes(toId) && refs.length < TEAM_REFS_MAX) refs.push(toId)
  const team_seen = Object.fromEntries(
    Object.entries(l.team_seen).map(([k, v]) =>
      k.startsWith(`${fromId}|`) ? [`${toId}|${k.slice(fromId.length + 1)}`, v] : [k, v]
    )
  )
  const tab = l.dock.tab === `team:${fromId}` ? (`team:${toId}` as const) : l.dock.tab
  return { ...l, team_refs: refs, team_seen, dock: { ...l.dock, tab } }
}

/**
 * Move a list to its new owner's row: write it there, take it off the old owner's row, and
 * point every member's reference (and their seen marks and open tab) at the new id.
 */
export async function moveTeam(before: TeamList, after: TeamList): Promise<void> {
  await storeTeam(after.id, after)
  await storeTeam(before.id, null)
  for (const m of after.members) {
    if (sameId(m.u, after.owner)) continue
    await updateWatchList(m.u, (l) => followMove(l, before.id, after.id), {
      announce: false
    }).catch(() => null)
  }
  announceTeam([before.owner, after.owner, ...after.members.map((m) => m.u)])
}

/** The records on a list this viewer may open (every gate), in list order. */
export async function readablePins(
  team: TeamList,
  user: User,
  isAdmin: boolean
): Promise<TeamPin[]> {
  if (team.pins.length === 0) return []
  const byCollection = new Map<string, string[]>()
  for (const p of team.pins) {
    const arr = byCollection.get(p.c)
    if (arr) arr.push(p.id)
    else byCollection.set(p.c, [p.id])
  }
  const ok = new Set<string>()
  const { compileAccessGates, visibleIds } = await import('../record-access.js')
  for (const [c, ids] of byCollection) {
    try {
      const gates = await compileAccessGates(user, c, { actingAdmin: isAdmin })
      for (const id of await visibleIds(gates, ids)) ok.add(pinKey(c, String(id)))
    } catch {
      /* no read access to that collection: none of its records */
    }
  }
  return team.pins.filter((p) => ok.has(pinKey(p.c, p.id)))
}
