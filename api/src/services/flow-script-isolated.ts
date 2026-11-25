import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setPriority } from 'node:os'
import { scriptLimits } from './flow-script-limits.js'
import {
  forwardLogs,
  hostReplacer,
  hostReviver,
  MAX_TIMEOUT_MS,
  PRELUDE,
  parseLogLines,
  type ScriptLog,
  ScriptTimeoutError
} from './flow-script-sandbox.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * The flow `exec-script` operation, on every deployment: a script step never runs in the API
 * process. Each run gets its OWN short-lived child process (re-review P1: a `node:vm` context in
 * the API is not a boundary — V8 and Node raise host-realm errors into the script through
 * `import()` and stack-trace formatting, and from those `e.constructor.constructor` reached the
 * API's `process`). On a Hub shared deployment script steps also need the operator's opt-in
 * (FLOW_SCRIPTS_ON_SHARED, off by default; flow-script-limits.ts flowScriptsOnShared, checked by
 * flow-executor.ts); Nivaro Cloud refuses them. Each run:
 *
 *  - starts a fresh `node` (process.execPath, no native module, works on the slim image) with
 *    the permission model on (`--permission`, checked inside Node — a safeguard, not a boundary
 *    against malicious code, Node's own docs say): no file read or write, no child processes, no
 *    workers, no native addons, no WASI — so no other app's files, uploads or mounted secrets;
 *  - gets an EMPTY environment (TZ only, this process's own zone, so dates read as in the app):
 *    no deployment secrets, no NODE_OPTIONS;
 *  - runs the script in a `node:vm` context (flow-script-sandbox.ts PRELUDE: data + log; the runner
 *    hands in no host function, logs are read after the run; no process / require / timers /
 *    fetch / FinalizationRegistry, `import()` refused). That context alone is NOT the boundary: a
 *    script can still be handed a host-realm error by V8 / Node. What makes such an error useless
 *    is the child itself: code generation from strings is refused process-wide
 *    (`--disallow-code-generation-from-strings`), its intrinsics are frozen
 *    (`--frozen-intrinsics`), and its global and modules are locked down (next point);
 *  - locks its own realm down before reading the job (CHILD_LOCKDOWN): every network entry point
 *    of the built-in modules throws (net, tls, dgram sockets, all of dns, http/https/http2,
 *    inspector, cluster, all of net but the pipes' own Socket; v8, module, os, child_process,
 *    worker_threads, wasi throw too), process loses getBuiltinModule / binding / dlopen / _kill /
 *    _debugProcess / reallyExit and its env, and the global keeps ECMAScript built-ins only (an
 *    allow-list: no require, process, module, fetch, WebSocket, timers or module globals).
 *    Network access is blocked in JavaScript, not by the operating system (Node 22 has no
 *    permission scope for it; Node 25's `--allow-net` adds a check inside Node). A script step
 *    has no network on any deployment; partner calls go through the Webhook / External API
 *    operations and their guarded fetch;
 *  - on a shared deployment: no binary types (OFF_HEAP_GLOBALS: their memory is off the V8 heap),
 *    a V8 heap cap of FLOW_SCRIPT_MEMORY_MB (default 64), and a start only when the container has
 *    room for it (its cgroup limit minus its working set — usage less inactive page cache — must
 *    hold the child's budget plus HEADROOM_RESERVE_MB; else it waits up to
 *    FLOW_SCRIPT_MAX_WAIT_MS and is refused; skipped with a warning where no limit can be read);
 *  - on a dedicated app: binary types kept, a V8 heap cap of FLOW_SCRIPT_MAX_MB (default 256), and,
 *    under a container (cgroup) limit, a start only when what is free under it holds the child's
 *    budget, FLOW_SCRIPT_MAX_MB + RSS_MARGIN_MB (no check on a host without a limit);
 *  - is watched outside V8 too: past its heap cap plus RSS_MARGIN_MB of resident memory
 *    (watchRss polls every 100 ms) it is killed;
 *  - is capped at the step's timeout (≤ 30 s, counted from when the child starts the step; before
 *    that a start-up plus input-transfer allowance), 8 MB of output and 200 log lines, and starts
 *    under `nice -n 10` (every thread; without a `nice` binary only its main thread is lowered);
 *  - exits right after its answer, and on its own when the API goes away (its stdin closes or its
 *    parent pid changes), so no orphan keeps running;
 *  - holds a slot: at most FLOW_SCRIPT_CONCURRENCY runs at once on the process (default 4 on a
 *    shared deployment, 2 on a dedicated app); on a shared deployment FLOW_SCRIPT_PER_APP for one
 *    app (default 2). A step waits for a slot (and for memory) up to FLOW_SCRIPT_MAX_WAIT_MS on a
 *    shared deployment (default 30 s) or 10 minutes on a dedicated app, one deadline for both —
 *    but at most
 *    BLOCKING_WAIT_MS (10 s) in a flow that runs before a record is saved, which then refuses the
 *    write (ScriptBusyError → 503 FLOW_SCRIPT_BUSY, nothing written). The input is serialized only
 *    once a slot is held.
 *
 * The child costs one `node` start per step: about 80 ms of CPU and 50 MB of resident memory in
 * the child, 6–7 ms of the API's own CPU, and 110–170 ms of wall time per step measured on a busy
 * development Mac (load 45 on 10 cores; hub-gap exec report). The process shares nothing with the API:
 * no module state, no pool, no Redis, no app context. Data crosses as one JSON line on stdin; the
 * child answers with JSON lines on stdout (its log lines, then one `done`), decoded as a UTF-8
 * stream. A child that dies without its `done` line is a failure, never an empty success.
 */

export class ScriptLimitError extends Error {}

/**
 * No slot or no memory for a script step in time (review N7). A flow that runs before a record is
 * saved rethrows it, so the write is refused with 503 FLOW_SCRIPT_BUSY and nothing is written; any
 * other flow takes the step's reject path with the message.
 */
export class ScriptBusyError extends ScriptLimitError {
  statusCode = 503
  code = 'FLOW_SCRIPT_BUSY'
}

/** How long a step of a flow that runs before a record is saved waits for a slot or memory. */
export const BLOCKING_WAIT_MS = 10_000

/** Kill allowance on top of the script's own timeout: the child's start-up is not script time. */
const STARTUP_GRACE_MS = 5000
/** After the child starts the step: room for the prelude and the log read past the timeout. */
const RUN_GRACE_MS = 5000

/** Time allowed to hand the child its input and parse it: 10 MB a second, at most 60 s. */
export function transferAllowanceMs(inputChars: number): number {
  return Math.min(60_000, Math.ceil(inputChars / 10_000))
}
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const STDERR_KEEP = 4096
/** The child's whole memory (RSS) may pass its heap cap by this much (Node itself, code, stacks). */
export const RSS_MARGIN_MB = 96
const RSS_POLL_MS = 100

/** Resident memory of a process in bytes; null when it cannot be read (gone, no /proc, no ps). */
export async function readRssBytes(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(await readFile(`/proc/${pid}/status`, 'utf8'))
      return m ? Number(m[1]) * 1024 : null
    } catch {
      return null
    }
  }
  // Elsewhere (a developer's Mac): ps, a little slower.
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
      const kb = Number(String(stdout ?? '').trim())
      resolve(err || !Number.isFinite(kb) || kb <= 0 ? null : kb * 1024)
    })
  })
}

