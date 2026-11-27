import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { CORE_PROVIDERS } from '../../../services/hub/providers/index.js'
import { teamsAdapter } from '../../../services/hub/providers/teams/index.js'
import type {
  DesiredResource,
  OutboundMessage,
  PlannedOp
} from '../../../services/hub/providers/types.js'
import { ProviderError } from '../../../services/hub/providers/types.js'

// Hub third-party providers, Task 24: the Microsoft Teams adapter against recorded Graph answers
// (providers/teams/__fixtures__, fake values only) and a faked Workflows webhook.

const botState = { enabled: false, sent: [] as unknown[], status: 0 }
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: botState.enabled, reason: 'not_configured' })
}))
vi.mock('../../../services/teams-bot/connector.js', () => ({
  sendActivity: async (...args: unknown[]) => {
    if (botState.status) {
      const e = new Error(`send activity failed (${botState.status})`) as Error & {
        status: number
      }
      e.status = botState.status
      throw e
    }
    botState.sent.push(args)
    return { id: 'a1' }
  }
}))

const FIX = join(import.meta.dirname, '../../../services/hub/providers/teams/__fixtures__')
const fx = (n: string): any => JSON.parse(readFileSync(join(FIX, n), 'utf8'))
const TEAM_RAW = fx('team.json')
const CHANNELS = fx('channels.json')
const MEMBERS = fx('members.json')
const TAB_RAW = fx('tab.json')
const ERRORS = fx('errors.json')

const TENANT = 'dddddddd-0000-4000-8000-00000000d0d0'
const CLIENT = 'cccccccc-0000-4000-8000-00000000c0de'
const SECRET = 'test-secret-teams-connection-abcdef'
const TEAM = TEAM_RAW.id as string
const CH = CHANNELS.value[1].id as string
const PRIV = CHANNELS.value[2].id as string
const CHAN = `${TEAM}:${CH}`
const PCHAN = `${TEAM}:${PRIV}`
const TAB_ID = TAB_RAW.id as string
const HOOK =
  'https://prod-12.westus.logic.azure.com:443/workflows/abc123/triggers/manual/paths/invoke?sig=test-secret-webhook-sig'

const ALL_ROLES = [
  'Group.Read.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'Channel.Create',
  'ChannelSettings.ReadWrite.All',
  'Channel.Delete.All',
  'ChannelMember.ReadWrite.All',
  'User.Read.All',
  'TeamsTab.ReadWriteForTeam.All'
]

