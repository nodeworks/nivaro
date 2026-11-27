import {
  arr,
  asObj,
  diffFields,
  mkOp,
  type Obj,
  preconditionsOf,
  str,
  strs
} from '../entra/shared.js'
import {
  GraphCallError,
  graph,
  graphAll,
  graphGuid,
  graphSegment,
  isGuid,
  odataString
} from '../microsoft/graph.js'
import { typedName } from '../plan-words.js'
import type {
  DesiredResource,
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ProviderContext
} from '../types.js'
import { ProviderError } from '../types.js'
import { CHANNEL, MEMBERS, TEAMS_TYPES } from './specs.js'
import { listTeams, requireTeam } from './team.js'

/**
 * Teams channels and their members. A channel's provider id is `<team guid>:<channel id>` (a
 * channel id itself holds colons: `19:abc@thread.tacv2`), so every call names the team it
 * belongs to and a channel outside the connection's tenant is simply not found. Members exist
 * only on private channels; people are matched by email and an email Entra does not know stops
 * the change, listed, never guessed.
 */

const channelLabel = TEAMS_TYPES.find((t) => t.key === CHANNEL)?.label ?? CHANNEL
const membersLabel = TEAMS_TYPES.find((t) => t.key === MEMBERS)?.label ?? MEMBERS
const SELECT = 'id,displayName,description,membershipType,webUrl'
const TEAMS_PER_LIST_PAGE = 10
const EMAIL_RE = /^[^\s@<>()[\],;:"\\]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/i
const MEMBER_BIND = (id: string) => `https://graph.microsoft.com/v1.0/users('${id}')`

// ── Ids ──

export function joinChannel(team: string, channelId: string): string {
  return `${team.toLowerCase()}:${channelId}`
}

/** `<team guid>:<channel id>` → its two parts; null when it is not one. */
export function splitChannel(externalId: string): { team: string; channel: string } | null {
  if (typeof externalId !== 'string' || externalId.length < 38) return null
  if (externalId[36] !== ':' || !isGuid(externalId.slice(0, 36))) return null
  return { team: externalId.slice(0, 36).toLowerCase(), channel: externalId.slice(37) }
}

function channelIds(externalId: string): { team: string; channel: string } {
  const ids = splitChannel(externalId)
  if (!ids) throw new ProviderError('BAD_ID', 'That is not a Teams channel id.')
  graphSegment(ids.channel, 'channel id')
  return ids
}

const channelPath = (ids: { team: string; channel: string }): string =>
  `/teams/${graphGuid(ids.team, 'team id')}/channels/${graphSegment(ids.channel, 'channel id')}`

/** The channel a Hub resource points at, resolved by the engine; an unresolved ref is refused. */
function channelRef(desired: DesiredResource, field = 'channel'): string {
  const ref = desired.refs[field]
  if (typeof ref !== 'string' || !splitChannel(ref))
    throw new ProviderError('REF_UNRESOLVED', 'The channel this belongs to is not known yet.')
  return ref
}

function teamRef(desired: DesiredResource): string {
  const ref = desired.refs.team
  if (typeof ref !== 'string')
    throw new ProviderError('REF_UNRESOLVED', 'The team this belongs to is not known yet.')
  return graphGuid(ref, 'team id')
}

function bad(message: string): ProviderError {
  return new ProviderError('INVALID', message)
}

export function channelNameProblem(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) return 'A channel needs a name.'
  if (name.length > 50) return 'A channel name is at most 50 characters.'
  if (/[~#%&*{}+/\\:<>?|'"]/.test(name))
    return 'Teams refuses ~ # % & * { } + / \\ : < > ? | and quotes in a channel name.'
  return null
}

const lc = (v: string) => v.trim().toLowerCase()

// ── Channels ──

export function observedChannel(team: string, raw: Obj): Observed {
  const id = str(raw.id) ?? ''
  return {
    type: CHANNEL,
    externalId: joinChannel(team, id),
    name: str(raw.displayName),
    fields: {
      team: team.toLowerCase(),
      name: str(raw.displayName),
      description: str(raw.description),
      membership: str(raw.membershipType) ?? 'standard',
      web_url: str(raw.webUrl)
    },
    tags: {},
    url: str(raw.webUrl)
  }
}

export async function getChannel(ctx: ProviderContext, externalId: string): Promise<Obj | null> {
  const ids = channelIds(externalId)
  const res = await graph(ctx, 'GET', channelPath(ids), {
    query: { $select: SELECT },
    allow: [404]
  })
  return res.status === 404 ? null : asObj(res.body)
}

export async function observeChannel(
  ctx: ProviderContext,
  externalId: string
): Promise<Observed | null> {
  const ids = splitChannel(externalId)
  if (!ids) return null
  const raw = await getChannel(ctx, externalId)
  return raw ? observedChannel(ids.team, raw) : null
}

async function channelsOf(ctx: ProviderContext, team: string): Promise<Obj[]> {
  return graphAll(ctx, `/teams/${graphGuid(team, 'team id')}/channels`, {
    query: { $select: SELECT }
  })
}

export async function listChannels(
  ctx: ProviderContext,
  cursor?: string | null
): Promise<ListPage> {
  // Channels hang off teams: walk a page of teams at a time (the team list's own cursor).
  const teams = await listTeamsPage(ctx, cursor ?? null)
  const items: Observed[] = []
  for (const team of teams.ids) {
    try {
      for (const raw of await channelsOf(ctx, team)) items.push(observedChannel(team, raw))
    } catch (err) {
      // A team the app cannot read channels of (archived, no consent) is skipped, not fatal.
      if (!(err instanceof GraphCallError) || ![403, 404].includes(err.status ?? 0)) throw err
    }
  }
  return { items, cursor: teams.next }
}

async function listTeamsPage(
  ctx: ProviderContext,
  cursor: string | null
): Promise<{ ids: string[]; next: string | null }> {
  if (cursor === null) {
    const first = await listTeams(ctx, null)
    return {
      ids: first.items.slice(0, TEAMS_PER_LIST_PAGE).map((t) => t.externalId),
      next: first.cursor
    }
  }
  const page = await listTeams(ctx, cursor)
  return {
    ids: page.items.slice(0, TEAMS_PER_LIST_PAGE).map((t) => t.externalId),
    next: page.cursor
  }
}

export async function findChannel(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<Observed | null> {
  const ref = desired.refs.team
  const name = str(desired.fields.name)
  if (typeof ref !== 'string' || !isGuid(ref) || !name) return null
  const hit = (await channelsOf(ctx, ref)).find((c) => lc(str(c.displayName) ?? '') === lc(name))
  return hit ? observedChannel(ref, hit) : null
}

export function planChannel(
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        CHANNEL,
        null,
        'delete',
        observed.externalId,
        `Delete ${typedName(channelLabel, observed.name)}: Teams keeps a deleted channel for 30 days, then its messages and files are gone (restore it in Teams before that).`,
        { preconditions: { name: observed.fields.name } }
      )
    ]
  }
  const name = typedName(channelLabel, str(desired.fields.name) ?? observed?.name)
  if (!observed)
    return [
      mkOp(
        CHANNEL,
        desired,
        'create',
        null,
        `Create ${name}${desired.fields.membership === 'private' ? ' (private)' : ''}. A channel the Hub did not make is refused: adopt it instead.`,
        {
          changes: [
            { field: 'team', to: desired.refs.team ?? null },
            { field: 'name', to: desired.fields.name },
            { field: 'description', to: desired.fields.description ?? null },
            { field: 'membership', to: desired.fields.membership ?? 'standard' }
          ]
        }
      )
    ]
  const wantTeam = typeof desired.refs.team === 'string' ? desired.refs.team.toLowerCase() : null
  const wantMembership = str(desired.fields.membership)
  const typeChanged =
    (wantTeam !== null && wantTeam !== observed.fields.team) ||
    (wantMembership !== null && wantMembership !== observed.fields.membership)
  if (typeChanged)
    return [
      mkOp(
        CHANNEL,
        desired,
        'replace',
        observed.externalId,
        `Replace ${name}: a channel’s team and type cannot be changed, so it is deleted and made again (its messages go with the old one).`,
        {
          changes: [
            { field: 'team', from: observed.fields.team, to: wantTeam },
            { field: 'membership', from: observed.fields.membership, to: wantMembership }
          ],
          preconditions: { team: observed.fields.team, membership: observed.fields.membership }
        }
      )
    ]
  const changes = diffFields(['name', 'description'], desired, observed)
  if (!changes.length)
    return [mkOp(CHANNEL, desired, 'noop', observed.externalId, `${name} is up to date.`)]
  return [
    mkOp(CHANNEL, desired, 'update', observed.externalId, `Change ${name}.`, {
      changes,
      preconditions: preconditionsOf(changes, observed.fields)
    })
  ]
}