/**
 * Watches a child's resident memory, outside V8: memory a script holds beyond the V8 heap
 * (--max-old-space-size does not reach it) still counts. Calls onOver once when it passes
 * limitBytes. Answers a stop function.
 */
export function watchRss(pid: number, limitBytes: number, onOver: () => void): () => void {
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  const tick = async () => {
    if (stopped) return
    const rss = await readRssBytes(pid)
    if (stopped) return
    if (rss !== null && rss > limitBytes) {
      stopped = true
      onOver()
      return
    }
    timer = setTimeout(tick, RSS_POLL_MS)
    timer.unref()
  }
  timer = setTimeout(tick, RSS_POLL_MS)
  timer.unref()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/** The permission-model flag this Node knows; null when it has none (scripts are then refused). */
export function permissionFlag(): string | null {
  const flags = process.allowedNodeEnvironmentFlags
  if (flags.has('--permission')) return '--permission'
  if (flags.has('--experimental-permission')) return '--experimental-permission'
  return null
}

/** The child's node flags (before `-e`). */
export function childFlags(permission: string, memoryMb: number): string[] {
  return [
    permission,
    '--disallow-code-generation-from-strings',
    '--frozen-intrinsics',
    `--max-old-space-size=${memoryMb}`,
    '--no-warnings'
  ]
}

// ECMAScript built-ins the child's own realm keeps once it is locked down. Everything else on its
// global (with `node -e` that is process, require, module, Buffer, fetch, WebSocket, the timers
// and every built-in module: net, dns, dgram, http, child_process, worker_threads, inspector …)
// is deleted: an allow-list, not a deny-list.
const REALM_KEEP = [
  'Object',
  'Function',
  'Array',
  'Number',
  'parseFloat',
  'parseInt',
  'Infinity',
  'NaN',
  'undefined',
  'Boolean',
  'String',
  'Symbol',
  'Date',
  'Promise',
  'RegExp',
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'globalThis',
  'JSON',
  'Math',
  'Intl',
  'Map',
  'BigInt',
  'Set',
  'WeakMap',
  'WeakSet',
  'Proxy',
  'Reflect',
  'FinalizationRegistry',
  'WeakRef',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
  'isFinite',
  'isNaN',
  'Iterator'
]

// Binary types: their memory lives outside the V8 heap, where --max-old-space-size does not
// reach. Flow data is JSON, so the script's context has none of them (and nothing in the
// language makes one without these globals).
export const OFF_HEAP_GLOBALS = [
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Atomics',
  'WebAssembly',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array'
]

// The child's lock-down, run before anything reads the job. It answers null unless the permission
// model is really on (no file read/write, no child processes, no workers, no addons, no WASI),
// then: every network entry point of the built-in modules throws (net connect/listen, tls, dgram
// sockets, every dns function and resolver, http/https/http2, inspector, cluster), process loses
// getBuiltinModule / binding / dlopen and its env, and the realm's global keeps only REALM_KEEP.
// It answers what the runner needs (vm, stdin, stdout), captured before the strip. Kept apart so
// a test can run it with a probe after it.
export const CHILD_LOCKDOWN = `const lockdown = () => {
    const P = process
    const perm = P.permission
    const has = (s) => { try { return perm.has(s) } catch { return true } }
    if (!perm || ['fs.read', 'fs.write', 'child', 'worker', 'addon', 'wasi'].some(has)) return null
    const deny = () => { throw new Error('Scripts have no network access') }
    const set = (obj, k) => {
      try { Object.defineProperty(obj, k, { value: deny, writable: false, configurable: false }) } catch {}
    }
    const denyAll = (obj, keep) => {
      if (!obj) return
      for (const k of Reflect.ownKeys(obj)) {
        if (keep && keep.includes(k)) continue
        const d = Object.getOwnPropertyDescriptor(obj, k)
        if (d && typeof d.value === 'function') set(obj, k)
      }
    }
    const denyClass = (C) => { if (typeof C === 'function') denyAll(C.prototype, ['constructor']) }
    // Own data properties only: reading a lazy getter could load more of Node (undici).
    const fns = (o) => Reflect.ownKeys(o).map((k) => Object.getOwnPropertyDescriptor(o, k)).filter((d) => d && typeof d.value === 'function').map((d) => d.value)
    let io
    try {
      io = {
        vm: require('node:vm'),
        isProxy: require('node:util').types.isProxy,
        stdin: P.stdin,
        stdout: P.stdout,
        exit: P.reallyExit.bind(P),
        ppid: P.ppid,
        readPpid: () => P.ppid,
        setInterval,
        setTimeout
      }
      // net: everything but the Socket the pipes already are (its connect still throws), the
      // address helpers and the Stream alias.
      const net = require('node:net')
      set(net.Socket.prototype, 'connect')
      set(net.Socket.prototype, '_connect')
      denyClass(net.Server)
      denyAll(net, ['Socket', 'Stream', 'isIP', 'isIPv4', 'isIPv6', 'BlockList', 'SocketAddress'])
      for (const m of ['node:dns', 'node:dns/promises', 'node:dgram', 'node:tls', 'node:http',
        'node:https', 'node:http2', 'node:inspector', 'node:inspector/promises', 'node:cluster',
        'node:child_process', 'node:worker_threads', 'node:wasi', 'node:v8', 'node:module',
        'node:os', 'node:repl', 'node:trace_events']) {
        let x
        try { x = require(m) } catch { continue }
        for (const C of fns(x)) denyClass(C)
        denyAll(x)
        const pd = Object.getOwnPropertyDescriptor(x, 'promises')
        if (pd && pd.value) { for (const C of fns(pd.value)) denyClass(C); denyAll(pd.value) }
      }
      for (const k of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'kill', '_kill',
        '_debugProcess', '_debugEnd', '_startProfilerIdleNotifier', '_stopProfilerIdleNotifier',
        'reallyExit', 'abort', 'chdir', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups',
        'initgroups', 'loadEnvFile', 'setSourceMapsEnabled']) set(P, k)
      for (const k of Object.keys(P.env)) delete P.env[k]
    } catch {
      return null
    }
    const keep = new Set(${JSON.stringify(REALM_KEEP)})
    for (const k of Reflect.ownKeys(globalThis)) {
      if (typeof k === 'string' && keep.has(k)) continue
      try { delete globalThis[k] } catch {}
    }
    for (const k of Reflect.ownKeys(globalThis)) if (!(typeof k === 'string' && keep.has(k))) return null
    return io
  }`

// The child's whole program (CommonJS, `node -e`): lock down, read ONE job line from stdin, run
// it in a vm context, answer JSON lines (its log lines, then `done`) and exit. The parent keeps
// stdin open for the whole run: stdin closing means the parent is gone, and the child exits
// (also when its parent pid changes), so a crashed API leaves no script running.
export const CHILD_SOURCE = `(() => {
  'use strict'
  const stdout = process.stdout
  ${CHILD_LOCKDOWN}
  const io = lockdown()
  const write = (o, cb) => {
    try { stdout.write(JSON.stringify(o) + '\\n', cb) } catch { if (cb) cb() }
  }
  const done = (o) => write(Object.assign({ t: 'done' }, o), () => { if (io) io.exit(0) })
  if (!io) {
    done({ ok: false, kind: 'setup', err: 'The script sandbox could not start' })
    return
  }
  const vm = io.vm
  const PRELUDE = ${JSON.stringify(PRELUDE)}
  const SETTLE_TURNS = 10
  const SETTLE_TURN_MS = 5
  const STRIP_OFF_HEAP = 'for (const k of ' + ${JSON.stringify(JSON.stringify(OFF_HEAP_GLOBALS))} + ') delete globalThis[k]'
  const ownString = (obj, key) => {
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return null
    const d = Object.getOwnPropertyDescriptor(obj, key)
    return d && 'value' in d && typeof d.value === 'string' ? d.value : null
  }
  const classify = (err) => {
    if (err !== null && (typeof err === 'object' || typeof err === 'function') && io.isProxy(err)) return { kind: 'error', err: 'Script failed' }
    if (ownString(err, 'code') === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /^Script execution timed out/.test(ownString(err, 'message') || '')) return { kind: 'timeout' }
    return { kind: 'error', err: (ownString(err, 'message') || 'Script failed').slice(0, 2000) }
  }
  let started = false
  const run = (text) => {
    let job
    try { job = JSON.parse(text) } catch { return done({ ok: false, kind: 'setup', err: 'Bad input' }) }
    // The step's own timeout starts now (the parent's input-transfer allowance ends here).
    write({ t: 'start' })
    const timeout = job.timeout
    const sandbox = Object.create(null)
    sandbox.__nvrInput = job.input
    let context
    let state
    let failure = null
    try {
      context = vm.createContext(sandbox, {
        name: 'flow-exec-script',
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate'
      })
      vm.runInContext(PRELUDE, context, { timeout })
      if (!job.binary) vm.runInContext(STRIP_OFF_HEAP, context, { timeout })
      const fn = vm.compileFunction('"use strict";\\n' + job.code, ['data', 'log'], {
        parsingContext: context,
        filename: 'exec-script.js'
      })
      Object.defineProperty(context, '__nvrFn', { value: fn })
      vm.runInContext('__nvrRun(__nvrFn)', context, { timeout })
      state = vm.runInContext('__nvrResult()', context, { timeout })
    } catch (err) {
      failure = classify(err)
    }
    // Still pending: a promise only the HOST settles (Node's loader refusing import()) lands a
    // moment after the evaluation on newer Node (22.23: the refusal read as a timeout, CI
    // 2026-11-25). Give the host a few short turns, re-reading the result each time (each read
    // drains the context's microtasks); a script that really waits on nothing stays a timeout.
    let turns = 0
    const finish = () => {
      if (!failure && context && state === 'P' && turns < SETTLE_TURNS) {
        turns++
        return io.setTimeout(() => {
          try { state = vm.runInContext('__nvrResult()', context, { timeout }) } catch (err) { failure = classify(err) }
          finish()
        }, SETTLE_TURN_MS)
      }
      if (context) {
        try {
          // Its own short window (review N2): the log read never doubles the step's timeout.
          const logs = vm.runInContext('__nvrLogs()', context, { timeout: Math.min(timeout, 250) })
          if (typeof logs === 'string') write({ t: 'logs', v: logs })
        } catch {}
      }
      if (failure) return done(Object.assign({ ok: false }, failure))
      if (typeof state !== 'string' || state === 'P') return done({ ok: false, kind: 'timeout' })
      if (state[0] === 'E') return done({ ok: false, kind: 'error', err: state.slice(1) })
      done({ ok: true, out: state.slice(1) })
    }
    finish()
  }
  let text = ''
  io.stdin.setEncoding('utf8')
  // Only the new chunk is scanned for the job's end (review N5: rescanning the whole input on
  // every 64 KB chunk made a large input quadratic).
  io.stdin.on('data', (c) => {
    if (started) return
    const at = c.indexOf('\\n')
    if (at < 0) { text += c; return }
    started = true
    run(text + c.slice(0, at))
    text = ''
  })
  // The parent closes stdin only by going away (or once it has our answer): never run on alone.
  io.stdin.on('end', () => io.exit(started ? 0 : 1))
  io.stdin.on('error', () => io.exit(1))
  const watch = io.setInterval(() => { if (io.readPpid() !== io.ppid) io.exit(1) }, 1000)
  watch.unref()
})()`

// ─── Slots: per process and per app ──────────────────────────────────────────────────────

interface Waiter {
  app: string
  cap: number
  total: number
  wake: () => void
}

/** Runs holding a slot on this process, per app (currentTenantKey) and in all, plus who waits. */
const gate = { active: 0, byApp: new Map<string, number>(), queue: [] as Waiter[] }

function fits(app: string, cap: number, total: number): boolean {
  return gate.active < total && (gate.byApp.get(app) ?? 0) < cap
}

function take(app: string): void {
  gate.active++
  gate.byApp.set(app, (gate.byApp.get(app) ?? 0) + 1)
}

function give(app: string): void {
  gate.active = Math.max(0, gate.active - 1)
  const n = (gate.byApp.get(app) ?? 1) - 1
  if (n <= 0) gate.byApp.delete(app)
  else gate.byApp.set(app, n)
  // Wake the first waiters that now fit (an app at its share is skipped, not blocking others).
  for (let i = 0; i < gate.queue.length; ) {
    const w = gate.queue[i]
    if (fits(w.app, w.cap, w.total)) {
      gate.queue.splice(i, 1)
      take(w.app)
      w.wake()
    } else i++
  }
}

/** Slot counts for tests and diagnostics. */
export function scriptGateState(): { active: number; waiting: number } {
  return { active: gate.active, waiting: gate.queue.length }
}

/** How long a dedicated app's step waits for a slot (it had no cap before: it ran in line). */
const DEDICATED_SLOT_WAIT_MS = 600_000

/** How long a step may wait for a slot or for memory. */
function waitBudget(dedicated: boolean, blocking: boolean): number {
  const limits = scriptLimits(dedicated)
  const base = dedicated ? DEDICATED_SLOT_WAIT_MS : limits.maxWaitMs
  return blocking ? Math.min(BLOCKING_WAIT_MS, base) : base
}

async function acquireSlot(dedicated: boolean, maxWaitMs: number): Promise<() => void> {
  const app = currentTenantKey()
  const limits = scriptLimits(dedicated)
  const cap = limits.perApp
  const total = limits.total
  if (fits(app, cap, total)) take(app)
  else {
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        app,
        cap,
        total,
        wake: () => {
          clearTimeout(timer)
          resolve()
        }
      }
      const timer = setTimeout(() => {
        const i = gate.queue.indexOf(w)
        if (i >= 0) gate.queue.splice(i, 1)
        reject(
          new ScriptBusyError(
            'Too many script steps are running for this app right now. Try again in a moment.'
          )
        )
      }, maxWaitMs)
      gate.queue.push(w)
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    give(app)
  }
}