function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b({ alg: 'RS256' })}.${b(claims)}.test-signature`
}

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: any
  url: string
}
type Answer = { status: number; body?: unknown; headers?: Record<string, string> }
type Routes = Record<string, Answer | ((c: Call) => Answer)>

let nextId = 9000
function setup(routes: Routes = {}, opts: { roles?: string[]; hook?: Answer } = {}) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    if (u.hostname === 'login.microsoftonline.com')
      return new Response(
        JSON.stringify({
          access_token: jwt({ roles: opts.roles ?? ALL_ROLES, tid: TENANT }),
          expires_in: 3600
        }),
        { status: 200 }
      )
    const raw = init.body ? String(init.body) : ''
    const call: Call = {
      method: String(init.method),
      path: u.pathname.replace(/^\/v1\.0/, ''),
      query: u.searchParams,
      body: raw ? JSON.parse(raw) : undefined,
      url
    }
    calls.push(call)
    if (u.hostname !== 'graph.microsoft.com') {
      const a = opts.hook ?? { status: 202 }
      return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
        status: a.status,
        headers: a.headers
      })
    }
    const h = routes[`${call.method} ${call.path}`]
    const r = (typeof h === 'function' ? h(call) : h) ?? { status: 404, body: ERRORS.notFound }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: teamsAdapter,
    connectionId: nextId++,
    config: { tenant_id: TENANT, client_id: CLIENT },
    secrets: { client_secret: SECRET },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl }
  })
  return { ctx, calls }
}

const graphWrites = (calls: Call[]) =>
  calls.filter((c) => c.url.includes('graph.microsoft.com') && c.method !== 'GET')

function desired(
  type: string,
  fields: Record<string, unknown>,
  over: Partial<DesiredResource> = {}
): DesiredResource {
  return {
    resourceId: 41,
    type,
    externalId: null,
    scope: 'app',
    appId: 7,
    environmentId: 3,
    fields,
    refs: {},
    tags: {},
    ...over
  } as DesiredResource
}

const chDesired = (over: Record<string, unknown> = {}, extra: Partial<DesiredResource> = {}) =>
  desired(
    'teams.channel',
    { name: 'app-alerts', description: 'Alerts for the app', membership: 'standard', ...over },
    { refs: { team: TEAM }, ...extra }
  )

const baseRoutes = (): Routes => ({
  [`GET /teams/${TEAM}`]: { status: 200, body: TEAM_RAW },
  [`GET /teams/${TEAM}/channels`]: { status: 200, body: CHANNELS },
  [`GET /teams/${TEAM}/channels/${encodeURIComponent(CH)}`]: {
    status: 200,
    body: CHANNELS.value[1]
  },
  [`GET /teams/${TEAM}/channels/${encodeURIComponent(PRIV)}`]: {
    status: 200,
    body: CHANNELS.value[2]
  },
  [`GET /teams/${TEAM}/channels/${encodeURIComponent(PRIV)}/members`]: {
    status: 200,
    body: MEMBERS
  }
})

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
})

describe('teams adapter', () => {
  it('is one entry in CORE_PROVIDERS and a sender type is marked sends', () => {
    expect(CORE_PROVIDERS.filter((a) => a.key === 'teams')).toHaveLength(1)
    expect(teamsAdapter.types.filter((t) => t.sends).map((t) => t.key)).toEqual([
      'teams.notify_target'
    ])
    expect(teamsAdapter.types.every((t) => t.costClass === undefined)).toBe(true)
  })

  it('hosts: Graph, login and the webhook hosts; none for a bad tenant', () => {
    const hosts = teamsAdapter.connection.hosts({ tenant_id: TENANT })
    expect(hosts).toContain('graph.microsoft.com')
    expect(hosts).toContain('*.logic.azure.com')
    expect(teamsAdapter.connection.hosts({ tenant_id: 'bad/tenant' })).toEqual([])
  })

  it('testConnection lists missing permissions and says which notify path works', async () => {
    const { ctx } = setup({}, { roles: ['Group.Read.All'] })
    const r = await teamsAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.missing).toContain('Channel.Create')
    expect(r.missing).not.toContain('Group.Read.All')
    expect(r.message).toContain('Workflows webhook')
    expect(r.message).toContain('bot')
  })

  it('observe maps provider fields', async () => {
    const { ctx } = setup({
      ...baseRoutes(),
      [`GET /teams/${TEAM}/channels/${encodeURIComponent(CH)}/tabs/${TAB_ID}`]: {
        status: 200,
        body: TAB_RAW
      }
    })
    const team = await teamsAdapter.observe(ctx, 'teams.team', TEAM)
    expect(team?.fields).toMatchObject({ name: 'Test Platform Team', archived: false })
    const ch = await teamsAdapter.observe(ctx, 'teams.channel', CHAN)
    expect(ch?.fields).toMatchObject({ team: TEAM, name: 'app-alerts', membership: 'standard' })
    const members = await teamsAdapter.observe(ctx, 'teams.channel_members', PCHAN)
    // Owners are never part of the managed list; emails are lower-cased.
    expect(members?.fields.emails).toEqual(['one@example.test'])
    const tab = await teamsAdapter.observe(ctx, 'teams.tab', `${CHAN}:${TAB_ID}`)
    expect(tab?.fields).toMatchObject({
      channel: CHAN,
      name: 'App',
      url: 'https://app.example.test/'
    })
    expect(await teamsAdapter.observe(ctx, 'teams.channel', `${TEAM}:19:gone@thread.tacv2`)).toBe(
      null
    )
    const t = await teamsAdapter.observe(ctx, 'teams.notify_target', `bot:${TAB_ID}:abc123`)
    expect(t?.fields).toEqual({ mode: 'bot' })
  })

  it('plan diff per type', () => {
    const { ctx } = setup()
    const obs = {
      type: 'teams.channel',
      externalId: CHAN,
      name: 'app-alerts',
      fields: {
        team: TEAM,
        name: 'app-alerts',
        description: 'Alerts for the app',
        membership: 'standard'
      },
      tags: {}
    }
    expect(teamsAdapter.plan(ctx, chDesired(), obs)[0]?.kind).toBe('noop')
    const upd = teamsAdapter.plan(ctx, chDesired({ description: 'New' }), obs)[0]
    expect(upd?.kind).toBe('update')
    expect(upd?.changes.map((c) => c.field)).toEqual(['description'])
    expect(teamsAdapter.plan(ctx, chDesired({ membership: 'private' }), obs)[0]?.kind).toBe(
      'replace'
    )
    expect(teamsAdapter.plan(ctx, chDesired(), null)[0]?.kind).toBe('create')
    const del = teamsAdapter.plan(ctx, null, obs)[0]
    expect(del?.kind).toBe('delete')
    expect(del?.reason).toContain('30 days')
    // Members: a removal is planned and reads as people leaving.
    const mObs = {
      type: 'teams.channel_members',
      externalId: PCHAN,
      name: 'x',
      fields: { channel: PCHAN, emails: ['a@example.test', 'b@example.test'] },
      tags: {}
    }
    const mDes = desired(
      'teams.channel_members',
      { name: 'x', emails: ['A@example.test'] },
      { refs: { channel: PCHAN } }
    )
    const m = teamsAdapter.plan(ctx, mDes, mObs)[0]
    expect(m?.kind).toBe('update')
    expect(m?.reason).toContain('leaves')
    // Tab: url change.
    const tObs = {
      type: 'teams.tab',
      externalId: `${CHAN}:${TAB_ID}`,
      name: 'App',
      fields: { channel: CHAN, name: 'App', url: 'https://app.example.test/' },
      tags: {}
    }
    const tDes = desired(
      'teams.tab',
      { name: 'App', url: 'https://other.example.test/' },
      { refs: { channel: CHAN } }
    )
    expect(teamsAdapter.plan(ctx, tDes, tObs)[0]?.changes[0]?.field).toBe('url')
    // Team: read only.
    expect(
      teamsAdapter.plan(ctx, desired('teams.team', {}), { ...obs, type: 'teams.team' })[0]?.kind
    ).toBe('noop')
  })

  it('apply is idempotent (read-before-write)', async () => {
    const { ctx, calls } = setup(baseRoutes())
    const d = chDesired({}, { externalId: CHAN })
    const r = await teamsAdapter.apply(
      ctx,
      {
        kind: 'update',
        type: 'teams.channel',
        resourceId: 41,
        externalId: CHAN,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      d
    )
    expect(r.ok).toBe(true)
    expect(graphWrites(calls)).toHaveLength(0)
    // A create finding the name already there is refused, never patched.
    const again = setup(baseRoutes())
    await expect(
      teamsAdapter.apply(
        again.ctx,
        {
          kind: 'create',
          type: 'teams.channel',
          resourceId: 41,
          externalId: null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        chDesired()
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(graphWrites(again.calls)).toHaveLength(0)
  })

  it('creates a channel, a private channel with its owner, and refuses a bad name', async () => {
    const routes = baseRoutes()
    routes[`GET /teams/${TEAM}/channels`] = { status: 200, body: { value: [] } }
    routes[`POST /teams/${TEAM}/channels`] = (c) => ({
      status: 201,
      body: {
        id: '19:new@thread.tacv2',
        displayName: c.body.displayName,
        membershipType: c.body.membershipType
      }
    })
    routes['GET /users'] = { status: 200, body: ERRORS.users }
    const { ctx, calls } = setup(routes)
    const mk = (d: DesiredResource) =>
      teamsAdapter.apply(
        ctx,
        {
          kind: 'create',
          type: 'teams.channel',
          resourceId: 41,
          externalId: null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        d
      )
    const std = await mk(chDesired({ name: 'fresh' }))
    expect(std.externalId).toBe(`${TEAM}:19:new@thread.tacv2`)
    const priv = await mk(
      chDesired({ name: 'secret', membership: 'private', owner_email: 'new@example.test' })
    )
    expect(priv.ok).toBe(true)
    const post = graphWrites(calls).at(-1)
    expect(post?.body.members[0].roles).toEqual(['owner'])
    await expect(mk(chDesired({ name: 'bad/name' }))).rejects.toMatchObject({ code: 'INVALID' })
    await expect(mk(chDesired({ name: 'p', membership: 'private' }))).rejects.toMatchObject({
      code: 'INVALID'
    })
  })

  it('members: unknown email stops everything, nothing is added; owners are never removed', async () => {
    const routes = baseRoutes()
    routes['GET /users'] = { status: 200, body: { value: [] } }
    const { ctx, calls } = setup(routes)
    const op = {
      kind: 'update',
      type: 'teams.channel_members',
      resourceId: 41,
      externalId: PCHAN,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    } as PlannedOp
    const d = desired(
      'teams.channel_members',
      { name: 'x', emails: ['one@example.test', 'ghost@example.test'] },
      { refs: { channel: PCHAN } }
    )
    await expect(teamsAdapter.apply(ctx, op, d)).rejects.toMatchObject({ code: 'UNKNOWN_PEOPLE' })
    expect(graphWrites(calls)).toHaveLength(0)
    // Wanting nobody removes the non-owner only.
    routes[`DELETE /teams/${TEAM}/channels/${encodeURIComponent(PRIV)}/members/member-one-fake`] = {
      status: 204
    }
    const none = setup(routes)
    const r = await teamsAdapter.apply(
      none.ctx,
      op,
      desired('teams.channel_members', { name: 'x', emails: [] }, { refs: { channel: PCHAN } })
    )
    expect(r.answer).toMatchObject({ removed: 1 })
    expect(graphWrites(none.calls).map((c) => c.path)).toEqual([
      `/teams/${TEAM}/channels/${encodeURIComponent(PRIV)}/members/member-one-fake`
    ])
  })

  it('tab: creates a website tab and refuses a non-https address', async () => {
    const routes: Routes = {
      [`GET /teams/${TEAM}/channels/${encodeURIComponent(CH)}/tabs`]: {
        status: 200,
        body: { value: [] }
      },
      [`POST /teams/${TEAM}/channels/${encodeURIComponent(CH)}/tabs`]: {
        status: 201,
        body: TAB_RAW
      }
    }
    const { ctx, calls } = setup(routes)
    const op = {
      kind: 'create',
      type: 'teams.tab',
      resourceId: 41,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    } as PlannedOp
    const d = desired(
      'teams.tab',
      { name: 'App', url: 'https://app.example.test/' },
      { refs: { channel: CHAN } }
    )
    const r = await teamsAdapter.apply(ctx, op, d)
    expect(r.externalId).toBe(`${CHAN}:${TAB_ID}`)
    expect(graphWrites(calls)[0]?.body['teamsApp@odata.bind']).toContain('teamspace.tab.web')
    await expect(
      teamsAdapter.apply(
        ctx,
        op,
        desired(
          'teams.tab',
          { name: 'App', url: 'http://app.example.test/' },
          { refs: { channel: CHAN } }
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('risk flags per type', () => {
    const t = (k: string) => teamsAdapter.types.find((x) => x.key === k)!
    const op = (kind: any, changes: any[] = []) => ({
      kind,
      type: '',
      resourceId: 1,
      externalId: 'x',
      reason: '',
      changes,
      preconditions: {},
      risk: []
    })
    expect(t('teams.channel').risk(op('delete'), null)).toEqual(['destructive'])
    expect(t('teams.channel').risk(op('update'), null)).toEqual([])
    expect(
      t('teams.channel_members').risk(
        op('update', [{ field: 'emails', from: ['a@x.test'], to: [] }]),
        null
      )
    ).toEqual(['destructive'])
    expect(
      t('teams.channel_members').risk(
        op('update', [{ field: 'emails', from: [], to: ['a@x.test'] }]),
        null
      )
    ).toEqual([])
    const target = t('teams.notify_target')
    const bot = desired('teams.notify_target', { mode: 'bot' })
    expect(target.risk(op('create'), bot)).toEqual(['public_exposure'])
    expect(target.risk(op('create'), desired('teams.notify_target', { mode: 'webhook' }))).toEqual(
      []
    )
    expect(target.risk(op('delete'), null)).toEqual(['destructive'])
  })

  it('maps 429 to retryable, other refusals not', async () => {
    const r429 = setup({
      [`GET /teams/${TEAM}`]: { status: 429, headers: { 'retry-after': '60' } }
    })
    await expect(teamsAdapter.observe(r429.ctx, 'teams.team', TEAM)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
    const r403 = setup({ [`GET /teams/${TEAM}`]: { status: 403, body: ERRORS.forbidden } })
    await expect(teamsAdapter.observe(r403.ctx, 'teams.team', TEAM)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      retryable: false
    })
  })

  it('secrets never appear in errors', async () => {
    const { ctx } = setup({
      [`GET /teams/${TEAM}`]: { status: 400, body: { error: { message: `bad ${SECRET} here` } } }
    })
    const err = await teamsAdapter.observe(ctx, 'teams.team', TEAM).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.message).not.toContain(SECRET)
  })

  it('declares outputs and none leak into observed/desired', async () => {
    expect(teamsAdapter.types.flatMap((t) => t.outputs ?? [])).toEqual([])
    const { ctx } = setup(baseRoutes())
    const seen = await teamsAdapter.observe(ctx, 'teams.channel', CHAN)
    expect(JSON.stringify(seen)).not.toContain(SECRET)
  })
})

describe('teams notify target', () => {
  const resource = async (fields: Record<string, unknown>, ext: string): Promise<any> => ({
    id: 5,
    connection_id: 1,
    provider: 'teams',
    type: 'teams.notify_target',
    external_id: ext,
    desired: fields
  })
  const msg = {
    kind: 'card',
    title: 'Deploy failed: shop',
    body: 'It broke.',
    severity: 'critical',
    link: 'https://hub.example.test/hub'
  } as OutboundMessage
  const createOp = {
    kind: 'create',
    type: 'teams.notify_target',
    resourceId: 5,
    externalId: null,
    reason: '',
    changes: [],
    preconditions: {},
    risk: []
  } as PlannedOp

  it('creates a webhook target with no provider call and validates the address', async () => {
    const { ctx, calls } = setup()
    const d = desired('teams.notify_target', {
      name: 'Alerts',
      mode: 'webhook',
      webhook_url: { fingerprint: 'f', changed: true, plain: HOOK }
    })
    const r = await teamsAdapter.apply(ctx, createOp, d)
    expect(r.externalId).toMatch(/^webhook:[0-9a-f-]{36}:w$/)
    expect(calls).toHaveLength(0)
    const bad = desired('teams.notify_target', {
      name: 'x',
      mode: 'webhook',
      webhook_url: {
        fingerprint: 'f',
        changed: true,
        plain: 'https://evil.example.test/workflows/x'
      }
    })
    await expect(teamsAdapter.apply(ctx, createOp, bad)).rejects.toMatchObject({ code: 'INVALID' })
    const http = desired('teams.notify_target', {
      name: 'x',
      mode: 'webhook',
      webhook_url: { fingerprint: 'f', changed: true, plain: HOOK.replace('https', 'http') }
    })
    await expect(teamsAdapter.apply(ctx, createOp, http)).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('notify sends one adaptive card to the webhook', async () => {
    const { sealSecret } = await import('../../../services/hub/secrets.js')
    const { ctx, calls } = setup()
    const res = await resource(
      { webhook_url: { $sealed: sealSecret(HOOK), fingerprint: 'f' } },
      `webhook:${TAB_ID}:w`
    )
    const r = await teamsAdapter.notify!(ctx, res, msg)
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const card = calls[0]?.body.attachments[0]
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(card.content.body[0].text).toBe('Deploy failed: shop')
    expect(card.content.body[0].color).toBe('Attention')
    expect(card.content.actions[0].url).toBe('https://hub.example.test/hub')
  })

  it('notify maps 429 to retryable and scrubs the webhook address from errors', async () => {
    const { sealSecret } = await import('../../../services/hub/secrets.js')
    const res = await resource(
      { webhook_url: { $sealed: sealSecret(HOOK), fingerprint: 'f' } },
      `webhook:${TAB_ID}:w`
    )
    const slow = setup({}, { hook: { status: 429 } })
    await expect(teamsAdapter.notify!(slow.ctx, res, msg)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
    const echo = setup(
      {},
      { hook: { status: 400, body: `rejected ${HOOK} sig=test-secret-webhook-sig` } }
    )
    const err = await teamsAdapter.notify!(echo.ctx, res, msg).catch((e) => e)
    expect(err.message).not.toContain('test-secret-webhook-sig')
    expect(err.message).not.toContain('/workflows/abc123')
    expect(err.retryable).toBe(false)
  })

  it('bot mode: refuses an address that is not a Bot Connector host, sends through the bot otherwise', async () => {
    const { ctx } = setup()
    const create = (service_url: string) =>
      teamsAdapter.apply(
        ctx,
        createOp,
        desired('teams.notify_target', {
          name: 'b',
          mode: 'bot',
          conversation_id: '19:abc@thread.tacv2',
          service_url
        })
      )
    botState.enabled = true
    await expect(create('https://attacker.example.test/')).rejects.toMatchObject({
      code: 'INVALID'
    })
    botState.enabled = false
    await expect(create('https://smba.trafficmanager.net/amer/')).rejects.toMatchObject({
      code: 'BOT_NOT_CONFIGURED'
    })
    botState.enabled = true
    const made = await create('https://smba.trafficmanager.net/amer/')
    expect(made.externalId).toMatch(/^bot:/)
    const res = await resource(
      {
        conversation_id: '19:abc@thread.tacv2',
        service_url: 'https://smba.trafficmanager.net/amer/'
      },
      made.externalId as string
    )
    botState.sent.length = 0
    expect((await teamsAdapter.notify!(ctx, res, msg)).ok).toBe(true)
    expect(botState.sent).toHaveLength(1)
    botState.status = 429
    await expect(teamsAdapter.notify!(ctx, res, msg)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
    botState.status = 404
    await expect(teamsAdapter.notify!(ctx, res, msg)).rejects.toMatchObject({
      code: 'TARGET_GONE',
      retryable: false
    })
    botState.status = 0
  })

  it('a moved bot conversation plans an update', () => {
    const { ctx } = setup()
    const d = desired('teams.notify_target', {
      name: 'b',
      mode: 'bot',
      conversation_id: '19:other@thread.tacv2',
      service_url: 'https://smba.trafficmanager.net/amer/'
    })
    const o = {
      type: 'teams.notify_target',
      externalId: `bot:${TAB_ID}:aaaaaaaaaaaa`,
      name: null,
      fields: { mode: 'bot' },
      tags: {}
    }
    expect(teamsAdapter.plan(ctx, d, o)[0]?.kind).toBe('update')
  })
})
