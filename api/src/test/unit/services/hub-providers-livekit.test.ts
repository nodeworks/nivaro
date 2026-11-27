import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { CORE_PROVIDERS, ensureCoreProviders } from '../../../services/hub/providers/index.js'
import { livekitAdapter } from '../../../services/hub/providers/livekit/index.js'
import * as registry from '../../../services/hub/providers/registry.js'
import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError
} from '../../../services/hub/providers/types.js'
import { appSettingAllowed } from '../../../services/hub-link/settings-allow.js'
import { verifyLiveKitToken } from '../../../services/huddle-sfu.js'

// Hub providers Task 35: the LiveKit Cloud adapter against recorded (fake-valued) Twirp answers.

const FIX = join(import.meta.dirname, '../../../services/hub/providers/livekit/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const HOST = 'demo-abc123.livekit.cloud'
const URL_ = `wss://${HOST}`
const KEY = 'APItestkey0001'
const SECRET = 'test-secret-lk-0001'
const PASTED_KEY = 'APIpasted00002'
const PASTED_SECRET = 'test-secret-lk-pasted-0002'
const ROOM = 'nvr-0000000000000000000000000000aaaa'
const EGRESS = 'EG_fakeegress01'
const TRUNK_IN = 'ST_fakein000001'
const TRUNK_OUT = 'ST_fakeout00001'

interface Call {
  service: string
  method: string
  body: any
  headers: Record<string, string>
  url: string
}
interface Route {
  method: string
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Answers only when the body matches. */
  when?: (body: any) => boolean
}

function harness(routes: Route[]) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const m = u.pathname.match(/^\/twirp\/([^/]+)\/([^/]+)$/)
    const call: Call = {
      service: m?.[1] ?? '',
      method: m?.[2] ?? '',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {},
      url
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === call.method && (!r.when || r.when(call.body)))
    if (!hit) return new Response('{"code":"not_found","msg":"no such method"}', { status: 404 })
    const status = hit.status ?? 200
    return new Response(JSON.stringify(hit.body ?? {}), { status, headers: hit.headers })
  }
  const ctx = makeProviderContext({
    adapter: livekitAdapter,
    connectionId: 1,
    config: { url: URL_, apiKey: KEY },
    secrets: { apiSecret: SECRET },
    now: () => new Date('2026-11-27T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

function desired(
  type: string,
  fields: Record<string, unknown>,
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
    refs: {},
    tags: {}
  }
}

const op = (type: string, over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'update',
  type,
  resourceId: 7,
  externalId: null,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const spec = (type: string) => livekitAdapter.types.find((t) => t.key === type)!
const T = {
  project: 'livekit.project',
  apiKey: 'livekit.api_key',
  room: 'livekit.room',
  egress: 'livekit.egress',
  sip: 'livekit.sip_trunk'
}

const trunkObs = (over: Record<string, unknown> = {}): Observed => ({
  type: T.sip,
  externalId: TRUNK_IN,
  name: 'front-desk',
  fields: {
    direction: 'inbound',
    name: 'front-desk',
    numbers: ['+15105550100'],
    allowed_addresses: ['203.0.113.0/24'],
    allowed_numbers: [],
    address: null,
    auth_username: 'hub-user',
    ...over
  },
  tags: {}
})

const roomObs = (): Observed => ({
  type: T.room,
  externalId: ROOM,
  name: ROOM,
  fields: { name: ROOM, participants: 3, publishers: 2, recording: false, created_at: null },
  tags: {}
})

const egressObs = (status = 'active'): Observed => ({
  type: T.egress,
  externalId: EGRESS,
  name: EGRESS,
  fields: { id: EGRESS, room: 'x', status, started_at: null },
  tags: {}
})

beforeEach(() => {
  registry.resetProvidersForTest()
})

describe('livekit adapter: registration', () => {
  it('is a core provider on the project host only, with a sealed secret', () => {
    ensureCoreProviders()
    expect(registry.getProvider('livekit')).toBe(livekitAdapter)
    expect(CORE_PROVIDERS).toContain(livekitAdapter)
    expect(livekitAdapter.connection.hosts({ url: URL_ })).toEqual([HOST])
    // Anything that is not a *.livekit.cloud address allows no host at all.
    for (const bad of [
      'wss://evil.example.com',
      'wss://demo.livekit.cloud.evil.com',
      'http://demo.livekit.cloud',
      'wss://user:pw@demo.livekit.cloud',
      'wss://demo.livekit.cloud:8443',
      'wss://demo.livekit.cloud/path',
      ''
    ])
      expect(livekitAdapter.connection.hosts({ url: bad }), bad).toEqual([])
    const f = (k: string) => livekitAdapter.connection.fields.find((x) => x.key === k)
    expect(f('apiSecret')?.secret).toBe(true)
    expect(f('apiKey')?.secret).toBeFalsy()
    expect(livekitAdapter.connection.describe({ url: URL_ })).not.toContain(SECRET)
    expect(livekitAdapter.connection.validate?.({ url: 'nope', apiKey: 'x' }, {})).not.toEqual([])
    expect(
      livekitAdapter.connection.validate?.({ url: URL_, apiKey: KEY }, { apiSecret: SECRET })
    ).toEqual([])
    expect(livekitAdapter.types.map((t) => t.key)).toEqual(Object.values(T))
  })

  it('refuses a host other than the project host', async () => {
    const { ctx } = harness([])
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })

  it('has no cost class (LiveKit bills usage) and no migration-style extras', () => {
    for (const t of livekitAdapter.types) expect(t.costClass).toBeUndefined()
  })
})

describe('livekit adapter: tokens', () => {
  it('signs an HS256 token with the key and the right grant for the call', async () => {
    const { ctx, calls } = harness([{ method: 'ListRooms', body: fx('rooms') }])
    await livekitAdapter.list(ctx, T.room)
    const token = String(calls[0].headers.authorization).replace('Bearer ', '')
    const claims = verifyLiveKitToken(token, SECRET, ctx.now().getTime())
    expect(claims?.iss).toBe(KEY)
    expect(claims?.video.roomList).toBe(true)
    expect(calls[0].url).toBe(`https://${HOST}/twirp/livekit.RoomService/ListRooms`)
    expect(verifyLiveKitToken(token, 'wrong-secret', ctx.now().getTime())).toBeNull()
  })
})

describe('livekit adapter: testConnection', () => {
  it('lists every permission missing when the key is refused, scrubbed', async () => {
    const { ctx } = harness([{ method: 'ListRooms', status: 401, body: fx('error-unauthorized') }])
    const r = await livekitAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.missing).toHaveLength(3)
    expect(r.message).toContain('LiveKit answered 401')
    expect(r.message).not.toContain(SECRET)
  })

  it('answers the project and marks SIP missing when the project has no SIP', async () => {
    const { ctx } = harness([
      { method: 'ListRooms', body: fx('rooms') },
      { method: 'ListEgress', body: fx('egress-list') },
      {
        method: 'ListSIPInboundTrunk',
        status: 403,
        body: { code: 'permission_denied', msg: 'sip not enabled' }
      },
      {
        method: 'ListSIPOutboundTrunk',
        status: 403,
        body: { code: 'permission_denied', msg: 'sip not enabled' }
      }
    ])
    const r = await livekitAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toContain(HOST)
    expect(r.identity).toContain('2 rooms open')
    expect(r.missing).toEqual(['manage SIP trunks (SIP must be on for the project)'])
  })
})

describe('livekit adapter: observe and list', () => {
  it('the project is the connection: rooms and people as figures, any other id is outside it', async () => {
    const { ctx } = harness([{ method: 'ListRooms', body: fx('rooms') }])
    const seen = await livekitAdapter.observe(ctx, T.project, HOST)
    expect(seen).toMatchObject({
      type: T.project,
      externalId: HOST,
      fields: { url: URL_, rooms: 2, participants: 4 }
    })
    expect(await livekitAdapter.observe(ctx, T.project, 'other.livekit.cloud')).toBeNull()
    const page = await livekitAdapter.list(ctx, T.project)
    expect(page.items.map((i) => i.externalId)).toEqual([HOST])
  })

  it('a room observes by name (camelCase answers too); a missing room is gone', async () => {
    const { ctx, calls } = harness([{ method: 'ListRooms', body: fx('room-one') }])
    const seen = await livekitAdapter.observe(ctx, T.room, ROOM)
    expect(seen?.fields).toMatchObject({
      name: ROOM,
      participants: 3,
      publishers: 2,
      recording: false
    })
    expect(calls[0].body).toEqual({ names: [ROOM] })
    const { ctx: c2 } = harness([{ method: 'ListRooms', body: { rooms: [] } }])
    expect(await livekitAdapter.observe(c2, T.room, ROOM)).toBeNull()
    const page = await livekitAdapter.list(
      harness([{ method: 'ListRooms', body: fx('rooms') }]).ctx,
      T.room
    )
    expect(page.items).toHaveLength(2)
    expect(page.cursor).toBeNull()
  })

  it('an egress maps its status words; list asks for active ones', async () => {
    const { ctx, calls } = harness([{ method: 'ListEgress', body: fx('egress-list') }])
    const page = await livekitAdapter.list(ctx, T.egress)
    expect(page.items.map((i) => i.fields.status)).toEqual(['active', 'complete'])
    expect(calls[0].body).toEqual({ active: true })
    const one = harness([{ method: 'ListEgress', body: fx('egress-one-active') }]).ctx
    expect((await livekitAdapter.observe(one, T.egress, EGRESS))?.fields.status).toBe('active')
    const gone = harness([{ method: 'ListEgress', body: { items: [] } }]).ctx
    expect(await livekitAdapter.observe(gone, T.egress, EGRESS)).toBeNull()
  })

  it('a trunk is found in either list and never carries a password', async () => {
    const routes: Route[] = [
      { method: 'ListSIPInboundTrunk', body: fx('sip-inbound-list') },
      { method: 'ListSIPOutboundTrunk', body: fx('sip-outbound-list') }
    ]
    const { ctx } = harness(routes)
    const a = await livekitAdapter.observe(ctx, T.sip, TRUNK_IN)
    expect(a?.fields).toMatchObject({
      direction: 'inbound',
      name: 'front-desk',
      allowed_addresses: ['203.0.113.0/24'],
      auth_username: 'hub-user'
    })
    const b = await livekitAdapter.observe(harness(routes).ctx, T.sip, TRUNK_OUT)
    expect(b?.fields).toMatchObject({ direction: 'outbound', address: 'sip.example.com' })
    expect(JSON.stringify([a, b]).toLowerCase()).not.toContain('password')
    const page = await livekitAdapter.list(harness(routes).ctx, T.sip)
    expect(page.items.map((i) => i.externalId)).toEqual([TRUNK_IN, TRUNK_OUT])
    expect(await livekitAdapter.observe(harness(routes).ctx, T.sip, 'ST_nothere0001')).toBeNull()
  })

  it('refuses an id that is not a safe value, with no call made', async () => {
    const { ctx, calls } = harness([])
    for (const [type, bad] of [
      [T.egress, '../x'],
      [T.egress, 'a/b'],
      [T.sip, ''],
      [T.sip, 'ST_x y'],
      [T.room, 'a\nb'],
      [T.room, ''],
      [T.apiKey, 'a\\b']
    ] as const)
      await expect(livekitAdapter.observe(ctx, type, bad)).rejects.toMatchObject({ code: 'BAD_ID' })
    expect(calls).toEqual([])
  })

  it('an API key has nothing to adopt and observes as registered once the project answers', async () => {
    const { ctx } = harness([{ method: 'ListRooms', body: fx('rooms') }])
    expect((await livekitAdapter.list(ctx, T.apiKey)).items).toEqual([])
    const seen = await livekitAdapter.observe(ctx, T.apiKey, KEY)
    expect(seen).toMatchObject({ externalId: KEY, status: 'registered', fields: { api_key: KEY } })
    expect(JSON.stringify(seen)).not.toContain(SECRET)
  })
})

describe('livekit adapter: plan', () => {
  const { ctx } = harness([])

  it('a project is adopt only: planning a create says to make it in the dashboard', () => {
    expect(() => livekitAdapter.plan(ctx, desired(T.project, {}), null)).toThrowError(/dashboard/)
    expect(livekitAdapter.plan(ctx, null, null)).toEqual([])
  })

  it('an API key create says nothing is made at LiveKit; no change is nothing', () => {
    const [p] = livekitAdapter.plan(
      ctx,
      desired(T.apiKey, {
        api_key: PASTED_KEY,
        api_secret: { fingerprint: 'abcd', changed: true }
      }),
      null
    )
    expect(p.kind).toBe('create')
    expect(p.reason).toContain('Nothing is created at LiveKit')
    expect(p.reason).toContain('LiveKit API key')
    expect(p.changes).toEqual([
      { field: 'api_key', to: PASTED_KEY },
      { field: 'api_secret', secret: true }
    ])
    const seen: Observed = {
      type: T.apiKey,
      externalId: PASTED_KEY,
      name: PASTED_KEY,
      fields: { api_key: PASTED_KEY },
      tags: {}
    }
    expect(
      livekitAdapter.plan(
        ctx,
        desired(
          T.apiKey,
          { api_key: PASTED_KEY, api_secret: { fingerprint: 'abcd', changed: false } },
          PASTED_KEY
        ),
        seen
      )
    ).toEqual([])
    const [u] = livekitAdapter.plan(
      ctx,
      desired(
        T.apiKey,
        { api_key: PASTED_KEY, api_secret: { fingerprint: 'ef01', changed: true } },
        PASTED_KEY
      ),
      seen
    )
    expect(u.kind).toBe('update')
    expect(u.reason).toContain('API secret')
    const [d] = livekitAdapter.plan(ctx, null, seen)
    expect(d.kind).toBe('delete')
    expect(d.reason).toContain('Nothing is deleted at LiveKit')
  })

  it('closing a room is a named op with the room in op.data; off means no op', () => {
    const [p] = livekitAdapter.plan(ctx, desired(T.room, { close: true }, ROOM), roomObs())
    expect(p).toMatchObject({
      kind: 'update',
      action: 'close',
      externalId: ROOM,
      data: { room: ROOM }
    })
    expect(p.reason).toContain('LiveKit room')
    expect(p.reason).toContain('3 connected people')
    expect(livekitAdapter.plan(ctx, desired(T.room, { close: false }, ROOM), roomObs())).toEqual([])
    expect(() => livekitAdapter.plan(ctx, desired(T.room, { close: true }), null)).toThrowError(
      /Adopt/
    )
  })

  it('stopping an egress plans only while it is live', () => {
    const [p] = livekitAdapter.plan(
      ctx,
      desired(T.egress, { stop: true }, EGRESS),
      egressObs('active')
    )
    expect(p).toMatchObject({ action: 'stop', data: { egress_id: EGRESS } })
    expect(
      livekitAdapter.plan(ctx, desired(T.egress, { stop: true }, EGRESS), egressObs('complete'))
    ).toEqual([])
  })

  it('a trunk create names the open-to-anyone case; a direction change is a replace', () => {
    const [open] = livekitAdapter.plan(
      ctx,
      desired(T.sip, { direction: 'inbound', name: 'wide', numbers: ['+15105550100'] }),
      null
    )
    expect(open.kind).toBe('create')
    expect(open.reason).toContain('anyone on the internet')
    const [safe] = livekitAdapter.plan(
      ctx,
      desired(T.sip, { direction: 'inbound', name: 'ok', allowed_addresses: ['203.0.113.0/24'] }),
      null
    )
    expect(safe.reason).not.toContain('anyone on the internet')
    const [r] = livekitAdapter.plan(
      ctx,
      desired(
        T.sip,
        { direction: 'outbound', name: 'front-desk', address: 'sip.example.com' },
        TRUNK_IN
      ),
      trunkObs()
    )
    expect(r.kind).toBe('replace')
    expect(r.reason).toContain('Direction')
  })

  it('a trunk update lists changed fields; a changed password shows as a secret change', () => {
    const [u] = livekitAdapter.plan(
      ctx,
      desired(
        T.sip,
        {
          direction: 'inbound',
          name: 'front-desk',
          numbers: ['+15105550100', '+15105550199'],
          allowed_addresses: ['203.0.113.0/24'],
          auth_username: 'hub-user',
          auth_password: { fingerprint: 'aaaa', changed: true }
        },
        TRUNK_IN
      ),
      trunkObs()
    )
    expect(u.kind).toBe('update')
    expect(u.changes.map((c) => c.field)).toEqual(['numbers', 'auth_password'])
    expect(u.changes[1]).toEqual({ field: 'auth_password', secret: true })
    expect(
      livekitAdapter.plan(
        ctx,
        desired(
          T.sip,
          {
            direction: 'inbound',
            name: 'front-desk',
            numbers: ['+15105550100'],
            allowed_addresses: ['203.0.113.0/24'],
            auth_username: 'hub-user'
          },
          TRUNK_IN
        ),
        trunkObs()
      )
    ).toEqual([])
    const [d] = livekitAdapter.plan(ctx, null, trunkObs())
    expect(d.kind).toBe('delete')
  })
})

describe('livekit adapter: risk flags', () => {
  const r = (type: string, o: Partial<PlannedOp>, d: DesiredResource | null = null) =>
    spec(type).risk(op(type, o), d)

  it('closing a room is destructive; stopping an egress is downtime', () => {
    expect(r(T.room, { action: 'close' })).toEqual(['destructive'])
    expect(r(T.egress, { action: 'stop' })).toEqual(['downtime'])
    expect(r(T.apiKey, { kind: 'create' })).toEqual([])
  })

  it('an inbound trunk with no address limit and no login is public_exposure (judged on what is sent)', () => {
    const wide = desired(T.sip, { direction: 'inbound', name: 'x', numbers: ['+15105550100'] })
    expect(r(T.sip, { kind: 'create' }, wide)).toEqual(['public_exposure'])
    const anyCidr = desired(T.sip, {
      direction: 'inbound',
      name: 'x',
      allowed_addresses: ['0.0.0.0/0']
    })
    expect(r(T.sip, { kind: 'create' }, anyCidr)).toEqual(['public_exposure'])
    const v6 = desired(T.sip, { direction: 'inbound', name: 'x', allowed_addresses: ['::/0'] })
    expect(r(T.sip, { kind: 'update' }, v6)).toEqual(['public_exposure'])
    const limited = desired(T.sip, {
      direction: 'inbound',
      name: 'x',
      allowed_addresses: ['203.0.113.0/24']
    })
    expect(r(T.sip, { kind: 'create' }, limited)).toEqual([])
    const login = desired(T.sip, { direction: 'inbound', name: 'x', auth_username: 'u' })
    expect(r(T.sip, { kind: 'create' }, login)).toEqual([])
    const outbound = desired(T.sip, {
      direction: 'outbound',
      name: 'x',
      address: 'sip.example.com'
    })
    expect(r(T.sip, { kind: 'create' }, outbound)).toEqual([])
    expect(r(T.sip, { kind: 'delete' })).toEqual(['destructive'])
    expect(r(T.sip, { kind: 'replace' }, limited)).toEqual(['destructive'])
  })
})

describe('livekit adapter: apply', () => {
  const keyDesired = (secret = PASTED_SECRET) =>
    desired(T.apiKey, {
      api_key: PASTED_KEY,
      api_secret: { fingerprint: 'abcd', changed: true, plain: secret }
    })

  it('registering a pasted key checks it with that key, then answers the three outputs', async () => {
    const { ctx, calls } = harness([{ method: 'ListRooms', body: fx('rooms') }])
    const res = await livekitAdapter.apply(ctx, op(T.apiKey, { kind: 'create' }), keyDesired())
    expect(res.ok).toBe(true)
    expect(res.externalId).toBe(PASTED_KEY)
    expect(res.outputs).toEqual({ api_key: PASTED_KEY, api_secret: PASTED_SECRET, url: URL_ })
    const token = String(calls[0].headers.authorization).replace('Bearer ', '')
    expect(verifyLiveKitToken(token, PASTED_SECRET, ctx.now().getTime())?.iss).toBe(PASTED_KEY)
    expect(JSON.stringify(res.observed)).not.toContain(PASTED_SECRET)
    expect(JSON.stringify(res.answer)).not.toContain(PASTED_SECRET)
    expect(calls.every((c) => c.method === 'ListRooms')).toBe(true)
  })

  it('a pasted key the project refuses is KEY_NOT_ACCEPTED and its secret is in no error', async () => {
    const { ctx } = harness([
      {
        method: 'ListRooms',
        status: 401,
        body: { code: 'unauthenticated', msg: `bad token ${PASTED_SECRET}` }
      }
    ])
    const err: ProviderError = await livekitAdapter
      .apply(ctx, op(T.apiKey, { kind: 'create' }), keyDesired())
      .catch((e) => e)
    expect(err).toMatchObject({ code: 'KEY_NOT_ACCEPTED', retryable: false })
    expect(err.message).not.toContain(PASTED_SECRET)
    const noSecret = harness([]).ctx
    await expect(
      livekitAdapter.apply(
        noSecret,
        op(T.apiKey, { kind: 'create' }),
        desired(T.apiKey, { api_key: PASTED_KEY })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
  })

  it('forgetting a key calls nothing at LiveKit', async () => {
    const { ctx, calls } = harness([])
    const res = await livekitAdapter.apply(
      ctx,
      op(T.apiKey, { kind: 'delete', externalId: PASTED_KEY }),
      null
    )
    expect(res).toMatchObject({ ok: true, externalId: PASTED_KEY, observed: null })
    expect(calls).toEqual([])
  })

  it('closing a room reads first, then deletes exactly the desired room', async () => {
    const { ctx, calls } = harness([
      { method: 'ListRooms', body: fx('room-one') },
      { method: 'DeleteRoom', body: {} }
    ])
    const res = await livekitAdapter.apply(
      ctx,
      op(T.room, { action: 'close', externalId: ROOM, data: { room: ROOM } }),
      desired(T.room, { close: true }, ROOM)
    )
    expect(res).toMatchObject({
      ok: true,
      externalId: ROOM,
      observed: null,
      answer: { closed: true }
    })
    const del = calls.find((c) => c.method === 'DeleteRoom')
    expect(del?.body).toEqual({ room: ROOM })
    const token = String(del?.headers.authorization).replace('Bearer ', '')
    expect(verifyLiveKitToken(token, SECRET, ctx.now().getTime())?.video).toMatchObject({
      roomAdmin: true,
      room: ROOM
    })
  })

  it('closing a room that is already gone deletes nothing', async () => {
    const { ctx, calls } = harness([{ method: 'ListRooms', body: { rooms: [] } }])
    const res = await livekitAdapter.apply(
      ctx,
      op(T.room, { action: 'close', externalId: ROOM }),
      desired(T.room, { close: true }, ROOM)
    )
    expect(res.answer).toEqual({ already: 'closed' })
    expect(calls.some((c) => c.method === 'DeleteRoom')).toBe(false)
  })

  it('a named op whose target is not the desired one is TARGET_MISMATCH, nothing sent', async () => {
    const { ctx, calls } = harness([])
    await expect(
      livekitAdapter.apply(
        ctx,
        op(T.room, { action: 'close', externalId: 'nvr-other' }),
        desired(T.room, { close: true }, ROOM)
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    await expect(
      livekitAdapter.apply(
        ctx,
        op(T.room, { action: 'close', externalId: ROOM, data: { room: 'nvr-other' } }),
        desired(T.room, { close: true }, ROOM)
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    await expect(
      livekitAdapter.apply(
        ctx,
        op(T.egress, { action: 'stop', externalId: 'EG_other00001' }),
        desired(T.egress, { stop: true }, EGRESS)
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    await expect(
      livekitAdapter.apply(ctx, op(T.room, { action: 'close', externalId: ROOM }), null)
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(calls).toEqual([])
  })

  it('op.data is compared, never sent: the mutation variables come from desired', async () => {
    const { ctx, calls } = harness([
      { method: 'ListEgress', body: fx('egress-one-active') },
      { method: 'StopEgress', body: {} }
    ])
    await livekitAdapter.apply(
      ctx,
      op(T.egress, {
        action: 'stop',
        externalId: EGRESS,
        data: { egress_id: EGRESS, extra: 'nope' }
      }),
      desired(T.egress, { stop: true }, EGRESS)
    )
    expect(calls.find((c) => c.method === 'StopEgress')?.body).toEqual({ egress_id: EGRESS })
  })

  it('stopping an egress that already ended stops nothing', async () => {
    const { ctx, calls } = harness([{ method: 'ListEgress', body: fx('egress-one-complete') }])
    const res = await livekitAdapter.apply(
      ctx,
      op(T.egress, { action: 'stop', externalId: EGRESS }),
      desired(T.egress, { stop: true }, EGRESS)
    )
    expect(res.answer).toEqual({ already: 'ended' })
    expect(calls.some((c) => c.method === 'StopEgress')).toBe(false)
  })

  it('a trunk create posts once with the password sent and not echoed', async () => {
    const { ctx, calls } = harness([
      { method: 'ListSIPInboundTrunk', body: { items: [] } },
      { method: 'ListSIPOutboundTrunk', body: { items: [] } },
      { method: 'CreateSIPInboundTrunk', body: fx('sip-inbound-created') }
    ])
    const res = await livekitAdapter.apply(
      ctx,
      op(T.sip, { kind: 'create' }),
      desired(T.sip, {
        direction: 'inbound',
        name: 'new-line',
        numbers: ['+15105550102'],
        allowed_addresses: ['198.51.100.0/24'],
        auth_username: 'hub-user',
        auth_password: { fingerprint: 'zz', changed: true, plain: 'test-secret-sip-0001' }
      })
    )
    expect(res.externalId).toBe('ST_fakein000002')
    const post = calls.find((c) => c.method === 'CreateSIPInboundTrunk')
    expect(post?.body.trunk).toMatchObject({
      name: 'new-line',
      numbers: ['+15105550102'],
      allowed_addresses: ['198.51.100.0/24'],
      auth_username: 'hub-user',
      auth_password: 'test-secret-sip-0001'
    })
    expect(JSON.stringify(res)).not.toContain('test-secret-sip-0001')
  })

  it('create over a trunk the Hub did not make is ALREADY_EXISTS; findExisting names it', async () => {
    const routes: Route[] = [
      { method: 'ListSIPInboundTrunk', body: fx('sip-inbound-list') },
      { method: 'ListSIPOutboundTrunk', body: fx('sip-outbound-list') }
    ]
    const want = desired(T.sip, {
      direction: 'inbound',
      name: 'front-desk',
      allowed_addresses: ['203.0.113.0/24']
    })
    const { ctx, calls } = harness(routes)
    await expect(
      livekitAdapter.apply(ctx, op(T.sip, { kind: 'create' }), want)
    ).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      retryable: false
    })
    expect(calls.filter((c) => c.method.startsWith('Create'))).toEqual([])
    const hit = await livekitAdapter.findExisting?.(harness(routes).ctx, T.sip, want)
    expect(hit?.externalId).toBe(TRUNK_IN)
    expect(
      await livekitAdapter.findExisting?.(
        harness(routes).ctx,
        T.sip,
        desired(T.sip, { name: 'zzz' })
      )
    ).toBeNull()
  })

  it('a resumed trunk create with its id recorded posts nothing', async () => {
    const { ctx, calls } = harness([
      { method: 'ListSIPInboundTrunk', body: fx('sip-inbound-list') },
      { method: 'ListSIPOutboundTrunk', body: fx('sip-outbound-list') }
    ])
    const res = await livekitAdapter.apply(
      ctx,
      op(T.sip, { kind: 'create' }),
      desired(T.sip, { direction: 'inbound', name: 'front-desk' }, TRUNK_IN)
    )
    expect(res.answer).toEqual({ already: 'exists' })
    expect(calls.filter((c) => c.method.startsWith('Create'))).toEqual([])
  })

  it('refuses a trunk with a bad shape before any write', async () => {
    const { ctx, calls } = harness([])
    for (const fields of [
      { direction: 'inbound', name: 'x', allowed_addresses: ['not-an-ip'] },
      { direction: 'inbound', name: 'x', numbers: ['call-me'] },
      { direction: 'outbound', name: 'x' },
      { direction: 'inbound', name: 'x', auth_username: 'u' },
      { direction: 'inbound', name: '' }
    ])
      await expect(
        livekitAdapter.apply(ctx, op(T.sip, { kind: 'create' }), desired(T.sip, fields))
      ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(calls.filter((c) => c.method.startsWith('Create'))).toEqual([])
  })

  it('an update reads first and writes only what differs; a password goes only when changed', async () => {
    const routes: Route[] = [
      { method: 'ListSIPInboundTrunk', body: fx('sip-inbound-list') },
      { method: 'ListSIPOutboundTrunk', body: fx('sip-outbound-list') },
      { method: 'UpdateSIPInboundTrunk', body: {} }
    ]
    const { ctx, calls } = harness(routes)
    await livekitAdapter.apply(
      ctx,
      op(T.sip, { externalId: TRUNK_IN }),
      desired(
        T.sip,
        {
          direction: 'inbound',
          name: 'front-desk',
          numbers: ['+15105550100', '+15105550199'],
          allowed_addresses: ['203.0.113.0/24'],
          auth_username: 'hub-user'
        },
        TRUNK_IN
      )
    )
    const post = calls.find((c) => c.method === 'UpdateSIPInboundTrunk')
    expect(post?.body).toEqual({
      sip_trunk_id: TRUNK_IN,
      update: { numbers: { set: ['+15105550100', '+15105550199'] } }
    })
    const same = harness(routes)
    const again = await livekitAdapter.apply(
      same.ctx,
      op(T.sip, { externalId: TRUNK_IN }),
      desired(
        T.sip,
        {
          direction: 'inbound',
          name: 'front-desk',
          numbers: ['+15105550100'],
          allowed_addresses: ['203.0.113.0/24'],
          auth_username: 'hub-user'
        },
        TRUNK_IN
      )
    )
    expect(again.answer).toEqual({ already: 'matches' })
    expect(same.calls.some((c) => c.method.startsWith('Update'))).toBe(false)
  })

  it('delete removes a trunk; a trunk already gone is a success; replace deletes then creates', async () => {
    const { ctx, calls } = harness([{ method: 'DeleteSIPTrunk', body: {} }])
    const res = await livekitAdapter.apply(
      ctx,
      op(T.sip, { kind: 'delete', externalId: TRUNK_IN }),
      null
    )
    expect(res).toMatchObject({ ok: true, externalId: TRUNK_IN, observed: null })
    expect(calls[0].body).toEqual({ sip_trunk_id: TRUNK_IN })
    const gone = harness([
      { method: 'DeleteSIPTrunk', status: 404, body: { code: 'not_found', msg: 'no' } }
    ]).ctx
    expect(
      (await livekitAdapter.apply(gone, op(T.sip, { kind: 'delete', externalId: TRUNK_IN }), null))
        .ok
    ).toBe(true)
    const rep = harness([
      { method: 'DeleteSIPTrunk', body: {} },
      { method: 'ListSIPInboundTrunk', body: { items: [] } },
      { method: 'ListSIPOutboundTrunk', body: { items: [] } },
      {
        method: 'CreateSIPOutboundTrunk',
        body: { sip_trunk_id: 'ST_fakeout00002', name: 'front-desk', address: 'sip.example.com' }
      }
    ])
    const out = await livekitAdapter.apply(
      rep.ctx,
      op(T.sip, { kind: 'replace', externalId: TRUNK_IN }),
      desired(
        T.sip,
        { direction: 'outbound', name: 'front-desk', address: 'sip.example.com' },
        TRUNK_IN
      )
    )
    expect(out.externalId).toBe('ST_fakeout00002')
    expect(rep.calls.map((c) => c.method)).toEqual([
      'DeleteSIPTrunk',
      'ListSIPInboundTrunk',
      'ListSIPOutboundTrunk',
      'CreateSIPOutboundTrunk'
    ])
  })

  it('a project is never changed by the Hub', async () => {
    const { ctx } = harness([])
    await expect(
      livekitAdapter.apply(ctx, op(T.project, { kind: 'delete', externalId: HOST }), null)
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})

describe('livekit adapter: errors', () => {
  it('maps 429 to a retryable error and says when to retry', async () => {
    const { ctx } = harness([
      {
        method: 'ListRooms',
        status: 429,
        body: fx('error-resource-exhausted'),
        headers: { 'retry-after': '7' }
      }
    ])
    const err: ProviderError = await livekitAdapter.list(ctx, T.room).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 7 s')
  })

  it('a 5xx is retryable, a 401 and a 400 are not', async () => {
    const mk = (status: number) =>
      harness([{ method: 'ListRooms', status, body: { code: 'x', msg: 'nope' } }]).ctx
    expect(await livekitAdapter.list(mk(503), T.room).catch((e) => e)).toMatchObject({
      retryable: true,
      code: 'PROVIDER_UNAVAILABLE'
    })
    expect(await livekitAdapter.list(mk(401), T.room).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'AUTH_FAILED'
    })
    expect(await livekitAdapter.list(mk(400), T.room).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'PROVIDER_REJECTED'
    })
  })

  it('secrets never appear in errors (scrubbed before the text is clipped)', async () => {
    const { ctx } = harness([{ method: 'ListRooms', status: 401, body: fx('error-unauthorized') }])
    const err: ProviderError = await livekitAdapter.list(ctx, T.room).catch((e) => e)
    expect(err.message).toContain('LiveKit answered 401')
    expect(err.message).not.toContain(SECRET)
    // A secret that straddles the clip point is masked, not cut in half.
    const long = harness([
      { method: 'ListRooms', status: 400, body: { code: 'x', msg: `${'a'.repeat(380)}${SECRET}` } }
    ]).ctx
    const e2: ProviderError = await livekitAdapter.list(long, T.room).catch((e) => e)
    expect(e2.message).not.toContain(SECRET.slice(0, 8))
    expect(e2.message.length).toBeLessThanOrEqual(400)
    const fetchFail = makeProviderContext({
      adapter: livekitAdapter,
      connectionId: 2,
      config: { url: URL_, apiKey: KEY },
      secrets: { apiSecret: SECRET },
      fetch: {
        fetchImpl: (async () => {
          throw new TypeError(`getaddrinfo failed for ${SECRET}`)
        }) as any,
        timeoutMs: 200
      }
    })
    const e3: Error = await livekitAdapter.list(fetchFail, T.room).catch((e) => e)
    expect(e3.message).not.toContain(SECRET)
  })
})

describe('livekit adapter: outputs and bindings', () => {
  it('declares api_key, api_secret and url; the huddle settings accept them', () => {
    const outs = spec(T.apiKey).outputs
    expect(outs).toEqual([
      { key: 'api_key', label: 'LiveKit API key', secret: true },
      { key: 'api_secret', label: 'LiveKit API secret', secret: true, onceOnly: true },
      { key: 'url', label: 'LiveKit server URL', secret: false }
    ])
    for (const k of ['huddle_livekit_url', 'huddle_livekit_key', 'huddle_livekit_secret'])
      expect(appSettingAllowed(k), k).toBe(true)
    for (const t of livekitAdapter.types.filter((x) => x.key !== T.apiKey))
      expect(t.outputs).toBeUndefined()
  })

  it('none leak into observed, desired or a plan; no field of any type holds a secret value', async () => {
    const { ctx } = harness([{ method: 'ListRooms', body: fx('rooms') }])
    const seen = await livekitAdapter.observe(ctx, T.apiKey, PASTED_KEY)
    const [p] = livekitAdapter.plan(
      ctx,
      desired(T.apiKey, {
        api_key: PASTED_KEY,
        api_secret: { fingerprint: 'abcd', changed: true }
      }),
      null
    )
    const text = JSON.stringify([seen, p])
    expect(text).not.toContain(PASTED_SECRET)
    expect(text).not.toContain(SECRET)
    expect(Object.keys(seen?.fields ?? {})).toEqual(['api_key'])
    expect(spec(T.apiKey).fields.find((f) => f.key === 'api_secret')?.kind).toBe('secret')
  })

  it('apply of an update with the same key and no new secret answers no outputs', async () => {
    const { ctx } = harness([])
    const res = await livekitAdapter.apply(
      ctx,
      op(T.apiKey, { kind: 'update', externalId: PASTED_KEY }),
      desired(
        T.apiKey,
        { api_key: PASTED_KEY, api_secret: { fingerprint: 'abcd', changed: false } },
        PASTED_KEY
      )
    )
    expect(res.outputs).toBeUndefined()
    expect(res.answer).toEqual({ already: 'matches' })
  })
})

describe('livekit adapter: health', () => {
  it('the project reports rooms and people; a refused key is down', async () => {
    const { ctx } = harness([{ method: 'ListRooms', body: fx('rooms') }])
    const h = await livekitAdapter.health?.(ctx, T.project, HOST)
    expect(h?.status).toBe('ok')
    expect(h?.details).toMatchObject({ rooms: 2, participants: 4, reachable: true })
    const bad = harness([{ method: 'ListRooms', status: 401, body: fx('error-unauthorized') }]).ctx
    const d = await livekitAdapter.health?.(bad, T.project, HOST)
    expect(d?.status).toBe('down')
    expect(d?.message).not.toContain(SECRET)
  })

  it('a room is ok while open and down when gone; a failed egress warns', async () => {
    const open = harness([{ method: 'ListRooms', body: fx('room-one') }]).ctx
    expect((await livekitAdapter.health?.(open, T.room, ROOM))?.status).toBe('ok')
    const gone = harness([{ method: 'ListRooms', body: { rooms: [] } }]).ctx
    expect((await livekitAdapter.health?.(gone, T.room, ROOM))?.status).toBe('down')
    const failed = harness([
      {
        method: 'ListEgress',
        body: { items: [{ egressId: EGRESS, roomName: 'r', status: 'EGRESS_FAILED' }] }
      }
    ]).ctx
    expect((await livekitAdapter.health?.(failed, T.egress, EGRESS))?.status).toBe('warn')
  })
})