function okResult(observed: Observed | null, externalId: string, status: number): OpResult {
  return { ok: true, externalId, observed, answer: { status } }
}

/** One user by work email (mail or sign-in name): the id, or null when Entra has none / several. */
async function userIdByEmail(ctx: ProviderContext, email: string): Promise<string | null> {
  const e = odataString(lc(email))
  const res = await graph(ctx, 'GET', '/users', {
    query: {
      $select: 'id,mail,userPrincipalName',
      $filter: `mail eq ${e} or userPrincipalName eq ${e}`,
      $top: 3
    }
  })
  const hits = arr(asObj(res.body).value)
  const id = hits.length === 1 ? str(hits[0]?.id) : null
  return id && isGuid(id) ? id : null
}

export async function createChannel(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<OpResult> {
  const team = teamRef(desired)
  await requireTeam(ctx, team)
  const name = String(desired.fields.name ?? '').trim()
  const problem = channelNameProblem(name)
  if (problem) throw bad(problem)
  const membership = desired.fields.membership === 'private' ? 'private' : 'standard'
  if (desired.externalId) {
    // A resumed run: the channel is already there, bring it to the wanted values.
    const seen = await observeChannel(ctx, desired.externalId)
    if (seen) return updateChannel(ctx, desired.externalId, desired)
  }
  const existing = (await channelsOf(ctx, team)).find(
    (c) => lc(str(c.displayName) ?? '') === lc(name)
  )
  if (existing)
    throw new ProviderError(
      'ALREADY_EXISTS',
      `A channel named ${name} already exists in this team and was not created by the Hub. Adopt it instead of creating it.`,
      { status: 409 }
    )
  const body: Obj = {
    '@odata.type': '#Microsoft.Graph.channel',
    displayName: name,
    membershipType: membership
  }
  const description = str(desired.fields.description)
  if (description) body.description = description
  if (membership === 'private') {
    const email = str(desired.fields.owner_email)
    if (!email || !EMAIL_RE.test(email))
      throw bad('A private channel needs the work email of its owner.')
    const owner = await userIdByEmail(ctx, email)
    if (!owner)
      throw new ProviderError(
        'UNKNOWN_PEOPLE',
        `Entra does not know ${lc(email)}, so the private channel was not created.`
      )
    body.members = [
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': MEMBER_BIND(owner)
      }
    ]
  }
  const res = await graph(ctx, 'POST', `/teams/${graphGuid(team, 'team id')}/channels`, {
    body,
    allow: [202]
  })
  let raw = asObj(res.body)
  if (!str(raw.id)) {
    // Private channels may answer 202 with no body: find the new one by name.
    const found = (await channelsOf(ctx, team)).find(
      (c) => lc(str(c.displayName) ?? '') === lc(name)
    )
    if (!found) throw new ProviderError('PROVIDER_ERROR', 'Teams did not return the new channel.')
    raw = found
  }
  const observed = observedChannel(team, raw)
  return okResult(observed, observed.externalId, res.status)
}

