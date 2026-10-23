// node --test scripts/realtime-load.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import {
  collectTokens,
  DeliveryTracker,
  estimateLoad,
  Histogram,
  keysOf,
  parseArgs,
  planSteps,
  readOptions,
  RouteBook,
  ServerBook,
  sharedHostsFrom,
  tableHeader,
  tableRow,
  tabsFor,
  targetRefusal,
  UsageError
} from './realtime-load.mjs'

test('parseArgs reads --k v, --k=v and bare flags', () => {
  assert.deepEqual(parseArgs(['--target', 'http://x:1', '--people=250', '--dry-run']), {
    target: 'http://x:1',
    people: '250',
    'dry-run': true
  })
})

test('readOptions: --target is required, numbers are checked, defaults match efp-new', () => {
  assert.throws(() => readOptions({}), UsageError)
  assert.throws(() => readOptions({ target: 'http://x', people: 'many' }), /--people/)
  assert.throws(() => readOptions({ target: 'http://x', 'hold-minutes': '0' }), /nothing to run/)
  const o = readOptions({ target: 'http://x/', 'ramp-minutes': '10' })
  assert.equal(o.target, 'http://x')
  assert.equal(o.people, 45)
  assert.equal(o.steps, 5)
  assert.equal(o.pingMs, 15_000)
  assert.equal(o.heartbeatMs, 25_000)
  assert.equal(o.refetch, true)
  assert.equal(o.refetchDebounceMs, 0)
})

test('collectTokens: flag, then file, then env list, then a single API key', () => {
  assert.deepEqual(collectTokens({ tokens: 'a, b' }, {}, 'c'), ['a', 'b'])
  assert.deepEqual(collectTokens({}, { REALTIME_LOAD_TOKENS: 'x' }, '# c\nnvm_1\n\nnvm_2\n'), [
    'nvm_1',
    'nvm_2'
  ])
  assert.deepEqual(collectTokens({}, { REALTIME_LOAD_TOKENS: 'x,y' }, null), ['x', 'y'])
  assert.deepEqual(collectTokens({ 'api-key': 'k1' }, {}, null), ['k1'])
  assert.deepEqual(collectTokens({}, { REALTIME_LOAD_API_KEY: 'k2' }, null), ['k2'])
  assert.deepEqual(collectTokens({}, {}, null), [])
})

test('targetRefusal: production never, shared hosts only when named exactly, big runs confirmed', () => {
  const shared = sharedHostsFrom(
    { TRAFFIC_REPLAY_SHARED_HOSTS: 'staging-db.internal, efp-staging.example.com' },
    'PUBLIC_URL=http://localhost:3055\nADMIN_URL="http://localhost:3056"\nDB_HOST=nedengefp01\n'
  )
  assert.deepEqual(shared, [
    'http://localhost:3055',
    'http://localhost:3056',
    'nedengefp01',
    'staging-db.internal',
    'efp-staging.example.com'
  ])
  const r = (t, extra = {}) => targetRefusal(t, { sharedHosts: shared, ...extra })
  assert.match(r('https://malowntx-efp-prod.cable.example.com'), /production/)
  assert.match(r('https://prod.example.com'), /production/)
  assert.match(
    r('https://malowntx-efp-prod.cable.example.com', {
      allowSharedHost: 'malowntx-efp-prod.cable.example.com'
    }),
    /production/
  )
  assert.equal(r('https://product-docs.example.com'), null)
  assert.match(r('http://localhost:3055'), /shared host/)
  assert.equal(r('http://localhost:3099'), null) // a throwaway API on another port
  assert.match(r('https://efp-staging.example.com'), /--allow-shared-host efp-staging.example.com/)
  assert.equal(
    r('https://efp-staging.example.com', { allowSharedHost: 'efp-staging.example.com' }),
    null
  )
  assert.match(r('ftp://x'), /http/)
  assert.match(r('not a url'), /URL/)
  assert.match(r('http://127.0.0.1:3099', { people: 400 }), /--confirm-scale 127.0.0.1:3099/)
  assert.equal(r('http://127.0.0.1:3099', { people: 400, confirmScale: '127.0.0.1:3099' }), null)
})

