import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 12: a credential minted while app A is serving is refused while app B is, on
// a Hub shared deployment (one process, one Redis, one SESSION_SECRET), and works exactly as
// before in self-hosted mode. One block per credential type; the guard
// (credential-binding.guard.test.ts) lists every site and how it is bound.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/socket-access.js', async (orig) => ({
  ...(await orig<object>()),
  // The ticket's sign-in still stands (judged elsewhere): only the app check is under test here.
  checkBind: vi.fn(async () => null)
}))

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { config } = await import('../../../config.js')
const binding = await import('../../../services/tenancy/credential-binding.js')
const { mediaTicket, verifyMediaTicket } = await import('../../../services/help-videos.js')
const { exportTicketValue, readExportTicket } = await import(
  '../../../services/help-video-package.js'
)
const { mintStatusToken, readStatusToken } = await import('../../../services/submission-status.js')
const { mintReplyToken, redeemReplyToken } = await import('../../../services/chat-send.js')
const { beginIdempotency } = await import('../../../services/idempotency.js')
const { activeMasquerades, touchMasqueradeMarker } = await import(
  '../../../services/masquerade-marker.js'
)
const { tenantTagRefused } = await import('../../../middleware/authenticate.js')
const { mintStreamTicket, redeemStreamTicket } = await import('../../../services/stream-ticket.js')
const { signActionToken, verifyActionToken } = await import('../../../routes/message-actions.js')
const { issueCode, consumeCode } = await import('../../../services/oauth-store.js')

const A = 'app-a-e1'
const B = 'app-b-e2'
const USER = '11111111-2222-4333-8444-555555555555'
const VIDEO = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SUB = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

/** Run `fn` as app `id` (the ALS context a shared deployment's request runs in). */
function inApp<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    runWithTenantDb(
      {} as never,
      id,
      () => {
        Promise.resolve().then(fn).then(resolve, reject)
      },
      id
    )
  )
}

function fakeRedis() {
  const kv = new Map<string, string>()
  const r = {
    kv,
    async set(k: string, v: string, ...opts: unknown[]) {
      if (opts.includes('NX') && kv.has(k)) return null
      kv.set(k, v)
      return 'OK'
    },
    async setex(k: string, _ttl: number, v: string) {
      kv.set(k, v)
      return 'OK'
    },
    async get(k: string) {
      return kv.get(k) ?? null
    },
    async getdel(k: string) {
      const v = kv.get(k) ?? null
      kv.delete(k)
      return v
    },
    async del(...ks: string[]) {
      for (const k of ks) kv.delete(k)
      return ks.length
    },
    async exists(k: string) {
      return kv.has(k) ? 1 : 0
    },
    async mget(...ks: Array<string | string[]>) {
      return ks.flat().map((k) => kv.get(k) ?? null)
    }
  }
  return r
}

const hub = () => {
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
}
afterEach(() => {
  delete process.env.HUB_SHARED_DEPLOYMENT
})

describe('the binding helpers', () => {
  it('stamp, refuse and sign nothing differently off a shared deployment', async () => {
    expect(binding.appCredentialTag()).toBeUndefined()
    expect(binding.appCredentialRefused(undefined)).toBe(false)
    expect(binding.appCredentialRefused('anything')).toBe(false)
    expect(binding.appBoundSigInput('x')).toBe('x')
    expect(binding.appKeyPart()).toBe('')
    // Inside a cloud-style tenant context too: only the Hub source binds (ruling R13).
    await inApp(A, () => {
      expect(binding.appCredentialTag()).toBeUndefined()
      expect(binding.appBoundSigInput('x')).toBe('x')
    })
  })

  it('on a shared deployment: the current app, refused elsewhere and with no app', async () => {
    hub()
    const tag = await inApp(A, () => binding.appCredentialTag())
    expect(tag).toBe(A)
    expect(await inApp(A, () => binding.appCredentialRefused(tag))).toBe(false)
    expect(await inApp(B, () => binding.appCredentialRefused(tag))).toBe(true)
    expect(await inApp(B, () => binding.appCredentialRefused(undefined))).toBe(true)
    expect(binding.appCredentialRefused(tag)).toBe(true) // no app at all
    const sa = await inApp(A, () => binding.appBoundSigInput('x'))
    const sb = await inApp(B, () => binding.appBoundSigInput('x'))
    expect(sa).not.toBe(sb)
    expect(await inApp(A, () => binding.appKeyPart())).not.toBe(
      await inApp(B, () => binding.appKeyPart())
    )
  })
})

