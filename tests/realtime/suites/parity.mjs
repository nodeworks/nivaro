// Parity: every realtime feature works through the stack's entry (Traefik) exactly as a
// single-role deployment. The same cases run in both modes; a case that passes in `single` and
// fails in `tier` is a tier regression. Writes go through the web processes, the subscriber sits
// on whichever process Traefik's sticky cookie picked — usually another one.
import { cfg, socketNodes } from '../lib/config.mjs'
import { dmRoom, fixture } from '../lib/fixture.mjs'
import { GqlWs, wsUrl } from '../lib/gqlws.mjs'
import { pct, poll, Suite, sleep } from '../lib/harness.mjs'
import { openSse } from '../lib/sse.mjs'
import { socketCounts } from '../lib/stack.mjs'

export const UNTESTED = [
  'widgets:watch / widget:data (pushed dashboard widgets) — needs a dashboard + widget fixture',
  'replay watch rooms (replay:join/state) and the realtime-replay script',
  'huddle extras: notes, follow-me, marks, react, ring (huddle:ring needs a DM huddle), live-watch',
  'AI streams (ai:delta/ai:done/ai:status) — need an AI provider',
  'chat:bot-stream, chat:draft, job:progress, bulk:rows, help-video:*, chaos:armed',
  'owners:changed / access:changed tenant notices (pipelines/owner matrix fixture)',
  'item-lock events — emitted to item:<c>:<id>, a room nothing in core joins (dead path)',
  'announcements:changed / flags:changed (announceToTenant)'
]