// ─── Memory headroom (review M2) ─────────────────────────────────────────────────────────

/** Headroom the container must keep beyond a new child's own budget (the API's own growth). */
export const HEADROOM_RESERVE_MB = 256
const HEADROOM_POLL_MS = 250

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return null
  }
}

/** A number from a memory.stat line ("inactive_file 123"); 0 when absent. */
function statValue(stat: string | null, key: string): number {
  const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(stat ?? '')
  return m ? Number(m[1]) : 0
}

/**
 * Free memory under a cgroup limit, by working set (review N1): usage less the inactive page cache
 * the kernel reclaims first (as `docker stats` and the kubelet count), so a container that reads
 * many files is not judged full. Null when there is no limit to judge against.
 */
export function cgroupHeadroom(
  limit: string | null,
  usage: string | null,
  stat: string | null,
  inactiveKey: 'inactive_file' | 'total_inactive_file'
): number | null {
  const max = Number(limit)
  const used = Number(usage)
  if (!limit || !usage || limit === 'max' || !Number.isFinite(max) || !Number.isFinite(used))
    return null
  // cgroup v1 reports "no limit" as a huge number (close to 2^63).
  if (max >= 2 ** 60) return null
  const working = Math.max(0, used - statValue(stat, inactiveKey))
  return Math.max(0, max - working)
}

