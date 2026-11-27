import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { ensureCoreProviders } from '../../../services/hub/providers/index.js'
import { getProvider } from '../../../services/hub/providers/registry.js'
import { slackAdapter } from '../../../services/hub/providers/slack/index.js'
import type { HubResourceRow } from '../../../services/hub/providers/store.js'
import {
  type DesiredResource,
  type Observed,
  type OutboundMessage,
  ProviderError
} from '../../../services/hub/providers/types.js'

// Hub providers Task 23: the Slack adapter against recorded (fake-valued) answers.

const FIX = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../services/hub/providers/slack/__fixtures__/answers.json'),
    'utf8'
  )
)
const fx = (name: string): any => FIX[name]

const TOKEN = 'xoxb-test-secret-slack-token-0001'

interface Call {
  method: string
  form: URLSearchParams
  headers: Record<string, string>
  host: string
}
interface Route {
  method: string
  body?: unknown
  status?: number
  headers?: Record<string, string>
  /** Used once, then the next route with the same method answers. */
  once?: boolean
  /** Only a call whose form satisfies this. */
  when?: (form: URLSearchParams) => boolean
}

let nextConnection = 100

function harness(routes: Route[], config: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const used = new Set<Route>()
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: u.pathname.replace(/^\/api\//, ''),
      form: new URLSearchParams(String(init?.body ?? '')),
      headers: init?.headers ?? {},
      host: u.host
    }
    calls.push(call)
    const hit = routes.find(
      (r) => r.method === call.method && !used.has(r) && (!r.when || r.when(call.form))
    )
    if (hit?.once) used.add(hit)
    if (!hit) return new Response(JSON.stringify(fx('error-channel-not-found')), { status: 200 })
    return new Response(JSON.stringify(hit.body ?? {}), {
      status: hit.status ?? 200,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: slackAdapter,
    connectionId: nextConnection++,
    config: { team_id: 'T0TEST001', ...config },
    secrets: { token: TOKEN },
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

const AUTH: Route = { method: 'auth.test', body: fx('auth-test') }
const writes = (calls: Call[]) =>
  calls.filter((c) => !/\.(info|list|members|lookupByEmail)$|^auth\.test$/.test(c.method))

function desired(
  type: string,
  fields: Record<string, unknown>,
  refs: DesiredResource['refs'] = {},
  externalId: string | null = null
): DesiredResource {
  return {
    resourceId: 7,
    type,
    externalId,
    scope: 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

const channelFields = {
  name: 'app-one',
  visibility: 'public',
  topic: 'Deploys',
  purpose: 'Hub events'
}

function row(over: Partial<HubResourceRow> = {}): HubResourceRow {
  return {
    id: 5,
    connection_id: 1,
    provider: 'slack',
    type: 'slack.channel',
    external_id: 'C0TEST001',
    name: 'app-one',
    scope: 'app',
    app_id: 1,
    environment_id: 2,
    desired: null,
    observed: null,
    drift: false,
    observed_at: null,
    tags: {},
    refs: [],
    created_by: null,
    adopted: false,
    deleted_at: null,
    created_at: null,
    updated_at: null,
    ...over
  }
}

const MSG: OutboundMessage = {
  kind: 'card',
  title: 'Deploy failed: shop · production',
  body: 'Build 41 <failed> & stopped.',
  link: 'https://hub.example.test/hub/deploys',
  severity: 'critical'
}

describe('slack adapter: registration', () => {
  it('is a core provider on slack.com only, pinned to one workspace, token secret', () => {
    ensureCoreProviders()
    expect(getProvider('slack')).toBe(slackAdapter)
    expect(slackAdapter.connection.hosts({ team_id: 'T0TEST001' })).toEqual(['slack.com'])
    expect(slackAdapter.connection.fields.find((f) => f.key === 'token')?.secret).toBe(true)
    expect(slackAdapter.connection.describe({ team_id: 'T0TEST001' })).not.toContain(TOKEN)
    expect(slackAdapter.types.map((t) => t.key)).toEqual([
      'slack.channel',
      'slack.channel_members',
      'slack.bookmark'
    ])
  })

  it('validates the workspace id and that the token is a bot token', () => {
    const v = slackAdapter.connection.validate!
    expect(v({ team_id: 'T0TEST001' }, { token: TOKEN })).toEqual([])
    expect(v({ team_id: 'nope' }, { token: TOKEN })).toHaveLength(1)
    expect(v({ team_id: 'T0TEST001' }, { token: 'xoxp-user-token' })).toHaveLength(1)
  })

  it('declares outputs and none leak into observed or desired; only the channel sends', async () => {
    expect(slackAdapter.types.every((t) => !t.outputs?.length)).toBe(true)
    expect(slackAdapter.types.filter((t) => t.sends).map((t) => t.key)).toEqual(['slack.channel'])
    const { ctx } = harness([AUTH, { method: 'conversations.info', body: fx('channel-info') }])
    const seen = await slackAdapter.observe(ctx, 'slack.channel', 'C0TEST001')
    expect(JSON.stringify(seen)).not.toContain('xoxb')
  })

  it('calls only slack.com with the bearer token in the header, never in the body', async () => {
    const { ctx, calls } = harness([
      AUTH,
      { method: 'conversations.info', body: fx('channel-info') }
    ])
    await slackAdapter.observe(ctx, 'slack.channel', 'C0TEST001')
    expect(calls.every((c) => c.host === 'slack.com')).toBe(true)
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls.every((c) => !c.form.toString().includes('xoxb'))).toBe(true)
  })
})

describe('slack adapter: testConnection', () => {
  it('lists missing scopes from the token’s own scope header', async () => {
    const { ctx } = harness([
      {
        method: 'auth.test',
        body: fx('auth-test'),
        headers: { 'x-oauth-scopes': 'chat:write,channels:read' }
      }
    ])
    const t = await slackAdapter.testConnection(ctx)
    expect(t.ok).toBe(true)
    expect(t.identity).toContain('Test Workspace')
    expect(t.missing).toContain('channels:manage')
    expect(t.missing).toContain('users:read.email')
    expect(t.missing).not.toContain('chat:write')
  })

  it('answers not ok for another workspace, and for a refused token with scrubbed text', async () => {
    const other = harness([{ method: 'auth.test', body: fx('auth-test-other') }])
    expect((await slackAdapter.testConnection(other.ctx)).ok).toBe(false)
    const bad = harness([{ method: 'auth.test', body: fx('error-invalid-auth') }])
    const t = await slackAdapter.testConnection(bad.ctx)
    expect(t.ok).toBe(false)
    expect(JSON.stringify(t)).not.toContain(TOKEN)
  })
})

describe('slack adapter: observe', () => {
  it('maps a channel and answers null for a missing one, a DM and a foreign workspace', async () => {
    const a = harness([AUTH, { method: 'conversations.info', body: fx('channel-info') }])
    const seen = await slackAdapter.observe(a.ctx, 'slack.channel', 'C0TEST001')
    expect(seen).toMatchObject({
      externalId: 'C0TEST001',
      name: 'app-one',
      status: 'active',
      fields: { name: 'app-one', visibility: 'public', topic: 'Deploys', purpose: 'Hub events' }
    })
    const gone = harness([
      AUTH,
      { method: 'conversations.info', body: fx('error-channel-not-found') }
    ])
    expect(await slackAdapter.observe(gone.ctx, 'slack.channel', 'C0TEST001')).toBeNull()
    const foreign = harness([
      AUTH,
      { method: 'conversations.info', body: fx('channel-info-foreign') }
    ])
    expect(await slackAdapter.observe(foreign.ctx, 'slack.channel', 'C0FOREIGN')).toBeNull()
  })

  it('refuses a token of another workspace on every read', async () => {
    const { ctx, calls } = harness([{ method: 'auth.test', body: fx('auth-test-other') }])
    await expect(slackAdapter.observe(ctx, 'slack.channel', 'C0TEST001')).rejects.toMatchObject({
      code: 'SLACK_OUT_OF_ACCOUNT'
    })
    expect(calls.map((c) => c.method)).toEqual(['auth.test'])
  })

  it('refuses ids that are not channel, user or bookmark ids', async () => {
    const { ctx, calls } = harness([AUTH])
    for (const bad of ['', '..', 'c0test', 'C0/../x', 'C0TEST001\n'])
      await expect(slackAdapter.observe(ctx, 'slack.channel', bad)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    await expect(slackAdapter.observe(ctx, 'slack.bookmark', 'C0TEST001/xx')).rejects.toMatchObject(
      {
        code: 'BAD_ID'
      }
    )
    expect(calls.filter((c) => c.method !== 'auth.test')).toEqual([])
  })

  it('members: observed emails come from the people in the channel, bots skipped', async () => {
    const { ctx } = harness([
      AUTH,
      { method: 'conversations.info', body: fx('channel-info') },
      { method: 'conversations.members', body: fx('members') },
      { method: 'users.info', body: fx('user-info-bot'), once: true },
      { method: 'users.info', body: fx('user-info') }
    ])
    const seen = await slackAdapter.observe(ctx, 'slack.channel_members', 'C0TEST001')
    expect(seen?.fields).toEqual({ channel: 'C0TEST001', emails: ['owner@example.test'] })
  })

  it('bookmark: reads one from the channel list', async () => {
    const { ctx } = harness([AUTH, { method: 'bookmarks.list', body: fx('bookmarks') }])
    const seen = await slackAdapter.observe(ctx, 'slack.bookmark', 'C0TEST001/Bk0TEST001')
    expect(seen?.fields).toEqual({
      channel: 'C0TEST001',
      title: 'Production',
      link: 'https://app.example.test/'
    })
  })

  it('lists channels of the pinned workspace only, with the provider cursor', async () => {
    const { ctx } = harness([
      AUTH,
      {
        method: 'conversations.list',
        body: {
          ...fx('channels-list'),
          response_metadata: { next_cursor: 'dGVzdA==' }
        }
      }
    ])
    const page = await slackAdapter.list(ctx, 'slack.channel')
    expect(page.items.map((i) => i.externalId)).toEqual(['C0TEST001'])
    expect(page.cursor).toBe('dGVzdA==')
  })
})

describe('slack adapter: plan', () => {
  const observed = (over: Partial<Observed> = {}): Observed => ({
    type: 'slack.channel',
    externalId: 'C0TEST001',
    name: 'app-one',
    fields: { name: 'app-one', visibility: 'public', topic: 'Deploys', purpose: 'Hub events' },
    tags: {},
    status: 'active',
    ...over
  })
  const { ctx } = harness([])

  it('channel: create, noop, update, unarchive, delete = archive', () => {
    const d = desired('slack.channel', channelFields)
    expect(slackAdapter.plan(ctx, d, null)[0]).toMatchObject({ kind: 'create' })
    expect(slackAdapter.plan(ctx, d, observed())).toEqual([])
    const upd = slackAdapter.plan(
      ctx,
      desired('slack.channel', { ...channelFields, topic: 'New' }),
      observed()
    )
    expect(upd[0]).toMatchObject({ kind: 'update', changes: [{ field: 'topic', to: 'New' }] })
    expect(upd[0]?.reason).toContain('Slack channel')
    expect(upd[0]?.reason).not.toContain('slack.channel')
    const un = slackAdapter.plan(ctx, d, observed({ status: 'archived' }))
    expect(un[0]?.changes).toEqual([{ field: 'archived', from: true, to: false }])
    const del = slackAdapter.plan(ctx, null, observed())
    expect(del[0]).toMatchObject({ kind: 'delete', externalId: 'C0TEST001' })
    expect(del[0]?.reason).toContain('Archive')
    expect(slackAdapter.plan(ctx, null, observed({ status: 'archived' }))).toEqual([])
  })

  it('making a private channel public is a public exposure, the reverse is not', () => {
    const spec = slackAdapter.types.find((t) => t.key === 'slack.channel')!
    const toPublic = slackAdapter.plan(
      ctx,
      desired('slack.channel', { ...channelFields, visibility: 'public' }),
      observed({ fields: { ...observed().fields, visibility: 'private' } })
    )[0]!
    expect(spec.risk(toPublic, null)).toEqual(['public_exposure'])
    const toPrivate = slackAdapter.plan(
      ctx,
      desired('slack.channel', { ...channelFields, visibility: 'private' }),
      observed()
    )[0]!
    expect(spec.risk(toPrivate, null)).toEqual([])
    expect(typeof spec.reversible === 'function' && spec.reversible('visibility')).toBe(false)
    expect(typeof spec.reversible === 'function' && spec.reversible('topic')).toBe(true)
  })

  it('members: plans only when someone is missing; delete just stops managing', () => {
    const have: Observed = {
      type: 'slack.channel_members',
      externalId: 'C0TEST001',
      name: 'app-one',
      fields: { channel: 'C0TEST001', emails: ['owner@example.test'] },
      tags: {}
    }
    const ref = { channel: 'C0TEST001' }
    expect(
      slackAdapter.plan(
        ctx,
        desired('slack.channel_members', { emails: ['Owner@example.test'] }, ref),
        have
      )
    ).toEqual([])
    const more = slackAdapter.plan(
      ctx,
      desired(
        'slack.channel_members',
        { emails: ['owner@example.test', 'second@example.test'] },
        ref
      ),
      have
    )
    expect(more[0]).toMatchObject({ kind: 'update' })
    expect(slackAdapter.plan(ctx, null, have)[0]?.reason).toContain('stay in the channel')
  })

  it('bookmark: create, update, noop, delete', () => {
    const ref = { channel: 'C0TEST001' }
    const fields = { title: 'Staging', link: 'https://staging.example.test/' }
    const seen: Observed = {
      type: 'slack.bookmark',
      externalId: 'C0TEST001/Bk0TEST001',
      name: 'Staging',
      fields: { channel: 'C0TEST001', ...fields },
      tags: {}
    }
    expect(slackAdapter.plan(ctx, desired('slack.bookmark', fields, ref), null)[0]?.kind).toBe(
      'create'
    )
    expect(slackAdapter.plan(ctx, desired('slack.bookmark', fields, ref), seen)).toEqual([])
    expect(
      slackAdapter.plan(ctx, desired('slack.bookmark', { ...fields, title: 'Stage' }, ref), seen)[0]
        ?.kind
    ).toBe('update')
    expect(slackAdapter.plan(ctx, null, seen)[0]?.kind).toBe('delete')
  })
})

describe('slack adapter: apply', () => {
  it('channel create: refuses a name it did not make, resumes its own', async () => {
    const taken = harness([AUTH, { method: 'conversations.create', body: fx('error-name-taken') }])
    const d = desired('slack.channel', channelFields)
    const op = slackAdapter.plan(taken.ctx, d, null)[0]!
    await expect(slackAdapter.apply(taken.ctx, op, d)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      retryable: false
    })
    const resumed = harness([AUTH, { method: 'conversations.info', body: fx('channel-info') }])
    const r = await slackAdapter.apply(
      resumed.ctx,
      op,
      desired('slack.channel', channelFields, {}, 'C0TEST001')
    )
    expect(r.ok).toBe(true)
    expect(writes(resumed.calls)).toEqual([])
  })

  it('channel create: posts name and privacy, then topic and purpose', async () => {
    const { ctx, calls } = harness([
      AUTH,
      { method: 'conversations.create', body: fx('channel-created') },
      { method: 'conversations.setTopic', body: fx('ok') },
      { method: 'conversations.setPurpose', body: fx('ok') },
      { method: 'conversations.info', body: fx('channel-info-private') }
    ])
    const d = desired('slack.channel', { ...channelFields, visibility: 'private' })
    const r = await slackAdapter.apply(ctx, slackAdapter.plan(ctx, d, null)[0]!, d)
    expect(r).toMatchObject({ ok: true, externalId: 'C0TEST009' })
    const create = calls.find((c) => c.method === 'conversations.create')!
    expect(create.form.get('name')).toBe('app-one')
    expect(create.form.get('is_private')).toBe('true')
    expect(calls.map((c) => c.method)).toContain('conversations.setTopic')
  })

  it('channel create refuses a bad name before any call', async () => {
    const { ctx, calls } = harness([AUTH])
    const d = desired('slack.channel', { ...channelFields, name: 'Has Spaces' })
    await expect(
      slackAdapter.apply(ctx, slackAdapter.plan(ctx, d, null)[0]!, d)
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(writes(calls)).toEqual([])
  })

  it('channel update: unarchive then rename, read before write', async () => {
    const { ctx, calls } = harness([
      AUTH,
      { method: 'conversations.info', body: fx('channel-info-archived'), once: true },
      { method: 'conversations.unarchive', body: fx('ok') },
      { method: 'conversations.rename', body: fx('ok') },
      { method: 'conversations.info', body: fx('channel-info') }
    ])
    const d = desired('slack.channel', { ...channelFields, name: 'app-two' }, {}, 'C0TEST001')
    const seen = await slackAdapter.observe(
      harness([AUTH, { method: 'conversations.info', body: fx('channel-info-archived') }]).ctx,
      'slack.channel',
      'C0TEST001'
    )
    const op = slackAdapter.plan(ctx, d, seen)[0]!
    expect(op.changes.map((c) => c.field)).toEqual(['archived', 'name'])
    const r = await slackAdapter.apply(ctx, op, d)
    expect(r.ok).toBe(true)
    expect(writes(calls).map((c) => c.method)).toEqual([
      'conversations.unarchive',
      'conversations.rename'
    ])
  })

  it('channel delete archives once; a gone or archived channel is a no-write success', async () => {
    const live = harness([
      AUTH,
      { method: 'conversations.info', body: fx('channel-info'), once: true },
      { method: 'conversations.archive', body: fx('ok') },
      { method: 'conversations.info', body: fx('channel-info-archived') }
    ])
    const op = slackAdapter.plan(
      live.ctx,
      null,
      (await slackAdapter.observe(
        harness([AUTH, { method: 'conversations.info', body: fx('channel-info') }]).ctx,
        'slack.channel',
        'C0TEST001'
      ))!
    )[0]!
    await slackAdapter.apply(live.ctx, op, null)
    expect(writes(live.calls).map((c) => c.method)).toEqual(['conversations.archive'])
    const gone = harness([
      AUTH,
      { method: 'conversations.info', body: fx('error-channel-not-found') }
    ])
    expect((await slackAdapter.apply(gone.ctx, op, null)).ok).toBe(true)
    expect(writes(gone.calls)).toEqual([])
  })

  it('members: matches people by email, invites the missing, lists unknown emails, never guesses', async () => {
    const { ctx, calls } = harness([
      AUTH,
      { method: 'conversations.info', body: fx('channel-info') },
      { method: 'conversations.members', body: fx('members') },
      {
        method: 'users.lookupByEmail',
        body: fx('lookup-owner'),
        when: (f) => f.get('email') === 'owner@example.test'
      },
      {
        method: 'users.lookupByEmail',
        body: fx('lookup-second'),
        when: (f) => f.get('email') === 'second@example.test'
      },
      { method: 'users.lookupByEmail', body: fx('lookup-missing') },
      { method: 'conversations.invite', body: fx('ok') },
      { method: 'users.info', body: fx('user-info') }
    ])
    const d = desired(
      'slack.channel_members',
      { emails: ['owner@example.test', 'second@example.test', 'ghost@example.test'] },
      { channel: 'C0TEST001' }
    )
    const op = slackAdapter.plan(ctx, d, null)[0]!
    const r = await slackAdapter.apply(ctx, op, d)
    expect(r.ok).toBe(true)
    expect(r.answer).toEqual({ added: 1, unmatched: ['ghost@example.test'] })
    const invite = calls.find((c) => c.method === 'conversations.invite')!
    expect(invite.form.get('users')).toBe('U0PERSON2')
    expect(invite.form.get('channel')).toBe('C0TEST001')
  })

  it('members: refuses a change aimed at a different channel than the resource points at', async () => {
    const { ctx, calls } = harness([AUTH])
    const d = desired(
      'slack.channel_members',
      { emails: ['a@example.test'] },
      { channel: 'C0TEST001' }
    )
    const op = { ...slackAdapter.plan(ctx, d, null)[0]!, externalId: 'C0OTHER99' }
    await expect(slackAdapter.apply(ctx, op, d)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(writes(calls)).toEqual([])
  })

  it('bookmark: create adds a link, refuses an existing link it did not make; delete is read-first', async () => {
    const d = desired(
      'slack.bookmark',
      { title: 'Staging', link: 'https://staging.example.test/' },
      { channel: 'C0TEST001' }
    )
    const fresh = harness([
      AUTH,
      { method: 'bookmarks.list', body: fx('bookmarks') },
      { method: 'bookmarks.add', body: fx('bookmark-added') }
    ])
    const r = await slackAdapter.apply(fresh.ctx, slackAdapter.plan(fresh.ctx, d, null)[0]!, d)
    expect(r.externalId).toBe('C0TEST001/Bk0TEST002')
    const add = fresh.calls.find((c) => c.method === 'bookmarks.add')!
    expect(add.form.get('type')).toBe('link')
    expect(add.form.get('link')).toBe('https://staging.example.test/')

    const dup = harness([AUTH, { method: 'bookmarks.list', body: fx('bookmarks') }])
    const same = desired(
      'slack.bookmark',
      { title: 'Prod', link: 'https://app.example.test/' },
      { channel: 'C0TEST001' }
    )
    await expect(
      slackAdapter.apply(dup.ctx, slackAdapter.plan(dup.ctx, same, null)[0]!, same)
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })

    const del = harness([
      AUTH,
      { method: 'bookmarks.list', body: fx('bookmarks') },
      { method: 'bookmarks.remove', body: fx('ok') }
    ])
    await slackAdapter.apply(
      del.ctx,
      {
        kind: 'delete',
        type: 'slack.bookmark',
        resourceId: null,
        externalId: 'C0TEST001/Bk0TEST001',
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      null
    )
    expect(writes(del.calls).map((c) => c.method)).toEqual(['bookmarks.remove'])
  })

  it('bookmark: an http link is refused, and a bookmark in another channel is a TARGET_MISMATCH', async () => {
    const { ctx } = harness([AUTH, { method: 'bookmarks.list', body: fx('bookmarks') }])
    const bad = desired(
      'slack.bookmark',
      { title: 'x', link: 'http://insecure.example.test/' },
      { channel: 'C0TEST001' }
    )
    await expect(
      slackAdapter.apply(ctx, slackAdapter.plan(ctx, bad, null)[0]!, bad)
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    const d = desired(
      'slack.bookmark',
      { title: 'x', link: 'https://ok.example.test/' },
      { channel: 'C0TEST001' }
    )
    await expect(
      slackAdapter.apply(
        ctx,
        {
          kind: 'update',
          type: 'slack.bookmark',
          resourceId: 7,
          externalId: 'C0OTHER99/Bk0TEST001',
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        d
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('findExisting names a channel with the same name in the pinned workspace', async () => {
    const { ctx } = harness([AUTH, { method: 'conversations.list', body: fx('channels-list') }])
    const hit = await slackAdapter.findExisting!(
      ctx,
      'slack.channel',
      desired('slack.channel', channelFields)
    )
    expect(hit?.externalId).toBe('C0TEST001')
    const none = harness([AUTH, { method: 'conversations.list', body: fx('channels-list') }])
    expect(
      await slackAdapter.findExisting!(
        none.ctx,
        'slack.channel',
        desired('slack.channel', { ...channelFields, name: 'other' })
      )
    ).toBeNull()
  })
})

describe('slack adapter: notify', () => {
  it('notify sends one message as a Block Kit card with a link button and escaped text', async () => {
    const { ctx, calls } = harness([AUTH, { method: 'chat.postMessage', body: fx('post-ok') }])
    const r = await slackAdapter.notify!(ctx, row(), MSG)
    expect(r.ok).toBe(true)
    const posts = calls.filter((c) => c.method === 'chat.postMessage')
    expect(posts).toHaveLength(1)
    const post = posts[0]!
    expect(post.form.get('channel')).toBe('C0TEST001')
    expect(post.form.get('thread_ts')).toBeNull()
    const blocks = JSON.parse(post.form.get('blocks') ?? '[]')
    expect(blocks.map((b: any) => b.type)).toEqual(['header', 'section', 'context', 'actions'])
    expect(blocks[1].text.text).toBe('Build 41 &lt;failed&gt; &amp; stopped.')
    expect(blocks[3].elements[0].url).toBe('https://hub.example.test/hub/deploys')
    expect(post.form.toString()).not.toContain('xoxb')
  })

  it('does not put a non-https link on a button', async () => {
    const { ctx, calls } = harness([AUTH, { method: 'chat.postMessage', body: fx('post-ok') }])
    await slackAdapter.notify!(ctx, row(), { ...MSG, link: 'javascript:alert(1)' })
    const blocks = JSON.parse(
      calls.find((c) => c.method === 'chat.postMessage')!.form.get('blocks')!
    )
    expect(blocks.map((b: any) => b.type)).not.toContain('actions')
  })

  it('an incident opens one thread; updates and the resolve reply in it', async () => {
    const { ctx, calls } = harness([
      AUTH,
      { method: 'chat.postMessage', body: fx('post-ok'), once: true },
      { method: 'chat.postMessage', body: fx('post-reply-ok') }
    ])
    const key = 'hub-incident-42'
    await slackAdapter.notify!(ctx, row(), { ...MSG, dedupKey: key, action: 'open' })
    await slackAdapter.notify!(ctx, row(), { ...MSG, dedupKey: key, action: 'update' })
    await slackAdapter.notify!(ctx, row(), { ...MSG, dedupKey: key, action: 'resolve' })
    await slackAdapter.notify!(ctx, row(), { ...MSG, dedupKey: key, action: 'open' })
    const posts = calls.filter((c) => c.method === 'chat.postMessage')
    expect(posts.map((p) => p.form.get('thread_ts'))).toEqual([
      null,
      '1700000000.000100',
      '1700000000.000100',
      null
    ])
  })

  it('replies in the thread the engine remembered (after a restart) and answers it back', async () => {
    const { ctx, calls } = harness([
      AUTH,
      { method: 'chat.postMessage', body: fx('post-reply-ok') }
    ])
    const key = 'incident:42'
    const r = await slackAdapter.notify!(ctx, row(), {
      ...MSG,
      dedupKey: key,
      action: 'update',
      threadRef: '1699999999.000900'
    })
    expect(r.answer).toMatchObject({ threadRef: '1699999999.000900', threaded: true })
    // A remembered value that is not a Slack ts is never sent as thread_ts.
    const bad = await slackAdapter.notify!(ctx, row(), {
      ...MSG,
      dedupKey: 'incident:43',
      action: 'update',
      threadRef: 'C0OTHER/../x'
    })
    expect(bad.answer?.threadRef).not.toBe('C0OTHER/../x')
    const posts = calls.filter((c) => c.method === 'chat.postMessage')
    expect(posts.map((p) => p.form.get('thread_ts'))).toEqual(['1699999999.000900', null])
    // A resolve answers no thread to keep.
    const done = await slackAdapter.notify!(ctx, row(), {
      ...MSG,
      dedupKey: key,
      action: 'resolve',
      threadRef: '1699999999.000900'
    })
    expect(done.answer?.threadRef).toBeUndefined()
  })

  it('notify maps 429 to retryable with the retry-after in the text', async () => {
    const { ctx } = harness([
      AUTH,
      {
        method: 'chat.postMessage',
        status: 429,
        headers: { 'retry-after': '7' },
        body: fx('error-ratelimited')
      }
    ])
    const r = await slackAdapter.notify!(ctx, row(), MSG)
    expect(r.ok).toBe(false)
    expect(r.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(r.error?.message).toContain('7 s')
  })

  it('a refusal is not retryable and never shows the token; other types do not send', async () => {
    const { ctx } = harness([AUTH, { method: 'chat.postMessage', body: fx('error-missing-scope') }])
    const r = await slackAdapter.notify!(ctx, row(), MSG)
    expect(r.error).toMatchObject({ code: 'MISSING_SCOPE', retryable: false })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    const other = await slackAdapter.notify!(ctx, row({ type: 'slack.bookmark' }), MSG)
    expect(other.error?.code).toBe('NOT_A_SENDER')
  })
})

describe('slack adapter: health and failures', () => {
  it('health: ok, warns when archived, down when gone', async () => {
    const a = harness([AUTH, { method: 'conversations.info', body: fx('channel-info') }])
    expect((await slackAdapter.health!(a.ctx, 'slack.channel', 'C0TEST001')).status).toBe('ok')
    const b = harness([AUTH, { method: 'conversations.info', body: fx('channel-info-archived') }])
    expect((await slackAdapter.health!(b.ctx, 'slack.channel', 'C0TEST001')).status).toBe('warn')
    const c = harness([AUTH, { method: 'conversations.info', body: fx('error-channel-not-found') }])
    expect((await slackAdapter.health!(c.ctx, 'slack.channel', 'C0TEST001')).status).toBe('down')
  })

  it('maps 429 to retryable on an apply and a Slack ratelimited answer too', async () => {
    const a = harness([
      AUTH,
      { method: 'conversations.create', status: 429, headers: { 'retry-after': '3' } }
    ])
    const d = desired('slack.channel', channelFields)
    const err = await slackAdapter
      .apply(a.ctx, slackAdapter.plan(a.ctx, d, null)[0]!, d)
      .catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ retryable: true, status: 429, code: 'RATE_LIMITED' })
    const b = harness([AUTH, { method: 'conversations.create', body: fx('error-ratelimited') }])
    await expect(
      slackAdapter.apply(b.ctx, slackAdapter.plan(b.ctx, d, null)[0]!, d)
    ).rejects.toMatchObject({ retryable: true })
  })

  it('an auth failure is not retryable', async () => {
    const { ctx } = harness([{ method: 'auth.test', body: fx('error-invalid-auth') }])
    await expect(slackAdapter.observe(ctx, 'slack.channel', 'C0TEST001')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      retryable: false
    })
  })
})
