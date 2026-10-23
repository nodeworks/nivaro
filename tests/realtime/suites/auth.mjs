// Auth/security: every way a live connection signs in, every way that sign-in ends (the socket
// and the streams must close within SOCKET_SWEEP_MS — the stack sets 5 s), and room authz.
// Throwaway users/keys are made per case through the API and removed again.
import { createHash, randomBytes } from 'node:crypto'
import { cfg } from '../lib/config.mjs'
import { dmRoom, fixture } from '../lib/fixture.mjs'
import { GqlWs, wsUrl } from '../lib/gqlws.mjs'
import { Suite, sleep } from '../lib/harness.mjs'
import { Client } from '../lib/http.mjs'
import { LiveSocket } from '../lib/sock.mjs'
import { openSse } from '../lib/sse.mjs'

const SWEEP_MS = 5000
/** How long an ended sign-in may keep its socket: the sweep interval plus a margin. */
const END_BUDGET_MS = SWEEP_MS * 2 + 2000

export const UNTESTED = [
  'cloud mode tenant isolation (two tenants, no cross-tenant event): needs CLOUD_META_DB_URL (a Postgres meta DB with cloud_tenants rows + per-tenant databases). The realtime role refuses to boot in cloud mode, so cloud keeps sockets on every process — the tier does not change it. Not built into this stack.',
  'Microsoft OIDC sign-in (OIDC_ENABLED=false here; sessions come from /api/auth/login/token)'
]

