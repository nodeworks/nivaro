#!/usr/bin/env node
/**
 * Resilience suite over toxiproxy (#2842). Runs against deploy/chaos-ci/docker-compose.yml.
 *
 *   node scripts/chaos/toxiproxy-suite.mjs [--mode compose|host] [--only boot,db-latency,...]
 *        [--record <url>] [--out file.json]
 *
 * compose (CI): the API runs as the `api` service; restarts go through `docker compose`.
 * host (local trial): mssql/redis/toxiproxy run in compose, the API runs from this checkout
 *   on --api-port (default 3243) behind the `api` proxy re-pointed at host.docker.internal.
 *
 * Cases: boot (boot under DB latency), db-latency (concurrent reads complete, none hang),
 * db-outage (ready flips, recovers), redis-blip (sessions survive), socket (clients reconnect
 * after a reset_peer on the API link). Nothing here may point at a real database: the only
 * database is the compose container behind toxiproxy.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finish, getJson, parseArgs, printChecks, repoRoot, sleep, startApi, summarize, waitFor } from './lib.mjs'

const args = parseArgs()
const mode = String(args.mode ?? 'compose')
const compose = resolve(repoRoot, 'deploy/chaos-ci/docker-compose.yml')
const TOXI = `http://127.0.0.1:${process.env.CHAOS_CI_TOXI_PORT ?? 18474}`
const API = `http://127.0.0.1:${process.env.CHAOS_CI_API_PORT ?? 13055}`
const apiPort = Number(args['api-port'] ?? 3243)
const only = args.only ? String(args.only).split(',') : null
const TOKEN = 'chaos-ci-static-token-0001'
const started_at = new Date().toISOString()

const dc = (...a) => spawnSync('docker', ['compose', '-f', compose, ...a], { encoding: 'utf8' })

// ── toxiproxy HTTP API ──────────────────────────────────────────────────────
async function toxi(method, path, body) {
  const res = await fetch(`${TOXI}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok && res.status !== 404) throw new Error(`toxiproxy ${method} ${path}: HTTP ${res.status}`)
  return res.status === 204 ? null : res.json().catch(() => null)
}
const addToxic = (proxy, type, attributes = {}, stream = 'downstream') =>
  toxi('POST', `/proxies/${proxy}/toxics`, { name: `${type}_${stream}`, type, stream, toxicity: 1, attributes })
const clearToxics = async (proxy) => {
  const list = (await toxi('GET', `/proxies/${proxy}/toxics`)) ?? []
  for (const t of list) await toxi('DELETE', `/proxies/${proxy}/toxics/${t.name}`)
}
const setEnabled = (proxy, enabled) => toxi('POST', `/proxies/${proxy}`, { enabled })
async function resetAll() {
  for (const p of ['mssql', 'redis', 'api']) {
    await clearToxics(p).catch(() => {})
    await setEnabled(p, true).catch(() => {})
  }
}

// ── the API under test ──────────────────────────────────────────────────────
let hostApi = null
function hostApiEnv() {
  return {
    NODE_ENV: 'development',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(process.env.CHAOS_CI_MSSQL_PORT ?? 11433),
    DB_DATABASE: 'nivaro_chaos',
    DB_USER: 'sa',
    DB_PASSWORD: 'Chaos_Ci_Passw0rd!',
    DB_ENCRYPT: 'false',
    DB_TRUST_SERVER_CERT: 'true',
    REDIS_URL: `redis://127.0.0.1:${process.env.CHAOS_CI_REDIS_PORT ?? 16379}`,
    SESSION_SECRET: 'chaos-ci-session-secret-0123456789abcdef',
    OIDC_ENABLED: 'false',
    SKIP_BOOT_MIGRATIONS: '',
    BOOT_DEPS_WAIT_MS: '120000',
    HEAVY_READ_CONCURRENCY: '2',
    HEAVY_READ_MAX_WAIT_MS: '4000',
    REDIS_CHANNEL_PREFIX: 'chaos-ci:'
  }
}
async function startTarget() {
  if (mode === 'compose') {
    const r = dc('up', '-d', 'api')
    if (r.status !== 0) throw new Error(`compose up api failed: ${r.stderr}`)
    return
  }
  hostApi = startApi({ port: apiPort, env: hostApiEnv() })
}
async function stopTarget() {
  if (mode === 'compose') dc('stop', 'api')
  else if (hostApi) {
    hostApi.stop('SIGTERM')
    await Promise.race([hostApi.exited, sleep(10_000)])
    hostApi = null
  }
}
const ready = async () => (await getJson(`${API}/api/ready`)).status === 200

async function prepare() {
  const up = dc('up', '-d', '--wait', 'mssql', 'redis', 'toxiproxy')
  if (up.status !== 0) throw new Error(`compose up failed: ${up.stderr}`)
  const init = dc('run', '--rm', 'mssql-init')
  if (init.status !== 0) throw new Error(`mssql-init failed: ${init.stderr}`)
  if (mode === 'host') {
    await toxi('DELETE', '/proxies/api')
    await toxi('POST', '/proxies', {
      name: 'api',
      listen: '0.0.0.0:3055',
      upstream: `host.docker.internal:${apiPort}`,
      enabled: true
    })
  }
  await resetAll()
  await startTarget()
  if (!(await waitFor(ready, { timeoutMs: 900_000, everyMs: 3000 })))
    throw new Error('API never became ready (migrations on the empty database can take minutes)')
  seedUser()
}

function seedUser() {
  const sql = `
IF NOT EXISTS (SELECT 1 FROM nivaro_roles WHERE name = 'Chaos CI Admin')
  INSERT INTO nivaro_roles (name, admin_access, app_access) VALUES ('Chaos CI Admin', 1, 1);
IF NOT EXISTS (SELECT 1 FROM nivaro_users WHERE email = 'chaos-ci@example.test')
  INSERT INTO nivaro_users (email, first_name, last_name, status, static_token, role)
  SELECT 'chaos-ci@example.test', 'Chaos', 'CI', 'active', '${TOKEN}', id FROM nivaro_roles WHERE name = 'Chaos CI Admin';`
  const r = dc('exec', '-T', 'mssql', '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa',
    '-P', 'Chaos_Ci_Passw0rd!', '-d', 'nivaro_chaos', '-b', '-Q', sql)
  if (r.status !== 0) throw new Error(`seed failed: ${r.stdout}${r.stderr}`)
}

async function login() {
  const res = await fetch(`${API}/api/auth/login/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN })
  })
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  return { ok: res.status === 200 && !!cookie, cookie }
}
const me = (cookie, ms = 8000) =>
  fetch(`${API}/api/auth/me`, { headers: { cookie }, signal: AbortSignal.timeout(ms) }).then((r) => r.status)

function socketClient() {
  for (const base of [resolve(repoRoot, 'admin/package.json'), resolve(dirname(fileURLToPath(import.meta.url)), 'package.json')]) {
    try {
      return createRequire(base)('socket.io-client')
    } catch {}
  }
  throw new Error('socket.io-client not found: npm install --no-save --prefix scripts/chaos socket.io-client@4.8.3')
}

// ── cases ───────────────────────────────────────────────────────────────────
const cases = {
  async 'db-latency'() {
    await addToxic('mssql', 'latency', { latency: 1500, jitter: 200 })
    const { cookie } = await login()
    const t0 = Date.now()
    const codes = await Promise.all(
      Array.from({ length: 12 }, () => me(cookie, 30_000).catch(() => 'timeout'))
    )
    const ms = Date.now() - t0
    await clearToxics('mssql')
    const hung = codes.filter((c) => c === 'timeout').length
    return [
      { name: 'DB +1.5 s: 12 concurrent reads all answer (none hang past 30 s)', ok: hung === 0, detail: `${ms} ms, codes ${[...new Set(codes)].join(',')}` },
      { name: 'DB latency cleared: API ready again', ok: !!(await waitFor(ready, { timeoutMs: 60_000 })) }
    ]
  },

  async 'db-outage'() {
    await setEnabled('mssql', false)
    const flipped = await waitFor(async () => (await getJson(`${API}/api/ready`)).status === 503, { timeoutMs: 60_000, everyMs: 1000 })
    const alive = (await getJson(`${API}/api/version`).catch(() => ({ status: 0 }))).status === 200
    await setEnabled('mssql', true)
    const back = await waitFor(ready, { timeoutMs: 120_000, everyMs: 1000 })
    return [
      { name: 'DB outage: /api/ready answers 503 (proxy would drain)', ok: !!flipped },
      { name: 'DB outage: process stays up (version still answers)', ok: alive },
      { name: 'DB back: /api/ready recovers without a restart', ok: !!back }
    ]
  },

  async 'redis-blip'() {
    const { ok, cookie } = await login()
    const before = ok ? await me(cookie) : 0
    await setEnabled('redis', false)
    await sleep(4000)
    await setEnabled('redis', true)
    const after = await waitFor(async () => (await me(cookie).catch(() => 0)) === 200, { timeoutMs: 60_000, everyMs: 1000 })
    return [
      { name: 'sign in by token gives a session', ok: before === 200 },
      { name: 'Redis down 4 s: the same session cookie works afterwards', ok: !!after }
    ]
  },

  async socket() {
    const { io } = socketClient()
    const wsTok = await (await fetch(`${API}/api/auth/ws-token`, { headers: { authorization: `Bearer ${TOKEN}` } })).json().catch(() => null)
    const sock = io(API, { transports: ['websocket'], reconnectionDelay: 500, reconnectionDelayMax: 3000 })
    const authed = () => new Promise((r) => {
      const t = setTimeout(() => r(false), 15_000)
      sock.once('auth:ok', () => (clearTimeout(t), r(true)))
    })
    await new Promise((r) => sock.once('connect', r))
    const first = authed()
    sock.emit('auth', { token: TOKEN })
    const okFirst = await first
    const dropped = new Promise((r) => sock.once('disconnect', () => r(Date.now())))
    await addToxic('api', 'reset_peer', { timeout: 0 })
    const tDrop = await Promise.race([dropped, sleep(15_000).then(() => 0)])
    await clearToxics('api')
    const tBack = Date.now()
    const reconnected = new Promise((r) => sock.once('connect', () => r(Date.now())))
    const tUp = await Promise.race([reconnected, sleep(60_000).then(() => 0)])
    let again = false
    if (tUp) {
      const a2 = authed()
      sock.emit('auth', { token: TOKEN })
      again = await a2
    }
    sock.close()
    void wsTok
    return [
      { name: 'socket connects and signs in', ok: okFirst },
      { name: 'reset_peer on the API link drops the socket', ok: !!tDrop },
      { name: 'client reconnects and signs in again after the reset clears', ok: !!tUp && again, detail: tUp ? `${tUp - tBack} ms` : 'never reconnected' }
    ]
  },

  // Last: restarts the target with the DB slow.
  async boot() {
    await stopTarget()
    await addToxic('mssql', 'latency', { latency: 800, jitter: 100 })
    const t0 = Date.now()
    await startTarget()
    const up = await waitFor(ready, { timeoutMs: 600_000, everyMs: 2000 })
    await clearToxics('mssql')
    return [{ name: 'boot with +0.8 s DB latency reaches ready', ok: !!up, detail: `${Math.round((Date.now() - t0) / 1000)} s` }]
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
const checks = []
let fatal = null
try {
  await prepare()
  for (const [name, fn] of Object.entries(cases)) {
    if (only && !only.includes(name)) continue
    console.log(`case: ${name}`)
    try {
      checks.push(...(await fn()))
    } catch (e) {
      checks.push({ name: `${name}: ran`, ok: false, detail: e.message })
    } finally {
      await resetAll().catch(() => {})
    }
  }
} catch (e) {
  fatal = e.message
  checks.push({ name: 'environment came up', ok: false, detail: fatal })
} finally {
  await resetAll().catch(() => {})
  if (mode === 'host') await stopTarget().catch(() => {})
  if (!args['keep-up'] && mode === 'host') dc('down', '-v')
}

printChecks(checks)
const verdict = summarize(checks)
console.log(`toxiproxy suite: ${verdict}`)
await finish(args, {
  script: 'toxiproxy-suite',
  fault_key: 'ci.toxiproxy',
  label: 'Resilience tests (toxiproxy)',
  verdict,
  metrics: { mode, checks: checks.length, failed: checks.filter((c) => !c.ok).length },
  checks,
  started_at,
  ended_at: new Date().toISOString()
})
process.exit(verdict === 'held' ? 0 : 1)
