import { asObj, mkOp, type Obj, str } from '../entra/shared.js'
import { graph, graphGuid, graphPage, isGuid } from '../microsoft/graph.js'
import { typedName } from '../plan-words.js'
import type { DesiredResource, ListPage, Observed, PlannedOp, ProviderContext } from '../types.js'
import { ProviderError } from '../types.js'
import { TEAM, TEAMS_TYPES } from './specs.js'

/**
 * Teams teams: read and adopt only (shared). The Hub never creates, changes or deletes a team;
 * channels, members and tabs are children of an adopted one. Ids are Entra group ids (GUIDs).
 */

const label = TEAMS_TYPES.find((t) => t.key === TEAM)?.label ?? TEAM
const GROUP_SELECT = 'id,displayName,description,visibility'
const PAGE = 50

export function observedTeam(raw: Obj): Observed {
  const archived = raw.isArchived === true
  return {
    type: TEAM,
    externalId: str(raw.id) ?? '',
    name: str(raw.displayName),
    fields: {
      name: str(raw.displayName),
      description: str(raw.description),
      visibility: str(raw.visibility),
      archived
    },
    tags: {},
    status: archived ? 'archived' : 'active',
    url: str(raw.webUrl)
  }
}

export async function getTeam(ctx: ProviderContext, id: string): Promise<Obj | null> {
  if (!isGuid(id)) return null
  const res = await graph(ctx, 'GET', `/teams/${graphGuid(id, 'team id')}`, { allow: [404] })
  return res.status === 404 ? null : asObj(res.body)
}

/** The team a channel or tab sits in must exist: its absence is the child's absence. */
export async function requireTeam(ctx: ProviderContext, id: string): Promise<Obj> {
  const team = await getTeam(ctx, id)
  if (!team)
    throw new ProviderError('NOT_FOUND', 'The team no longer exists in Teams.', { status: 404 })
  return team
}

export async function observeTeam(ctx: ProviderContext, externalId: string) {
  const raw = await getTeam(ctx, externalId)
  return raw ? observedTeam(raw) : null
}

export async function listTeams(ctx: ProviderContext, cursor?: string | null): Promise<ListPage> {
  const page = await graphPage(ctx, '/groups', {
    query: {
      $select: GROUP_SELECT,
      $filter: "resourceProvisioningOptions/Any(x:x eq 'Team')",
      $top: PAGE
    },
    from: cursor ?? null
  })
  return { items: page.items.map(observedTeam), cursor: page.next }
}

export function planTeam(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  // Teams are read and adopted, never created, changed or deleted by the Hub.
  if (desired && observed)
    return [
      mkOp(
        TEAM,
        desired,
        'noop',
        observed.externalId,
        `${typedName(label, observed.name)} is read-only for the Hub.`
      )
    ]
  return []
}
