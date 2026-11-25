import { types } from 'node:util'
import vm from 'node:vm'

/**
 * The flow `exec-script` operation's sandbox (C2, security audit 2026-10-27).
 *
 * The script used to run through `new Function` in the API process — `process.env`,
 * `process.getBuiltinModule('child_process')` and every pool were in reach. It now runs in a
 * fresh `node:vm` context that holds nothing of the host:
 *
 *  - `data` is rebuilt INSIDE the context from JSON (Dates kept as Dates), so no host object —
 *    and so no host `Function` constructor — is reachable through it;
 *  - `log` (info / warn / error / debug) and `console` are context functions that collect lines
 *    inside the context; the host reads them after the run as one string (no host function is
 *    ever inside the context: a stack overflow on entry to one would hand the script a host-realm
 *    error, and its constructor chain the host Function constructor);
 *  - every value the host reads back is a primitive string; a thrown value is turned into a
 *    message inside the context, and a Proxy that still reaches the host is never inspected;
 *  - FinalizationRegistry and WeakRef are removed (their callbacks run later, past the timeout);
 *  - the context's own built-ins (JSON, Math, Date, Array, Object, RegExp, Promise …) are
 *    there; `process`, `require`, `import()`, timers, `fetch`, `eval` / `new Function` and
 *    WebAssembly are not;
 *  - the timeout covers the synchronous run AND the microtasks it queues (an infinite loop is
 *    stopped, not left spinning the event loop).
 *
 * Unchanged for scripts: `data` + `log`, `return` an object to replace the data, mutate `data`
 * and return nothing to pass the mutated data on, return a Promise (resolved inside the run).
 * The script's data crosses the boundary as JSON: functions / undefined / symbols drop out, a
 * BigInt becomes a string.
 */

export const DATE_KEY = '\u0000nvr:date'

export interface ScriptLog {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  debug: (msg: string) => void
}

export class ScriptTimeoutError extends Error {}

export function hostReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key]
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : { [DATE_KEY]: raw.toISOString() }
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

export function hostReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[DATE_KEY] === 'string' &&
    Object.keys(value).length === 1
  ) {
    return new Date((value as Record<string, string>)[DATE_KEY])
  }
  return value
}

/** Log lines a run keeps (and the characters of each); the rest are dropped. */
export const MAX_LOG_LINES = 200
export const MAX_LOG_CHARS = 4000

// Runs inside the context, before the script. It takes the input (a string) off the global and
// keeps the JSON functions it needs in a closure, so a script that replaces JSON.stringify or
// Array.prototype.map later changes only its own data. NOTHING of the host is in the context:
// `log` / `console` collect lines in a context array, read after the run with __nvrLogs() — no
// host function a script could overflow its way into (a stack overflow on entry to a host
// function hands the script a host-realm error, and from it the host Function constructor).
// Every value the host reads back is a primitive string; __nvrRun never throws on purpose
// (whatever the script throws is turned into a message here, under the run's timeout).
// FinalizationRegistry and WeakRef are removed: their callbacks would run later, outside the
// timeout. Also run, unchanged, by the isolated runner's child process (flow-script-isolated.ts).
export const PRELUDE = `(() => {
  'use strict'
  const input = globalThis.__nvrInput
  delete globalThis.__nvrInput
  delete globalThis.FinalizationRegistry
  delete globalThis.WeakRef
  const stringify = JSON.stringify
  const parse = JSON.parse
  const Str = String
  const isArray = Array.isArray
  const keys = Object.keys
  const define = Object.defineProperty
  const freeze = Object.freeze
  const DATE_KEY = ${JSON.stringify(DATE_KEY)}
  const MAX_LINES = ${MAX_LOG_LINES}
  const MAX_CHARS = ${MAX_LOG_CHARS}
  const lines = []
  const one = (a) => {
    if (typeof a === 'string') return a
    try { const j = stringify(a); return typeof j === 'string' ? j : Str(a) } catch { try { return Str(a) } catch { return '' } }
  }
  const say = (level) => (...args) => {
    if (lines.length >= MAX_LINES) return
    let m = ''
    try { for (let i = 0; i < args.length; i++) m += (i ? ' ' : '') + one(args[i]) } catch { m = '' }
    lines[lines.length] = [level, typeof m === 'string' ? m.slice(0, MAX_CHARS) : '']
  }
  const log = freeze({ info: say('info'), warn: say('warn'), error: say('error'), debug: say('debug') })
  define(globalThis, 'console', {
    value: freeze({ log: say('info'), info: say('info'), warn: say('warn'), error: say('error'), debug: say('debug') })
  })
  const revive = (k, v) => v && typeof v === 'object' && !isArray(v) && typeof v[DATE_KEY] === 'string' && keys(v).length === 1 ? new Date(v[DATE_KEY]) : v
  const replace = function (k, v) {
    const raw = this[k]
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : { [DATE_KEY]: raw.toISOString() }
    if (typeof v === 'bigint') return v.toString()
    return v
  }
  const message = (e) => {
    try {
      const m = e !== null && (typeof e === 'object' || typeof e === 'function') ? e.message : undefined
      const s = Str(m !== undefined ? m : e)
      return typeof s === 'string' ? s.slice(0, 2000) : 'Script failed'
    } catch { return 'Script failed' }
  }
  let out = null
  let err = null
  let done = false
  const finish = (r) => {
    if (done) return
    try {
      const s = stringify(r, replace)
      out = typeof s === 'string' ? s : 'null'
    } catch (e) { err = message(e) }
    done = true
  }
  const fail = (e) => { if (done) return; err = message(e); done = true }
  define(globalThis, '__nvrRun', {
    value: (fn) => {
      try {
        const data = parse(input, revive)
        const r = fn.call(undefined, data, log)
        if (r !== null && typeof r === 'object' && typeof r.then === 'function') r.then((v) => finish(v !== null && v !== undefined && typeof v === 'object' ? v : data), fail)
        else finish(r !== null && r !== undefined && typeof r === 'object' ? r : data)
      } catch (e) { fail(e) }
    }
  })
  define(globalThis, '__nvrResult', {
    value: () => (done ? (err !== null ? 'E' + err : 'O' + out) : 'P')
  })
  define(globalThis, '__nvrLogs', {
    value: () => { try { const s = stringify(lines); return typeof s === 'string' ? s : '[]' } catch { return '[]' } }
  })
})()`