test('planSteps: 0 → 250 over 10 minutes in 5 steps, then a hold', () => {
  const plan = planSteps({ start: 0, people: 250, rampMinutes: 10, steps: 5, holdMinutes: 5 })
  assert.deepEqual(
    plan.map((s) => [s.label, s.people, s.durationMs]),
    [
      ['ramp 1/5', 50, 120_000],
      ['ramp 2/5', 100, 120_000],
      ['ramp 3/5', 150, 120_000],
      ['ramp 4/5', 200, 120_000],
      ['ramp 5/5', 250, 120_000],
      ['hold', 250, 300_000]
    ]
  )
  assert.deepEqual(
    planSteps({ start: 0, people: 45, rampMinutes: 0, steps: 1, holdMinutes: 2 }).map((s) => [
      s.label,
      s.people
    ]),
    [['hold', 45]]
  )
})

test('250 people with 60% second tabs is about 400 sockets', () => {
  const tabs = tabsFor(250, 0.6)
  assert.ok(tabs >= 395 && tabs <= 405, `got ${tabs}`)
  assert.equal(tabsFor(10, 0), 10)
  assert.equal(tabsFor(10, 1), 20)
})

test('estimateLoad shows the refetch storm and what a debounce caps it to', () => {
  const o = readOptions({ target: 'http://x', people: '250' })
  const storm = estimateLoad(o)
  assert.ok(storm.requests_per_s['GET /api/presence/online'] > 1000)
  const calm = estimateLoad({ ...o, refetchDebounceMs: 2000 })
  assert.equal(calm.requests_per_s['GET /api/presence/online'], round1(calm.tabs / 2))
  assert.equal(estimateLoad({ ...o, refetch: false }).requests_per_s['GET /api/presence/online'], 0)
})
const round1 = (n) => Math.round(n * 10) / 10

test('Histogram percentiles and share within target', () => {
  const h = new Histogram()
  for (let i = 0; i < 90; i++) h.add(100)
  for (let i = 0; i < 10; i++) h.add(3500)
  assert.equal(h.percentile(0.5), 110)
  assert.equal(h.percentile(0.95), 3600)
  assert.equal(h.within(2000), 90)
  h.add(45_000)
  assert.equal(h.percentile(1), 45_000)
  assert.equal(new Histogram().percentile(0.5), null)
})

test('keysOf reads single, batched and merged payloads', () => {
  assert.deepEqual(keysOf('presence:changed', { user_id: 'AB-1' }), ['ab-1'])
  assert.deepEqual(keysOf('presence:changed', { user_ids: ['A', 'b'] }), ['a', 'b'])
  assert.equal(keysOf('presence:changed', {}), null)
  assert.deepEqual(keysOf('collection:update', { collection: 'c', item: 7 }), ['7'])
  assert.deepEqual(keysOf('collection:update', { items: [1, 2], coalesced: true }), ['1', '2'])
  assert.equal(keysOf('collection:update', { items: null, many: true }), null)
})

test('DeliveryTracker: latency per tab, coalesced events, misses only for proven tabs', () => {
  const t = new DeliveryTracker({ timeoutMs: 10_000 })
  // Tabs 1 and 2 have proven they hear presence events; tab 3 never did.
  t.receive('presence', ['x'], 1, 0)
  t.receive('presence', ['x'], 2, 0)
  t.takeStep(2000)

  t.write('presence', 'u1', 1000, [1, 2, 3])
  t.write('presence', 'u1', 1500, [1, 2, 3])
  // One coalesced event delivers both writes to tab 1.
  assert.equal(t.receive('presence', ['u1'], 1, 1600), 2)
  // Tab 2 hears it late, as part of a batch naming several users.
  assert.equal(t.receive('presence', ['u0', 'u1'], 2, 4000), 2)
  // A repeat event for the same writes is not counted twice.
  assert.equal(t.receive('presence', ['u1'], 1, 1700), 0)
  t.write('presence', 'u2', 2000, [1, 2])
  t.receive('presence', ['u2'], 1, 2100)
  t.sweep(20_000) // tab 2 never heard u2 → 1 miss; tab 3 was never expected
  const s = t.takeStep(2000)
  assert.equal(s.writes, 3)
  assert.equal(s.deliveries, 5)
  assert.equal(s.missed, 1)
  assert.equal(s.within_target_pct, 60)
  assert.equal(s.unmatched_events, 1)
  assert.equal(t.total(2000).deliveries, 5)
})

