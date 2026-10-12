// biome-ignore-all lint/suspicious/noConsole: command-line tool, the console is its output
/**
 * Realtime load test (#1754).
 *
 *   cd api && npx tsx ../scripts/realtime-load-test.mts --target http://127.0.0.1:3132 \
 *     --api-pid <pid> --sockets 100 --rate 4 --duration 30 --out /tmp/rt-load.json
 *
 * N simulated socket.io clients sign in with a one-time ws-token, join record / collection / chat
 * rooms, while a write generator creates and updates rows in a THROWAWAY table. Reports delivery
 * latency (p50/p95/p99), memory per socket (RSS of the target process), Redis traffic (INFO stats
 * deltas) and event-stream lag (/api/realtime/pipeline). Prints a human summary and a JSON file.
 *
 * What it creates (all removed again in `finally`, on Ctrl-C and on failure):
 *   - table zz_loadtest_<random> with its nivaro_collections + nivaro_fields rows
 *   - a throwaway active user with an admin role and a static token
 *   - whatever the API wrote about them (activity, revisions, journal, presence rows)
 *
 * SAFETY: the database is shared. By default the script refuses any target but 127.0.0.1:3132
 * and caps the run at smoke scale (200 sockets, 5 writes/s, 60 s). Full scale needs
 * `--full-scale --confirm-dedicated <target host>` and belongs on a dedicated environment with
 * its own database (see the Realtime load test doc section).
 */

import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { db } from '../api/src/db/index.js'

const requireFrom = (pkg: string) => createRequire(new URL(pkg, import.meta.url))
const { io: connectSocket } = requireFrom('../admin/package.json')('socket.io-client') as {
  io: (url: string, opts: Record<string, unknown>) => any
}
const Redis = requireFrom('../api/package.json')('ioredis') as new (url: string) => any

// ─── CLI ────────────────────────────────────────────────────────────────────────

const SMOKE = { sockets: 200, rate: 5, duration: 60, port: '3132' }

function parseArgs(argv: string[]) {
  const a: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) a[k] = true
    else {
      a[k] = next
      i++
    }
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
const num = (k: string, d: number) => (args[k] != null ? Number(args[k]) : d)

if (args.help) {
  console.log(`realtime-load-test.mts
  --target <url>        API base (default http://127.0.0.1:3132)
  --api-pid <pid>       target process id, for RSS per socket (local targets only)
  --sockets <n>         simulated clients (default 100)
  --ramp <s>            seconds to connect all clients over (default 5)
  --rate <w/s>          writes per second to the throwaway table (default 4)
  --duration <s>        seconds of load after the ramp (default 30)
  --mix <r/c/h>         room mix in percent record/collection/chat (default 20/70/10)
  --coalesce-share <f>  share of clients that opt in to burst merging (default 0.5)
  --out <file>          write the JSON report here
  --full-scale --confirm-dedicated <host>   lift the smoke limits (dedicated env only)`)
  process.exit(0)
}

const target = String(args.target ?? 'http://127.0.0.1:3132').replace(/\/$/, '')
const url = new URL(target)
const fullScale = args['full-scale'] === true
if (fullScale) {
  if (args['confirm-dedicated'] !== url.host) {
    console.error(
      `--full-scale needs --confirm-dedicated ${url.host} (this must be a dedicated environment)`
    )
    process.exit(2)
  }
} else {
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== SMOKE.port) {
    console.error(`Refusing target ${url.host}: smoke runs only against 127.0.0.1:${SMOKE.port}`)
    process.exit(2)
  }
}
const N = num('sockets', 100)
const RAMP = num('ramp', 5)
const RATE = num('rate', 4)
const DURATION = num('duration', 30)
if (!fullScale && (N > SMOKE.sockets || RATE > SMOKE.rate || DURATION > SMOKE.duration)) {
  console.error(
    `Smoke limits: <= ${SMOKE.sockets} sockets, <= ${SMOKE.rate} writes/s, <= ${SMOKE.duration} s`
  )
  process.exit(2)
}
if (!(N >= 1) || !(RATE > 0) || !(DURATION > 0)) {
  console.error('sockets, rate and duration must be positive numbers')
  process.exit(2)
}
const [mixR, mixC, mixH] = String(args.mix ?? '20/70/10')
  .split('/')
  .map(Number)