export const MAX_TIMEOUT_MS = 30_000

/** An own data property that is a string; null otherwise. Never runs a getter. */
export function ownString(obj: unknown, key: string): string | null {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return null
  const d = Object.getOwnPropertyDescriptor(obj, key)
  return d && 'value' in d && typeof d.value === 'string' ? d.value : null
}

/**
 * What a run's error means, read without ever running script code on the host: a Proxy (whose
 * traps would run here, past the timeout) is never inspected; anything else is read through own
 * data properties only.
 */
export function classifyRunError(err: unknown): 'timeout' | { message: string } {
  if (err !== null && (typeof err === 'object' || typeof err === 'function') && types.isProxy(err))
    return { message: 'Script failed' }
  if (
    ownString(err, 'code') === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
    /^Script execution timed out/.test(ownString(err, 'message') ?? '')
  )
    return 'timeout'
  return { message: (ownString(err, 'message') ?? 'Script failed').slice(0, 2000) }
}

/** The run's log lines as [level, message] pairs, from the string __nvrLogs() answered. */
export function parseLogLines(raw: unknown): Array<[string, string]> {
  if (typeof raw !== 'string') return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: Array<[string, string]> = []
  for (const l of v.slice(0, MAX_LOG_LINES)) {
    if (Array.isArray(l) && typeof l[0] === 'string' && typeof l[1] === 'string')
      out.push([l[0], l[1].slice(0, MAX_LOG_CHARS)])
  }
  return out
}

export function forwardLogs(log: ScriptLog, lines: Array<[string, string]>): void {
  for (const [level, m] of lines) {
    try {
      if (level === 'warn') log.warn(m)
      else if (level === 'error') log.error(m)
      else if (level === 'debug') log.debug(m)
      else log.info(m)
    } catch {
      /* a log sink never fails the run */
    }
  }
}

/** Runs one exec-script body. Resolves with the script's output data; rejects with the
 *  script's error (message only) or a ScriptTimeoutError. Log lines reach `log` after the run. */
export async function runSandboxedScript(
  code: string,
  data: Record<string, unknown>,
  log: ScriptLog,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  const timeout = Math.min(Math.max(Number(timeoutMs) || 5000, 1), MAX_TIMEOUT_MS)
  const input = JSON.stringify(data ?? {}, hostReplacer) ?? '{}'
  // A null-prototype sandbox: `globalThis.constructor` must not resolve to the HOST Object (and
  // from there the host Function constructor) — with no prototype the lookup falls through to
  // the context's own global. It holds one string, taken off by the prelude.
  const sandbox = Object.create(null) as Record<string, unknown>
  sandbox.__nvrInput = input
  const context = vm.createContext(sandbox, {
    name: 'flow-exec-script',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate'
  })
  vm.runInContext(PRELUDE, context, { timeout })
  const readLogs = () => {
    try {
      forwardLogs(log, parseLogLines(vm.runInContext('__nvrLogs()', context, { timeout })))
    } catch {
      /* logs are best effort */
    }
  }
  let state: unknown
  try {
    // compileFunction parses the code as a function BODY — it cannot close the function and run
    // statements at the top of the prelude's scope.
    const fn = vm.compileFunction(`"use strict";\n${code}`, ['data', 'log'], {
      parsingContext: context,
      filename: 'exec-script.js'
    })
    Object.defineProperty(context, '__nvrFn', { value: fn })
    vm.runInContext('__nvrRun(__nvrFn)', context, { timeout })
    state = vm.runInContext('__nvrResult()', context, { timeout })
  } catch (err) {
    readLogs()
    const c = classifyRunError(err)
    if (c === 'timeout') throw new ScriptTimeoutError(`Script timed out after ${timeout}ms`)
    throw new Error(c.message)
  }
  readLogs()
  if (typeof state !== 'string' || state === 'P') {
    // A promise that never settles (there are no timers in the sandbox) — what the old
    // implementation reported once its timer ran out.
    throw new ScriptTimeoutError(`Script timed out after ${timeout}ms`)
  }
  if (state.startsWith('E')) throw new Error(state.slice(1))
  const parsed = JSON.parse(state.slice(1), hostReviver) as unknown
  return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}