export async function run({ only }) {
  const suite = new Suite('parity', { only })
  const fx = await fixture()
  const { admin, users } = fx
  const id0 = fx.item(0)
  const id1 = fx.item(1)
  const latencies = []

  // ── collections ───────────────────────────────────────────────────────────
  await suite.case('collection:update create/update/delete reaches a member on every socket node', async (t) => {
    t.cleanup(fx.closeAll)
    // Several sockets so both socket-holding processes get some (Traefik spreads new sessions).
    const socks = []
    for (let i = 0; i < 6; i++) socks.push(await fx.sock('alice'))
    for (const s of socks) s.join('collection:join', { collection: 'rt_items' })
    await sleep(500)
    const counts = await socketCounts()
    t.metric('socket_counts', counts)
    t.check('sockets spread over both socket nodes', Object.values(counts).filter((n) => n > 0).length >= 2, counts)
    const marks = socks.map((s) => s.mark())
    const t0 = Date.now()
    const created = await admin.must('POST', '/api/items/rt_items', { title: 'parity create', status: 'open', n: 1 })
    await admin.must('PATCH', `/api/items/rt_items/${created.id}`, { n: 2 })
    await admin.must('DELETE', `/api/items/rt_items/${created.id}`)
    for (const [i, s] of socks.entries()) {
      const c = await s.next('collection:update', (p) => String(p.item) === String(created.id) && p.action === 'create', { from: marks[i] })
      const u = await s.next('collection:update', (p) => String(p.item) === String(created.id) && p.action === 'update', { from: marks[i] })
      const d = await s.next('collection:update', (p) => String(p.item) === String(created.id) && p.action === 'delete', { from: marks[i] })
      t.check(`socket ${i + 1}: create/update/delete`, c && u && d, { create: !!c, update: !!u, delete: !!d })
      if (u) t.check(`socket ${i + 1}: changed_fields names n`, (u.p.changed_fields ?? []).includes('n'), u.p.changed_fields)
      if (c) latencies.push(c.at - t0)
      if (c) t.check(`socket ${i + 1}: journaled (_seq)`, typeof c.p._seq === 'number', c.p._seq)
    }
  })

  await suite.case('collection:join is refused without read access (dave, rt_secret)', async (t) => {
    t.cleanup(fx.closeAll)
    const dave = await fx.sock('dave')
    const alice = await fx.sock('alice')
    const carol = await fx.sock('carol')
    dave.join('collection:join', { collection: 'rt_items' })
    alice.join('collection:join', { collection: 'rt_secret' })
    carol.join('collection:join', { collection: 'rt_items' })
    await sleep(500)
    const [md, ma, mc] = [dave.mark(), alice.mark(), carol.mark()]
    await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: Date.now() % 1000 })
    await admin.must('PATCH', `/api/items/rt_secret/${fx.seed.secret}`, { title: `secret ${Date.now()}` })
    const got = await carol.next('collection:update', (p) => p.collection === 'rt_items', { from: mc })
    t.check('reader (carol) receives rt_items', !!got)
    await sleep(1500)
    t.check('no-role user (dave) receives nothing for rt_items', dave.all('collection:update', md).length === 0)
    t.check('member (alice) receives nothing for rt_secret', alice.all('collection:update', ma).filter((e) => e.p.collection === 'rt_secret').length === 0)
  })

  // ── record rooms ──────────────────────────────────────────────────────────
  await suite.case('record room: viewers, field editing, comment typing, signal, comment', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    const b = await fx.sock('bob')
    const mb = b.mark()
    a.join('record:join', { collection: 'rt_items', item: id0 })
    // Staggered like real people (the realtime board publishes every second); the same-moment
    // case has its own test below.
    await sleep(2500)
    b.join('record:join', { collection: 'rt_items', item: id0 })
    const viewers = await b.next('record:viewers', (p) => (p.viewers ?? []).length >= 2, { from: mb })
    t.check('record:viewers lists both people', !!viewers, viewers?.p)
    const m2 = b.mark()
    a.emit('field:focus', { collection: 'rt_items', item: id0, field: 'title' })
    t.check('field:editing reaches the other viewer', !!(await b.next('field:editing', (p) => p.field === 'title', { from: m2 })))
    a.emit('field:change', { collection: 'rt_items', item: id0, field: 'title', value: 'typing…' })
    t.check('field:changed reaches the other viewer', !!(await b.next('field:changed', (p) => p.field === 'title', { from: m2 })))
    a.emit('comment:typing', { collection: 'rt_items', item: id0 })
    t.check('record:comment-typing reaches the other viewer', !!(await b.next('record:comment-typing', () => true, { from: m2 })))
    a.emit('record:signal', { collection: 'rt_items', item: id0, kind: 'transition', state: 'start' })
    t.check('record:signal reaches the other viewer', !!(await b.next('record:signal', (p) => p.kind === 'transition', { from: m2 })))
    await a.http.must('POST', '/api/comments', { collection: 'rt_items', item: String(id0), text: 'parity comment' })
    t.check('record:comment (POST /api/comments) reaches the room', !!(await b.next('record:comment', () => true, { from: m2 })))
    let rv = null
    await poll(async () => {
      rv = await a.http.post('/api/presence/record-viewers', { pairs: [{ collection: 'rt_items', item_id: String(id0) }] })
      return rv.json?.data?.[`rt_items:${id0}`] === 2
    }, { timeoutMs: 8000, everyMs: 1000 })
    t.metric('record_viewers_rest', rv.json?.data)
    t.check('POST /api/presence/record-viewers counts both viewers', rv.json?.data?.[`rt_items:${id0}`] === 2, rv.json)
    const m3 = b.mark()
    a.leave('record:leave', { collection: 'rt_items', item: id0 }, 'record:join')
    t.check('record:viewers on leave drops to one', !!(await b.next('record:viewers', (p) => (p.viewers ?? []).length === 1, { from: m3 })))
  })

  await suite.case('record:viewers converge when two people open a record at the same moment', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    const b = await fx.sock('bob')
    const [ma, mb] = [a.mark(), b.mark()]
    a.join('record:join', { collection: 'rt_items', item: id1 })
    b.join('record:join', { collection: 'rt_items', item: id1 })
    // Each side's latest record:viewers must list both within a few seconds.
    const latest = (s, m) => s.all('record:viewers', m).filter((e) => String(e.p.item) === String(id1)).at(-1)
    const ok = await poll(() => (latest(a, ma)?.p?.viewers ?? []).length >= 2 && (latest(b, mb)?.p?.viewers ?? []).length >= 2, { timeoutMs: 8000 })
    t.metric('last_lists', { a: (latest(a, ma)?.p?.viewers ?? []).length, b: (latest(b, mb)?.p?.viewers ?? []).length })
    t.check('both sides end up seeing two viewers', !!ok)
  })

  await suite.case('record:join is refused for an unreadable record (alice → rt_secret)', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    const m = a.mark()
    a.join('record:join', { collection: 'rt_secret', item: fx.seed.secret })
    await sleep(1500)
    t.check('no record:viewers for a record she cannot read', a.all('record:viewers', m).length === 0)
  })

  await suite.case('presence:watch → presence:rows', async (t) => {
    t.cleanup(fx.closeAll)
    const watcher = await fx.sock('bob')
    const viewer = await fx.sock('alice')
    const m = watcher.mark()
    watcher.join('presence:watch', { collection: 'rt_items', items: [id1] })
    await sleep(300)
    viewer.join('record:join', { collection: 'rt_items', item: id1 })
    const rows = await watcher.next('presence:rows', (p) => (p.user_ids ?? []).length >= 1, { from: m })
    t.check('presence:rows names the viewer', !!rows, rows?.p)
  })

  // ── presence ──────────────────────────────────────────────────────────────
  await suite.case('presence:changed on sign-in, idle and sign-out (counts per action)', async (t) => {
    t.cleanup(fx.closeAll)
    const bob = await fx.sock('bob')
    // Earlier cases left alice online for a moment; a sign-in of someone already online
    // broadcasts nothing (coalesced presence), so wait until she is offline first.
    const wasOffline = await poll(async () => {
      const r = await bob.http.get('/api/presence/online')
      const row = (r.json?.data ?? []).find((u) => String(u.user_id).toUpperCase() === String(users.alice.id).toUpperCase())
      return !row || row.state === 'offline'
    }, { timeoutMs: 30_000, everyMs: 1000 })
    t.check('alice offline before the test (her earlier sockets closed)', !!wasOffline)
    await sleep(1500)
    const m = bob.mark()
    const alice = await fx.sock('alice')
    const isAlice = (p) =>
      String(p?.user_id ?? '').toUpperCase() === String(users.alice.id).toUpperCase() ||
      (p?.user_ids ?? []).map((x) => String(x).toUpperCase()).includes(String(users.alice.id).toUpperCase())
    const on = await bob.next('presence:changed', isAlice, { from: m, timeoutMs: 6000 })
    t.check('presence:changed when alice signs in', !!on, on?.p)
    await sleep(2500)
    const signInEvents = bob.all('presence:changed', m).length
    t.metric('presence_changed_per_sign_in', signInEvents)
    const m2 = bob.mark()
    alice.emit('presence:idle', { idle: true })
    t.check('presence:changed when alice goes idle', !!(await bob.next('presence:changed', isAlice, { from: m2, timeoutMs: 6000 })))
    const online = await poll(async () => {
      const r = await bob.http.get('/api/presence/online')
      return (r.json?.data ?? []).find((u) => String(u.user_id).toUpperCase() === String(users.alice.id).toUpperCase())
    })
    t.check('GET /api/presence/online lists alice', !!online, online ? { state: online.state, is_idle: online.is_idle } : null)
    const m3 = bob.mark()
    alice.close()
    t.check('presence:changed when alice leaves (last socket, any replica)', !!(await bob.next('presence:changed', isAlice, { from: m3, timeoutMs: 8000 })))
    const offline = await poll(async () => {
      const r = await bob.http.get('/api/presence/online')
      const row = (r.json?.data ?? []).find((u) => String(u.user_id).toUpperCase() === String(users.alice.id).toUpperCase())
      return !row || row.state === 'offline' ? 'gone' : null
    }, { timeoutMs: 8000 })
    t.check('alice drops off /api/presence/online', offline === 'gone')
  })

  await suite.case('presence:changed burst: 10 sign-ins → events seen by a viewer', async (t) => {
    t.cleanup(fx.closeAll)
    const viewer = await fx.sock('bob')
    await sleep(1000)
    const m = viewer.mark()
    const t0 = Date.now()
    const tabs = []
    for (let i = 0; i < 10; i++) tabs.push(await fx.sock('alice'))
    await sleep(3000)
    const evs = viewer.all('presence:changed', m)
    t.metric('presence_changed_events', evs.length)
    t.metric('presence_changed_window_ms', Date.now() - t0)
    t.check('at least one presence:changed reached the viewer', evs.length >= 1, evs.length)
    // Batching (post-mortem fix 10): one person opening 10 tabs should not cost 10 broadcasts.
    t.note(`10 tabs of one person → ${evs.length} presence:changed at another viewer (batched shape: ${evs.some((e) => Array.isArray(e.p?.user_ids))})`)
  })

  await suite.case('presence-map:join + page:at → presence-map:update (admin)', async (t) => {
    t.cleanup(fx.closeAll)
    const ad = await fx.sock(fx.bearer(cfg.adminToken, { name: 'admin' }))
    const a = await fx.sock('alice')
    ad.join('presence-map:join', {})
    t.check('snapshot on join', !!(await ad.next('presence-map:update', () => true)))
    const m = ad.mark()
    a.emit('page:at', { path: '/rtci/parity', app: 'rtci' })
    const up = await ad.next('presence-map:update', (p) => JSON.stringify(p).includes('/rtci/parity'), { from: m })
    t.check('page:at from another node shows on the map', !!up)
  })

  // ── notifications ─────────────────────────────────────────────────────────
  await suite.case('notification:new reaches every tab of the recipient', async (t) => {
    t.cleanup(fx.closeAll)
    const tabs = [await fx.sock('bob'), await fx.sock('bob'), await fx.sock('bob')]
    const other = await fx.sock('carol')
    const marks = tabs.map((s) => s.mark())
    const mo = other.mark()
    const subject = `rtci ${Date.now()}`
    const alice = await fx.browser('alice')
    const r = await alice.post('/api/notifications', { recipient: users.bob.id, subject, message: 'parity' })
    t.check('POST /api/notifications 201', r.status === 201, r.status)
    for (const [i, s] of tabs.entries())
      t.check(`tab ${i + 1} got notification:new`, !!(await s.next('notification:new', (p) => p.subject === subject, { from: marks[i] })))
    await sleep(500)
    t.check('someone else did not', other.all('notification:new', mo).filter((e) => e.p.subject === subject).length === 0)
  })

  await suite.case('notification in-app is skipped while the recipient views that record (#269)', async (t) => {
    t.cleanup(fx.closeAll)
    const viewing = await fx.sock('bob')
    viewing.join('record:join', { collection: 'rt_items', item: id1 })
    // With the tier, web learns who views what from the realtime board (published every 2 s).
    await sleep(5000)
    const alice = await fx.browser('alice')
    // Several sends: the web process that judges "is bob viewing?" varies per request.
    const n = 4
    let delivered = 0
    for (let i = 0; i < n; i++) {
      const m = viewing.mark()
      const subject = `viewing ${Date.now()}-${i}`
      await alice.post('/api/notifications', { recipient: users.bob.id, subject, collection: 'rt_items', item: String(id1) })
      if (await viewing.next('notification:new', (p) => p.subject === subject, { from: m, timeoutMs: 1500 })) delivered++
    }
    t.metric('delivered_while_viewing', `${delivered}/${n}`)
    t.check(`no in-app notification while viewing (${delivered}/${n} delivered)`, delivered === 0, delivered)
    // Control: a record bob is not viewing is delivered.
    const m = viewing.mark()
    const subject = `control ${Date.now()}`
    await alice.post('/api/notifications', { recipient: users.bob.id, subject, collection: 'rt_items', item: String(id0) })
    t.check('a record he is not viewing is delivered', !!(await viewing.next('notification:new', (p) => p.subject === subject, { from: m })))
  })

  await suite.case('page presence: GET /api/journeys/here lists a socket on that path', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    const path = `/rtci/here-${Date.now()}`
    a.emit('page:at', { path, app: 'rtci' })
    await sleep(5000) // realtime board lag (tier)
    let seen = 0
    const n = 6
    for (let i = 0; i < n; i++) {
      const r = await admin.get(`/api/journeys/here?path=${encodeURIComponent(path)}`)
      if (JSON.stringify(r.json?.data ?? []).toUpperCase().includes(String(users.alice.id).toUpperCase())) seen++
    }
    t.metric('here_hits', `${seen}/${n}`)
    t.check(`every web process answers with alice (${seen}/${n})`, seen === n, seen)
  })

  // ── chat ──────────────────────────────────────────────────────────────────
  await suite.case('chat: General room message, read marker', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    const a2 = await fx.sock(a.http)
    const b = await fx.sock('bob')
    a.join('chat:join', { room: 'global' })
    b.join('chat:join', { room: 'global' })
    await sleep(400)
    const m = b.mark()
    const text = `hello ${Date.now()}`
    const sent = await a.http.post('/api/chat/messages', { room: 'global', message: text })
    t.check('POST /api/chat/messages 201', sent.status === 201, sent.status === 201 ? null : sent.text.slice(0, 200))
    t.check('chat:message reaches bob', !!(await b.next('chat:message', (p) => p.message === text || JSON.stringify(p).includes(text), { from: m })))
    const m2 = a2.mark()
    const rd = await a.http.post('/api/chat/rooms/global/read', {})
    t.check('POST read 200', rd.ok, rd.status)
    t.check("read:changed reaches alice's other tab", !!(await a2.next('read:changed', (p) => p.kind === 'chat', { from: m2 })))
  })

  await suite.case('chat: DM reaches the participant, never a third person', async (t) => {
    t.cleanup(fx.closeAll)
    const room = dmRoom(users.alice.id, users.bob.id)
    const a = await fx.sock('alice')
    const b = await fx.sock('bob')
    const bNoJoin = await fx.sock('bob')
    const c = await fx.sock('carol')
    a.join('chat:join', { room })
    b.join('chat:join', { room })
    c.join('chat:join', { room })
    await sleep(500)
    const [mb, mn, mc] = [b.mark(), bNoJoin.mark(), c.mark()]
    const text = `dm ${Date.now()}`
    const sent = await a.http.post('/api/chat/messages', { room, message: text })
    t.check('POST DM 201', sent.status === 201, sent.status === 201 ? null : sent.text.slice(0, 200))
    t.check('bob (joined) gets chat:message', !!(await b.next('chat:message', (p) => JSON.stringify(p).includes(text), { from: mb })))
    t.check("bob's other tab gets it via user room", !!(await bNoJoin.next('chat:message', (p) => JSON.stringify(p).includes(text), { from: mn })))
    await sleep(800)
    t.check('carol (chat:join refused) gets nothing', c.all('chat:message', mc).filter((e) => JSON.stringify(e.p).includes(text)).length === 0)
  })

  await suite.case('chat typing (typing_room on user_presence) reaches a watcher', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    const b = await fx.sock('bob')
    b.join('collection:join', { collection: 'user_presence' })
    await sleep(500)
    const rows = await a.http.get(`/api/items/user_presence?filter[user_id][_eq]=${users.alice.id}&fields=id`)
    const rowId = rows.json?.data?.[0]?.id
    t.check('alice has a user_presence row', !!rowId, rows.status)
    if (!rowId) return
    const m = b.mark()
    const r = await a.http.patch(`/api/items/user_presence/${rowId}`, { typing_room: 'global' })
    t.check('PATCH typing_room 200', r.ok, r.status)
    t.check('collection:update user_presence reaches bob', !!(await b.next('collection:update', (p) => p.collection === 'user_presence', { from: m })))
  })

  // ── huddles ───────────────────────────────────────────────────────────────
  await suite.case('huddle signalling between two nodes (join, peers, signal, leave)', async (t) => {
    t.cleanup(fx.closeAll)
    const room = 'global'
    const a = await fx.sock('alice')
    const b = await fx.sock('bob')
    a.join('chat:join', { room })
    b.join('chat:join', { room })
    await sleep(300)
    const ma = a.mark()
    a.emit('huddle:join', { room })
    const ja = await a.next('huddle:joined', (p) => p.room === room, { from: ma })
    t.check('alice huddle:joined', !!ja, a.all('huddle:denied', ma).map((e) => e.p))
    const mb = b.mark()
    b.emit('huddle:join', { room })
    const jb = await b.next('huddle:joined', (p) => p.room === room, { from: mb })
    t.check('bob huddle:joined lists alice as a peer', !!jb && (jb.p.peers ?? []).length >= 1, jb?.p?.peers?.length)
    t.check('alice gets huddle:peers with 2', !!(await a.next('huddle:peers', (p) => (p.peers ?? []).length >= 2, { from: ma })))
    const target = ja?.p?.self
    const m2 = a.mark()
    b.emit('huddle:signal', { room, to: target, data: { type: 'offer', sdp: 'rtci' } })
    const sig = await a.next('huddle:signal', (p) => p.data?.sdp === 'rtci', { from: m2 })
    t.check('huddle:signal from bob reaches alice (to: socket id across nodes)', !!sig, sig?.p?.from)
    b.emit('huddle:leave', { room })
    a.emit('huddle:leave', { room })
    await sleep(500)
  })

  // ── watch rooms ───────────────────────────────────────────────────────────
  await suite.case('watch rooms: traffic, traffic-map, jobs (admin), refused for members', async (t) => {
    t.cleanup(fx.closeAll)
    const ad = await fx.sock(fx.bearer(cfg.adminToken, { name: 'admin' }))
    const member = await fx.sock('alice')
    ad.join('admin:join', { room: 'traffic' })
    ad.join('admin:join', { room: 'traffic-map' })
    ad.join('admin:join', { room: 'jobs' })
    member.join('admin:join', { room: 'traffic' })
    member.join('admin:join', { room: 'traffic-map' })
    await sleep(500)
    const m = ad.mark()
    const mm = member.mark()
    await admin.get('/api/items/rt_items?limit=1')
    t.check('traffic:request (web request → admin socket)', !!(await ad.next('traffic:request', () => true, { from: m })))
    t.check('traffic-map:frame arrives', !!(await ad.next('traffic-map:frame', () => true, { from: m, timeoutMs: 6000 })))
    const crons = (await admin.get('/api/cron')).json?.data ?? []
    const job = crons.find((c) => /presence|sweep|prune|cleanup/i.test(c.id ?? c.name ?? '')) ?? crons[0]
    if (job) {
      const r = await admin.post(`/api/cron/${encodeURIComponent(job.id ?? job.name)}/run`, {})
      t.check(`run-now ${job.id ?? job.name}`, r.status < 300, r.status)
      t.check('job:update reaches the jobs watch room', !!(await ad.next('job:update', () => true, { from: m, timeoutMs: 10_000 })))
    } else t.check('a cron job to run', false, 'GET /api/cron empty')
    await sleep(1000)
    t.check('member gets no traffic:request', member.all('traffic:request', mm).length === 0)
    t.check('member gets no traffic-map:frame', member.all('traffic-map:frame', mm).length === 0)
  })

  await suite.case('ops:join presence topic viewers (issue-view:1)', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    const b = await fx.sock('bob')
    a.join('ops:join', { topic: 'issue-view:1' })
    await sleep(2500) // staggered: the realtime board publishes every second
    const m = a.mark()
    b.join('ops:join', { topic: 'issue-view:1' })
    const ch = await a.next('ops:changed', (p) => (p.viewers ?? []).length >= 2, { from: m })
    t.check('ops:changed lists both viewers', !!ch, ch?.p)
  })

  // ── GraphQL subscriptions ────────────────────────────────────────────────
  const SUB = 'subscription ($c: String!) { itemMutated(collection: $c) { collection item action changed_fields } }'
  await suite.case('graphql-ws itemMutated (ticket and bearer)', async (t) => {
    const alice = await fx.browser('alice')
    const ticket = await alice.streamTicket()
    const viaTicket = await new GqlWs(wsUrl(cfg.base, '/api/graphql-ws'), { ticket }).open()
    const viaBearer = await new GqlWs(wsUrl(cfg.base, '/api/graphql-ws'), {
      authorization: `Bearer ${users.carol.token}`
    }).open()
    t.cleanup(() => {
      viaTicket.close()
      viaBearer.close()
    })
    t.check('ticket connection acked', viaTicket.acked, viaTicket.closed)
    t.check('bearer connection acked', viaBearer.acked, viaBearer.closed)
    const s1 = viaTicket.subscribe(SUB, { c: 'rt_items' })
    const s2 = viaBearer.subscribe(SUB, { c: 'rt_items' })
    await sleep(800)
    const [m1, m2] = [viaTicket.mark(), viaBearer.mark()]
    await admin.must('PATCH', `/api/items/rt_items/${id0}`, { title: `gql ${Date.now()}` })
    const n1 = await viaTicket.next((m) => m.id === s1 && m.type === 'next', { from: m1 })
    const n2 = await viaBearer.next((m) => m.id === s2 && m.type === 'next', { from: m2 })
    t.check('itemMutated over ticket connection', !!n1, viaTicket.messages.slice(m1).map((x) => x.type))
    t.check('itemMutated over bearer connection', !!n2, viaBearer.messages.slice(m2).map((x) => x.type))
    if (n1) t.check('payload names the item', String(n1.payload?.data?.itemMutated?.item) === String(id0), n1.payload)
  })

  await suite.case('graphql-ws refuses an unreadable collection (alice → rt_secret)', async (t) => {
    const alice = await fx.browser('alice')
    const ws = await new GqlWs(wsUrl(cfg.base, '/api/graphql-ws'), { ticket: await alice.streamTicket() }).open()
    t.cleanup(() => ws.close())
    const sid = ws.subscribe(SUB, { c: 'rt_secret' })
    const m = ws.mark()
    await sleep(500)
    await admin.must('PATCH', `/api/items/rt_secret/${fx.seed.secret}`, { title: `s ${Date.now()}` })
    const got = await ws.next((x) => x.id === sid && (x.type === 'error' || x.type === 'next'), { from: 0, timeoutMs: 4000 })
    const leaked = got?.type === 'next' && got.payload?.data?.itemMutated
    t.check('no itemMutated data for rt_secret', !leaked, got)
    t.check('an error (or nothing) instead', !got || got.type === 'error' || !!got.payload?.errors, got?.type)
    void m
  })

  await suite.case('GraphQL over SSE (/api/graphql/stream) — GET with ticket, POST with bearer', async (t) => {
    const alice = await fx.browser('alice')
    const ticket = await alice.streamTicket()
    const q = encodeURIComponent(SUB)
    const v = encodeURIComponent(JSON.stringify({ c: 'rt_items' }))
    const get = await openSse(`${cfg.base}/api/graphql/stream?query=${q}&variables=${v}&ticket=${ticket}`)
    const post = await openSse(`${cfg.base}/api/graphql/stream`, {
      method: 'POST',
      headers: { authorization: `Bearer ${users.carol.token}` },
      body: { query: SUB, variables: { c: 'rt_items' } }
    })
    t.cleanup(() => {
      get.close()
      post.close()
    })
    t.check('GET stream 200', get.status === 200, get.status)
    t.check('POST stream 200', post.status === 200, post.status)
    await sleep(800)
    const [m1, m2] = [get.mark(), post.mark()]
    await admin.must('PATCH', `/api/items/rt_items/${id0}`, { title: `gsse ${Date.now()}` })
    t.check('GET stream event: next', !!(await get.next((e) => e.event === 'next', { from: m1 })))
    t.check('POST stream event: next', !!(await post.next((e) => e.event === 'next', { from: m2 })))
  })

  // ── SSE streams ───────────────────────────────────────────────────────────
  await suite.case('/api/events/stream — ticket and bearer, cross-replica writes', async (t) => {
    const alice = await fx.browser('alice')
    const viaTicket = await openSse(`${cfg.base}/api/events/stream?collections=rt_items&ticket=${await alice.streamTicket()}`)
    const viaBearer = await openSse(`${cfg.base}/api/events/stream?collections=rt_items`, {
      headers: { authorization: `Bearer ${users.carol.token}` }
    })
    t.cleanup(() => {
      viaTicket.close()
      viaBearer.close()
    })
    t.check('ticket stream 200', viaTicket.status === 200, viaTicket.status)
    t.check('bearer stream 200', viaBearer.status === 200, viaBearer.status)
    t.metric('served_by_role', viaTicket.headers?.get('x-nivaro-role') ?? null)
    await sleep(500)
    const [m1, m2] = [viaTicket.mark(), viaBearer.mark()]
    // Several writes: Traefik spreads them over both web processes, so some land on a process
    // that holds neither stream.
    const n = 6
    for (let i = 0; i < n; i++) await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: i })
    await sleep(2500)
    const got1 = viaTicket.events.slice(m1).filter((e) => e.event === 'collection.update').length
    const got2 = viaBearer.events.slice(m2).filter((e) => e.event === 'collection.update').length
    t.metric('events_ticket', got1)
    t.metric('events_bearer', got2)
    t.check(`ticket stream got all ${n} writes`, got1 >= n, got1)
    t.check(`bearer stream got all ${n} writes`, got2 >= n, got2)
  })

  await suite.case('/api/events/stream drops unreadable collections (alice asks for rt_secret)', async (t) => {
    const alice = await fx.browser('alice')
    const s = await openSse(`${cfg.base}/api/events/stream?collections=rt_secret,rt_items&ticket=${await alice.streamTicket()}`)
    t.cleanup(() => s.close())
    await sleep(500)
    const m = s.mark()
    // Several writes of each: a stream may only hear the writes of its own process (see the
    // cross-replica case), and this case is about the filter.
    for (let i = 0; i < 4; i++) {
      await admin.must('PATCH', `/api/items/rt_secret/${fx.seed.secret}`, { title: `x ${Date.now()}` })
      await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: 7 + i })
    }
    await s.next((e) => e.data?.collection === 'rt_items', { from: m })
    t.check('no rt_secret frame', s.events.slice(m).every((e) => e.data?.collection !== 'rt_secret'))
    t.check('rt_items frame arrived', s.events.slice(m).some((e) => e.data?.collection === 'rt_items'))
  })

  await suite.case('saved-view stream: ready, record.change, record.leave', async (t) => {
    const alice = await fx.browser('alice')
    const view = await alice.must('POST', '/api/saved-views', {
      collection: 'rt_items',
      name: `rtci view ${Date.now()}`,
      filters: [{ path: ['status'], op: '_eq', value: 'open' }]
    })
    t.cleanup(() => alice.del(`/api/saved-views/${view.id}`))
    const s = await openSse(`${cfg.base}/api/events/views/${view.id}/stream?ticket=${await alice.streamTicket()}`)
    t.cleanup(() => s.close())
    t.check('stream 200', s.status === 200, s.status === 200 ? null : s.body)
    t.check('ready frame', !!(await s.next((e) => e.event === 'ready')))
    const m = s.mark()
    await admin.must('PATCH', `/api/items/rt_items/${id1}`, { status: 'open', n: 11 })
    t.check('record.change for a row in the view', !!(await s.next((e) => e.event === 'record.change', { from: m })))
    const m2 = s.mark()
    await admin.must('PATCH', `/api/items/rt_items/${id1}`, { status: 'closed' })
    t.check('record.leave when the row leaves the view', !!(await s.next((e) => e.event === 'record.leave', { from: m2 })))
    await admin.must('PATCH', `/api/items/rt_items/${id1}`, { status: 'open' })
  })

  await suite.case('admin /api/stream sees writes made on any web process', async (t) => {
    const s = await openSse(`${cfg.base}/api/stream`, { headers: { authorization: `Bearer ${cfg.adminToken}` } })
    t.cleanup(() => s.close())
    t.check('stream 200', s.status === 200, s.status)
    await sleep(500)
    const m = s.mark()
    const n = 6
    for (let i = 0; i < n; i++) await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: 100 + i })
    await sleep(2000)
    const got = s.events.slice(m).filter((e) => e.data?.type === 'update').length
    t.metric('admin_stream_events', got)
    t.check(`all ${n} writes on the admin stream`, got >= n, got)
  })

  // ── MCP live ──────────────────────────────────────────────────────────────
  await suite.case('MCP live session (?live=1): subscribe a record, change it, notification', async (t) => {
    const h = { authorization: `Bearer ${cfg.adminToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
    const init = await fetch(`${cfg.base}/api/mcp?live=1`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rtci', version: '1' } } })
    })
    const sid = init.headers.get('mcp-session-id')
    t.check('initialize returns mcp-session-id', !!sid, init.status)
    if (!sid) return
    t.cleanup(() => fetch(`${cfg.base}/api/mcp`, { method: 'DELETE', headers: { ...h, 'mcp-session-id': sid } }))
    await fetch(`${cfg.base}/api/mcp`, { method: 'POST', headers: { ...h, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    const sub = await fetch(`${cfg.base}/api/mcp`, {
      method: 'POST',
      headers: { ...h, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: `nivaro://record/rt_items/${id0}` } })
    })
    t.check('resources/subscribe 200', sub.ok, sub.status)
    const stream = await openSse(`${cfg.base}/api/mcp`, { headers: { authorization: h.authorization, 'mcp-session-id': sid } })
    t.cleanup(() => stream.close())
    t.check('session stream 200', stream.status === 200, stream.status)
    await sleep(6000) // the stream re-reads its subscriptions every 5 s
    const m = stream.mark()
    for (let i = 0; i < 3; i++) await admin.must('PATCH', `/api/items/rt_items/${id0}`, { title: `mcp ${Date.now()}` })
    const got = await stream.next((e) => JSON.stringify(e.data).includes('resources/updated'), { from: m, timeoutMs: 8000 })
    t.check('notifications/resources/updated arrives', !!got, stream.events.slice(m).length)
  })

  // ── pushes ────────────────────────────────────────────────────────────────
  await suite.case('force-refresh to one person (user_ids) and config:update to everyone', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    const b = await fx.sock('bob')
    const [ma, mb] = [a.mark(), b.mark()]
    const r = await admin.post('/api/realtime/force-refresh', { seconds: 30, message: 'rtci', user_ids: [users.alice.id] })
    t.check('POST force-refresh 2xx', r.status < 300, r.status)
    t.check('alice gets client:force-refresh', !!(await a.next('client:force-refresh', () => true, { from: ma })))
    await sleep(700)
    t.check('bob does not', b.all('client:force-refresh', mb).length === 0)
    const m2 = b.mark()
    const p = await admin.patch('/api/collections/rt_items', { note: `rtci ${Date.now()}` })
    t.check('PATCH collection 200', p.ok, p.status)
    t.check('config:update reaches a member', !!(await b.next('config:update', () => true, { from: m2, timeoutMs: 6000 })))
  })

  // ── shared worker + diagnostics ──────────────────────────────────────────
  await suite.case('shared worker: worker.js + socket.io.min.js served; hello counted in stats', async (t) => {
    t.cleanup(fx.closeAll)
    const w = await fetch(`${cfg.base}/api/realtime/worker.js`)
    t.check('GET /api/realtime/worker.js 200 javascript', w.status === 200 && /javascript/.test(w.headers.get('content-type') ?? ''), w.status)
    const lib = await fetch(`${cfg.base}/socket.io/socket.io.min.js`)
    t.check('GET /socket.io/socket.io.min.js 200 (what the worker loads)', lib.status === 200, lib.status)
    await fx.sock('alice', { sharedWorker: true, features: ['coalesce'] })
    await sleep(500)
    // Stats from the realtime board refresh every 10 s on a SOCKETS=off web process.
    const stats = await poll(async () => {
      const r = await admin.get('/api/realtime/stats')
      return (r.json?.data?.socket_count ?? 0) > 0 ? r.json.data : null
    }, { timeoutMs: 25_000, everyMs: 2000 })
    t.metric('stats_node_view', { socket_count: stats?.socket_count, shared_worker_count: stats?.shared_worker_count })
    t.check('GET /api/realtime/stats sees sockets (diagnostics parity)', (stats?.socket_count ?? 0) > 0, stats?.socket_count)
  })

  await suite.case('delivery SLO: acks from sockets are counted', async (t) => {
    t.cleanup(fx.closeAll)
    const a = await fx.sock('alice')
    a.join('collection:join', { collection: 'rt_items' })
    await sleep(300)
    const before = (await admin.get('/api/realtime/delivery-slo')).json?.data
    for (let i = 0; i < 10; i++) await admin.must('PATCH', `/api/items/rt_items/${id0}`, { n: 200 + i })
    await sleep(3000)
    const acked = a.all('collection:update').filter((e) => typeof e.p._st === 'number').length
    t.metric('sampled_events_seen', acked)
    const after = (await admin.get('/api/realtime/delivery-slo')).json?.data
    t.metric('slo_before', before ? JSON.stringify(before).slice(0, 300) : null)
    t.metric('slo_after', after ? JSON.stringify(after).slice(0, 300) : null)
    t.check('events carry _st with REALTIME_ACK_EVERY=1', acked >= 5, acked)
    t.check('delivery-slo answers', !!after)
    t.check('delivery-slo changed after acks', JSON.stringify(before) !== JSON.stringify(after))
  })

  suite.metrics.delivery_ms = pct(latencies)
  suite.metrics.socket_nodes = socketNodes()
  return suite.result({ untested: UNTESTED })
}