describe('help-video media tickets (?st=)', () => {
  it('self-hosted: unchanged (same signature as before, verifies)', () => {
    const now = Date.now()
    const t = mediaTicket(VIDEO, USER, 'p', now)
    const [exp, user, scope, sig] = t.split('.')
    const want = createHmac('sha256', config.SESSION_SECRET)
      .update(`hv|${VIDEO}|${USER.toUpperCase()}|${scope}|${exp}`)
      .digest('base64url')
      .slice(0, 32)
    expect(sig).toBe(want)
    expect(user).toBe(USER.toUpperCase())
    expect(verifyMediaTicket(t, VIDEO, now)?.userId).toBe(USER.toUpperCase())
  })

  it('shared: minted in A, refused in B, accepted in A', async () => {
    hub()
    const now = Date.now()
    const t = await inApp(A, () => mediaTicket(VIDEO, USER, 'p', now))
    expect(await inApp(A, () => verifyMediaTicket(t, VIDEO, now))).not.toBeNull()
    expect(await inApp(B, () => verifyMediaTicket(t, VIDEO, now))).toBeNull()
  })
})

describe('help-video export links (hv:pkg:)', () => {
  it('self-hosted: no app stamp, reads back', () => {
    const raw = exportTicketValue(USER, [VIDEO], null)
    expect(JSON.parse(raw)).toEqual({ user: USER, ids: [VIDEO], tag: null })
    expect(readExportTicket(raw)).toEqual({ user: USER, ids: [VIDEO], tag: null })
  })

  it('shared: made in A, refused in B, read in A', async () => {
    hub()
    const raw = await inApp(A, () => exportTicketValue(USER, [VIDEO], null))
    expect(await inApp(A, () => readExportTicket(raw))).toMatchObject({ user: USER })
    expect(await inApp(B, () => readExportTicket(raw))).toBeNull()
    // A link made before this change (no app) opens nothing on a shared deployment.
    const old = JSON.stringify({ user: USER, ids: [VIDEO], tag: null })
    expect(await inApp(A, () => readExportTicket(old))).toBeNull()
  })
})

describe('submission status links', () => {
  it('self-hosted: unchanged', () => {
    const { token } = mintStatusToken(SUB, '1', 30)
    expect(readStatusToken(token)?.s).toBe(SUB)
  })

  it('shared: minted in A, refused in B (copied database, same hash), accepted in A', async () => {
    hub()
    const { token } = await inApp(A, () => mintStatusToken(SUB, '1', 30))
    expect((await inApp(A, () => readStatusToken(token)))?.s).toBe(SUB)
    expect(await inApp(B, () => readStatusToken(token))).toBeNull()
  })
})

describe('chat push-reply tokens', () => {
  it('self-hosted: redeems once', async () => {
    const redis = fakeRedis()
    const app = { redis } as never
    const token = (await mintReplyToken(app, USER, 'dm:x')) as string
    expect(await redeemReplyToken(app, token)).toEqual({ user: USER, room: 'dm:x' })
    expect(await redeemReplyToken(app, token)).toBeNull()
  })

  it('shared: minted in A, refused in B, accepted in A', async () => {
    hub()
    const redis = fakeRedis()
    const app = { redis } as never
    const t1 = (await inApp(A, () => mintReplyToken(app, USER, 'dm:x'))) as string
    expect(await inApp(B, () => redeemReplyToken(app, t1))).toBeNull()
    const t2 = (await inApp(A, () => mintReplyToken(app, USER, 'dm:x'))) as string
    expect(await inApp(A, () => redeemReplyToken(app, t2))).toEqual({ user: USER, room: 'dm:x' })
  })
})