/**
 * Free memory for a new script child, in bytes: the container's cgroup limit minus its working
 * set (cgroup v2, else v1); on Linux without a limit, MemAvailable from /proc/meminfo. Null where
 * none can be read (macOS, Windows): the caller then skips the check with a warning, rather than
 * refusing every step on a figure that leaves out reclaimable memory (review N3). The children of
 * this process count in the cgroup's usage, so steps already running are included.
 */
export async function memoryHeadroomBytes(): Promise<number | null> {
  return (await memoryHeadroom())?.bytes ?? null
}

/** Free memory and whether it is under a container (cgroup) limit; null where none can be read. */
export interface Headroom {
  bytes: number
  /** True: a cgroup limit minus the working set. False: the machine's MemAvailable. */
  limited: boolean
}

export async function memoryHeadroom(): Promise<Headroom | null> {
  if (process.platform !== 'linux') return null
  const v2 = cgroupHeadroom(
    await readText('/sys/fs/cgroup/memory.max'),
    await readText('/sys/fs/cgroup/memory.current'),
    await readText('/sys/fs/cgroup/memory.stat'),
    'inactive_file'
  )
  if (v2 !== null) return { bytes: v2, limited: true }
  const v1 = cgroupHeadroom(
    await readText('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    await readText('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
    await readText('/sys/fs/cgroup/memory/memory.stat'),
    'total_inactive_file'
  )
  if (v1 !== null) return { bytes: v1, limited: true }
  const m = /^MemAvailable:\s+(\d+) kB$/m.exec((await readText('/proc/meminfo')) ?? '')
  return m ? { bytes: Number(m[1]) * 1024, limited: false } : null
}

/** Test seam: the headroom reader (tests only; null = the real one). */
let headroomReader: (() => Promise<Headroom | null>) | null = null
export function setHeadroomReaderForTests(fn: (() => Promise<Headroom | null>) | null): void {
  headroomReader = fn
}

/** Warned once per process that free memory cannot be read here (no app data). */
let headroomUnreadableWarned = false

/**
 * Waits until `deadline` for room for one more child of memoryMb, else ScriptBusyError.
 * Shared deployment: the free memory must hold the child's budget plus HEADROOM_RESERVE_MB.
 * Dedicated app (review N6, ruling 4 F2): only under a container limit, and the free memory there
 * must hold the child's budget (heap cap + RSS_MARGIN_MB); the children already running count in
 * its usage.
 */
async function waitForHeadroom(
  memoryMb: number,
  deadline: number,
  log: ScriptLog,
  dedicated: boolean
): Promise<void> {
  const budget = (memoryMb + RSS_MARGIN_MB) * 1024 * 1024
  const need = dedicated ? budget : budget + HEADROOM_RESERVE_MB * 1024 * 1024
  for (;;) {
    const room = await (headroomReader ?? memoryHeadroom)()
    if (room && dedicated && !room.limited) return
    const free = room?.bytes ?? null
    if (free === null) {
      if (!headroomUnreadableWarned) {
        headroomUnreadableWarned = true
        try {
          log.warn(
            'Free memory cannot be read on this server (no cgroup limit or /proc/meminfo): script steps start without the memory check'
          )
        } catch {
          /* a log sink never fails the run */
        }
      }
      return
    }
    if (free >= need) return
    if (Date.now() >= deadline)
      throw new ScriptBusyError(
        'Not enough free memory on this server to start a script step right now. Try again in a moment.'
      )
    await new Promise((r) => setTimeout(r, HEADROOM_POLL_MS))
  }
}

// ─── One run ─────────────────────────────────────────────────────────────────────────────

/** The child's whole environment: TZ only (this process's own time zone, so dates read as in
 *  the app), never a secret. Read from Intl, not from the environment. */
export function childEnv(): Record<string, string> {
  let tz = ''
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    /* no zone: the child uses UTC */
  }
  return /^[A-Za-z0-9_+\-/]{1,64}$/.test(tz) ? { TZ: tz } : {}
}

