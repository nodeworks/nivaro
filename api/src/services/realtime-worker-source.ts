/**
 * One socket per browser (#2475): the SharedWorker script every tab of one app attaches to.
 *
 * Served as plain JavaScript at `GET /api/realtime/worker.js` (routes/realtime-worker.ts), so
 * neither app bundles it: a SharedWorker is identified by its URL and must be same-origin, and
 * both apps reach the API on their own origin (the admin is served by it; a headless frontend
 * proxies `/api`). The worker loads socket.io's own client from `/socket.io/socket.io.min.js`
 * (the server serves it) and owns the ONE connection; tabs talk to it over MessagePorts through
 * `createWorkerSocket` (packages/shared/src/lib/worker-socket.ts), which presents the port as
 * a socket.io-shaped object so every existing consumer keeps working.
 *
 * What the worker owns (and tabs no longer do):
 * - sign-in: it asks one live tab for a `/auth/ws-token` and sends `auth {token}`. A tab that
 *   answers no token backs it off (1 s doubling to 5 min); a tab that answers `signedOut: true`
 *   parks it: the socket closes and nothing is asked until a tab sends `signed-in` or a new tab
 *   says hello (a fresh page may be signed in). Focus never restarts the asking;
 * - rooms: per-port membership, one server join when the first tab enters a room, one leave
 *   when the last tab leaves, every held room re-joined after each `auth:ok`;
 * - the catch-up: one `lastSeq`, one `catchup {cursor}` per reconnect, replayed events fan out
 *   like live ones, then every tab hears `catchup:events {events: []}` to settle its state;
 * - routing: `collection:update` only to tabs holding that collection, record-room events to
 *   tabs holding that record, chat messages to tabs in that room, everything else to all;
 * - presence per tab: `page:at` is forwarded for the tab the person used last.
 *
 * Kept in a string (not a .ts module) because the API ships it as a file, not as code it runs:
 * tsc never sees it, so realtime-worker-source.test.ts parses and exercises it in a vm.
 * PROTO changes when the message shape changes; a tab that meets another PROTO falls back to
 * its own socket (an old worker lives until its last old tab closes).
 */

export const REALTIME_WORKER_PROTO = 1

/** `REALTIME_SHARED_WORKER=off` turns the worker route off; tabs then keep one socket each. */
export function realtimeWorkerEnabled(): boolean {
  return (process.env.REALTIME_SHARED_WORKER ?? 'on').toLowerCase() !== 'off'
}

