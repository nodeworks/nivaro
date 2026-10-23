// Failover / chaos: replica loss, graceful shutdown, Redis faults (toxiproxy), web restarts with
// sockets live, mixed versions, long-polling through sticky routing, slow consumers. Every case
// puts the stack back (toxics cleared, stopped services started, ready) in its cleanup.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { cfg, directUrl, repoRoot, socketNodes, webNodes } from '../lib/config.mjs'
import { fixture } from '../lib/fixture.mjs'
import { pct, poll, Suite, sleep } from '../lib/harness.mjs'
import { adminClient, Client } from '../lib/http.mjs'
import { LiveSocket } from '../lib/sock.mjs'
import { openSse } from '../lib/sse.mjs'
import { kill, recreate, socketCounts, start, stop, toxics, waitReady } from '../lib/stack.mjs'

const WS = createRequire(resolve(repoRoot, 'api/package.json'))('ws')

export const UNTESTED = [
  'Traefik itself restarting (single point in this stack; production runs it replicated)',
  'MSSQL faults (covered by deploy/chaos-ci + scripts/chaos/toxiproxy-suite.mjs)',
  'host reboot / docker daemon restart'
]

export async function run({ only, args }) {
  const suite = new Suite('failover', { only })
  const fx = await fixture()
  const { admin } = fx
  const nodes = socketNodes()
  const tier = cfg.mode === 'tier'

  async function ensureAllUp() {
    await toxics.resetAll()
    for (const n of [...new Set([...nodes, ...webNodes()])]) {
      try {
        await waitReady(n, 2000)
      } catch {
        await start(n).catch(() => {})
        await waitReady(n, 240_000)
      }
    }
    await sleep(3000) // Traefik's health check (2 s) puts every server back
  }

  /** `count` sockets (alice) through Traefik, all in collection:rt_items. */
  async function fleet(count, o = {}) {
    const socks = []
    for (let i = 0; i < count; i++) socks.push(await fx.sock('alice', o))
    for (const s of socks) s.join('collection:join', { collection: 'rt_items' })
    await sleep(600)
    return socks
  }

  /** Create a row every `everyMs` for `ms` (through Traefik, falling back to a live web). */
  async function writeLoop(ms, everyMs = 250, label = 'w') {
    const ids = []
    const failed = []
    const end = Date.now() + ms
    let i = 0
    while (Date.now() < end) {
      const body = { title: `${label} ${i++}`, status: 'loop', n: i }
      let r = await admin.post('/api/items/rt_items', body, { timeoutMs: 5000 }).catch((e) => ({ ok: false, status: e.message }))
      if (!r.ok) {
        for (const w of webNodes()) {
          r = await adminClient(directUrl(w)).post('/api/items/rt_items', body, { timeoutMs: 5000 }).catch((e) => ({ ok: false, status: e.message }))
          if (r.ok) break
        }
      }
      if (r.ok) ids.push({ id: r.json?.data?.id, at: Date.now() })
      else failed.push(r.status)
      await sleep(everyMs)
    }
    return { ids, failed }
  }

  /** Per socket: which written ids it never saw (live or replayed), after waiting `graceMs`. */
  async function missing(socks, ids, graceMs = 8000) {
    const want = new Set(ids.map((x) => String(x.id)))
    const seen = (s) => new Set(s.all('collection:update').filter((e) => e.p.action === 'create').map((e) => String(e.p.item)))
    await poll(() => socks.every((s) => [...want].every((id) => seen(s).has(id))), { timeoutMs: graceMs, everyMs: 500 })
    return socks.map((s) => {
      const got = seen(s)
      const miss = [...want].filter((id) => !got.has(id))
      const replayed = s.events.filter((e) => e.replay && want.has(String(e.p?.item))).length
      return { socket: s.id, missing: miss.length, replayed, catchupFull: s.all('catchup:full').length }
    })
  }

  function reconnectStats(socks, since) {
    const times = socks.map((s) => {
      const d = s.disconnects.find((x) => x.at >= since)
      return d ? { down: d.at - since, reason: d.reason } : null
    })
    return times
  }

  // ── replica loss ─────────────────────────────────────────────────────────
  for (const how of ['SIGKILL', 'graceful (docker stop, SIGTERM)']) {
    await suite.case(`socket replica lost (${how}): clients move to the other, rooms kept, missed events replayed`, async (t) => {
      t.cleanup(async () => {
        fx.closeAll()
        await ensureAllUp()
      })
      const socks = await fleet(16)
      const before = await socketCounts()
      t.metric('sockets_before', before)
      const victim = nodes[0]
      const onVictim = before[victim] ?? 0
      t.check(`some sockets on ${victim}`, onVictim > 0, before)
      const since = Date.now()
      const loop = writeLoop(9000, 200, `loss-${how.slice(0, 4)}`)
      await sleep(1000)
      const stopP = how === 'SIGKILL' ? kill(victim) : stop(victim, 15)
      await stopP
      const stopMs = Date.now() - since
      const { ids, failed } = await loop
      const recon = socks.map((s) => ({ s, d: s.disconnects.find((x) => x.at >= since) }))
      const moved = recon.filter((r) => r.d)
      await poll(() => moved.every((r) => r.s.connected && r.s.authCount >= 2), { timeoutMs: 20_000 })
      const reauth = moved.map((r) => {
        // auth:ok after the disconnect: the reconnect time this person saw.
        const ok = r.s.events.find((e) => e.ev === 'auth:ok' && e.at > r.d.at)
        return ok ? ok.at - r.d.at : null
      })
      t.metric('stop_call_ms', stopMs)
      t.metric('disconnected', moved.length)
      t.metric('disconnect_reasons', [...new Set(moved.map((r) => r.d.reason))])
      t.metric('detect_ms', pct(moved.map((r) => r.d.at - since - 1000)))
      t.metric('reconnect_ms', pct(reauth))
      t.metric('writes', { ok: ids.length, failed: failed.length })
      // onVictim is the process's own count (it may include sockets another run left behind);
      // the fleet itself must have lost some and every one of the 16 must be signed in again.
      t.check('the lost replica held some of the fleet and they noticed (no hang)', moved.length > 0, { moved: moved.length, onVictim })
      t.check('every fleet socket is connected and signed in again', socks.every((s) => s.connected), socks.filter((s) => !s.connected).length)
      t.check('every disconnected socket signed in again', reauth.every((x) => x != null), reauth)
      t.check('reconnect p95 under 10 s', (pct(reauth).p95 ?? 1e9) < 10_000, pct(reauth))
      const after = await socketCounts()
      t.metric('sockets_after', after)
      t.check(`all sockets now on the survivor (${nodes[1]})`, (after[nodes[1]] ?? 0) >= socks.length, after)
      const miss = await missing(socks, ids)
      const lost = miss.reduce((a, m) => a + m.missing, 0)
      t.metric('missed_per_socket', miss.filter((m) => m.missing || m.replayed || m.catchupFull))
      t.metric('replayed_events', miss.reduce((a, m) => a + m.replayed, 0))
      t.check(`no event lost across the failover (${lost} missing over ${socks.length} sockets × ${ids.length} writes)`, lost === 0, lost)
      t.check('writes kept succeeding (web unaffected)', tier ? failed.length === 0 : true, failed.slice(0, 5))
      // Rooms kept: a record-room join made before the loss still works after it.
      const m = socks[0].mark()
      await admin.must('PATCH', `/api/items/rt_items/${fx.item(0)}`, { n: Date.now() % 1000 })
      t.check('after recovery the rejoined collection room delivers', !!(await socks[0].next('collection:update', () => true, { from: m })))
    }, { timeoutMs: 180_000 })
  }

  await suite.case('graceful shutdown: SSE streams on the stopped replica end promptly (no hang)', async (t) => {
    t.cleanup(async () => {
      fx.closeAll()
      await ensureAllUp()
    })
    const alice = await fx.browser('alice')
    const streams = []
    for (let i = 0; i < 6; i++) streams.push(await openSse(`${cfg.base}/api/events/stream?collections=rt_items&ticket=${await alice.streamTicket()}`))
    t.cleanup(() => streams.forEach((s) => s.close()))
    const victim = nodes[0]
    const since = Date.now()
    const stopP = stop(victim, 15)
    const ended = await poll(() => (streams.filter((s) => s.ended).length > 0 ? streams.filter((s) => s.ended) : null), { timeoutMs: 15_000 })
    t.metric('streams_ended', streams.map((s) => (s.ended ? s.ended.at - since : null)))
    t.check('streams on the stopped replica ended within the drain window', (ended?.length ?? 0) > 0)
    t.check('no stream outlived the stop by more than 12 s', streams.every((s) => !s.ended || s.ended.at - since < 12_000))
    await stopP
  }, { timeoutMs: 120_000 })

  await suite.case('new connections during a replica loss all succeed (Traefik health check)', async (t) => {
    t.cleanup(async () => {
      fx.closeAll()
      await ensureAllUp()
    })
    await kill(nodes[0])
    await sleep(500)
    const t0 = Date.now()
    const socks = []
    let failedOpen = 0
    for (let i = 0; i < 12; i++) {
      try {
        socks.push(await fx.sock('bob', { timeoutMs: 20_000 }))
      } catch {
        failedOpen++
      }
    }
    const errs = socks.reduce((a, s) => a + s.connectErrors.length, 0)
    t.metric('open_ms', Date.now() - t0)
    t.metric('connect_errors_retried', errs)
    t.check('every new socket eventually signed in', failedOpen === 0, failedOpen)
  }, { timeoutMs: 180_000 })

  // ── Redis faults ──────────────────────────────────────────────────────────
  const allRedis = Object.values(cfg.nodes).map((n) => n.redis)
  await suite.case('Redis outage (all links, 6 s): sockets survive or come back, delivery resumes', async (t) => {
    t.cleanup(async () => {
      fx.closeAll()
      await ensureAllUp()
    })
    const socks = await fleet(10)
    const since = Date.now()
    for (const p of allRedis) await toxics.enable(p, false)
    await sleep(2500)
    const ready = {}
    for (const n of nodes) ready[n] = (await fetch(`${directUrl(n)}/api/ready`).catch(() => ({ status: 0 }))).status
    t.metric('ready_during_outage', ready)
    await sleep(3500)
    for (const p of allRedis) await toxics.enable(p, true)
    const healed = Date.now()
    t.metric('disconnected_sockets', socks.filter((s) => s.disconnects.some((d) => d.at >= since)).length)
    // First delivery after the heal.
    let firstMs = null
    await poll(async () => {
      const m = socks.map((s) => s.mark())
      const r = await admin.post('/api/items/rt_items', { title: 'after redis', status: 'loop' }).catch(() => null)
      if (!r?.ok) return null
      const ok = await Promise.all(socks.map((s, i) => s.next('collection:update', (p) => String(p.item) === String(r.json.data.id), { from: m[i], timeoutMs: 3000 })))
      if (ok.every(Boolean)) {
        firstMs = Date.now() - healed
        return true
      }
      return null
    }, { timeoutMs: 60_000, everyMs: 500 })
    t.metric('first_full_delivery_after_heal_ms', firstMs)
    t.check('every socket receives again after Redis returns', firstMs != null, firstMs)
    t.check('within 30 s', firstMs != null && firstMs < 30_000, firstMs)
    t.check('every socket is signed in at the end', socks.every((s) => s.connected), socks.filter((s) => !s.connected).length)
  }, { timeoutMs: 180_000 })

  await suite.case('Redis slow (300 ms latency on every link): every event still arrives', async (t) => {
    t.cleanup(async () => {
      fx.closeAll()
      await ensureAllUp()
    })
    const socks = await fleet(8)
    for (const p of allRedis) await toxics.add(p, 'latency', { latency: 300, jitter: 50 }, 'downstream')
    const t0 = Date.now()
    const { ids } = await writeLoop(6000, 300, 'slow')
    const lat = []
    const miss = await missing(socks, ids, 20_000)
    for (const s of socks)
      for (const w of ids) {
        const e = s.events.find((x) => x.ev === 'collection:update' && String(x.p.item) === String(w.id))
        if (e) lat.push(e.at - w.at)
      }
    t.metric('write_loop_ms', Date.now() - t0)
    t.metric('delivery_after_write_ms', pct(lat))
    const lost = miss.reduce((a, m) => a + m.missing, 0)
    t.check(`no lost events (${lost})`, lost === 0, miss.filter((m) => m.missing))
  }, { timeoutMs: 180_000 })

  await suite.case('Redis partition of ONE socket replica (8 s): its clients miss nothing after the heal', async (t) => {
    t.cleanup(async () => {
      fx.closeAll()
      await ensureAllUp()
    })
    const socks = await fleet(12)
    const victim = nodes[0]
    const counts = await socketCounts()
    t.metric('sockets', counts)
    await toxics.enable(cfg.nodes[victim].redis, false)
    const since = Date.now()
    const loop = writeLoop(8000, 300, 'part')
    await sleep(3000)
    const ready = (await fetch(`${directUrl(victim)}/api/ready`).catch(() => ({ status: 0 }))).status
    t.metric('partitioned_ready_status', ready)
    const { ids } = await loop
    await toxics.enable(cfg.nodes[victim].redis, true)
    // Real traffic goes on after the heal: the next event in the room shows the clients that
    // their room counter skipped (#2462 gap detection → catchup:room).
    await sleep(2000)
    const after = await writeLoop(2000, 500, 'part-after')
    ids.push(...after.ids)
    const miss = await missing(socks, ids, 20_000)
    t.metric('room_gaps_seen', socks.reduce((a, s) => a + s.roomGaps.length, 0))
    t.metric('room_catchups', socks.reduce((a, s) => a + s.roomCatchups.length, 0))
    const lost = miss.reduce((a, m) => a + m.missing, 0)
    t.metric('disconnects', socks.filter((s) => s.disconnects.some((d) => d.at >= since)).length)
    t.metric('missed', miss.filter((m) => m.missing))
    t.metric('catchup_full', miss.reduce((a, m) => a + m.catchupFull, 0))
    t.check(`no event lost for the partitioned replica's clients (${lost} missing)`, lost === 0, lost)
  }, { timeoutMs: 180_000 })

  // ── web restarts / mixed versions ────────────────────────────────────────
  await suite.case('web processes restart one by one while sockets are live', async (t) => {
    t.cleanup(async () => {
      fx.closeAll()
      await ensureAllUp()
    })
    const socks = await fleet(10)
    const since = Date.now()
    for (const w of webNodes()) {
      await stop(w, 15)
      await start(w)
      await waitReady(w, 240_000)
      await sleep(3000)
    }
    const dropped = socks.filter((s) => s.disconnects.some((d) => d.at >= since)).length
    t.metric('sockets_dropped', dropped)
    if (tier) t.check('no socket dropped (sockets live on the realtime tier)', dropped === 0, dropped)
    else t.note(`single mode: ${dropped}/${socks.length} sockets dropped by the web restarts (expected — they live on web)`)
    const { ids } = await writeLoop(2000, 250, 'webr')
    const lost = (await missing(socks, ids)).reduce((a, m) => a + m.missing, 0)
    t.check('delivery works after both web processes restarted', lost === 0, lost)
  }, { timeoutMs: 600_000 })

  const altImage = typeof args?.['alt-image'] === 'string' ? args['alt-image'] : process.env.RTCI_ALT_IMAGE
  await suite.case(
    'mixed versions: web-2 on another image, writes through each web reach every socket',
    async (t) => {
      t.cleanup(async () => {
        fx.closeAll()
        await recreate('web-2', {})
        await waitReady('web-2', 240_000)
        await ensureAllUp()
      })
      await recreate('web-2', { RTCI_IMAGE_WEB2: altImage })
      await waitReady('web-2', 240_000)
      const v1 = (await (await fetch(`${directUrl('web-1')}/api/version`)).json()).version
      const v2 = (await (await fetch(`${directUrl('web-2')}/api/version`)).json()).version
      t.metric('versions', { 'web-1': v1, 'web-2': v2, alt: altImage })
      const socks = await fleet(8)
      for (const w of webNodes()) {
        const marks = socks.map((s) => s.mark())
        const r = await adminClient(directUrl(w)).must('POST', '/api/items/rt_items', { title: `mixed via ${w}`, status: 'loop' })
        const got = await Promise.all(socks.map((s, i) => s.next('collection:update', (p) => String(p.item) === String(r.id), { from: marks[i] })))
        t.check(`write on ${w} reaches all ${socks.length} sockets`, got.every(Boolean), got.filter((x) => !x).length)
      }
      for (const w of webNodes()) {
        const s = socks[0]
        const m = s.mark()
        const r = await adminClient(directUrl(w)).post('/api/notifications', { recipient: fx.users.alice.id, subject: `mixed ${w}` })
        t.check(`notification:new via ${w}`, r.ok && !!(await s.next('notification:new', (p) => p.subject === `mixed ${w}`, { from: m })))
      }
    },
    { skip: altImage ? false : 'pass --alt-image <tag> (or RTCI_ALT_IMAGE), e.g. an image built from main', timeoutMs: 600_000 }
  )

  // ── transports ────────────────────────────────────────────────────────────
  await suite.case('long-polling only clients through the sticky router', async (t) => {
    t.cleanup(fx.closeAll)
    const socks = await fleet(10, { transports: ['polling'] })
    t.check('all on polling', socks.every((s) => s.transport === 'polling'), socks.map((s) => s.transport))
    const errs = socks.reduce((a, s) => a + s.connectErrors.length, 0)
    t.metric('connect_errors', errs)
    const { ids } = await writeLoop(3000, 250, 'poll')
    const miss = await missing(socks, ids)
    const lost = miss.reduce((a, m) => a + m.missing, 0)
    t.check(`polling clients get every event (${lost} missing)`, lost === 0, lost)
    const reconnects = socks.reduce((a, s) => a + s.disconnects.length, 0)
    t.check('no polling session broke (no "session id unknown" reconnects)', reconnects === 0 && errs === 0, { reconnects, errs })
    t.metric('per_node', await socketCounts())
  }, { timeoutMs: 120_000 })

  await suite.case('polling without the sticky cookie (what an LB without affinity does)', async (t) => {
    // Informational: proves stickiness is load-bearing for polling. A cookie-less client is
    // spread per request; the second node does not know the engine session.
    const c = await fx.browser('bob')
    let ok = 0
    let bad = 0
    for (let i = 0; i < 6; i++) {
      const hs = await fetch(`${cfg.base}/socket.io/?EIO=4&transport=polling`)
      const sid = (await hs.text()).match(/"sid":"([^"]+)"/)?.[1]
      let fine = true
      for (let j = 0; j < 4 && sid; j++) {
        const r = await fetch(`${cfg.base}/socket.io/?EIO=4&transport=polling&sid=${sid}`, { method: 'POST', body: '40', headers: { 'content-type': 'text/plain' } })
        if (r.status !== 200) fine = false
      }
      fine ? ok++ : bad++
    }
    void c
    t.metric('cookieless_sessions', { ok, broken: bad })
    t.check('measured', true)
    t.note(`polling with no affinity cookie: ${bad}/6 sessions broke (expected > 0 with 2 replicas)`)
  })

  // ── slow consumer ─────────────────────────────────────────────────────────
  await suite.case('slow consumer: a stalled socket is held/closed, a healthy one is unaffected', async (t) => {
    t.cleanup(fx.closeAll)
    const healthy = await fx.sock('bob')
    healthy.join('chat:join', { room: 'global' })
    // Straight to a socket process: Traefik and toxiproxy would otherwise absorb the backlog in
    // their own buffers and the server would never see a slow reader.
    const stalled = await rawStalledSocket(await fx.browser('carol'), 'global', directUrl(nodes[0]))
    t.cleanup(() => stalled.close())
    t.check('raw stalled socket signed in', stalled.authed, stalled.log.slice(0, 5))
    await sleep(500)
    stalled.pause()
    const m = healthy.mark()
    const poster = await fx.browser('alice')
    const big = () => Buffer.from(Array.from({ length: 6000 }, () => Math.floor(Math.random() * 256))).toString('base64')
    const n = Number(args?.['slow-messages'] ?? 1500)
    const t0 = Date.now()
    let sent = 0
    for (let i = 0; i < n; i += 20) {
      const batch = []
      for (let j = i; j < Math.min(n, i + 20); j++) batch.push(poster.post('/api/chat/messages', { room: 'global', message: `slow ${j} ${big()}` }).then((r) => r.ok && sent++))
      await Promise.all(batch)
    }
    const postMs = Date.now() - t0
    await poll(() => healthy.all('chat:message', m).length >= sent, { timeoutMs: 20_000 })
    const got = healthy.all('chat:message', m).length
    t.metric('posted', { sent, postMs, bytes_approx: sent * 8000 })
    t.metric('healthy_received', got)
    t.check(`healthy socket received every message (${got}/${sent})`, got >= sent, got)
    stalled.resume()
    await sleep(3000)
    t.metric('stalled_outcome', { closed: stalled.closedAt != null, stale: stalled.events.filter((e) => e === 'realtime:stale').length, frames: stalled.frames })
    t.check('the stalled socket was held (realtime:stale) or closed — not buffered without bound', stalled.closedAt != null || stalled.events.includes('realtime:stale'))
  }, { timeoutMs: 180_000 })

  return suite.result({ untested: UNTESTED })
}

