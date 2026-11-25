/**
 * The flow `exec-script` operation's sandbox contract (C2, security audit 2026-10-27): the vm
 * context PRELUDE and the pure helpers around it. Scripts never run in the API process: every
 * deployment runs them in a child process of its own (flow-script-isolated.ts).
 *
 * Why not in-process (re-review 2026-11-24, P1): a `node:vm` context is not a boundary. Even with
 * nothing of the host handed in, V8 and Node run host JavaScript on the script's behalf and their
 * errors reach the script as HOST-realm objects — `import()` rejects with the host loader's
 * TypeError, and a stack overflow inside Node's stack-trace formatter throws a host RangeError.
 * From either, `e.constructor.constructor('return process')()` was the API's own `process` on a
 * dedicated install. In the child the same errors are useless: code generation from strings is
 * refused process-wide, its intrinsics are frozen and its global is stripped (flow-script-isolated.ts).
 *
 * Inside the context (both kinds of deployment):
 *  - `data` is rebuilt from JSON (Dates kept as Dates);
 *  - `log` (info / warn / error / debug) and `console` are context functions that collect lines in
 *    the context; the child reads them after the run as one string built without script hooks;
 *  - everything read back is a primitive string; a thrown value is turned into a message inside the
 *    context, and a Proxy that still reaches the reader is never inspected (classifyRunError);
 *  - FinalizationRegistry and WeakRef are removed (their callbacks run later, past the timeout);
 *  - the context's own built-ins (JSON, Math, Date, Array, Object, RegExp, Promise …) are there;
 *    `process`, `require`, timers, `fetch`, `eval` / `new Function` and WebAssembly compilation are
 *    not (and `import()` is refused);
 *  - the timeout covers the synchronous run AND the microtasks it queues.
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

// Runs inside the context, before the script (in the child process, flow-script-isolated.ts). It
// takes the input (a string) off the global and keeps the JSON functions it needs in a closure,
// so a script that replaces JSON.stringify or Array.prototype.map later changes only its own data.
// The runner hands in no host function: `log` / `console` collect lines in the context, read
// after the run with __nvrLogs(). Each line is stored as pre-serialized JSON text through a
// captured defineProperty, and __nvrLogs() joins them with a plain loop, so no script hook
// (toJSON, an Array.prototype setter) runs while the lines are read. Every value read back is a
// primitive string; __nvrRun never throws on purpose (whatever the script throws is turned into a
// message here, under the run's timeout). FinalizationRegistry and WeakRef are removed: their
// callbacks would run later, outside the timeout.
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
  let count = 0
  const one = (a) => {
    if (typeof a === 'string') return a
    try { const j = stringify(a); return typeof j === 'string' ? j : Str(a) } catch { try { return Str(a) } catch { return '' } }
  }
  const say = (level) => (...args) => {
    if (count >= MAX_LINES) return
    let m = ''
    try { for (let i = 0; i < args.length; i++) m += (i ? ' ' : '') + one(args[i]) } catch { m = '' }
    const text = typeof m === 'string' ? m.slice(0, MAX_CHARS) : ''
    // Strings only (no toJSON lookup on a primitive), stored as own data (no setter runs).
    define(lines, count, { value: '[' + stringify(level) + ',' + stringify(text) + ']' })
    count++
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
    value: () => {
      let s = '['
      for (let i = 0; i < count; i++) s += (i ? ',' : '') + lines[i]
      return s + ']'
    }
  })
})()`

export const MAX_TIMEOUT_MS = 30_000

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
