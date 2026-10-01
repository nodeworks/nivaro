import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apiBase,
  compareReadiness,
  judgePreflight,
  judgeReady,
  judgeSmoke,
  readinessSnapshot,
  runGate
} from './release-gate.mjs'

test('apiBase strips /api/version and refuses anything else', () => {
  assert.equal(apiBase('https://efp-staging.example.com/api/version'), 'https://efp-staging.example.com')
  assert.equal(apiBase('https://x.example.com/sub/api/version/'), 'https://x.example.com/sub')
  assert.equal(apiBase('https://x.example.com/version.json'), null)
  assert.equal(apiBase(undefined), null)
})

test('judgeReady: ready passes; a failed extension is the image, a slow DB is the environment', () => {
  assert.equal(judgeReady(200, { ready: true, checks: [] }).ok, true)
  const ext = judgeReady(503, {
    ready: false,
    checks: [{ id: 'extensions', ok: false, summary: 'efp-ops is not loaded' }]
  })
  assert.equal(ext.ok, false)
  assert.equal(ext.dependencyOnly, false)
  assert.match(ext.detail, /efp-ops is not loaded/)
  const db = judgeReady(503, { ready: false, checks: [{ id: 'database', ok: false, summary: 'slow' }] })
  assert.equal(db.dependencyOnly, true)
})

test('judgePreflight: 503 fails with the failing summaries; warnings still pass', () => {
  const fail = judgePreflight(503, {
    data: { status: 'fail', checks: [{ id: 'migrations', status: 'fail', summary: '2 pending' }] }
  })
  assert.deepEqual([fail.ok, fail.detail], [false, '2 pending'])
  const warn = judgePreflight(200, {
    data: { status: 'warn', checks: [{ id: 'redis', status: 'warn', summary: 'Redis unreachable' }] }
  })
  assert.equal(warn.ok, true)
  assert.match(warn.detail, /Redis unreachable/)
  assert.equal(judgePreflight(401, {}).refused, true)
})

test('judgeSmoke names the failing smoke checks', () => {
  assert.equal(judgeSmoke(200, { data: { ok: true, checks: [] } }).ok, true)
  const bad = judgeSmoke(503, {
    data: { ok: false, checks: [{ name: 'extensions', ok: false, detail: 'efp-ops failed' }] }
  })
  assert.deepEqual([bad.ok, bad.detail], [false, 'extensions: efp-ops failed'])
})

test('compareReadiness: a drop fails and names the checks that got worse', () => {
  const before = readinessSnapshot({
    data: {
      score: 90,
      checks: [
        { id: 'a', label: 'Layout drift', status: 'pass' },
        { id: 'b', label: 'Dead columns', status: 'warn' }
      ]
    }
  })
  const after = readinessSnapshot({
    data: {
      score: 80,
      checks: [
        { id: 'a', label: 'Layout drift', status: 'fail' },
        { id: 'b', label: 'Dead columns', status: 'warn' }
      ]
    }
  })
  const cmp = compareReadiness(before, after)
  assert.equal(cmp.ok, false)
  assert.deepEqual(cmp.worse, ['Layout drift: pass → fail'])
  assert.equal(compareReadiness(before, after, 10).ok, true)
  assert.equal(compareReadiness(null, after).ok, true)
  assert.equal(compareReadiness(before, null).ok, false)
})

/** A fake API: `routes[method path] = { status, body }`. */
function fakeApi(routes, seen = []) {
  return async (method, path, { auth }) => {
    seen.push(`${method} ${path}${auth ? ' (auth)' : ''}`)
    return routes[`${method} ${path}`] ?? { status: 404, body: null }
  }
}

const healthy = {
  'GET /api/ready': { status: 200, body: { ready: true, checks: [] } },
  'GET /api/preflight': { status: 200, body: { data: { status: 'ok', checks: [] } } },
  'POST /api/ops-runtime/smoke?strict=1': { status: 200, body: { data: { ok: true, checks: [] } } },
  'GET /api/readiness': { status: 200, body: { data: { score: 90, checks: [] } } }
}

test('runGate passes a healthy deploy and asks every check, authed where it must', async () => {
  const seen = []
  const res = await runGate({
    name: 'staging api',
    token: 't',
    request: fakeApi(healthy, seen),
    before: { score: 90, checks: {} }
  })
  assert.equal(res.ok, true, res.lines.join('\n'))
  assert.deepEqual(seen, [
    'GET /api/ready',
    'GET /api/preflight (auth)',
    'POST /api/ops-runtime/smoke?strict=1 (auth)',
    'GET /api/readiness (auth)'
  ])
})

test('runGate without a token checks /api/ready only and says what it skipped', async () => {
  const seen = []
  const res = await runGate({ name: 's', token: null, request: fakeApi(healthy, seen), before: null })
  assert.equal(res.ok, true)
  assert.equal(res.authed, false)
  assert.deepEqual(seen, ['GET /api/ready'])
  assert.match(res.lines.at(-1), /NOT checked/)
})

test('runGate fails on a refused token, a failed smoke check and a readiness drop', async () => {
  const refusedToken = await runGate({
    name: 's',
    token: 'stale',
    request: fakeApi({
      ...healthy,
      'GET /api/preflight': { status: 401, body: { error: 'Invalid token' } },
      'POST /api/ops-runtime/smoke?strict=1': { status: 401, body: null },
      'GET /api/readiness': { status: 401, body: null }
    }),
    before: null
  })
  assert.equal(refusedToken.ok, false)
  assert.ok(refusedToken.failures.every((f) => /token refused/.test(f)))

  let slept = 0
  const dropped = await runGate({
    name: 's',
    token: 't',
    request: fakeApi({ ...healthy, 'GET /api/readiness': { status: 200, body: { data: { score: 70, checks: [] } } } }),
    before: { score: 90, checks: {} },
    sleep: async (ms) => {
      slept += ms
    }
  })
  assert.equal(dropped.ok, false)
  assert.equal(slept, 60_000, 'a drop is re-read once after settling')
  assert.match(dropped.failures[0], /score 90 → 70/)
})