const mixTotal = mixR + mixC + mixH
if (![mixR, mixC, mixH].every(Number.isFinite) || mixTotal <= 0) {
  console.error('--mix must look like 20/70/10')
  process.exit(2)
}
const COALESCE_SHARE = num('coalesce-share', 0.5)
const apiPid = args['api-pid'] ? Number(args['api-pid']) : null

// ─── Stats helpers ──────────────────────────────────────────────────────────────

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return (
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10
  )
}
function summarize(values: number[]) {
  const s = [...values].sort((x, y) => x - y)
  return {
    n: s.length,
    min: s.length ? Math.round(s[0] * 10) / 10 : null,
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : null
  }
}
const rssKb = (): number | null => {
  if (!apiPid) return null
  try {
    return Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(apiPid)])
        .toString()
        .trim()
    )
  } catch {
    return null
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Throwaway fixtures ─────────────────────────────────────────────────────────

const suffix = randomBytes(4).toString('hex')
const COLLECTION = `zz_loadtest_${suffix}`
const USER_ID = randomUUID()
const USER_EMAIL = `zz-loadtest-${suffix}@example.invalid`
const STATIC_TOKEN = `zzlt_${randomBytes(24).toString('hex')}`
let createdTable = false
let createdUser = false
let createdMeta = false
const recordIds: number[] = []

async function setup() {
  const role = await db('nivaro_roles').where({ admin_access: true }).first('id')
  if (!role) throw new Error('no admin role to give the throwaway user')
  await db.schema.createTable(COLLECTION, (t) => {
    t.increments('id')
    t.string('title', 120)
    t.integer('n')
  })
  createdTable = true
  createdMeta = true
  await db('nivaro_collections').insert({
    collection: COLLECTION,
    display_name: COLLECTION,
    hidden: true,
    accountability: 'all'
  })
  const fields: Array<[string, string]> = [
    ['id', 'integer'],
    ['title', 'string'],
    ['n', 'integer']
  ]
  for (const [i, [field, type]] of fields.entries())
    await db('nivaro_fields').insert({ collection: COLLECTION, field, type, sort: i })
  await db('nivaro_users').insert({
    id: USER_ID,
    first_name: 'zz',
    last_name: 'loadtest',
    email: USER_EMAIL,
    role: role.id,
    status: 'active',
    static_token: STATIC_TOKEN
  })
  createdUser = true
}

/** Tables holding a column of this name: used to sweep what the API wrote about our fixtures. */
async function tablesWithColumn(column: string): Promise<string[]> {
  const rows = await db.raw(
    'select TABLE_NAME t from INFORMATION_SCHEMA.COLUMNS where COLUMN_NAME = ?',
    [column]
  )
  return (rows as Array<{ t: string }>).map((r) => r.t)
}

const cleanupLog: string[] = []
async function cleanup() {
  const swallow = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (err) {
      cleanupLog.push(`${label}: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  if (createdMeta || createdTable) {
    for (const t of await tablesWithColumn('collection').catch(() => [] as string[])) {
      if (t === 'nivaro_collections' || t === COLLECTION) continue
      await swallow(`sweep ${t}`, () => db(t).where({ collection: COLLECTION }).delete())
    }
    await swallow('nivaro_fields', () =>
      db('nivaro_fields').where({ collection: COLLECTION }).delete()
    )
    await swallow('nivaro_relations', () =>
      db('nivaro_relations')
        .where({ many_collection: COLLECTION })
        .orWhere({ one_collection: COLLECTION })
        .delete()
    )
    await swallow('nivaro_collections', () =>
      db('nivaro_collections').where({ collection: COLLECTION }).delete()
    )
    await swallow('drop table', () => db.schema.dropTableIfExists(COLLECTION))
  }
  if (createdUser) {
    // Rows that name the user through a foreign key, then the common unconstrained columns.
    const fks = (await db
      .raw(
        `select OBJECT_NAME(fk.parent_object_id) t, COL_NAME(fkc.parent_object_id, fkc.parent_column_id) c
         from sys.foreign_keys fk
         join sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id
         where fk.referenced_object_id = OBJECT_ID('nivaro_users')`
      )
      .catch(() => [])) as Array<{ t: string; c: string }>
    for (const { t, c } of fks)
      await swallow(`user rows ${t}.${c}`, () =>
        db(t)
          .where({ [c]: USER_ID })
          .delete()
      )
    for (const col of ['user_id', 'user']) {
      for (const t of await tablesWithColumn(col).catch(() => [] as string[])) {
        if (t === 'nivaro_users') continue
        await swallow(`user rows ${t}.${col}`, () =>
          db(t)
            .where({ [col]: USER_ID })
            .delete()
        )
      }
    }
    await swallow('nivaro_users', () => db('nivaro_users').where({ id: USER_ID }).delete())
  }
}

async function verifyGone() {
  const tableGone = !(await db.schema.hasTable(COLLECTION))
  const metaCollections = Number(
    (await db('nivaro_collections').where({ collection: COLLECTION }).count({ c: '*' }).first())
      ?.c ?? 0
  )
  const metaFields = Number(
    (await db('nivaro_fields').where({ collection: COLLECTION }).count({ c: '*' }).first())?.c ?? 0
  )
  const users = Number(
    (await db('nivaro_users').where({ id: USER_ID }).count({ c: '*' }).first())?.c ?? 0
  )
  return { tableGone, metaCollections, metaFields, users }
}

// ─── HTTP ───────────────────────────────────────────────────────────────────────

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${target}/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${STATIC_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`)
  return body
}

// ─── Clients ────────────────────────────────────────────────────────────────────

type Kind = 'record' | 'collection' | 'chat'
interface Client {
  idx: number
  kind: Kind
  coalesce: boolean
  socket: any
  authed: boolean
  connectMs: number | null
  connectedAt: number
}

/** Arrivals of collection:update, keyed `${action}:${id}` -> [receive times]. */
const arrivals = new Map<string, Array<{ at: number; coalesced: boolean }>>()
const sendTimes = new Map<string, number>()
const responseTimes = new Map<string, number>()
let mergedWithoutIds = 0
let mergedMessages = 0
const signalArrivals: number[][] = [] // per signal index: receive times
const signalSends: number[] = []
let signalIdxCursor = 0
let disconnects = 0
let connectErrors = 0

const kindFor = (i: number): Kind => {
  const x = ((i + 0.5) / N) * mixTotal
  if (x < mixR) return 'record'
  if (x < mixR + mixC) return 'collection'
  return 'chat'
}

async function startClient(c: Client): Promise<void> {
  const tok = (await api('/auth/ws-token')).token as string
  const t0 = performance.now()
  const socket = connectSocket(target, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true
  })
  c.socket = socket
  socket.on('disconnect', () => {
    disconnects++
  })
  socket.on('connect_error', () => {
    connectErrors++
  })
  socket.on('nvr:ping', (p: any) => socket.emit('nvr:pong', p))
  socket.on('collection:update', (p: any) => {
    if (p?.collection !== COLLECTION) return
    const at = performance.now()
    const note = (key: string, coalesced: boolean) => {
      const l = arrivals.get(key) ?? []
      l.push({ at, coalesced })
      arrivals.set(key, l)
    }
    if (Array.isArray(p.items)) {
      mergedMessages++
      // A merged message lists ids, not actions; attribute it to whatever action was sent for that id.
      for (const id of p.items) {
        note(sendTimes.has(`update:${id}`) ? `update:${id}` : `create:${id}`, true)
      }
    } else if (p.item === '*' || p.item == null || p.many) {
      mergedMessages++
      mergedWithoutIds += Number(p.count ?? 1)
    } else if (p.action) note(`${p.action}:${p.item}`, false)
  })
  socket.on('record:signal', () => {
    const at = performance.now()
    // Signals go out one per second, so a receive belongs to the newest send before it.
    for (let i = signalSends.length - 1; i >= 0; i--) {
      if (signalSends[i] <= at) {
        if (!signalArrivals[i]) signalArrivals[i] = []
        signalArrivals[i].push(at)
        break
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`client ${c.idx}: no auth:ok in 15s`)), 15_000)
    socket.on('connect', () => {
      socket.emit('client:hello', {
        app: 'load-test',
        transport: 'websocket',
        reconnects: 0,
        features: c.coalesce ? ['coalesce'] : []
      })
      socket.emit('auth', { token: tok })
    })
    socket.on('auth:ok', () => {
      clearTimeout(timer)
      c.authed = true
      c.connectMs = performance.now() - t0
      c.connectedAt = Date.now()
      resolve()
    })
    socket.on('connect_error', (e: Error) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  if (c.kind === 'collection') socket.emit('collection:join', { collection: COLLECTION })
  else if (c.kind === 'record')
    socket.emit('record:join', {
      collection: COLLECTION,
      item: String(recordIds[0])
    })
  else socket.emit('chat:join', { room: `zz-loadtest-${suffix}` }) // join-gate load only: a room we cannot see
}

// ─── Redis ──────────────────────────────────────────────────────────────────────

async function redisInfo(redis: any) {
  const raw: string = await redis.info('stats')
  const get = (k: string) => Number(new RegExp(`${k}:(\\d+)`).exec(raw)?.[1] ?? NaN)
  const streamLen = await redis.xlen('nvr:ev:stream').catch(() => null)
  return {
    commands: get('total_commands_processed'),
    netIn: get('total_net_input_bytes'),
    netOut: get('total_net_output_bytes'),
    connections: get('total_connections_received'),
    streamLen
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────────

const clients: Client[] = []
let finished = false

async function run() {
  let redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    const { config } = await import('../api/src/config.js')
    redisUrl = config.REDIS_URL
  }
  const redis = new Redis(redisUrl as string)

  console.log(
    `target ${target}  collection ${COLLECTION}  sockets ${N}  rate ${RATE}/s  duration ${DURATION}s`
  )
  await setup()
  // Seed rows: the first sits in the record rooms, the rest take one update each (a row is
  // reused only after the pool wraps, so an arrival always belongs to the newest send).
  const rows: number[] = []
  for (let i = 0; i < 100; i++) {
    const r = await api(`/items/${COLLECTION}`, {
      method: 'POST',
      body: JSON.stringify({ title: `seed ${i}`, n: i })
    })
    rows.push(Number(r.data.id))
  }
  recordIds.push(...rows)

  const health = await api('/health')
  const rssBase = rssKb()
  const redisBefore = await redisInfo(redis)
  const pipelineBefore = (await api('/realtime/pipeline')).data
  const t0 = Date.now()

  // Ramp
  for (let i = 0; i < N; i++)
    clients.push({
      idx: i,
      kind: kindFor(i),
      coalesce: i / N < COALESCE_SHARE,
      socket: null,
      authed: false,
      connectMs: null,
      connectedAt: 0
    })
  const gap = (RAMP * 1000) / N
  const starts: Array<Promise<unknown>> = []
  let failed = 0
  for (const c of clients) {
    starts.push(
      startClient(c).catch((e) => {
        failed++
        if (failed <= 3) console.error(`  ${e.message}`)
      })
    )
    await sleep(gap)
  }
  await Promise.all(starts)
  await sleep(1500) // joins are fire-and-forget; let them land
  const rssConnected = rssKb()
  const statsConnected = (await api('/realtime/stats')).data
  const authed = clients.filter((c) => c.authed).length
  const collectionClients = clients.filter((c) => c.authed && c.kind === 'collection').length
  console.log(
    `connected ${authed}/${N} (server sees ${statsConnected.socket_count}), transports ${JSON.stringify(statsConnected.transports)}`
  )

  // Load
  const lagSamples: number[] = []
  const lagTimer = setInterval(async () => {
    try {
      const p = (await api('/realtime/pipeline')).data
      if (typeof p.stream?.lastDeliveryLagMs === 'number')
        lagSamples.push(p.stream.lastDeliveryLagMs)
    } catch {}
  }, 2000)

  let writes = 0
  let writeErrors = 0
  const writeLatency: number[] = []
  const loadEnd = performance.now() + DURATION * 1000
  const signalSender = clients.find((c) => c.authed && c.kind === 'record')
  let nextSignal = performance.now() + 500
  let signalState: 'start' | 'stop' = 'start'
  let seq = 0
  let updates = 0
  const interval = 1000 / RATE
  let nextWrite = performance.now()
  const inflight: Array<Promise<void>> = []
  while (performance.now() < loadEnd) {
    const now = performance.now()
    if (signalSender && now >= nextSignal) {
      signalSends[signalIdxCursor++] = now
      signalSender.socket.emit('record:signal', {
        collection: COLLECTION,
        item: String(recordIds[0]),
        kind: 'note',
        state: signalState
      })
      signalState = signalState === 'start' ? 'stop' : 'start'
      nextSignal += 1000
    }
    if (now >= nextWrite) {
      nextWrite += interval
      const n = seq++
      inflight.push(
        (async () => {
          const sent = performance.now()
          try {
            if (n % 2 === 0) {
              // The id is only known from the response (the event can beat it), so the send
              // time is attached afterwards and latency is computed at the end.
              const r = await api(`/items/${COLLECTION}`, {
                method: 'POST',
                body: JSON.stringify({ title: `lt ${n}`, n })
              })
              sendTimes.set(`create:${Number(r.data.id)}`, sent)
              responseTimes.set(`create:${Number(r.data.id)}`, performance.now())
            } else {
              const id = recordIds[1 + (updates++ % (recordIds.length - 1))]
              sendTimes.set(`update:${id}`, sent)
              await api(`/items/${COLLECTION}/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ title: `lt ${n} upd`, n: n + 1 })
              })
              responseTimes.set(`update:${id}`, performance.now())
            }
            writes++
            writeLatency.push(performance.now() - sent)
          } catch (e) {
            writeErrors++
            if (writeErrors <= 3) console.error(`  write: ${(e as Error).message}`)
          }
        })()
      )
    }
    await sleep(5)
  }
  await Promise.all(inflight)
  await sleep(3000) // let stragglers land
  clearInterval(lagTimer)

  // Collect
  const redisAfter = await redisInfo(redis)
  const pipelineAfter = (await api('/realtime/pipeline')).data
  const rssPeak = rssKb()
  const elapsed = (Date.now() - t0) / 1000

  // Latency: first arrival per (key, client) is not tracked per client, so use all arrivals.
  const direct: number[] = []
  const merged: number[] = []
  const afterResponse: number[] = []
  let received = 0
  for (const [key, list] of arrivals) {
    // `update:<id>` sends are overwritten by later updates of the same row; use the newest send before each arrival.
    const sent = sendTimes.get(key)
    if (sent == null) continue
    for (const a of list) {
      received++
      const ms = a.at - sent
      if (ms < 0 || ms > 60_000) continue
      ;(a.coalesced ? merged : direct).push(ms)
      const resp = responseTimes.get(key)
      if (!a.coalesced && resp != null) afterResponse.push(a.at - resp)
    }
  }
  const expected = writes * collectionClients
  const signalLat: number[] = []
  let signalRecv = 0
  for (const [i, list] of signalArrivals.entries()) {
    if (!list) continue
    for (const at of list) {
      signalRecv++
      signalLat.push(at - signalSends[i])
    }
  }
  const recordClients = clients.filter((c) => c.authed && c.kind === 'record').length
  const signalExpected = signalSends.length * Math.max(0, recordClients - 1)

  const mem = (a: number | null, b: number | null) => (a != null && b != null ? b - a : null)
  const rssDelta = mem(rssBase, rssConnected)
  const dRedis = {
    commands: redisAfter.commands - redisBefore.commands,
    netInBytes: redisAfter.netIn - redisBefore.netIn,
    netOutBytes: redisAfter.netOut - redisBefore.netOut,
    connections: redisAfter.connections - redisBefore.connections
  }
  const report = {
    at: new Date().toISOString(),
    target,
    version: health.version,
    params: {
      sockets: N,
      ramp_s: RAMP,
      rate_per_s: RATE,
      duration_s: DURATION,
      mix: { record: mixR, collection: mixC, chat: mixH },
      coalesce_share: COALESCE_SHARE
    },
    connections: {
      requested: N,
      authenticated: authed,
      failed,
      server_socket_count: statsConnected.socket_count,
      transports: statsConnected.transports,
      connect_ms: summarize(
        clients.filter((c) => c.connectMs != null).map((c) => c.connectMs as number)
      ),
      disconnects,
      connect_errors: connectErrors
    },
    writes: { sent: writes, errors: writeErrors, http_ms: summarize(writeLatency) },
    delivery: {
      collection_expected: expected,
      collection_received: received + mergedWithoutIds,
      collection_loss_pct: expected
        ? Math.round(((expected - received - mergedWithoutIds) / expected) * 1000) / 10
        : null,
      merged_messages: mergedMessages,
      merged_without_ids: mergedWithoutIds,
      latency_ms_unmerged_clients: summarize(direct),
      // Arrival minus the write's HTTP response; negative = the event beat the response.
      latency_ms_unmerged_after_response: summarize(afterResponse),
      latency_ms_merging_clients: summarize(merged),
      record_signal: {
        sent: signalSends.length,
        expected: signalExpected,
        received: signalRecv,
        latency_ms: summarize(signalLat)
      }
    },
    memory: {
      rss_base_kb: rssBase,
      rss_connected_kb: rssConnected,
      rss_after_load_kb: rssPeak,
      kb_per_socket: rssDelta != null && authed ? Math.round((rssDelta / authed) * 10) / 10 : null,
      note: apiPid ? 'RSS of --api-pid; includes GC noise' : 'pass --api-pid for memory'
    },
    redis: {
      ...dRedis,
      commands_per_s: Math.round(dRedis.commands / elapsed),
      net_out_kb_per_s: Math.round(dRedis.netOutBytes / 1024 / elapsed),
      stream_len_before: redisBefore.streamLen,
      stream_len_after: redisAfter.streamLen,
      note: 'INFO deltas for the whole Redis server; other users of this Redis add noise'
    },
    stream: {
      published_delta: pipelineAfter.stream.published - pipelineBefore.stream.published,
      own_skipped_delta: pipelineAfter.stream.ownSkipped - pipelineBefore.stream.ownSkipped,
      note: 'one node: every entry is read back by its own publisher (own_skipped), so delivery lag only fills with 2+ nodes',
      delivered_delta: pipelineAfter.stream.delivered - pipelineBefore.stream.delivered,
      publish_failed_delta:
        pipelineAfter.stream.publishFailed - pipelineBefore.stream.publishFailed,
      read_errors_delta: pipelineAfter.stream.readErrors - pipelineBefore.stream.readErrors,
      active: pipelineAfter.stream.active,
      delivery_lag_ms: summarize(lagSamples)
    }
  }
  redis.disconnect()
  return report
}

function printSummary(
  r: Awaited<ReturnType<typeof run>>,
  verify: Awaited<ReturnType<typeof verifyGone>>
) {
  const l = (s: {
    n: number
    p50: number | null
    p95: number | null
    p99: number | null
    max: number | null
  }) => `p50 ${s.p50} / p95 ${s.p95} / p99 ${s.p99} / max ${s.max} ms (n=${s.n})`
  console.log('\n=== Realtime load test ===')
  console.log(
    `connections    ${r.connections.authenticated}/${r.connections.requested} ok, connect ${l(r.connections.connect_ms)}, drops ${r.connections.disconnects}`
  )
  console.log(
    `writes         ${r.writes.sent} ok, ${r.writes.errors} failed, http ${l(r.writes.http_ms)}`
  )
  console.log(
    `delivery       ${r.delivery.collection_received}/${r.delivery.collection_expected} collection updates (loss ${r.delivery.collection_loss_pct}%), ${r.delivery.merged_messages} merged messages`
  )
  console.log(`  unmerged     ${l(r.delivery.latency_ms_unmerged_clients)}`)
  console.log(`  vs response  ${l(r.delivery.latency_ms_unmerged_after_response)}`)
  console.log(`  merging      ${l(r.delivery.latency_ms_merging_clients)}`)
  console.log(
    `  record sig   ${r.delivery.record_signal.received}/${r.delivery.record_signal.expected}, ${l(r.delivery.record_signal.latency_ms)}`
  )
  console.log(
    `memory         base ${r.memory.rss_base_kb} KB -> ${r.memory.rss_connected_kb} KB, ${r.memory.kb_per_socket} KB/socket`
  )
  console.log(
    `redis          ${r.redis.commands} cmds (${r.redis.commands_per_s}/s), out ${r.redis.net_out_kb_per_s} KB/s, stream ${r.redis.stream_len_before} -> ${r.redis.stream_len_after}`
  )
  console.log(
    `stream         published +${r.stream.published_delta}, delivered +${r.stream.delivered_delta}, own-skipped +${r.stream.own_skipped_delta}, failed +${r.stream.publish_failed_delta}, lag ${l(r.stream.delivery_lag_ms)}`
  )
  console.log(
    `cleanup        table gone ${verify.tableGone}, collection rows ${verify.metaCollections}, field rows ${verify.metaFields}, user rows ${verify.users}${cleanupLog.length ? `\n  notes: ${cleanupLog.join('; ')}` : ''}`
  )
}

async function teardown() {
  if (finished) return
  finished = true
  for (const c of clients) {
    try {
      c.socket?.disconnect()
    } catch {}
  }
  await cleanup()
}

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    console.error(`\n${sig}: cleaning up`)
    teardown().finally(() => process.exit(130))
  })

let exitCode = 0
try {
  const report = await run()
  await teardown()
  const verify = await verifyGone()
  printSummary(report, verify)
  const out = { ...report, cleanup: { ...verify, notes: cleanupLog } }
  if (typeof args.out === 'string') {
    writeFileSync(args.out, JSON.stringify(out, null, 2))
    console.log(`json -> ${args.out}`)
  }
} catch (err) {
  console.error(`FAILED: ${(err as Error).message}`)
  exitCode = 1
  await teardown()
  console.error(JSON.stringify(await verifyGone().catch(() => null)))
}
await db.destroy().catch(() => {})
process.exit(exitCode)
