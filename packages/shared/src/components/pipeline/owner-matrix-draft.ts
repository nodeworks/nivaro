import type {
  OwnerTeam,
  PipelineOwnerGroup,
  PipelineOwnerGroupsMap,
  PipelineOwnerGroupUser,
  RecordFilter
} from './types'

/**
 * The Owner Matrix draft: a copy of the saved groups map that cell edits
 * change locally (nothing is written) until Save. The record trial sends the
 * DELTA (draftDelta) to POST /pipelines/:id/owner-preview, which lays it over
 * the saved groups and runs the real owner resolver; Save replays the same
 * delta through the normal owner-group routes (draftSaveOps).
 *
 * Draft-only groups carry an id starting `draft:`; draft-only member links a
 * negative link_id.
 */

export const DRAFT_ID_PREFIX = 'draft:'
export const isDraftGroupId = (id: string) => id.startsWith(DRAFT_ID_PREFIX)

let seq = 0
const nextDraftId = () => `${DRAFT_ID_PREFIX}${Date.now().toString(36)}${(++seq).toString(36)}`
const nextLinkId = () => -(Date.now() % 1_000_000_000) - ++seq

export function cloneGroupsMap(map: PipelineOwnerGroupsMap | undefined): PipelineOwnerGroupsMap {
  const out: PipelineOwnerGroupsMap = {}
  for (const [state, groups] of Object.entries(map ?? {})) {
    out[state] = groups.map((g) => ({
      ...g,
      filters: g.filters ? g.filters.map((f) => ({ ...f })) : g.filters,
      users: [...(g.users ?? [])],
      teams: [...(g.teams ?? [])]
    }))
  }
  return out
}

function newGroup(stateId: string, filters: RecordFilter[]): PipelineOwnerGroup {
  return {
    id: nextDraftId(),
    template: '',
    state: stateId,
    name: null,
    filters,
    sort: 0,
    is_default: false,
    priority: 0,
    max_wip: null,
    users: [],
    teams: []
  }
}

function mapGroup(
  map: PipelineOwnerGroupsMap,
  groupId: string,
  fn: (g: PipelineOwnerGroup) => PipelineOwnerGroup
): PipelineOwnerGroupsMap {
  const out: PipelineOwnerGroupsMap = {}
  for (const [state, groups] of Object.entries(map)) {
    out[state] = groups.map((g) => (g.id === groupId ? fn(g) : g))
  }
  return out
}

/** The cell's own group, or a new draft group with the cell's filters. */
function ensureGroup(
  map: PipelineOwnerGroupsMap,
  stateId: string,
  groupId: string | null,
  filters: RecordFilter[]
): { map: PipelineOwnerGroupsMap; groupId: string } {
  if (groupId && Object.values(map).some((gs) => gs.some((g) => g.id === groupId)))
    return { map, groupId }
  const g = newGroup(stateId, filters)
  return { map: { ...map, [stateId]: [...(map[stateId] ?? []), g] }, groupId: g.id }
}