export async function updateChannel(
  ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource
): Promise<OpResult> {
  const ids = channelIds(externalId)
  // The team is create-only: a desired team that is not this channel's is a different target.
  if (typeof desired.refs.team === 'string' && desired.refs.team.toLowerCase() !== ids.team)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'The channel is not in the team this resource names.'
    )
  const raw = await getChannel(ctx, externalId)
  if (!raw)
    throw new ProviderError('NOT_FOUND', 'The channel no longer exists in Teams.', { status: 404 })
  const observed = observedChannel(ids.team, raw)
  const changes = diffFields(['name', 'description'], desired, observed)
  if (!changes.length) return okResult(observed, externalId, 200)
  const patch: Obj = {}
  for (const c of changes) {
    if (c.field === 'name') {
      const problem = channelNameProblem(c.to)
      if (problem) throw bad(problem)
      patch.displayName = String(c.to).trim()
    }
    if (c.field === 'description') patch.description = typeof c.to === 'string' ? c.to : ''
  }
  await graph(ctx, 'PATCH', channelPath(ids), { body: patch })
  const after = await getChannel(ctx, externalId)
  return okResult(after ? observedChannel(ids.team, after) : null, externalId, 204)
}

export async function deleteChannel(ctx: ProviderContext, externalId: string): Promise<OpResult> {
  const ids = channelIds(externalId)
  const res = await graph(ctx, 'DELETE', channelPath(ids), { allow: [404] })
  return okResult(null, externalId, res.status)
}

// ── Channel members ──

export interface Member {
  id: string
  email: string
  owner: boolean
}

async function membersOf(ctx: ProviderContext, externalId: string): Promise<Member[]> {
  const ids = channelIds(externalId)
  const rows = await graphAll(ctx, `${channelPath(ids)}/members`)
  const out: Member[] = []
  for (const m of rows) {
    const email = str(m.email)
    const id = str(m.id)
    if (!id || !email) continue
    out.push({
      id,
      email: lc(email),
      owner: strs(m.roles).some((r) => r.toLowerCase() === 'owner')
    })
  }
  return out
}

function observedMembers(externalId: string, members: Member[], name: string | null): Observed {
  return {
    type: MEMBERS,
    externalId,
    name,
    fields: {
      channel: externalId,
      emails: members
        .filter((m) => !m.owner)
        .map((m) => m.email)
        .sort()
    },
    tags: {}
  }
}

