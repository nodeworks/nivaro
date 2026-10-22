#!/usr/bin/env node
/**
 * Rolling deploy under replayed load (#2836). Measures a deploy; it never starts one.
 *
 *   pnpm chaos:deploy-load --target <https://staging...> [--load replay|builtin] [--caller k12|u<uuid>]
 *        [--token <bearer>] [--window-s 600] [--after-s 30] [--rps 20] [--record <base-url>] [--out file]
 *   pnpm chaos:deploy-load --dry-run     # proves the counting on a throwaway API restarting itself
 *
 * Runbook (STAGING ONLY, Rob's deploy command):
 *   1. Pick the target (staging URL) and a bearer token valid on it. Run this script. It starts the
 *      load and polls /api/version + /api/ready every 250 ms.
 *   2. Start the deploy the usual way ("deploy staging"). The script waits up to --window-s for the
 *      version to change, then keeps measuring --after-s seconds and stops.
 *   3. Read "this deploy dropped N of M requests". A pass is 0 dropped and 0 errored.
 *   Never point it at production or a shared host; traffic-replay keeps its own refusals (shared
 *   hosts, PUBLIC_URL/ADMIN_URL/DB_HOST, NODE_ENV=development) and the replay mode inherits them.
 *
 * Counted: sent, errored (HTTP 5xx), dropped (no response: reset, refused, timeout). Also: socket
 * reconnect time (one socket.io client), the version flip, and how long two versions answered
 * polls in the same window (rolling overlap).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finish, getJson, parseArgs, printChecks, repoRoot, sleep, startApi, waitFor } from './lib.mjs'

const args = parseArgs()
const dry = !!args['dry-run']
const started_at = new Date().toISOString()
const dryPort = Number(args.port ?? 3233)
const target = String(dry ? `http://127.0.0.1:${dryPort}` : (args.target ?? '')).replace(/\/$/, '')
if (!target) {
  console.error('--target <url> is required (or --dry-run)')
  process.exit(2)
}
const windowMs = Number(args['window-s'] ?? 600) * 1000
const afterMs = Number(args['after-s'] ?? 30) * 1000
const loadMode = String(args.load ?? (dry ? 'builtin' : 'replay'))
const token = String(args.token ?? process.env.TRAFFIC_REPLAY_TOKEN ?? '')

const t0 = Date.now()
const rel = () => Date.now() - t0
let stopping = false

// ── polling: which version answers, is it ready ─────────────────────────────
const polls = []
async function poller() {
  while (!stopping) {
    const at = rel()
    const [v, r] = await Promise.all([
      getJson(`${target}/api/version`, 2000).catch(() => null),
      getJson(`${target}/api/ready`, 2000).catch(() => null)
    ])
    polls.push({ at, version: v?.body?.version ?? null, instance: v?.body?.instance ?? null, ready: r?.status ?? 0 })
    await sleep(250)
  }
}

// ── load ────────────────────────────────────────────────────────────────────
const counts = { sent: 0, ok: 0, errored: 0, dropped: 0 }
const paths = ['/api/version', '/api/ready', '/api/health']
async function builtinLoad() {
  const every = Math.max(5, Math.round(1000 / Number(args.rps ?? 20)))
  const inflight = new Set()
  let i = 0
  while (!stopping) {
    const url = `${target}${paths[i++ % paths.length]}`
    counts.sent++
    const p = fetch(url, { signal: AbortSignal.timeout(10_000), headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then(async (res) => {
        await res.arrayBuffer().catch(() => null)
        if (res.status >= 500) counts.errored++
        else counts.ok++
      })
      .catch(() => void counts.dropped++)
      .finally(() => inflight.delete(p))
    inflight.add(p)
    await sleep(every)
  }
  await Promise.allSettled([...inflight])
}

/** traffic:replay for the window; its closing line carries the status counts ("network" = no response). */
async function replayLoad() {
  if (!args.caller) throw new Error('--caller is required for --load replay (k<api key id> or u<user uuid>)')
  let total = 0
  while (!stopping) {
    const child = spawn(
      'pnpm',
      ['--filter', '@nivaro/api', 'run', 'traffic:replay', '--', '--caller', String(args.caller), '--target', target,
        '--token', token, '--hours', String(args.hours ?? 1), '--sample', String(args.sample ?? 200),
        '--multiplier', String(args.multiplier ?? 1)],
      { cwd: repoRoot, env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    await new Promise((r) => child.on('exit', r))
    const refused = /traffic replay refused: (.*)/.exec(out)
    if (refused) throw new Error(`traffic:replay refused: ${refused[1]}`)
    const m = /statuses (\{.*?\})/.exec(out)
    if (!m) throw new Error(`traffic:replay gave no result:\n${out.slice(-400)}`)
    const st = JSON.parse(m[1])
    for (const [k, n] of Object.entries(st)) {
      counts.sent += n
      total += n
      if (k === 'network') counts.dropped += n
      else if (Number(k) >= 500) counts.errored += n
      else counts.ok += n
    }
  }
  return total
}

// ── one socket ──────────────────────────────────────────────────────────────
const socketLog = { connects: [], disconnects: [] }
function socket() {
  let io
  for (const base of [resolve(repoRoot, 'admin/package.json'), resolve(dirname(fileURLToPath(import.meta.url)), 'package.json')]) {
    try {
      io = createRequire(base)('socket.io-client').io
      break
    } catch {}
  }
  if (!io) return null
  const s = io(target, { transports: ['websocket', 'polling'], reconnectionDelay: 500, reconnectionDelayMax: 3000 })
  s.on('connect', () => socketLog.connects.push(rel()))
  s.on('disconnect', () => socketLog.disconnects.push(rel()))
  return s
}

// ── analysis ────────────────────────────────────────────────────────────────
function analyse() {
  const seen = polls.filter((p) => p.version)
  const first = seen[0]?.version ?? null
  const flipPoll = seen.find((p) => p.version !== first)
  const second = flipPoll?.version ?? null
  let overlapMs = 0
  if (flipPoll) {
    const lastOld = [...seen].reverse().find((p) => p.version === first)
    overlapMs = Math.max(0, (lastOld?.at ?? 0) - flipPoll.at)
  }
  // The gap: longest run of polls with no version answer (no replica up) or ready != 200.
  let gapMs = 0
  let runStart = null
  for (const p of polls) {
    const bad = !p.version || p.ready !== 200
    if (bad && runStart === null) runStart = p.at
    if (!bad && runStart !== null) {
      gapMs = Math.max(gapMs, p.at - runStart)
      runStart = null
    }
  }
  const reconnects = socketLog.disconnects.map((d) => {
    const up = socketLog.connects.find((c) => c > d)
    return up ? up - d : null
  })
  return { from: first, to: second, flipAtMs: flipPoll?.at ?? null, overlapMs, notReadyGapMs: gapMs, socketReconnectMs: reconnects }
}

// ── dry run: a throwaway API restarting itself ──────────────────────────────
async function dryScenario() {
  const env = { BOOT_DEPS_WAIT_MS: '30000', PORT: String(dryPort) }
  const a = startApi({ port: dryPort, env: { ...env, NIVARO_VERSION: '9.9.1' } })
  const up = (v) => waitFor(async () => (await getJson(`${target}/api/version`)).body?.version === v, { timeoutMs: 120_000, everyMs: 500 })
  if (!(await up('9.9.1'))) throw new Error('throwaway API A never came up')
  console.log('dry run: A (9.9.1) up; starting load')
  await sleep(4000)
  // The "deploy": hard-stop A, start B on the same port.
  a.stop('SIGKILL')
  await a.exited
  const b = startApi({ port: dryPort, env: { ...env, NIVARO_VERSION: '9.9.2' } })
  if (!(await up('9.9.2'))) throw new Error('throwaway API B never came up')
  console.log('dry run: B (9.9.2) answering')
  await sleep(afterMs > 8000 ? 8000 : afterMs)
  stopping = true
  sock?.close()
  b.stop('SIGTERM')
  await Promise.race([b.exited, sleep(10_000)])
}

// ── run ─────────────────────────────────────────────────────────────────────
const sock = socket()
const polling = poller()
const load = loadMode === 'replay' ? replayLoad() : builtinLoad()
let loadErr = null
load.catch((e) => {
  loadErr = e
  stopping = true
})

try {
  if (dry) await dryScenario()
  else {
    console.log(`measuring ${target}: start the deploy now (waiting up to ${windowMs / 1000} s for the version to change)`)
    const base = await waitFor(async () => polls.find((p) => p.version)?.version, { timeoutMs: 30_000, everyMs: 250 })
    const flipped = await waitFor(
      async () => loadErr || polls.some((p) => p.version && p.version !== base),
      { timeoutMs: windowMs, everyMs: 500 }
    )
    if (!loadErr) {
      if (!flipped) console.log('no version change seen inside the window')
      else await sleep(afterMs)
    }
    stopping = true
  }
} finally {
  stopping = true
  await Promise.allSettled([polling, load])
  sock?.close()
}

const a = analyse()
const total = counts.sent
const lost = counts.dropped + counts.errored
const summary = `this deploy dropped ${counts.dropped} of ${total} requests (${counts.errored} more answered 5xx)`
const checks = [
  { name: 'load ran', ok: !loadErr && total > 0, detail: loadErr ? loadErr.message : `${total} requests` },
  { name: 'version change observed', ok: !!a.to, detail: a.to ? `${a.from} to ${a.to} at +${Math.round(a.flipAtMs / 1000)} s` : 'none' },
  { name: 'no request dropped or errored', ok: lost === 0, detail: summary }
]
printChecks(checks)
console.log(summary)
console.log(`two versions answered together for ${a.overlapMs} ms; longest not-ready gap ${a.notReadyGapMs} ms; socket reconnect ${JSON.stringify(a.socketReconnectMs)} ms`)
// A dry run proves the counting, not the deploy: it must SEE the drops its hard restart causes.
const verdict = dry ? (a.to && counts.sent > 0 ? 'held' : 'broke') : lost === 0 && a.to ? 'held' : 'broke'
await finish(args, {
  script: 'deploy-under-load',
  fault_key: 'ci.deploy-load',
  label: dry ? 'Rolling deploy under load (dry run)' : 'Rolling deploy under replayed load',
  verdict,
  metrics: { sent: counts.sent, ok: counts.ok, errored: counts.errored, dropped: counts.dropped, version_from: a.from, version_to: a.to, overlap_ms: a.overlapMs, not_ready_gap_ms: a.notReadyGapMs, socket_reconnect_ms: a.socketReconnectMs, load: loadMode },
  checks,
  summary,
  started_at,
  ended_at: new Date().toISOString()
})
process.exit(verdict === 'held' ? 0 : 1)