export interface DraftPerson {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

export function draftAddUser(
  map: PipelineOwnerGroupsMap,
  a: { stateId: string; groupId: string | null; filters: RecordFilter[]; user: DraftPerson }
): PipelineOwnerGroupsMap {
  const { map: m, groupId } = ensureGroup(map, a.stateId, a.groupId, a.filters)
  return mapGroup(m, groupId, (g) =>
    g.users.some((u) => String(u.user).toUpperCase() === String(a.user.id).toUpperCase())
      ? g
      : {
          ...g,
          users: [
            ...g.users,
            {
              id: nextLinkId(),
              link_id: nextLinkId(),
              group: groupId,
              user: a.user.id,
              first_name: a.user.first_name,
              last_name: a.user.last_name,
              email: a.user.email
            } satisfies PipelineOwnerGroupUser
          ]
        }
  )
}

export function draftRemoveUser(
  map: PipelineOwnerGroupsMap,
  linkId: number
): PipelineOwnerGroupsMap {
  const out: PipelineOwnerGroupsMap = {}
  for (const [state, groups] of Object.entries(map)) {
    out[state] = groups.map((g) =>
      g.users.some((u) => u.link_id === linkId)
        ? { ...g, users: g.users.filter((u) => u.link_id !== linkId) }
        : g
    )
  }
  return out
}

export function draftAddTeam(
  map: PipelineOwnerGroupsMap,
  a: {
    stateId: string
    groupId: string | null
    filters: RecordFilter[]
    team: { id: number; name: string; slug?: string; member_count: number }
  }
): PipelineOwnerGroupsMap {
  const { map: m, groupId } = ensureGroup(map, a.stateId, a.groupId, a.filters)
  return mapGroup(m, groupId, (g) =>
    (g.teams ?? []).some((t) => t.id === a.team.id)
      ? g
      : {
          ...g,
          teams: [
            ...(g.teams ?? []),
            {
              link_id: nextLinkId(),
              id: a.team.id,
              name: a.team.name,
              slug: a.team.slug ?? '',
              member_count: a.team.member_count
            } satisfies OwnerTeam
          ]
        }
  )
}

export function draftRemoveTeam(
  map: PipelineOwnerGroupsMap,
  groupId: string,
  teamId: number
): PipelineOwnerGroupsMap {
  return mapGroup(map, groupId, (g) => ({
    ...g,
    teams: (g.teams ?? []).filter((t) => t.id !== teamId)
  }))
}

export function draftCreateGroup(
  map: PipelineOwnerGroupsMap,
  stateId: string,
  filters: RecordFilter[]
): PipelineOwnerGroupsMap {
  return ensureGroup(map, stateId, null, filters).map
}

export function draftPatchGroup(
  map: PipelineOwnerGroupsMap,
  groupId: string,
  patch: { priority?: number; max_wip?: number | null }
): PipelineOwnerGroupsMap {
  return mapGroup(map, groupId, (g) => ({ ...g, ...patch }))
}

/** One changed, new or removed group, as POST /pipelines/:id/owner-preview takes it. */
export interface DraftGroupDelta {
  id: string
  state: string
  name: string | null
  filters: RecordFilter[] | null
  is_default: boolean
  priority: number
  users: string[]
  teams: number[]
  removed?: boolean
}

const userKey = (g: PipelineOwnerGroup) =>
  g.users
    .map((u) => String(u.user).toUpperCase())
    .sort()
    .join(',')
const teamKey = (g: PipelineOwnerGroup) =>
  (g.teams ?? [])
    .map((t) => t.id)
    .sort((a, b) => a - b)
    .join(',')

function flatten(map: PipelineOwnerGroupsMap): Map<string, PipelineOwnerGroup> {
  const out = new Map<string, PipelineOwnerGroup>()
  for (const groups of Object.values(map)) for (const g of groups) out.set(g.id, g)
  return out
}

const toDelta = (g: PipelineOwnerGroup, removed = false): DraftGroupDelta => ({
  id: g.id,
  state: g.state,
  name: g.name ?? null,
  filters: g.filters ?? null,
  is_default: !!g.is_default,
  priority: Number(g.priority ?? 0) || 0,
  users: g.users.map((u) => String(u.user)),
  teams: (g.teams ?? []).map((t) => t.id),
  ...(removed ? { removed: true } : {})
})

/** The groups the draft changes (members, teams, priority), adds or removes. */
export function draftDelta(
  saved: PipelineOwnerGroupsMap | undefined,
  draft: PipelineOwnerGroupsMap | null
): DraftGroupDelta[] {
  if (!draft) return []
  const before = flatten(saved ?? {})
  const after = flatten(draft)
  const out: DraftGroupDelta[] = []
  for (const [id, g] of after) {
    const s = before.get(id)
    if (!s) {
      out.push(toDelta(g))
      continue
    }
    if (
      userKey(s) !== userKey(g) ||
      teamKey(s) !== teamKey(g) ||
      Number(s.priority ?? 0) !== Number(g.priority ?? 0) ||
      (s.max_wip ?? null) !== (g.max_wip ?? null)
    )
      out.push(toDelta(g))
  }
  for (const [id, s] of before) if (!after.has(id)) out.push(toDelta(s, true))
  return out
}

/** A request Save sends, in order. `group` may name a draft id the create step returns. */
export type DraftSaveOp =
  | {
      kind: 'create'
      draftId: string
      stateId: string
      filters: RecordFilter[] | null
      priority: number
    }
  | { kind: 'patch'; group: string; body: { priority?: number; max_wip?: number | null } }
  | { kind: 'add-user'; group: string; user: string }
  | { kind: 'remove-user'; linkId: number }
  | { kind: 'add-team'; group: string; team: number }
  | { kind: 'remove-team'; group: string; team: number }

/** The writes that turn the saved matrix into the draft, through the normal routes. */
export function draftSaveOps(
  saved: PipelineOwnerGroupsMap | undefined,
  draft: PipelineOwnerGroupsMap | null
): DraftSaveOp[] {
  if (!draft) return []
  const before = flatten(saved ?? {})
  const ops: DraftSaveOp[] = []
  for (const [id, g] of flatten(draft)) {
    const s = before.get(id)
    if (!s) {
      // Written even when empty (an override cell): the preview counted it too.
      ops.push({
        kind: 'create',
        draftId: id,
        stateId: g.state,
        filters: g.filters ?? null,
        priority: Number(g.priority ?? 0) || 0
      })
      if (g.max_wip != null) ops.push({ kind: 'patch', group: id, body: { max_wip: g.max_wip } })
      for (const u of g.users) ops.push({ kind: 'add-user', group: id, user: String(u.user) })
      for (const t of g.teams ?? []) ops.push({ kind: 'add-team', group: id, team: t.id })
      continue
    }
    const body: { priority?: number; max_wip?: number | null } = {}
    if (Number(s.priority ?? 0) !== Number(g.priority ?? 0)) body.priority = Number(g.priority ?? 0)
    if ((s.max_wip ?? null) !== (g.max_wip ?? null)) body.max_wip = g.max_wip ?? null
    if (Object.keys(body).length > 0) ops.push({ kind: 'patch', group: id, body })
    const savedUsers = new Set(s.users.map((u) => String(u.user).toUpperCase()))
    const draftUsers = new Set(g.users.map((u) => String(u.user).toUpperCase()))
    for (const u of s.users)
      if (!draftUsers.has(String(u.user).toUpperCase()))
        ops.push({ kind: 'remove-user', linkId: u.link_id })
    for (const u of g.users)
      if (!savedUsers.has(String(u.user).toUpperCase()))
        ops.push({ kind: 'add-user', group: id, user: String(u.user) })
    const savedTeams = new Set((s.teams ?? []).map((t) => t.id))
    const draftTeams = new Set((g.teams ?? []).map((t) => t.id))
    for (const t of s.teams ?? [])
      if (!draftTeams.has(t.id)) ops.push({ kind: 'remove-team', group: id, team: t.id })
    for (const t of g.teams ?? [])
      if (!savedTeams.has(t.id)) ops.push({ kind: 'add-team', group: id, team: t.id })
  }
  return ops
}
