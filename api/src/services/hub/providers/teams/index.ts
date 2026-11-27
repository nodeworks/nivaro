import {
  GRAPH_CONNECTION_FIELDS,
  GRAPH_HOSTS,
  graphConnectionProblems,
  graphToken,
  mintGraphToken,
  tenantOf,
  tenantProblem,
  tokenClaims,
  tokenRoles
} from '../microsoft/graph.js'
import type {
  ConnectionTest,
  DesiredResource,
  HealthAnswer,
  Observed,
  OpResult,
  ProviderAdapter,
  ProviderContext
} from '../types.js'
import { ProviderError } from '../types.js'
import { botReady } from './bot.js'
import {
  createChannel,
  createMembers,
  deleteChannel,
  deleteMembers,
  findChannel,
  listChannels,
  listMembers,
  observeChannel,
  observeMembers,
  planChannel,
  planMembers,
  updateChannel,
  updateMembers
} from './channel.js'
import {
  createTarget,
  deleteTarget,
  observeTarget,
  planTarget,
  sendTarget,
  targetHealth,
  updateTarget,
  WEBHOOK_HOSTS
} from './notify.js'
import { CHANNEL, MEMBERS, TAB, TARGET, TEAM, TEAMS_TYPES } from './specs.js'
import { createTab, deleteTab, findTab, listTabs, observeTab, planTab, updateTab } from './tab.js'
import { listTeams, observeTeam, planTeam } from './team.js'

/**
 * Microsoft Teams provider (Hub third-party providers, Task 24). Microsoft Graph with the
 * client-credentials grant (the connection has the same shape as Entra's: tenant, client id,
 * sealed secret or certificate key; the shared client is providers/microsoft/graph.ts). Types:
 * teams.team (shared, read and adopt), teams.channel, teams.channel_members (private channels),
 * teams.tab (website tab) and teams.notify_target. Graph app-only cannot post into a channel, so
 * Hub notifications go through a target: a Teams Workflows webhook (sealed address) or the
 * Nivaro Teams bot. The Test says which of the two this Hub can use.
 */

type Need = { type: string; any: string[] }
const NEEDS: Need[] = [
  { type: TEAM, any: ['Group.Read.All'] },
  { type: TEAM, any: ['Team.ReadBasic.All'] },
  { type: CHANNEL, any: ['Channel.ReadBasic.All'] },
  { type: CHANNEL, any: ['Channel.Create'] },
  { type: CHANNEL, any: ['ChannelSettings.ReadWrite.All'] },
  { type: CHANNEL, any: ['Channel.Delete.All'] },
  { type: MEMBERS, any: ['ChannelMember.ReadWrite.All'] },
  { type: MEMBERS, any: ['User.Read.All'] },
  { type: TAB, any: ['TeamsTab.ReadWriteForTeam.All', 'TeamsTab.ReadWrite.All'] }
]

function unknownType(type: string): ProviderError {
  return new ProviderError('UNKNOWN_TYPE', `Teams has no resource type ${type}.`)
}

function bad(message: string): ProviderError {
  return new ProviderError('INVALID', message)
}

type Maker = (ctx: ProviderContext, desired: DesiredResource) => Promise<OpResult>
type Editor = (
  ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource
) => Promise<OpResult>
type Remover = (ctx: ProviderContext, externalId: string) => Promise<OpResult>
type Reader = (ctx: ProviderContext, externalId: string) => Promise<Observed | null>

/** Create / update / delete of a type, with replace = delete then create. */
async function applyGeneric(
  ctx: ProviderContext,
  op: { kind: string; externalId: string | null },
  desired: DesiredResource | null,
  fns: { create: Maker; update: Editor; remove: Remover; read: Reader }
): Promise<OpResult> {
  switch (op.kind) {
    case 'noop': {
      const seen = op.externalId ? await fns.read(ctx, op.externalId) : null
      return { ok: true, externalId: op.externalId, observed: seen, answer: { status: 200 } }
    }
    case 'create':
      if (!desired) throw bad('A create needs the wanted values.')
      return fns.create(ctx, desired)
    case 'update':
      if (!desired || !op.externalId) throw bad('An update needs a resource.')
      return fns.update(ctx, op.externalId, desired)
    case 'delete':
      if (!op.externalId) throw bad('A delete needs a resource id.')
      return fns.remove(ctx, op.externalId)
    case 'replace':
      if (!desired || !op.externalId) throw bad('A replace needs a resource.')
      await fns.remove(ctx, op.externalId)
      return fns.create(ctx, { ...desired, externalId: null })
    default:
      throw bad(`Unknown operation ${String(op.kind)}.`)
  }
}