export async function run({ only }) {
  const suite = new Suite('auth', { only })
  const fx = await fixture()
  const { admin, users } = fx
  const id0 = fx.item(0)

  let tmpN = 0
  async function tempUser(t, role = fx.seed.roles.member) {
    const email = `rtci-tmp-${Date.now()}-${tmpN++}@example.test`
    const u = await admin.must('POST', '/api/users', { email, first_name: 'Tmp', last_name: 'RTCI', role })
    const { token } = await admin.must('POST', `/api/users/${u.id}/token`)
    t.cleanup(() => admin.del(`/api/users/${u.id}`))
    return { id: u.id, email, token, role }
  }

  /** Socket ended: session:ended seen (or a server disconnect) — ms after `since`, or null. */
  async function endedWithin(s, since, ms) {
    try {
      await s.until(() => s.events.some((e) => e.ev === 'session:ended' && e.at >= since) || s.disconnects.some((d) => d.at >= since && d.reason === 'io server disconnect'), ms, 'end')
    } catch {
      return null
    }
    const e = s.events.find((x) => x.ev === 'session:ended' && x.at >= since)
    const d = s.disconnects.find((x) => x.at >= since)
    return { ms: (e?.at ?? d?.at) - since, reason: e?.p?.reason ?? d?.reason, event: !!e }
  }

  /** After an end, the client's reconnect must not sign in again (its token is dead). */
  async function staysOut(s, ms = 4000) {
    const n = s.authCount
    await sleep(ms)
    return s.authCount === n
  }

  // ── sign-in paths ─────────────────────────────────────────────────────────
  await suite.case('session cookie → ws-token → auth:ok; logout ends socket, SSE and graphql-ws', async (t) => {
    t.cleanup(fx.closeAll)
    const b = await fx.browser('bob')
    const s = await fx.sock(b)
    t.check('auth:ok as bob', String(s.userId).toUpperCase() === String(users.bob.id).toUpperCase(), s.userId)
    const sse = await openSse(`${cfg.base}/api/events/stream?collections=rt_items&ticket=${await b.streamTicket()}`)
    const gql = await new GqlWs(wsUrl(cfg.base, '/api/graphql-ws'), { ticket: await b.streamTicket() }).open()
    t.cleanup(() => {
      sse.close()
      gql.close()
    })
    t.check('SSE open', sse.status === 200, sse.status)
    t.check('graphql-ws acked', gql.acked)
    // A graphql-ws connection resolves its sign-in on its first operation; the sign-in watch
    // starts there.
    gql.subscribe('subscription { itemMutated(collection: "rt_items") { item } }')
    await sleep(800)
    const since = Date.now()
    const out = await b.post('/api/auth/logout', {})
    t.check('logout 200', out.ok, out.status)
    const end = await endedWithin(s, since, END_BUDGET_MS)
    t.metric('socket_end', end)
    t.check(`socket ended within ${END_BUDGET_MS} ms`, !!end, end)
    t.check('session:ended event (not just a drop)', !!end?.event, end)
    // The events stream re-checks its sign-in on its 25 s heartbeat.
    const sseEnd = await sse.next((e) => e.event === 'session.ended', { timeoutMs: 30_000 })
    t.metric('sse_end_ms', sseEnd ? sseEnd.at - since : null)
    t.check('SSE got session.ended (within its 25 s heartbeat)', !!sseEnd || !!sse.ended, sse.ended)
    const closed = await gql.waitClose(35_000)
    t.metric('graphql_ws_close', closed)
    t.check('graphql-ws closed (4401) after sign-out', closed?.code === 4401, closed)
    t.check('socket does not sign back in', await staysOut(s))
  }, { timeoutMs: 90_000 })

  await suite.case('logout-all ends the sockets of every session of that person', async (t) => {
    t.cleanup(fx.closeAll)
    const u = await tempUser(t)
    const b1 = await fx.browser(u)
    const b2 = await fx.browser(u)
    const s1 = await fx.sock(b1)
    const s2 = await fx.sock(b2)
    const since = Date.now()
    const r = await b1.post('/api/auth/logout-all', {})
    t.check('logout-all 200', r.ok, r.status)
    const e1 = await endedWithin(s1, since, END_BUDGET_MS)
    const e2 = await endedWithin(s2, since, END_BUDGET_MS)
    t.metric('ends', { s1: e1, s2: e2 })
    t.check('first session socket ended', !!e1)
    t.check('second session socket ended', !!e2)
  })

  await suite.case('static token: direct socket auth and ws-token; rotating it ends the socket', async (t) => {
    t.cleanup(fx.closeAll)
    const u = await tempUser(t)
    const direct = new LiveSocket(null, { staticToken: u.token })
    await direct.open()
    t.cleanup(() => direct.close())
    t.check('static token signs a socket in', direct.authCount === 1)
    const viaBearer = await fx.sock(new Client({ bearer: u.token, name: 'bearer' }))
    t.check('ws-token minted by Bearer signs in', viaBearer.authCount === 1)
    const since = Date.now()
    await admin.must('POST', `/api/users/${u.id}/token`) // rotate
    const e1 = await endedWithin(direct, since, END_BUDGET_MS)
    const e2 = await endedWithin(viaBearer, since, END_BUDGET_MS)
    t.metric('ends', { direct: e1, ws_token: e2 })
    t.check('direct static-token socket ended after rotation', !!e1, e1)
    t.check('ws-token (token-bound) socket ended after rotation', !!e2, e2)
  })

  await suite.case('API key: socket signs in; revoking the key ends it (key_revoked)', async (t) => {
    t.cleanup(fx.closeAll)
    const key = await admin.must('POST', '/api/api-keys', {
      name: `rtci tmp ${Date.now()}`,
      user: users.alice.id,
      scopes: [{ collection: 'rt_items', actions: ['read'] }]
    })
    t.cleanup(() => admin.del(`/api/api-keys/${key.id}`))
    const s = await fx.sock(new Client({ bearer: key.key, name: 'apikey' }))
    t.check('API-key socket signed in', s.authCount === 1)
    s.join('collection:join', { collection: 'rt_items' })
    await sleep(400)
    const m = s.mark()
    await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: 1 })
    t.check('API-key socket receives rt_items (in scope)', !!(await s.next('collection:update', () => true, { from: m })))
    const since = Date.now()
    const r = await admin.post(`/api/api-keys/${key.id}/revoke`, {})
    t.check('revoke 2xx', r.status < 300, r.status)
    const end = await endedWithin(s, since, END_BUDGET_MS)
    t.metric('end', end)
    t.check(`socket ended within ${END_BUDGET_MS} ms`, !!end, end)
    t.check('reason key_revoked', end?.reason === 'key_revoked', end?.reason)
    const mint = await new Client({ bearer: key.key }).get('/api/auth/ws-token')
    t.check('revoked key mints no ws-token', mint.status === 401 || mint.status === 403, mint.status)
  })

  await suite.case('masquerade (View as): socket as the target; ending it closes the socket', async (t) => {
    t.cleanup(fx.closeAll)
    const m = await admin.must('POST', '/api/auth/masquerade', { user_id: users.carol.id })
    const token = m.token
    t.check('masquerade token nvm_', /^nvm_/.test(token ?? ''), token?.slice(0, 4))
    const direct = new LiveSocket(null, { staticToken: token })
    await direct.open()
    t.cleanup(() => direct.close())
    t.check('nvm_ socket signs in as carol', String(direct.userId).toUpperCase() === String(users.carol.id).toUpperCase(), direct.userId)
    const viaWs = await fx.sock(new Client({ bearer: token, name: 'masq' }))
    t.check('ws-token minted under View-as signs in as carol', String(viaWs.userId).toUpperCase() === String(users.carol.id).toUpperCase())
    const since = Date.now()
    const r = await new Client({ bearer: token }).del('/api/auth/masquerade')
    t.check('DELETE masquerade 2xx', r.status < 300, r.status)
    const e1 = await endedWithin(direct, since, END_BUDGET_MS)
    const e2 = await endedWithin(viaWs, since, END_BUDGET_MS)
    t.metric('ends', { direct: e1, ws_token: e2 })
    t.check('direct nvm_ socket ended', !!e1, e1)
    t.check('ws-token socket ended', !!e2, e2)
  })

  await suite.case('suspending a person closes their socket (account_inactive)', async (t) => {
    t.cleanup(fx.closeAll)
    const u = await tempUser(t)
    const s = await fx.sock(await fx.browser(u))
    const since = Date.now()
    const r = await admin.patch(`/api/users/${u.id}`, { status: 'suspended' })
    t.check('PATCH status suspended', r.ok, r.status)
    const end = await endedWithin(s, since, END_BUDGET_MS)
    t.metric('end', end)
    t.check('socket ended', !!end, end)
  })

  await suite.case('role change re-gates rooms: access:changed, then no more events', async (t) => {
    t.cleanup(fx.closeAll)
    const u = await tempUser(t)
    const s = await fx.sock(await fx.browser(u))
    s.join('collection:join', { collection: 'rt_items' })
    await sleep(400)
    const m0 = s.mark()
    await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: 2 })
    t.check('member receives before the change', !!(await s.next('collection:update', () => true, { from: m0 })))
    // Drop the role (no access to rt_items any more); keep the joins out of the client's rejoin
    // list so a reconnect does not mask the server's own re-gating.
    s.joins = []
    const m1 = s.mark()
    const r = await admin.patch(`/api/users/${u.id}`, { role: null })
    t.check('PATCH role null', r.ok, r.status)
    const ac = await s.next('access:changed', () => true, { from: m1, timeoutMs: END_BUDGET_MS })
    t.metric('access_changed', ac?.p ?? null)
    t.check('access:changed arrives', !!ac)
    await sleep(500)
    const m2 = s.mark()
    await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: 3 })
    await sleep(2000)
    t.check('no rt_items events after losing access', s.all('collection:update', m2).length === 0, s.all('collection:update', m2).length)
  })

  // ── tokens that must not open anything ───────────────────────────────────
  await suite.case('garbage, expired and replayed ws-tokens sign nothing in', async (t) => {
    t.cleanup(fx.closeAll)
    const junk = new LiveSocket(null, { staticToken: `junk-${randomBytes(8).toString('hex')}`, reconnection: false })
    await junk.open({ timeoutMs: 3000 }).catch(() => {})
    t.cleanup(() => junk.close())
    t.check('garbage token: no auth:ok', junk.authCount === 0)
    const b = await fx.browser('bob')
    const tok = await b.wsToken()
    const first = new LiveSocket(null, { staticToken: tok, reconnection: false })
    await first.open({ timeoutMs: 5000 }).catch(() => {})
    t.cleanup(() => first.close())
    const replay = new LiveSocket(null, { staticToken: tok, reconnection: false })
    await replay.open({ timeoutMs: 3000 }).catch(() => {})
    t.cleanup(() => replay.close())
    t.check('ws-token works once', first.authCount === 1)
    t.check('the same ws-token a second time: no auth:ok', replay.authCount === 0)
    const m = junk.mark()
    junk.emit('collection:join', { collection: 'rt_items' })
    await sleep(300)
    await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: 4 })
    await sleep(1500)
    t.check('unauthenticated socket gets no collection events', junk.all('collection:update', m).length === 0)
    t.metric('unauthenticated_socket_events', [...new Set(junk.events.map((e) => e.ev))])
    const leaks = junk.events.filter((e) => e.ev === 'presence:changed')
    t.note(`unauthenticated socket received ${leaks.length} presence:changed (self-hosted io.emit reaches signed-out sockets; payload carries user ids)`)
  })

  await suite.case('OAuth nvo_ token: allowed on /api/mcp, refused for ws-token, tickets and sockets', async (t) => {
    t.cleanup(fx.closeAll)
    const tok = await oauthToken(await fx.browser('alice'))
    t.check('OAuth flow issued an nvo_ access token', /^nvo_/.test(tok ?? ''), tok?.slice(0, 4))
    if (!tok) return
    const c = new Client({ bearer: tok })
    const mcp = await fetch(`${cfg.base}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rtci', version: '1' } } })
    })
    t.check('nvo_ works on /api/mcp', mcp.status === 200, mcp.status)
    const ws = await c.get('/api/auth/ws-token')
    t.check('nvo_ cannot mint a ws-token', ws.status === 401 || ws.status === 403, ws.status)
    const ticket = await c.get('/api/events/ticket')
    t.check('nvo_ cannot mint a stream ticket', ticket.status === 401 || ticket.status === 403, ticket.status)
    const sse = await openSse(`${cfg.base}/api/events/stream`, { headers: { authorization: `Bearer ${tok}` } })
    sse.close()
    t.check('nvo_ cannot open /api/events/stream', sse.status === 401 || sse.status === 403, sse.status)
    const s = new LiveSocket(null, { staticToken: tok, reconnection: false })
    await s.open({ timeoutMs: 3000 }).catch(() => {})
    t.cleanup(() => s.close())
    t.check('nvo_ as a socket auth token signs nothing in', s.authCount === 0)
  })

  // ── room authz ────────────────────────────────────────────────────────────
  await suite.case('room authz: DM huddle, admin rooms, presence:admin refused to outsiders', async (t) => {
    t.cleanup(fx.closeAll)
    const room = dmRoom(users.alice.id, users.bob.id)
    const carol = await fx.sock('carol')
    const m = carol.mark()
    carol.emit('huddle:join', { room })
    const denied = await carol.next('huddle:denied', () => true, { from: m })
    t.check('huddle:join in a DM she is not in → huddle:denied', !!denied, denied?.p)
    carol.join('presence:join', 'admin')
    carol.join('admin:join', { room: 'jobs' })
    carol.join('pulse:join', {})
    await sleep(500)
    const m2 = carol.mark()
    await admin.post('/api/presence/ping', { sessionId: `rtci-${Date.now()}`, pageUrl: '/rtci' })
    await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: 5 })
    await sleep(1500)
    const got = [...new Set(carol.events.slice(m2).map((e) => e.ev))]
    t.metric('events_seen_by_member', got)
    t.check('no presence:update (admin session rows)', !got.includes('presence:update'))
    t.check('no job:* / activity:pulse', !got.some((e) => e.startsWith('job:') || e === 'activity:pulse'))
  })

  await suite.case('a socket sees only its own user room (notifications for others never leak)', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    const m = a.mark()
    const subject = `private ${Date.now()}`
    await fx.browser('carol').then((c) => c.post('/api/notifications', { recipient: users.bob.id, subject }))
    await sleep(1500)
    t.check('alice receives none of bob’s notifications', a.all('notification:new', m).filter((e) => e.p.subject === subject).length === 0)
  })

  return suite.result({ untested: UNTESTED })
}

/** The OAuth 2.1 code flow for a public client, as the signed-in `browser` → an nvo_ token. */
async function oauthToken(browser) {
  const base = browser.base
  const redirect = 'http://localhost:9/rtci-callback'
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'rtci', redirect_uris: [redirect], token_endpoint_auth_method: 'none' })
  })
  if (reg.status !== 201) return null
  const client = await reg.json()
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const params = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'rtci'
  }
  const page = await browser.get(`/oauth/authorize?${new URLSearchParams(params)}`)
  const csrf = page.text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? page.text.match(/value="([^"]+)"\s+name="csrf"/)?.[1]
  if (!csrf) return null
  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: browser.cookieHeader() },
    body: new URLSearchParams({ ...params, csrf, decision: 'allow' }),
    redirect: 'manual'
  })
  const loc = res.headers.get('location') ?? ''
  const code = loc ? new URL(loc).searchParams.get('code') : null
  if (!code) return null
  const tok = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier })
  })
  return (await tok.json().catch(() => null))?.access_token ?? null
}