/** `nice` at a fixed path, so the whole child (its GC and helper threads too) starts at a lower
 *  CPU priority; null when the image has none (then only its main thread is lowered). */
function niceBinary(): string | null {
  for (const p of ['/usr/bin/nice', '/bin/nice']) if (existsSync(p)) return p
  return null
}

function spawnRun(
  code: string,
  input: string,
  log: ScriptLog,
  timeout: number,
  memoryMb: number,
  binary: boolean
): Promise<Record<string, unknown>> {
  const flag = permissionFlag()
  if (!flag) {
    return Promise.reject(
      new Error('Scripts cannot run on this server: its Node has no permission model')
    )
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      stopRss()
      try {
        child.stdin.end()
      } catch {
        /* already closed */
      }
      fn()
    }
    const args = [...childFlags(flag, memoryMb), '-e', CHILD_SOURCE]
    const nice = niceBinary()
    const child = nice
      ? spawn(nice, ['-n', '10', process.execPath, ...args], {
          env: childEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      : spawn(process.execPath, args, {
          env: childEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
    let killedForTime = false
    let killedForSize = false
    let killedForMemory = false
    const stopRss = child.pid
      ? watchRss(child.pid, (memoryMb + RSS_MARGIN_MB) * 1024 * 1024, () => {
          killedForMemory = true
          child.kill('SIGKILL')
        })
      : () => {}
    // Until the child says it started, the clock is the start-up plus input-transfer allowance
    // (review N5: a large input must not use up the script's own time); from then, the step's
    // timeout plus a short grace for the prelude and the log read.
    const kill = () => {
      killedForTime = true
      child.kill('SIGKILL')
    }
    let killTimer = setTimeout(kill, STARTUP_GRACE_MS + transferAllowanceMs(input.length))
    // Once only (review 4 F5): a second `start` line never moves the clock again.
    let runStarted = false
    const onStart = () => {
      if (runStarted) return
      runStarted = true
      clearTimeout(killTimer)
      killTimer = setTimeout(kill, timeout + RUN_GRACE_MS)
    }
    if (child.pid && !nice) {
      try {
        setPriority(child.pid, 10)
      } catch {
        /* a lower priority is best effort */
      }
    }

    let outBytes = 0
    let pending = ''
    let scanFrom = 0
    let result: { ok: boolean; kind?: string; err?: string; out?: string } | null = null
    const onLine = (line: string) => {
      if (!line) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (msg.t === 'start') onStart()
      else if (msg.t === 'logs') forwardLogs(log, parseLogLines(msg.v))
      else if (msg.t === 'done' && !result) {
        result = {
          ok: msg.ok === true,
          kind: typeof msg.kind === 'string' ? msg.kind : undefined,
          err: typeof msg.err === 'string' ? msg.err.slice(0, 2000) : undefined,
          out: typeof msg.out === 'string' ? msg.out : undefined
        }
      }
    }
    // Decoded as a stream (review H1): a character split across two pipe reads stays whole.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text: string) => {
      outBytes += Buffer.byteLength(text, 'utf8')
      if (outBytes > MAX_OUTPUT_BYTES) {
        if (!killedForSize) {
          killedForSize = true
          child.kill('SIGKILL')
        }
        return
      }
      pending += text
      let nl = pending.indexOf('\n', scanFrom)
      while (nl >= 0) {
        onLine(pending.slice(0, nl))
        pending = pending.slice(nl + 1)
        nl = pending.indexOf('\n')
      }
      scanFrom = pending.length
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      // The head: V8's out-of-memory line comes before its long native stack trace.
      if (stderr.length < STDERR_KEEP) stderr = (stderr + text).slice(0, STDERR_KEEP)
    })
    child.on('error', () =>
      finish(() => reject(new Error('The script sandbox could not start on this server')))
    )
    child.on('close', () => {
      if (pending) onLine(pending)
      const r = result as typeof result
      finish(() => {
        if (r?.ok && typeof r.out === 'string') {
          try {
            const parsed = JSON.parse(r.out, hostReviver) as unknown
            resolve(
              parsed !== null && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : {}
            )
          } catch {
            reject(new Error('Script output could not be read'))
          }
        } else if (killedForMemory) {
          reject(new ScriptLimitError(`Script used more than ${memoryMb} MB of memory`))
        } else if (killedForSize) {
          reject(new ScriptLimitError('Script output is larger than 8 MB'))
        } else if (r && r.kind === 'timeout') {
          reject(new ScriptTimeoutError(`Script timed out after ${timeout}ms`))
        } else if (r && r.kind === 'error') {
          reject(new Error(r.err || 'Script failed'))
        } else if (r && r.kind === 'setup') {
          reject(new Error(r.err || 'The script sandbox could not start'))
        } else if (killedForTime) {
          reject(new ScriptTimeoutError(`Script timed out after ${timeout}ms`))
        } else if (/heap out of memory|Allocation failed|Reached heap limit/i.test(stderr)) {
          reject(new ScriptLimitError(`Script used more than ${memoryMb} MB of memory`))
        } else {
          reject(new Error('Script stopped before it finished'))
        }
      })
    })
    child.stdin.on('error', () => {
      /* the child died before reading its job: 'close' reports why */
    })
    // One job line; stdin stays open for the run (its close tells the child we are gone).
    child.stdin.write(`${JSON.stringify({ code, input, timeout, binary })}\n`)
  })
}