/**
 * A socket.io client on a raw `ws` connection whose reading can be paused (the TCP window then
 * fills and the server's send buffer grows) — what a frozen tab or a dead mobile link looks like.
 */
async function rawStalledSocket(browser, room, base = cfg.base) {
  const token = await browser.wsToken()
  const url = `${base.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`
  const ws = new WS(url, { perMessageDeflate: false })
  const out = { authed: false, log: [], events: [], frames: 0, closedAt: null }
  ws.on('message', (data) => {
    const s = String(data)
    out.frames++
    if (s === '2') return ws.send('3')
    if (s.startsWith('0')) return ws.send('40')
    if (s.startsWith('40')) {
      ws.send(`42${JSON.stringify(['client:hello', { app: 'rtci-raw', tab: `raw-${Date.now()}` }])}`)
      ws.send(`42${JSON.stringify(['auth', { token }])}`)
      return
    }
    if (s.startsWith('42')) {
      try {
        const [ev] = JSON.parse(s.slice(2))
        out.events.push(ev)
        if (ev === 'auth:ok') {
          out.authed = true
          ws.send(`42${JSON.stringify(['chat:join', { room }])}`)
        }
      } catch {}
    }
    if (out.log.length < 20) out.log.push(s.slice(0, 60))
  })
  ws.on('close', () => {
    out.closedAt = Date.now()
  })
  ws.on('error', () => {})
  await poll(() => out.authed, { timeoutMs: 10_000 })
  out.pause = () => ws._socket?.pause()
  out.resume = () => ws._socket?.resume()
  out.close = () => {
    try {
      ws.terminate()
    } catch {}
  }
  return out
}