export const teamsAdapter: ProviderAdapter = {
  key: 'teams',
  label: 'Microsoft Teams',
  connection: {
    fields: GRAPH_CONNECTION_FIELDS,
    hosts(config) {
      // Graph, and the Workflows webhook hosts a notify target posts to.
      return tenantProblem(config.tenant_id) ? [] : [...GRAPH_HOSTS, ...WEBHOOK_HOSTS]
    },
    describe(config) {
      return `Teams tenant ${tenantOf(config)} · app ${String(config.client_id ?? '')}`
    },
    validate: graphConnectionProblems
  },
  types: TEAMS_TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    let token: string
    try {
      token = await mintGraphToken(ctx)
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : 'Could not reach Microsoft.'
      return { ok: false, identity: null, permissions: [], missing: [], message }
    }
    const roles = new Set(tokenRoles(token))
    const permissions = NEEDS.map((n) => ({
      type: n.type,
      need: n.any[0] as string,
      has: n.any.some((p) => roles.has(p))
    }))
    const missing = [...new Set(permissions.filter((p) => !p.has).map((p) => p.need))]
    const claims = tokenClaims(token)
    const identity = `Application ${String(ctx.config.client_id ?? '')} in tenant ${String(claims.tid ?? tenantOf(ctx.config))}`
    const bot = await botReady()
    const notify = `Notifications: a Teams Workflows webhook always works (Graph cannot post into a channel). ${bot.reason}`
    const grant = !roles.size
      ? 'Microsoft returned no application permissions for this token. Grant the Graph application permissions below and give admin consent. '
      : missing.length
        ? `Grant ${missing.join(', ')} as Microsoft Graph application permissions and give admin consent. `
        : ''
    return { ok: true, identity, permissions, missing, message: `${grant}${notify}` }
  },

  async observe(ctx, type, externalId) {
    if (type === TARGET) return observeTarget(externalId)
    await graphToken(ctx)
    switch (type) {
      case TEAM:
        return observeTeam(ctx, externalId)
      case CHANNEL:
        return observeChannel(ctx, externalId)
      case MEMBERS:
        return observeMembers(ctx, externalId)
      case TAB:
        return observeTab(ctx, externalId)
      default:
        throw unknownType(type)
    }
  },

  async list(ctx, type, cursor) {
    if (type === TARGET) return { items: [], cursor: null }
    await graphToken(ctx)
    switch (type) {
      case TEAM:
        return listTeams(ctx, cursor)
      case CHANNEL:
        return listChannels(ctx, cursor)
      case MEMBERS:
        return listMembers()
      case TAB:
        return listTabs()
      default:
        throw unknownType(type)
    }
  },

  /** Plan time: what a create would collide with. Reads only; apply refuses a collision itself. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    switch (type) {
      case CHANNEL:
        await graphToken(ctx)
        return findChannel(ctx, desired)
      case TAB:
        await graphToken(ctx)
        return findTab(ctx, desired)
      default:
        return null
    }
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    switch (type) {
      case TEAM:
        return planTeam(desired, observed)
      case CHANNEL:
        return planChannel(desired, observed)
      case MEMBERS:
        return planMembers(desired, observed)
      case TAB:
        return planTab(desired, observed)
      case TARGET:
        return planTarget(desired, observed)
      default:
        return []
    }
  },

  async apply(ctx, op, desired) {
    switch (op.type) {
      case TEAM:
        throw new ProviderError(
          'UNSUPPORTED',
          'The Hub only reads and adopts Teams teams; it never creates, changes or deletes one.'
        )
      case CHANNEL:
        await graphToken(ctx)
        return applyGeneric(ctx, op, desired, {
          create: createChannel,
          update: updateChannel,
          remove: deleteChannel,
          read: observeChannel
        })
      case MEMBERS:
        await graphToken(ctx)
        return applyGeneric(ctx, op, desired, {
          create: createMembers,
          update: updateMembers,
          remove: deleteMembers,
          read: observeMembers
        })
      case TAB:
        await graphToken(ctx)
        return applyGeneric(ctx, op, desired, {
          create: createTab,
          update: updateTab,
          remove: deleteTab,
          read: observeTab
        })
      case TARGET:
        return applyGeneric(ctx, op, desired, {
          create: createTarget,
          update: updateTarget,
          remove: deleteTarget,
          read: (_c, id) => observeTarget(id)
        })
      default:
        throw unknownType(op.type)
    }
  },

  /** A target sends one adaptive card through its webhook or the Nivaro Teams bot. */
  notify(ctx, resource, msg) {
    if (resource.type !== TARGET)
      throw new ProviderError('NOT_A_SENDER', 'Only a Teams notify target can send messages.')
    return sendTarget(ctx, resource, msg)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    if (type === TARGET) return targetHealth(externalId, checkedAt)
    await graphToken(ctx)
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone in Teams.', checkedAt }
    if (type === TEAM && seen.fields.archived === true)
      return { status: 'warn', message: 'This team is archived.', checkedAt }
    return { status: 'ok', checkedAt }
  }
}