export const REALTIME_WORKER_SOURCE = `/* Nivaro realtime shared worker (#2475) — one socket per browser. Source: api/src/services/realtime-worker-source.ts */
'use strict'
var PROTO = ${REALTIME_WORKER_PROTO}
var ORIGIN = self.location.origin
var PING_MS = 5000
var DEAD_AFTER_MS = 16000
var TOKEN_WAIT_MS = 5000
/* A tab that answers with no token cannot mint one (signed out, or a failed request): ask again
   with a doubling wait, not every second (one signed-out tab sent 16,000 401s in 8 hours; staging
   2026-10-23 saw 2,116 ws-token 401s an hour). A tab that knows it is signed out says so
   (signedOut: true): the worker parks — closes the socket and asks nothing — until a tab sends
   'signed-in' or a new tab says hello. Focus ('active') never restarts the asking: the zombie
   reaper (45 s) plus the stall watchdog used to turn that into a loop. */
var TOKEN_RETRY_MIN_MS = 1000
var TOKEN_RETRY_MAX_MS = 300000
var tokenRetryMs = TOKEN_RETRY_MIN_MS
/* Parked: a tab said it is signed out. */
var tokenParked = false
/* A backoff wait is running: a (re)connect leaves the asking to its timer. */
var tokenBackoff = false
/* The socket is down on purpose (parked, or the server dropped it unauthenticated): the stall
   watchdog leaves it alone; the backoff timer or a wake connects it again. */
var tokenIdle = false

importScripts(ORIGIN + '/socket.io/socket.io.min.js')

/* port -> { rooms: Set<string>, lastPong: number, pageAt: any, hello: any, pending: Map } */
var ports = new Map()
var activePort = null
var socket = null
var authed = false
var everAuthed = false
var lastSeq = 0
var reconnects = -1
var hello = null
var tokenReq = { id: 0, port: null, timer: null }
var connectFailures = 0
var everConnected = false
/* Watchdog state: when the socket went down, and when a connect attempt last started or ended. */
var downSince = 0
var lastAttemptAt = 0
var STALL_MS = 25000

/* Room-shaped emits: event -> [leave event, key of payload]. The worker keeps the server
   membership as the union of every tab's. */
var JOINS = {
  'collection:join': ['collection:leave', function (p) { return p && p.collection ? 'collection:' + p.collection : null }],
  'admin:join': ['admin:leave', function (p) { return p && p.room ? 'watch:' + p.room : null }],
  'ops:join': ['ops:leave', function (p) { return p && p.topic ? 'ops:' + p.topic : null }],
  'record:join': ['record:leave', function (p) { return p && p.collection && p.item != null ? 'record:' + p.collection + ':' + p.item : null }],
  'chat:join': ['chat:leave', function (p) { return p && p.room ? 'chat:' + p.room : null }],
  'pulse:join': ['pulse:leave', function () { return 'pulse' }],
  'presence-map:join': ['presence-map:leave', function () { return 'presence-map' }],
  'presence:join': [null, function (p) { return typeof p === 'string' && p ? 'presence:' + p : null }],
  'tenant:join': [null, function (p) { return typeof p === 'string' && p ? 'tenant:' + p : null }]
}
/* Events the worker handles itself above (socket.io's onAny skips the reserved ones anyway). */
var OWN_EVENTS = { connect: 1, disconnect: 1, connect_error: 1, 'catchup:cursor': 1, 'nvr:ping': 1, 'catchup:events': 1, 'auth:ok': 1, 'session:ended': 1 }
var LEAVES = {}
Object.keys(JOINS).forEach(function (join) {
  var leave = JOINS[join][0]
  if (leave) LEAVES[leave] = join
})
/* key -> { event, payload, leave: leave event or null, leavePayload } */
var roomSpecs = new Map()

function holdersOf(key) {
  var out = []
  ports.forEach(function (st, port) { if (st.rooms.has(key)) out.push(port) })
  return out
}
function anyHolder(key) {
  var found = false
  ports.forEach(function (st) { if (st.rooms.has(key)) found = true })
  return found
}
function post(port, msg) {
  try { port.postMessage(msg) } catch (e) { /* a closed port */ }
}
function broadcast(msg, targets) {
  (targets || Array.from(ports.keys())).forEach(function (port) { post(port, msg) })
}
function deliver(event, args, targets) {
  broadcast({ t: 'ev', event: event, args: args }, targets)
}
function status() {
  var transport = null
  try { transport = socket && socket.io && socket.io.engine && socket.io.engine.transport ? socket.io.engine.transport.name : null } catch (e) { transport = null }
  return { t: 'status', connected: !!(socket && socket.connected), authed: authed, transport: transport }
}

/* Route a server event to the tabs it concerns. */
function route(event, args) {
  var p = args[0]
  var targets = null
  if (event === 'collection:update') {
    targets = p && p.collection ? holdersOf('collection:' + p.collection) : []
  } else if (event === 'presence:rows') {
    targets = p && p.collection && p.item != null ? holdersOf('rows:' + p.collection + ':' + p.item) : []
  } else if (event === 'chat:message') {
    var chatHolders = p && p.room ? holdersOf('chat:' + p.room) : []
    targets = chatHolders.length ? chatHolders : null
  } else if (event === 'ops:changed') {
    var opsHolders = p && p.topic ? holdersOf('ops:' + p.topic) : []
    targets = opsHolders.length ? opsHolders : null
  } else if (event.indexOf('record:') === 0 || event.indexOf('field:') === 0) {
    if (p && p.collection && p.item != null) {
      targets = holdersOf('record:' + p.collection + ':' + p.item)
    } else {
      targets = []
      ports.forEach(function (st, port) {
        var held = false
        st.rooms.forEach(function (k) { if (k.indexOf('record:') === 0) held = true })
        if (held) targets.push(port)
      })
    }
  }
  deliver(event, args, targets)
}

function emitRaw(event, payload) {
  if (socket && socket.connected) socket.emit(event, payload)
}

function joinServer(key) {
  var spec = roomSpecs.get(key)
  if (spec && authed) emitRaw(spec.event, spec.payload)
}
function leaveServer(key) {
  var spec = roomSpecs.get(key)
  if (spec && spec.leave) emitRaw(spec.leave, spec.payload)
}
function rejoinAll() {
  roomSpecs.forEach(function (spec, key) {
    if (!anyHolder(key)) return
    if (key.indexOf('rows:') === 0) return
    emitRaw(spec.event, spec.payload)
  })
  /* row watches go back grouped per collection (one message per collection) */
  var byCollection = {}
  roomSpecs.forEach(function (spec, key) {
    if (key.indexOf('rows:') !== 0 || !anyHolder(key)) return
    var c = spec.payload.collection
    if (!byCollection[c]) byCollection[c] = []
    byCollection[c].push(spec.payload.item)
  })
  Object.keys(byCollection).forEach(function (c) {
    emitRaw('presence:watch', { collection: c, items: byCollection[c] })
  })
}

function hold(port, key, spec) {
  var st = ports.get(port)
  if (!st) return
  var first = !anyHolder(key)
  st.rooms.add(key)
  if (!roomSpecs.has(key)) roomSpecs.set(key, spec)
  if (first) joinServer(key)
}
function release(port, key) {
  var st = ports.get(port)
  if (!st || !st.rooms.has(key)) return
  st.rooms.delete(key)
  if (!anyHolder(key)) {
    leaveServer(key)
    roomSpecs.delete(key)
  }
}
function releaseAll(port) {
  var st = ports.get(port)
  if (!st) return
  var rowsByCollection = {}
  Array.from(st.rooms).forEach(function (key) {
    if (key.indexOf('rows:') === 0) {
      var spec = roomSpecs.get(key)
      st.rooms.delete(key)
      if (!anyHolder(key) && spec) {
        roomSpecs.delete(key)
        var c = spec.payload.collection
        if (!rowsByCollection[c]) rowsByCollection[c] = []
        rowsByCollection[c].push(spec.payload.item)
      }
      return
    }
    release(port, key)
  })
  Object.keys(rowsByCollection).forEach(function (c) {
    emitRaw('presence:unwatch', { collection: c, items: rowsByCollection[c] })
  })
}

/* presence:watch / presence:unwatch carry a list; the server is told only about pairs no tab
   watched before / no tab watches any more. */
function watchRows(port, payload, on) {
  if (!payload || !payload.collection || !Array.isArray(payload.items)) return
  var c = String(payload.collection)
  var changed = []
  payload.items.forEach(function (item) {
    if (item == null) return
    var key = 'rows:' + c + ':' + String(item)
    var st = ports.get(port)
    if (!st) return
    if (on) {
      var first = !anyHolder(key)
      st.rooms.add(key)
      if (!roomSpecs.has(key)) roomSpecs.set(key, { event: 'presence:watch', payload: { collection: c, item: String(item) }, leave: null })
      if (first) changed.push(String(item))
    } else {
      if (!st.rooms.has(key)) return
      st.rooms.delete(key)
      if (!anyHolder(key)) {
        roomSpecs.delete(key)
        changed.push(String(item))
      }
    }
  })
  if (changed.length && (on ? authed : true)) emitRaw(on ? 'presence:watch' : 'presence:unwatch', { collection: c, items: changed })
}

function requestToken() {
  if (tokenReq.timer) clearTimeout(tokenReq.timer)
  tokenReq.timer = null
  tokenBackoff = false
  if (tokenParked) return
  var candidates = []
  if (activePort && ports.has(activePort)) candidates.push(activePort)
  ports.forEach(function (st, port) { if (candidates.indexOf(port) < 0) candidates.push(port) })
  candidates = candidates.filter(function (p) { return p !== tokenReq.port || candidates.length === 1 })
  if (!candidates.length) return
  tokenReq.id += 1
  tokenReq.port = candidates[0]
  post(tokenReq.port, { t: 'need-token', req: tokenReq.id })
  tokenReq.timer = setTimeout(function () {
    tokenReq.timer = null
    if (!authed && socket && socket.connected) requestToken()
  }, TOKEN_WAIT_MS)
}

/* No token: wait (doubling) and ask again — connecting first when the socket is idle. */
function scheduleTokenRetry() {
  if (tokenReq.timer) clearTimeout(tokenReq.timer)
  var wait = tokenRetryMs
  tokenRetryMs = Math.min(tokenRetryMs * 2, TOKEN_RETRY_MAX_MS)
  tokenBackoff = true
  tokenReq.timer = setTimeout(function () {
    tokenReq.timer = null
    tokenBackoff = false
    if (authed || tokenParked || !socket) return
    if (socket.connected) requestToken()
    else if (tokenIdle) {
      tokenIdle = false
      socket.connect()
    }
  }, wait)
}

/* A tab knows it is signed out: stop asking and close the unauthenticated socket. */
function parkToken() {
  tokenParked = true
  tokenBackoff = false
  if (tokenReq.timer) clearTimeout(tokenReq.timer)
  tokenReq.timer = null
  tokenIdle = true
  if (socket && socket.connected && !authed) socket.disconnect()
}

/* Ask now: a new tab (a fresh page may be signed in) or a tab that heard a sign-in (reset = the
   wait starts over). A parked or idle socket connects again; its connect asks. */
function wakeToken(reset) {
  if (reset) tokenRetryMs = TOKEN_RETRY_MIN_MS
  tokenParked = false
  if (authed || !socket) return
  if (socket.connected) return requestToken()
  if (!tokenIdle) return
  tokenIdle = false
  tokenBackoff = false
  if (tokenReq.timer) clearTimeout(tokenReq.timer)
  tokenReq.timer = null
  socket.connect()
}

function sendHello() {
  if (!hello) return
  var features = ['coalesce'].concat(hello.features || []).filter(function (f, i, a) { return a.indexOf(f) === i })
  var msg = { reconnects: Math.max(0, reconnects), app: hello.app || 'shared-worker', features: features, transport: status().transport, shared_worker: true }
  var v = hello.version || {}
  Object.keys(v).forEach(function (k) { msg[k] = v[k] })
  emitRaw('client:hello', msg)
}

function ensureSocket() {
  if (socket) return
  socket = self.io(ORIGIN, {
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    withCredentials: true,
    /* An attempt routed to a stopped server hangs until this fires (socket.io's default is 20 s). */
    timeout: 10000,
    reconnection: true,
    reconnectionDelay: 1500 + Math.floor(Math.random() * 2500),
    reconnectionDelayMax: 15000,
    randomizationFactor: 0.6
  })
  socket.on('connect', function () {
    everConnected = true
    connectFailures = 0
    downSince = 0
    reconnects += 1
    authed = false
    tokenIdle = false
    deliver('connect', [])
    broadcast(status())
    if (!tokenParked && !tokenBackoff) requestToken()
  })
  socket.on('connect_error', function (err) {
    connectFailures += 1
    lastAttemptAt = Date.now()
    deliver('connect_error', [{ message: err && err.message ? String(err.message) : 'connect_error' }])
    broadcast(status())
    /* The API answers HTTP but no socket transport gets through (a proxy without the upgrade
       and polling off): only a tab can read the SSE stream, so tell them to run their own. */
    if (!everConnected && connectFailures === 2) {
      fetch(ORIGIN + '/api/version', { cache: 'no-store', credentials: 'include' }).then(function (r) {
        if (r.ok && !(socket && socket.connected)) broadcast({ t: 'fallback', reason: 'socket-blocked' })
      }).catch(function () { /* the API is down: the socket's own reconnect handles that */ })
    }
  })
  socket.on('disconnect', function (reason) {
    var wasAuthed = authed
    authed = false
    downSince = Date.now()
    /* Dropped by the server before signing in (the 45 s zombie reaper): no reconnect until a
       token is likely — the backoff timer, a new tab or a sign-in brings it back. */
    if (!wasAuthed && reason === 'io server disconnect') {
      tokenIdle = true
      if (!tokenParked && !tokenBackoff) scheduleTokenRetry()
    }
    deliver('disconnect', [reason])
    broadcast(status())
  })
  socket.on('auth:ok', function () {
    authed = true
    tokenRetryMs = TOKEN_RETRY_MIN_MS
    sendHello()
    rejoinAll()
    if (everAuthed && lastSeq > 0) emitRaw('catchup', { cursor: lastSeq })
    everAuthed = true
    deliver('auth:ok', [])
    broadcast(status())
    var st = activePort ? ports.get(activePort) : null
    if (st && st.pageAt) emitRaw('page:at', st.pageAt)
  })
  socket.on('catchup:cursor', function (p) {
    if (lastSeq === 0 && p && typeof p.seq === 'number' && p.seq > 0) lastSeq = p.seq
  })
  socket.on('nvr:ping', function (p) { emitRaw('nvr:pong', { t: p && p.t }) })
  socket.on('catchup:events', function (p) {
    var events = (p && p.events) || []
    events.forEach(function (ev) {
      if (ev.seq > lastSeq) lastSeq = ev.seq
      var payload = Object.assign({}, ev.payload, { _seq: ev.seq })
      route(ev.event, [payload])
    })
    deliver('catchup:events', [{ events: [] }])
  })
  socket.on('session:ended', function (p) {
    authed = false
    deliver('session:ended', [p])
  })
  socket.io.on('reconnect_attempt', function () { lastAttemptAt = Date.now(); broadcast(status()) })
  socket.io.engine && socket.io.engine.on && socket.io.engine.on('upgrade', function () { broadcast(status()) })
  socket.onAny(function (event) {
    var args = Array.prototype.slice.call(arguments, 1)
    var p = args[0]
    if (p && typeof p === 'object' && typeof p._seq === 'number' && p._seq > lastSeq) lastSeq = p._seq
    if (OWN_EVENTS[event]) return
    route(event, args)
  })
}

function onEmit(port, msg) {
  var event = msg.event
  var payload = msg.payload
  if (!event) return
  if (JOINS[event]) {
    var key = JOINS[event][1](payload)
    if (key) hold(port, key, { event: event, payload: payload, leave: JOINS[event][0] })
    return
  }
  if (LEAVES[event]) {
    var leaveKey = JOINS[LEAVES[event]][1](payload)
    if (leaveKey) release(port, leaveKey)
    return
  }
  if (event === 'presence:watch') return watchRows(port, payload, true)
  if (event === 'presence:unwatch') {
    if (payload && payload.collection && Array.isArray(payload.items)) return watchRows(port, payload, false)
    /* unwatch everything this tab holds */
    var st0 = ports.get(port)
    if (!st0) return
    var all = {}
    Array.from(st0.rooms).forEach(function (k) {
      if (k.indexOf('rows:') !== 0) return
      var spec = roomSpecs.get(k)
      if (!spec) return
      if (!all[spec.payload.collection]) all[spec.payload.collection] = []
      all[spec.payload.collection].push(spec.payload.item)
    })
    Object.keys(all).forEach(function (c) { watchRows(port, { collection: c, items: all[c] }, false) })
    return
  }
  if (event === 'catchup' || event === 'nvr:pong') return
  if (event === 'client:hello') {
    var st1 = ports.get(port)
    if (st1) st1.hello = payload
    if (!hello && payload) hello = { app: payload.app, features: payload.features, version: {} }
    return
  }
  if (event === 'page:at') {
    var st2 = ports.get(port)
    if (st2) st2.pageAt = payload
    if (port === activePort || !activePort) {
      activePort = port
      emitRaw('page:at', payload)
    }
    return
  }
  if (typeof msg.ack === 'number') {
    if (!(socket && socket.connected)) return post(port, { t: 'ack', id: msg.ack, args: [] })
    socket.emit(event, payload, function () {
      post(port, { t: 'ack', id: msg.ack, args: Array.prototype.slice.call(arguments) })
    })
    return
  }
  emitRaw(event, payload)
}

function drop(port) {
  if (!ports.has(port)) return
  releaseAll(port)
  ports.delete(port)
  if (activePort === port) activePort = null
  if (tokenReq.port === port) tokenReq.port = null
  try { port.close() } catch (e) { /* already closed */ }
}

function onMessage(port, ev) {
  var msg = ev.data
  if (!msg || typeof msg !== 'object') return
  var st = ports.get(port)
  if (!st) return
  st.lastPong = Date.now()
  switch (msg.t) {
    case 'hello':
      st.hello = msg
      if (!hello) hello = { app: msg.app, features: msg.features, version: msg.version || {} }
      if (!activePort || msg.active) activePort = port
      ensureSocket()
      post(port, status())
      if (socket && socket.connected) {
        post(port, { t: 'ev', event: 'connect', args: [] })
        if (authed) post(port, { t: 'ev', event: 'auth:ok', args: [] })
        else wakeToken(false)
      } else if (socket && tokenIdle) wakeToken(false)
      return
    case 'pong':
      return
    case 'active':
      activePort = port
      if (st.pageAt && authed) emitRaw('page:at', st.pageAt)
      return
    case 'signed-in':
      wakeToken(true)
      return
    case 'token':
      if (msg.req !== tokenReq.id) return
      if (tokenReq.timer) clearTimeout(tokenReq.timer)
      tokenReq.timer = null
      if (msg.token && socket && socket.connected) socket.emit('auth', { token: msg.token })
      else if (!msg.token) {
        if (msg.signedOut === true) parkToken()
        else scheduleTokenRetry()
      }
      return
    case 'emit':
      onEmit(port, msg)
      return
    case 'connect':
      if (socket && !socket.connected) socket.connect()
      return
    case 'bye':
      drop(port)
      return
    default:
      return
  }
}

self.onconnect = function (e) {
  var port = e.ports[0]
  ports.set(port, { rooms: new Set(), lastPong: Date.now(), pageAt: null, hello: null })
  port.onmessage = function (ev) { onMessage(port, ev) }
  port.onmessageerror = function () { drop(port) }
  port.start && port.start()
  post(port, { t: 'ready', proto: PROTO })
}

/* Watchdog: after a server roll behind a polling proxy (traefik's swarm provider) the socket
   was seen sitting disconnected with no further attempts while plain tabs recovered. A socket
   down with no attempt starting or ending for STALL_MS gets a fresh connect. */
setInterval(function () {
  if (!socket || socket.connected || tokenIdle || !downSince || !ports.size) return
  var now = Date.now()
  if (now - Math.max(downSince, lastAttemptAt) < STALL_MS) return
  lastAttemptAt = now
  try { if (socket.io.engine) socket.io.engine.close() } catch (e) { /* already closed */ }
  socket.connect()
}, 5000)

/* Tabs that vanished without a bye (a crashed tab, a killed process) stop answering pings. */
setInterval(function () {
  var now = Date.now()
  ports.forEach(function (st, port) {
    if (now - st.lastPong > DEAD_AFTER_MS) drop(port)
    else post(port, { t: 'ping' })
  })
}, PING_MS)
`
