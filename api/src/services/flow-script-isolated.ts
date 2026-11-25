import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setPriority } from 'node:os'
import { scriptLimits } from './flow-script-limits.js'
import {
  hostReplacer,
  hostReviver,
  MAX_TIMEOUT_MS,
  PRELUDE,
  type ScriptLog,
  ScriptTimeoutError
} from './flow-script-sandbox.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * The flow `exec-script` operation on a Hub shared deployment (hub gap `exec`): one process
 * serves many apps there, so a script step runs in its OWN short-lived child process, never in
 * the shared one — and only when the operator turned script steps on for the deployment
 * (FLOW_SCRIPTS_ON_SHARED, off by default; flow-script-limits.ts flowScriptsOnShared, checked by
 * flow-executor.ts). Each run:
 *
 *  - starts a fresh `node` (process.execPath, no native module, works on the slim image) with
 *    the permission model on (`--permission`, OS/C++ level): no file read or write, no child
 *    processes, no workers, no native addons, no WASI — so no other app's files, uploads or
 *    mounted secrets;
 *  - gets an EMPTY environment (TZ only, this process's own zone, so dates read as in the app):
 *    no deployment secrets, no NODE_OPTIONS;
 *  - cannot compile code from strings in its own realm (`--disallow-code-generation-from-strings`)
 *    and runs the script inside the same `node:vm` context as a dedicated app
 *    (flow-script-sandbox.ts PRELUDE: data + log only, no process / require / import() / timers /
 *    fetch), minus the binary types (OFF_HEAP_GLOBALS);
 *  - locks its own realm down before reading the job (CHILD_LOCKDOWN): every network entry point
 *    of the built-in modules throws (net, tls, dgram sockets, all of dns, http/https/http2,
 *    inspector, cluster), process loses getBuiltinModule / binding / dlopen and its env, and the
 *    global keeps ECMAScript built-ins only (an allow-list: no require, process, module, fetch,
 *    WebSocket, timers or module globals). Node 22 has no permission scope for the network
 *    (`--allow-net` arrives in Node 25), so the network block is these layers, not the OS: a
 *    script must escape the vm context AND compile code without strings AND find a module
 *    reference in a realm that holds none. A script step has no network on any deployment;
 *    partner calls go through the Webhook / External API operations and their guarded fetch;
 *  - is capped at FLOW_SCRIPT_MEMORY_MB of V8 heap (default 64) and, outside V8, at that plus
 *    RSS_MARGIN_MB of resident memory (watchRss polls it every 100 ms and kills the child); the
 *    script has no ArrayBuffer / typed arrays / WebAssembly, the only way JavaScript holds memory
 *    off the heap. RLIMIT_AS is not used: V8 reserves far more address space than it touches;
 *  - is capped at the step's timeout (≤ 30 s, plus a start-up allowance before the process is
 *    killed), 8 MB of output and 200 log lines, and runs at a lower CPU priority than the API;
 *  - holds a slot: at most FLOW_SCRIPT_CONCURRENCY runs at once on the process (default 4) and
 *    FLOW_SCRIPT_PER_APP for one app (default 2); a run that waits FLOW_SCRIPT_MAX_WAIT_MS
 *    (default 30 s) for a slot is refused, never run past the cap.
 *
 * The process shares nothing with the API: no module state, no pool, no Redis, no app context.
 * Data crosses as JSON on stdin; the child answers with JSON lines on stdout (log lines, then one
 * `done`). A child that dies without its `done` line is a failure, never an empty success.
 * Nivaro Cloud still refuses script steps (flow-executor.ts EXEC_SCRIPT_CLOUD_REFUSAL); a
 * dedicated app still runs them in-process (runSandboxedScript).
 */

export class ScriptLimitError extends Error {}

