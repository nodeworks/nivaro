import { asObj, diffFields, mkOp, type Obj, preconditionsOf, str } from '../entra/shared.js'
import { graph, graphAll, graphGuid, graphSegment, isGuid } from '../microsoft/graph.js'
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
import { splitChannel } from './channel.js'
import { TAB, TEAMS_TYPES } from './specs.js'

/**
 * Teams website tabs: a tab on a channel that shows one https address (the app's environment).
 * A tab's provider id is `<channel id>:<tab guid>` (the channel part is `<team>:<channel>`). Only
 * the built-in website tab is managed; every other kind of tab is left alone and not listed.
 */

const label = TEAMS_TYPES.find((t) => t.key === TAB)?.label ?? TAB
/** The Teams app id of the built-in website tab. */
export const WEB_TAB_APP = 'com.microsoft.teamspace.tab.web'
const WEB_TAB_BIND = `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${WEB_TAB_APP}`

export function joinTab(channelId: string, tabId: string): string {
  return `${channelId}:${tabId}`
}

/** `<team>:<channel>:<tab guid>` → the channel id and the tab id; null when it is not one. */
export function splitTab(externalId: string): { channel: string; tab: string } | null {
  if (typeof externalId !== 'string' || externalId.length < 38 + 37) return null
  const tab = externalId.slice(-36)
  if (externalId[externalId.length - 37] !== ':' || !isGuid(tab)) return null
  const channel = externalId.slice(0, -37)
  return splitChannel(channel) ? { channel, tab: tab.toLowerCase() } : null
}

function tabIds(externalId: string): { team: string; channel: string; tab: string } {
  const t = splitTab(externalId)
  const c = t ? splitChannel(t.channel) : null
  if (!t || !c) throw new ProviderError('BAD_ID', 'That is not a Teams tab id.')
  graphSegment(c.channel, 'channel id')
  return { team: c.team, channel: c.channel, tab: t.tab }
}

const channelBase = (ids: { team: string; channel: string }): string =>
  `/teams/${graphGuid(ids.team, 'team id')}/channels/${graphSegment(ids.channel, 'channel id')}`

const tabPath = (ids: { team: string; channel: string; tab: string }): string =>
  `${channelBase(ids)}/tabs/${graphGuid(ids.tab, 'tab id')}`

/** Why `raw` is not a tab address (empty = fine): https only, no login, a real host. */
export function tabUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'A tab needs a website address.'
  if (raw.length > 2000) return 'The tab address is too long.'
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:') return 'A tab address must start with https://.'
    if (u.username || u.password) return 'A tab address may not carry a login.'
    return null
  } catch {
    return 'That is not a valid address.'
  }
}

function isWebTab(raw: Obj): boolean {
  const app = asObj(raw.teamsApp)
  // An answer with no expanded app is read as a web tab when it has the website settings.
  if (str(app.id)) return app.id === WEB_TAB_APP
  return !!str(asObj(raw.configuration).websiteUrl)
}

function observedTab(channelId: string, raw: Obj): Observed {
  const cfg = asObj(raw.configuration)
  return {
    type: TAB,
    externalId: joinTab(channelId, String(raw.id ?? '').toLowerCase()),
    name: str(raw.displayName),
    fields: {
      channel: channelId,
      name: str(raw.displayName),
      url: str(cfg.websiteUrl) ?? str(cfg.contentUrl)
    },
    tags: {},
    url: str(raw.webUrl)
  }
}

async function tabsOf(ctx: ProviderContext, ids: { team: string; channel: string }) {
  const all = await graphAll(ctx, `${channelBase(ids)}/tabs`, { query: { $expand: 'teamsApp' } })
  return all.filter(isWebTab)
}

export async function observeTab(
  ctx: ProviderContext,
  externalId: string
): Promise<Observed | null> {
  const t = splitTab(externalId)
  const c = t ? splitChannel(t.channel) : null
  if (!t || !c) return null
  const res = await graph(ctx, 'GET', tabPath({ ...c, tab: t.tab }), {
    query: { $expand: 'teamsApp' },
    allow: [404]
  })
  if (res.status === 404) return null
  const raw = asObj(res.body)
  return isWebTab(raw) ? observedTab(t.channel, raw) : null
}

export async function listTabs(): Promise<ListPage> {
  // Tabs are managed per channel, never discovered: there is nothing to adopt.
  return { items: [], cursor: null }
}