describe('idempotency keys (a stored answer is replayed only to the app that wrote it)', () => {
  function call(redis: ReturnType<typeof fakeRedis>) {
    const sent: { code?: number; body?: unknown; replay?: boolean } = {}
    const reply = {
      code(c: number) {
        sent.code = c
        return reply
      },
      header(k: string) {
        if (k === 'idempotent-replay') sent.replay = true
        return reply
      },
      send(b: unknown) {
        sent.body = b
        return reply
      }
    }
    const req = {
      headers: { 'idempotency-key': 'k-1' },
      method: 'POST',
      url: '/api/items/things',
      raw: { url: '/api/items/things' },
      body: { a: 1 },
      user: { id: USER },
      server: { redis },
      log: { warn: () => {} }
    } as never
    return { req, reply: reply as never, sent }
  }
  async function storeDone(redis: ReturnType<typeof fakeRedis>, req: never) {
    const key = (req as { idempotency: { redisKey: string; fingerprint: string } }).idempotency
    await redis.set(
      key.redisKey,
      JSON.stringify({
        state: 'done',
        fingerprint: key.fingerprint,
        status: 201,
        body: { id: 7 },
        finished_at: 'x'
      })
    )
  }

  it('self-hosted: the same key replays the stored answer', async () => {
    const redis = fakeRedis()
    const first = call(redis)
    expect(await beginIdempotency(first.req, first.reply, 'items')).toBeNull()
    await storeDone(redis, first.req)
    const again = call(redis)
    await beginIdempotency(again.req, again.reply, 'items')
    expect(again.sent.replay).toBe(true)
  })

  it("shared: app B never gets app A's answer for the same caller + key", async () => {
    hub()
    const redis = fakeRedis()
    const first = call(redis)
    expect(await inApp(A, () => beginIdempotency(first.req, first.reply, 'items'))).toBeNull()
    await storeDone(redis, first.req)
    const inB = call(redis)
    expect(await inApp(B, () => beginIdempotency(inB.req, inB.reply, 'items'))).toBeNull()
    expect(inB.sent.replay).toBeUndefined()
    const inA = call(redis)
    await inApp(A, () => beginIdempotency(inA.req, inA.reply, 'items'))
    expect(inA.sent.replay).toBe(true)
  })
})

describe('View-as markers ("someone is acting as this user")', () => {
  it('self-hosted: the marker key is unchanged', async () => {
    const redis = fakeRedis()
    touchMasqueradeMarker(redis as never, 'u-self', 'adm')
    await new Promise((r) => setTimeout(r, 0))
    expect(redis.kv.has('nvr:masq:active:U-SELF')).toBe(true)
    expect((await activeMasquerades(redis as never, ['u-self'])).get('U-SELF')).toBe('ADM')
  })

  it("shared: app A's View-as is not shown in app B", async () => {
    hub()
    const redis = fakeRedis()
    await inApp(A, () => touchMasqueradeMarker(redis as never, 'u-shared', 'adm'))
    await new Promise((r) => setTimeout(r, 0))
    expect((await inApp(B, () => activeMasquerades(redis as never, ['u-shared']))).size).toBe(0)
    expect(
      (await inApp(A, () => activeMasquerades(redis as never, ['u-shared']))).get('U-SHARED')
    ).toBe('ADM')
  })
})

// ─── Already bound (tests that they stay so on a shared deployment) ────────────