/** Kill allowance on top of the script's own timeout: the child's start-up is not script time. */
const STARTUP_GRACE_MS = 5000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_LOG_LINES = 200
const MAX_LOG_CHARS = 4000
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
    const perm = process.permission
    const has = (s) => { try { return perm.has(s) } catch { return true } }
    if (!perm || ['fs.read', 'fs.write', 'child', 'worker', 'addon', 'wasi'].some(has)) return null
    const deny = () => { throw new Error('Scripts have no network access') }
    const denyAll = (obj, keep) => {
      if (!obj) return
      for (const k of Reflect.ownKeys(obj)) {
        if (keep && keep.includes(k)) continue
        const d = Object.getOwnPropertyDescriptor(obj, k)
        if (!d || typeof d.value !== 'function') continue
        try { Object.defineProperty(obj, k, { value: deny, writable: false, configurable: false }) } catch {}
      }
    }
    const denyClass = (C) => { if (typeof C === 'function') denyAll(C.prototype, ['constructor']) }
    let vm, stdin, stdout
    try {
      vm = require('node:vm')
      stdin = process.stdin
      stdout = process.stdout
      const net = require('node:net')
      net.Socket.prototype.connect = deny
      net.Server.prototype.listen = deny
      for (const k of ['connect', 'createConnection', 'createServer']) net[k] = deny
      for (const m of ['node:dns', 'node:dns/promises', 'node:dgram', 'node:tls', 'node:http',
        'node:https', 'node:http2', 'node:inspector', 'node:inspector/promises', 'node:cluster',
        'node:child_process', 'node:worker_threads', 'node:wasi']) {
        let x
        try { x = require(m) } catch { continue }
        // Own data properties only: reading a lazy getter could load more of Node (undici).
        const fns = (o) => Reflect.ownKeys(o).map((k) => Object.getOwnPropertyDescriptor(o, k)).filter((d) => d && typeof d.value === 'function').map((d) => d.value)
        for (const C of fns(x)) denyClass(C)
        denyAll(x)
        const pd = Object.getOwnPropertyDescriptor(x, 'promises')
        if (pd && pd.value) { for (const C of fns(pd.value)) denyClass(C); denyAll(pd.value) }
      }
      for (const k of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'kill', 'chdir']) {
        try { Object.defineProperty(process, k, { value: deny, writable: false, configurable: false }) } catch {}
      }
      for (const k of Object.keys(process.env)) delete process.env[k]
    } catch {
      return null
    }
    const keep = new Set(${JSON.stringify(REALM_KEEP)})
    for (const k of Reflect.ownKeys(globalThis)) {
      if (typeof k === 'string' && keep.has(k)) continue
      try { delete globalThis[k] } catch {}
    }
    for (const k of Reflect.ownKeys(globalThis)) if (!(typeof k === 'string' && keep.has(k))) return null
    return { vm, stdin, stdout }
  }`

// The child's whole program (CommonJS, `node -e`): lock down, read one job from stdin, run it in
// a vm context, answer JSON lines.
export const CHILD_SOURCE = `(() => {
  'use strict'
  ${CHILD_LOCKDOWN}
  const io = lockdown()
  const out = (o) => { try { (io ? io.stdout : process.stdout).write(JSON.stringify(o) + '\\n') } catch {} }
  const done = (o) => out(Object.assign({ t: 'done' }, o))
  if (!io) {
    done({ ok: false, kind: 'setup', err: 'The script sandbox could not start' })
    return
  }
  const vm = io.vm
  const PRELUDE = ${JSON.stringify(PRELUDE)}
  const STRIP_OFF_HEAP = 'for (const k of ' + ${JSON.stringify(JSON.stringify(OFF_HEAP_GLOBALS))} + ') delete globalThis[k]'
  const MAX_LOG_LINES = ${MAX_LOG_LINES}
  const MAX_LOG_CHARS = ${MAX_LOG_CHARS}
  const ownString = (obj, key) => {
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return null
    const d = Object.getOwnPropertyDescriptor(obj, key)
    return d && 'value' in d && typeof d.value === 'string' ? d.value : null
  }
  const isTimeout = (err) =>
    ownString(err, 'code') === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
    /^Script execution timed out/.test(ownString(err, 'message') || '')
  const run = (text) => {
    let job
    try { job = JSON.parse(text) } catch { return done({ ok: false, kind: 'setup', err: 'Bad input' }) }
    const timeout = job.timeout
    let lines = 0
    const bridge = (level, msg) => {
      if (lines >= MAX_LOG_LINES) return
      lines++
      out({ t: 'log', l: String(level), m: typeof msg === 'string' ? msg.slice(0, MAX_LOG_CHARS) : '' })
    }
    const sandbox = Object.create(null)
    sandbox.__nvrBridge = bridge
    sandbox.__nvrInput = job.input
    let state
    try {
      const context = vm.createContext(sandbox, {
        name: 'flow-exec-script',
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate'
      })
      vm.runInContext(PRELUDE, context, { timeout })
      vm.runInContext(STRIP_OFF_HEAP, context, { timeout })
      const fn = vm.compileFunction('"use strict";\\n' + job.code, ['data', 'log'], {
        parsingContext: context,
        filename: 'exec-script.js'
      })
      Object.defineProperty(context, '__nvrFn', { value: fn })
      vm.runInContext('__nvrRun(__nvrFn)', context, { timeout })
      state = vm.runInContext('__nvrResult()', context, { timeout })
    } catch (err) {
      if (isTimeout(err)) return done({ ok: false, kind: 'timeout' })
      return done({ ok: false, kind: 'error', err: ownString(err, 'message') || 'Script failed' })
    }
    if (typeof state !== 'string' || state === 'P') return done({ ok: false, kind: 'timeout' })
    if (state[0] === 'E') return done({ ok: false, kind: 'error', err: state.slice(1) })
    done({ ok: true, out: state.slice(1) })
  }
  let text = ''
  io.stdin.setEncoding('utf8')
  io.stdin.on('data', (c) => { text += c })
  io.stdin.on('end', () => run(text))
})()`

// ─── Slots: per process and per app ──────────────────────────────────────────────────────

interface Waiter {
  app: string
  wake: () => void
}

/** Runs holding a slot on this process, per app (currentTenantKey) and in all, plus who waits. */
const gate = { active: 0, byApp: new Map<string, number>(), queue: [] as Waiter[] }

function fits(app: string): boolean {
  const { total, perApp } = scriptLimits()
  return gate.active < total && (gate.byApp.get(app) ?? 0) < perApp
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
    if (fits(w.app)) {
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

async function acquireSlot(): Promise<() => void> {
  const app = currentTenantKey()
  if (fits(app)) take(app)
  else {
    const { maxWaitMs } = scriptLimits()
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        app,
        wake: () => {
          clearTimeout(timer)
          resolve()
        }
      }
      const timer = setTimeout(() => {
        const i = gate.queue.indexOf(w)
        if (i >= 0) gate.queue.splice(i, 1)
        reject(
          new ScriptLimitError(
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

function spawnRun(
  code: string,
  input: string,
  log: ScriptLog,
  timeout: number,
  memoryMb: number
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
      fn()
    }
    const child = spawn(process.execPath, [...childFlags(flag, memoryMb), '-e', CHILD_SOURCE], {
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
    const killTimer = setTimeout(() => {
      killedForTime = true
      child.kill('SIGKILL')
    }, timeout + STARTUP_GRACE_MS)
    if (child.pid) {
      try {
        setPriority(child.pid, 10)
      } catch {
        /* a lower priority is best effort */
      }
    }

    let outBytes = 0
    let pending = ''
    let result: { ok: boolean; kind?: string; err?: string; out?: string } | null = null
    let logLines = 0
    const onLine = (line: string) => {
      if (!line) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (msg.t === 'log') {
        if (logLines >= MAX_LOG_LINES) return
        logLines++
        const m = typeof msg.m === 'string' ? msg.m.slice(0, MAX_LOG_CHARS) : ''
        try {
          if (msg.l === 'warn') log.warn(m)
          else if (msg.l === 'error') log.error(m)
          else if (msg.l === 'debug') log.debug(m)
          else log.info(m)
        } catch {
          /* a log sink never fails the run */
        }
      } else if (msg.t === 'done' && !result) {
        result = {
          ok: msg.ok === true,
          kind: typeof msg.kind === 'string' ? msg.kind : undefined,
          err: typeof msg.err === 'string' ? msg.err.slice(0, 2000) : undefined,
          out: typeof msg.out === 'string' ? msg.out : undefined
        }
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > MAX_OUTPUT_BYTES) {
        if (!killedForSize) {
          killedForSize = true
          child.kill('SIGKILL')
        }
        return
      }
      pending += chunk.toString('utf8')
      let nl = pending.indexOf('\n')
      while (nl >= 0) {
        onLine(pending.slice(0, nl))
        pending = pending.slice(nl + 1)
        nl = pending.indexOf('\n')
      }
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      // The head: V8's out-of-memory line comes before its long native stack trace.
      if (stderr.length < STDERR_KEEP)
        stderr = (stderr + chunk.toString('utf8')).slice(0, STDERR_KEEP)
    })
    child.on('error', () =>
      finish(() => reject(new Error('The script sandbox could not start on this server')))
    )
    child.on('close', () => {
      if (pending) onLine(pending)
      const r = result as typeof result
      finish(() => {
        if (killedForMemory) {
          reject(new ScriptLimitError(`Script used more than ${memoryMb} MB of memory`))
        } else if (killedForSize) {
          reject(new ScriptLimitError('Script output is larger than 8 MB'))
        } else if (r?.ok && typeof r.out === 'string') {
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
    child.stdin.end(JSON.stringify({ code, input, timeout }))
  })
}

/** Runs one exec-script body in its own child process (see the header). Same contract as
 *  runSandboxedScript: resolves with the output data; rejects with the script's error message,
 *  a ScriptTimeoutError, or a ScriptLimitError (memory, output, no free slot). */
export async function runIsolatedScript(
  code: string,
  data: Record<string, unknown>,
  log: ScriptLog,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  const timeout = Math.min(Math.max(Number(timeoutMs) || 5000, 1), MAX_TIMEOUT_MS)
  const input = JSON.stringify(data ?? {}, hostReplacer) ?? '{}'
  const { memoryMb } = scriptLimits()
  const release = await acquireSlot()
  try {
    return await spawnRun(code, input, log, timeout, memoryMb)
  } finally {
    release()
  }
}
