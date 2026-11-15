// node --test scripts/realtime-bot/bot.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkTarget,
  createCleanup,
  exitCodeFor,
  formatTable,
  hostRefusal,
  parseArgs,
  planChecks,
  Refusal,
  runBot,
  UsageError
} from './bot.mjs'

const BASE = [
  '--target',
  'https://staging.example.test',
  '--admin-token',
  'x'.repeat(64),
  '--role',
  '11111111-2222-3333-4444-555555555555',
  '--collection',
  'orders',
  '--record',
  '42',
  '--field',
  'notes'
]

/** A fake API: app-info says `environment`; records every call; `fail` names calls that 500. */
function fakeApi(environment, fail = () => false) {
  const calls = []
  let n = 0
  const json = (status, body) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  })
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const path = new URL(url).pathname
    calls.push(`${method} ${path}`)
    if (path === '/api/app-info') return json(200, { environment, version: '9.9.9' })
    if (fail(method, path)) return json(500, { error: 'boom' })
    if (method === 'POST' && path === '/api/users')
      return json(201, { data: { id: `0000000${++n}-0000-0000-0000-000000000000` } })
    if (method === 'POST' && path.endsWith('/token')) return json(200, { data: { token: 't'.repeat(64) } })
    if (method === 'DELETE') return json(204, null)
    return json(200, { data: {} })
  }
  return { fetch, calls }
}

test('options: target required, no default; unknown checks refused', () => {
  assert.throws(() => parseArgs([], {}), UsageError)
  assert.throws(() => parseArgs([...BASE, '--skip', 'nope'], {}), UsageError)
  const o = parseArgs(['--target', 'https://staging.example.test/', '--dry-run'], {})
  assert.equal(o.target, 'https://staging.example.test')
  assert.equal(o.appUrl, 'https://staging.example.test')
  assert.throws(() => parseArgs(['--target', 'https://staging.example.test'], {}), /admin-token/)
  assert.equal(parseArgs(BASE, {}).listField, 'notes')
})

test('plan: line and move need their options', () => {
  const plan = planChecks(parseArgs(BASE, {}))
  const by = Object.fromEntries(plan.map((p) => [p.name, p.run]))
  assert.deepEqual(by, {
    'field-edit': true,
    comment: true,
    file: true,
    line: false,
    move: false,
    create: true,
    delete: true
  })
  const noCreate = planChecks(parseArgs([...BASE, '--skip', 'create'], {}))
  assert.equal(noCreate.find((p) => p.name === 'delete').run, false)
})

test('refuses production by app-info, and by host name', async () => {
  await assert.rejects(checkTarget(fakeApi('production').fetch, 'https://app.example.test'), Refusal)
  assert.match(hostRefusal('https://efp-prod.example.com'), /production/)
  assert.match(hostRefusal('https://production.example.com'), /production/)
  assert.equal(hostRefusal('https://staging.example.com'), null)
  assert.equal(hostRefusal('https://products.example.com'), null)
})

test('refuses a target it cannot identify', async () => {
  await assert.rejects(checkTarget(fakeApi(undefined).fetch, 'https://x.example.test'), /no environment/)
  const down = async () => {
    throw new Error('ECONNREFUSED')
  }
  await assert.rejects(checkTarget(down, 'https://x.example.test'), /cannot identify/)
})

test('a production target creates nothing at all', async () => {
  const api = fakeApi('production')
  let launched = false
  const r = await runBot(parseArgs(BASE, {}), {
    fetch: api.fetch,
    launch: async () => {
      launched = true
    },
    log: () => {}
  })
  assert.match(r.refused, /production/)
  assert.equal(exitCodeFor(r), 2)
  assert.deepEqual(api.calls, ['GET /api/app-info'])
  assert.equal(launched, false)
})

test('dry run reads app-info only', async () => {
  const api = fakeApi('staging')
  const r = await runBot(parseArgs(['--target', 'https://staging.example.test', '--dry-run'], {}), {
    fetch: api.fetch,
    log: () => {}
  })
  assert.equal(r.dryRun, true)
  assert.deepEqual(api.calls, ['GET /api/app-info'])
  assert.ok(formatTable(r.rows).includes('would run'))
})

test('setup failure still removes the throwaway people and their tokens', async () => {
  const api = fakeApi('staging')
  const r = await runBot(parseArgs(BASE, {}), {
    fetch: api.fetch,
    launch: async () => {
      throw new Error('no chromium here')
    },
    log: () => {},
    stamp: 'test'
  })
  assert.equal(r.ok, false)
  assert.match(r.setupError, /no chromium/)
  assert.equal(exitCodeFor(r), 3)
  const deletes = api.calls.filter((c) => c.startsWith('DELETE'))
  // Tokens revoked and both people removed — B's first (last in, first out).
  assert.deepEqual(deletes, [
    'DELETE /api/users/00000002-0000-0000-0000-000000000000/token',
    'DELETE /api/users/00000002-0000-0000-0000-000000000000',
    'DELETE /api/users/00000001-0000-0000-0000-000000000000/token',
    'DELETE /api/users/00000001-0000-0000-0000-000000000000'
  ])
  assert.ok(r.cleanup.every((c) => c.ok))
})

test('a failure half-way through setup removes what was made', async () => {
  // Minting B's token fails: A (and A's token) and B still go.
  let tokens = 0
  const api = fakeApi('staging', (m, p) => m === 'POST' && p.endsWith('/token') && ++tokens === 2)
  const r = await runBot(parseArgs(BASE, {}), { fetch: api.fetch, log: () => {}, stamp: 't' })
  assert.equal(exitCodeFor(r), 3)
  const deletes = api.calls.filter((c) => c.startsWith('DELETE'))
  assert.deepEqual(deletes, [
    'DELETE /api/users/00000002-0000-0000-0000-000000000000',
    'DELETE /api/users/00000001-0000-0000-0000-000000000000/token',
    'DELETE /api/users/00000001-0000-0000-0000-000000000000'
  ])
})

test('cleanup keeps going when a step fails', async () => {
  const done = []
  const c = createCleanup(() => {})
  c.add('one', () => done.push(1))
  c.add('two', () => {
    throw new Error('nope')
  })
  c.add('three', () => done.push(3))
  const r = await c.run()
  assert.deepEqual(done, [3, 1])
  assert.deepEqual(
    r.map((x) => x.ok),
    [true, false, true]
  )
  assert.equal(c.size, 0)
})

test('a failed check exits 1, a pass 0', () => {
  assert.equal(exitCodeFor({ ok: false, rows: [{ result: 'FAIL' }] }), 1)
  assert.equal(exitCodeFor({ ok: true, rows: [] }), 0)
})