export async function findTab(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<Observed | null> {
  const ref = desired.refs.channel
  const name = str(desired.fields.name)
  const c = typeof ref === 'string' ? splitChannel(ref) : null
  if (!c || !name) return null
  const hit = (await tabsOf(ctx, c)).find(
    (t) => (str(t.displayName) ?? '').toLowerCase() === name.toLowerCase()
  )
  return hit ? observedTab(String(ref), hit) : null
}

export function planTab(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        TAB,
        null,
        'delete',
        observed.externalId,
        `Remove ${typedName(label, observed.name)} from the channel.`,
        { preconditions: { name: observed.fields.name, url: observed.fields.url } }
      )
    ]
  }
  const name = typedName(label, str(desired.fields.name) ?? observed?.name)
  if (!observed)
    return [
      mkOp(
        TAB,
        desired,
        'create',
        null,
        `Add ${name} (${String(desired.fields.url ?? '')}). A tab the Hub did not make is refused: it is not adopted.`,
        {
          changes: [
            { field: 'channel', to: desired.refs.channel ?? null },
            { field: 'name', to: desired.fields.name },
            { field: 'url', to: desired.fields.url }
          ]
        }
      )
    ]
  const wantChannel = typeof desired.refs.channel === 'string' ? desired.refs.channel : null
  if (wantChannel !== null && wantChannel !== observed.fields.channel)
    return [
      mkOp(
        TAB,
        desired,
        'replace',
        observed.externalId,
        `Replace ${name}: a tab cannot move to another channel, so it is removed and added again.`,
        {
          changes: [{ field: 'channel', from: observed.fields.channel, to: wantChannel }],
          preconditions: { channel: observed.fields.channel }
        }
      )
    ]
  const changes = diffFields(['name', 'url'], desired, observed)
  if (!changes.length)
    return [mkOp(TAB, desired, 'noop', observed.externalId, `${name} is up to date.`)]
  return [
    mkOp(TAB, desired, 'update', observed.externalId, `Change ${name}.`, {
      changes,
      preconditions: preconditionsOf(changes, observed.fields)
    })
  ]
}

function configuration(url: string): Obj {
  return { entityId: '', contentUrl: url, websiteUrl: url, removeUrl: null }
}

export async function createTab(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const ref = desired.refs.channel
  const c = typeof ref === 'string' ? splitChannel(ref) : null
  if (!c || typeof ref !== 'string')
    throw new ProviderError('REF_UNRESOLVED', 'The channel this belongs to is not known yet.')
  const name = String(desired.fields.name ?? '').trim()
  if (!name) throw new ProviderError('INVALID', 'A tab needs a name.')
  const problem = tabUrlProblem(desired.fields.url)
  if (problem) throw new ProviderError('INVALID', problem)
  if (desired.externalId) {
    const seen = await observeTab(ctx, desired.externalId)
    if (seen) return updateTab(ctx, desired.externalId, desired)
  }
  const existing = (await tabsOf(ctx, c)).find(
    (t) => (str(t.displayName) ?? '').toLowerCase() === name.toLowerCase()
  )
  if (existing)
    throw new ProviderError(
      'ALREADY_EXISTS',
      `A tab named ${name} already exists on this channel and was not created by the Hub. Rename yours or remove the other one.`,
      { status: 409 }
    )
  const res = await graph(ctx, 'POST', `${channelBase(c)}/tabs`, {
    body: {
      displayName: name,
      'teamsApp@odata.bind': WEB_TAB_BIND,
      configuration: configuration(String(desired.fields.url).trim())
    }
  })
  const raw = asObj(res.body)
  const id = str(raw.id)
  if (!id) throw new ProviderError('PROVIDER_ERROR', 'Teams did not return the new tab.')
  const observed = observedTab(ref, {
    ...raw,
    configuration: raw.configuration ?? configuration(String(desired.fields.url).trim())
  })
  return { ok: true, externalId: observed.externalId, observed, answer: { status: res.status } }
}

export async function updateTab(
  ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource
): Promise<OpResult> {
  const ids = tabIds(externalId)
  const channelId = splitTab(externalId)?.channel ?? ''
  if (typeof desired.refs.channel === 'string' && desired.refs.channel !== channelId)
    throw new ProviderError('TARGET_MISMATCH', 'The tab is not on the channel this resource names.')
  const seen = await observeTab(ctx, externalId)
  if (!seen) throw new ProviderError('NOT_FOUND', 'The tab no longer exists.', { status: 404 })
  const changes = diffFields(['name', 'url'], desired, seen)
  if (!changes.length) return { ok: true, externalId, observed: seen, answer: { status: 200 } }
  const patch: Obj = {}
  for (const ch of changes) {
    if (ch.field === 'name') {
      const name = String(ch.to ?? '').trim()
      if (!name) throw new ProviderError('INVALID', 'A tab needs a name.')
      patch.displayName = name
    }
    if (ch.field === 'url') {
      const problem = tabUrlProblem(ch.to)
      if (problem) throw new ProviderError('INVALID', problem)
      patch.configuration = configuration(String(ch.to).trim())
    }
  }
  await graph(ctx, 'PATCH', tabPath(ids), { body: patch })
  return {
    ok: true,
    externalId,
    observed: await observeTab(ctx, externalId),
    answer: { status: 204 }
  }
}

export async function deleteTab(ctx: ProviderContext, externalId: string): Promise<OpResult> {
  const ids = tabIds(externalId)
  const res = await graph(ctx, 'DELETE', tabPath(ids), { allow: [404] })
  return { ok: true, externalId, observed: null, answer: { status: res.status } }
}