export interface ScriptRunOptions {
  /** A dedicated app (one app per process): binary types kept, FLOW_SCRIPT_MAX_MB as the child's
   *  heap cap, every slot usable (default 2), the memory check only under a container limit.
   *  Default: a shared deployment. */
  dedicated?: boolean
  /** The flow runs before a record is saved (it holds the write): a slot or memory is waited for
   *  at most BLOCKING_WAIT_MS, then ScriptBusyError (the write is refused, nothing is written). */
  blocking?: boolean
}

/** Runs one exec-script body in its own child process (see the header). Resolves with the
 *  output data; rejects with the script's error message, a ScriptTimeoutError, a ScriptBusyError
 *  (no slot or memory in time) or a ScriptLimitError (memory, output). Log lines reach `log`
 *  after the run. */
export async function runIsolatedScript(
  code: string,
  data: Record<string, unknown>,
  log: ScriptLog,
  timeoutMs = 5000,
  opts: ScriptRunOptions = {}
): Promise<Record<string, unknown>> {
  const dedicated = opts.dedicated === true
  const timeout = Math.min(Math.max(Number(timeoutMs) || 5000, 1), MAX_TIMEOUT_MS)
  const { memoryMb } = scriptLimits(dedicated)
  // ONE deadline for the slot and the memory together (review 4 F3): a before-save flow's step
  // waits ≤ BLOCKING_WAIT_MS in all.
  const deadline = Date.now() + waitBudget(dedicated, opts.blocking === true)
  const release = await acquireSlot(dedicated, deadline - Date.now())
  try {
    await waitForHeadroom(memoryMb, deadline, log, dedicated)
    // Serialized only once a slot is held: a queued step keeps no copy of its input (review N7).
    const input = JSON.stringify(data ?? {}, hostReplacer) ?? '{}'
    return await spawnRun(code, input, log, timeout, memoryMb, dedicated)
  } finally {
    release()
  }
}