describe('View-as (nvm_) and run-as-key (nvq_) records: tenantTagRefused', () => {
  it('self-hosted: an untagged record is accepted', () => {
    expect(tenantTagRefused(undefined)).toBe(false)
  })
  it('shared: a record tagged in A is refused in B, accepted in A; untagged refused', async () => {
    hub()
    expect(await inApp(B, () => tenantTagRefused(A))).toBe(true)
    expect(await inApp(A, () => tenantTagRefused(A))).toBe(false)
    expect(await inApp(A, () => tenantTagRefused(undefined))).toBe(true)
  })
})

describe('socket ws-tokens', () => {
  // The reader (mintedForThisTenant, a closure in plugins/socketio.ts, P5-16) refuses a token
  // that names another app or none on a shared deployment; here: the minting side names the app.
  it('shared: the stored value names the app it was minted in', async () => {
    hub()
    const { encodeBoundToken, parseWsTokenValue } = await import(
      '../../../services/socket-access.js'
    )
    const { currentTenantKey } = await import('../../../services/tenant-rooms.js')
    const raw = await inApp(A, () =>
      encodeBoundToken(USER, { kind: 'apikey', id: 3 }, currentTenantKey())
    )
    expect(parseWsTokenValue(raw).t).toBe(A)
  })
})

describe('stream tickets (SSE / graphql-ws)', () => {
  it('self-hosted: redeems', async () => {
    const redis = fakeRedis()
    const bindReq = { user: { id: USER }, authMethod: 'api_key', apiKeyId: 3 } as never
    const t = await mintStreamTicket(redis as never, bindReq)
    expect(t).toBeTruthy()
    expect(await redeemStreamTicket(redis as never, t)).toMatchObject({ userId: USER })
  })
  it('shared: minted in A, refused in B, accepted in A', async () => {
    hub()
    const redis = fakeRedis()
    const bindReq = { user: { id: USER }, authMethod: 'api_key', apiKeyId: 3 } as never
    const t1 = await inApp(A, () => mintStreamTicket(redis as never, bindReq))
    expect(await inApp(B, () => redeemStreamTicket(redis as never, t1))).toBeNull()
    const t2 = await inApp(A, () => mintStreamTicket(redis as never, bindReq))
    expect(await inApp(A, () => redeemStreamTicket(redis as never, t2))).toMatchObject({
      userId: USER
    })
  })
})

describe('message-action links (Teams/Slack/email approvals)', () => {
  const payload = { action_id: 'approve', kind: 'approval', ref_id: '9' }
  it('self-hosted: verifies', () => {
    expect(verifyActionToken(signActionToken(payload))?.ref_id).toBe('9')
  })
  it('shared: signed in A, refused in B, accepted in A', async () => {
    hub()
    const t = await inApp(A, () => signActionToken(payload))
    expect(await inApp(B, () => verifyActionToken(t))).toBeNull()
    expect((await inApp(A, () => verifyActionToken(t)))?.ref_id).toBe('9')
  })
})

describe('OAuth / phone sign-in records (codes, tokens, grants)', () => {
  const rec = {
    kind: 'mcp' as const,
    client_id: 'c',
    user_id: USER,
    grant_id: 'g',
    redirect_uri: 'https://x',
    code_challenge: 'cc',
    resource: null
  }
  it('self-hosted: a code is exchanged', async () => {
    const redis = fakeRedis()
    const code = await issueCode(redis as never, rec)
    expect((await consumeCode(redis as never, code))?.user_id).toBe(USER)
  })
  it('shared: a code issued in A is refused in B, accepted in A', async () => {
    hub()
    const redis = fakeRedis()
    const c1 = await inApp(A, () => issueCode(redis as never, rec))
    expect(await inApp(B, () => consumeCode(redis as never, c1))).toBeNull()
    const c2 = await inApp(A, () => issueCode(redis as never, rec))
    expect((await inApp(A, () => consumeCode(redis as never, c2)))?.user_id).toBe(USER)
  })
})

beforeEach(() => {
  delete process.env.HUB_SHARED_DEPLOYMENT
})