export async function observeMembers(
  ctx: ProviderContext,
  externalId: string
): Promise<Observed | null> {
  if (!splitChannel(externalId)) return null
  const channel = await getChannel(ctx, externalId)
  if (!channel) return null
  return observedMembers(externalId, await membersOf(ctx, externalId), str(channel.displayName))
}

export async function listMembers(): Promise<ListPage> {
  // Membership is managed per channel, never discovered: there is nothing to adopt.
  return { items: [], cursor: null }
}

function wantedEmails(desired: DesiredResource): string[] {
  const out: string[] = []
  for (const e of strs(desired.fields.emails)) {
    const v = lc(e)
    if (!EMAIL_RE.test(v)) throw bad(`${e} is not an email address.`)
    if (!out.includes(v)) out.push(v)
  }
  return out
}

export function planMembers(
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        MEMBERS,
        null,
        'delete',
        observed.externalId,
        `Stop managing the members of ${typedName(membersLabel, observed.name)}: people stay in the channel (delete the channel to remove them).`,
        { preconditions: { emails: observed.fields.emails } }
      )
    ]
  }
  const name = typedName(membersLabel, str(desired.fields.name) ?? observed?.name)
  const want = strs(desired.fields.emails)
    .map(lc)
    .filter((e, i, a) => a.indexOf(e) === i)
    .sort()
  if (!observed)
    return [
      mkOp(
        MEMBERS,
        desired,
        'create',
        null,
        `Add the people of ${name} to the private channel (never removes anyone).`,
        { changes: [{ field: 'emails', to: want }] }
      )
    ]
  const have = strs(observed.fields.emails).map(lc).sort()
  if (JSON.stringify(want) === JSON.stringify(have))
    return [mkOp(MEMBERS, desired, 'noop', observed.externalId, `${name} is up to date.`)]
  const gone = have.filter((e) => !want.includes(e))
  return [
    mkOp(
      MEMBERS,
      desired,
      'update',
      observed.externalId,
      gone.length
        ? `Change ${name}: ${gone.length} ${gone.length === 1 ? 'person leaves' : 'people leave'} the channel.`
        : `Change ${name}.`,
      {
        changes: [{ field: 'emails', from: have, to: want }],
        preconditions: { emails: have }
      }
    )
  ]
}

/** Adds (and for an update, removes) members so the channel's managed set equals the wanted one. */
async function syncMembers(
  ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource,
  removeOthers: boolean
): Promise<OpResult> {
  const ids = channelIds(externalId)
  const channel = await getChannel(ctx, externalId)
  if (!channel)
    throw new ProviderError('NOT_FOUND', 'The channel no longer exists in Teams.', { status: 404 })
  if (str(channel.membershipType) !== 'private')
    throw bad('Only a private channel has members of its own; a standard channel uses the team’s.')
  const want = wantedEmails(desired)
  const members = await membersOf(ctx, externalId)
  const present = new Set(members.map((m) => m.email))
  const toAdd = want.filter((e) => !present.has(e))
  const toRemove = removeOthers ? members.filter((m) => !m.owner && !want.includes(m.email)) : []
  // Everyone is looked up before the first write: one unknown email stops the whole change.
  const resolved = new Map<string, string>()
  const unknown: string[] = []
  for (const email of toAdd) {
    const id = await userIdByEmail(ctx, email)
    if (id) resolved.set(email, id)
    else unknown.push(email)
  }
  if (unknown.length)
    throw new ProviderError(
      'UNKNOWN_PEOPLE',
      `Entra does not know ${unknown.join(', ')}. Nothing was changed; the Hub never guesses a person.`
    )
  for (const [, userId] of resolved)
    await graph(ctx, 'POST', `${channelPath(ids)}/members`, {
      body: {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: [],
        'user@odata.bind': MEMBER_BIND(userId)
      }
    })
  for (const m of toRemove)
    await graph(ctx, 'DELETE', `${channelPath(ids)}/members/${graphSegment(m.id, 'member id')}`, {
      allow: [404]
    })
  const after = await membersOf(ctx, externalId)
  return {
    ok: true,
    externalId,
    observed: observedMembers(externalId, after, str(channel.displayName)),
    answer: { added: toAdd.length, removed: toRemove.length }
  }
}

export async function createMembers(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<OpResult> {
  return syncMembers(ctx, channelRef(desired), desired, false)
}

export async function updateMembers(
  ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource
): Promise<OpResult> {
  const ref = desired.refs.channel
  if (typeof ref === 'string' && ref !== externalId)
    throw new ProviderError('TARGET_MISMATCH', 'These members are not of the channel this names.')
  return syncMembers(ctx, externalId, desired, true)
}

export async function deleteMembers(_ctx: ProviderContext, externalId: string): Promise<OpResult> {
  // A release: the Hub stops managing the list; nobody is removed from the channel.
  return okResult(null, externalId, 204)
}