test('DeliveryTracker: a merged batch with no id list delivers every pending write of its kind', () => {
  const t = new DeliveryTracker()
  t.receive('row', ['seed'], 5, 0)
  t.write('row', '10', 100, [5])
  t.write('row', '11', 120, [5])
  assert.equal(t.receive('row', null, 5, 400), 2)
})

test('RouteBook and ServerBook summaries', () => {
  const r = new RouteBook()
  for (let i = 0; i < 30; i++) r.note('GET /api/presence/online', 200 + i, i !== 0)
  r.note('POST /api/presence/ping', 20, true)
  const s = r.summary(10)
  assert.equal(s[0].route, 'GET /api/presence/online')
  assert.equal(s[0].rps, 3)
  assert.equal(s[0].errors, 1)

  const b = new ServerBook()
  b.note(
    {
      host: 'web-1',
      event_loop_lag_ms: { current: 40, max_1m: 3315 },
      pool: { used: 25, max: 25, pending_acquires: 47 },
      rss_mb: 600
    },
    120
  )
  b.note(
    { host: 'web-2', event_loop_lag_ms: { current: 2, max_1m: 90 }, pool: { used: 3, max: 25 } },
    8
  )
  b.note(null, 0)
  const sum = b.summary()
  assert.equal(sum.lag_max_ms, 3315)
  assert.equal(sum.pool_waiting_max, 47)
  assert.equal(sum.failed_samples, 1)
  assert.equal(Object.keys(sum.nodes).length, 2)
})

test('the step table has one cell per column', () => {
  const row = tableRow({
    label: 'ramp 1/5',
    people: 50,
    sockets: 80,
    requests_per_s: 42.5,
    routes: [{ route: 'GET /api/presence/online', p95_ms: 480 }],
    delivery: { p95_ms: 900, within_target_pct: 99.1, missed: 0 },
    server: { lag_max_ms: 120, pool_used_max: 4, pool_max: 25, pool_waiting_max: 0 },
    generator_lag_p99_ms: 12
  })
  assert.equal(row.length, tableHeader().length)
  assert.match(row, /ramp 1\/5/)
})

test('--dry-run plans 250 people without opening anything', () => {
  const out = execFileSync(
    process.execPath,
    [
      new URL('./realtime-load.mjs', import.meta.url).pathname,
      '--target',
      'http://127.0.0.1:3199',
      '--people',
      '250',
      '--ramp-minutes',
      '10',
      '--steps',
      '5',
      '--hold-minutes',
      '5',
      '--dry-run',
      '--json'
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH } }
  )
  assert.match(out, /Dry run: nothing was opened or sent/)
  const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  assert.equal(json.plan.length, 6)
  assert.ok(json.estimate.sockets >= 395)
})

test('a production-looking target exits 2 before anything else', () => {
  let code = 0
  try {
    execFileSync(
      process.execPath,
      [
        new URL('./realtime-load.mjs', import.meta.url).pathname,
        '--target',
        'https://efp-prod.example.com',
        '--dry-run'
      ],
      { encoding: 'utf8', stdio: 'pipe', env: { PATH: process.env.PATH } }
    )
  } catch (err) {
    code = err.status
  }
  assert.equal(code, 2)
})
