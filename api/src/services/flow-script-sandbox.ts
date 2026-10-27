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
 *  - `log` (info / warn / error / debug) and `console` are context functions that hand a plain
 *    string to one host bridge, captured in a closure and removed from the global; the bridge
 *    never throws and returns nothing;
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

const DATE_KEY = '\u0000nvr:date'

export interface ScriptLog {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  debug: (msg: string) => void
}

export class ScriptTimeoutError extends Error {}

function hostReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key]
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : { [DATE_KEY]: raw.toISOString() }
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

function hostReviver(_key: string, value: unknown): unknown {
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

// Runs inside the context. Takes the bridge + input off the global and keeps them in a closure,
// then exposes one runner. Nothing here hands a host object to the script.
const PRELUDE = `(() => {
  'use strict'
  const bridge = globalThis.__nvrBridge
  const input = globalThis.__nvrInput
  delete globalThis.__nvrBridge
  delete globalThis.__nvrInput
  const DATE_KEY = ${JSON.stringify(DATE_KEY)}
  const text = (args) => args.map((a) => {
    if (typeof a === 'string') return a
    try { const j = JSON.stringify(a); return j === undefined ? String(a) : j } catch { return String(a) }
  }).join(' ')
  const say = (level) => (...args) => { bridge(level, text(args)) }
  const log = Object.freeze({ info: say('info'), warn: say('warn'), error: say('error'), debug: say('debug') })
  Object.defineProperty(globalThis, 'console', {
    value: Object.freeze({ log: say('info'), info: say('info'), warn: say('warn'), error: say('error'), debug: say('debug') })
  })
  const revive = (k, v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v[DATE_KEY] === 'string' && Object.keys(v).length === 1 ? new Date(v[DATE_KEY]) : v
  const replace = function (k, v) {
    const raw = this[k]
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : { [DATE_KEY]: raw.toISOString() }
    if (typeof v === 'bigint') return v.toString()
    return v
  }
  let out = null
  let err = null
  let done = false
  Object.defineProperty(globalThis, '__nvrRun', {
    value: (fn) => {
      const data = JSON.parse(input, revive)
      const finish = (r) => {
        try {
          out = JSON.stringify(r !== null && r !== undefined && typeof r === 'object' ? r : data, replace) ?? 'null'
        } catch (e) { err = String(e && e.message !== undefined ? e.message : e) }
        done = true
      }
      const fail = (e) => { err = String(e && e.message !== undefined ? e.message : e); done = true }
      try {
        const r = fn.call(undefined, data, log)
        if (r !== null && typeof r === 'object' && typeof r.then === 'function') r.then(finish, fail)
        else finish(r)
      } catch (e) { fail(e) }
    }
  })
  Object.defineProperty(globalThis, '__nvrResult', {
    value: () => (done ? (err !== null ? 'E' + err : 'O' + out) : 'P')
  })
})()`

const MAX_TIMEOUT_MS = 30_000

function ownString(obj: unknown, key: string): string | null {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return null
  const d = Object.getOwnPropertyDescriptor(obj, key)
  return d && 'value' in d && typeof d.value === 'string' ? d.value : null
}

/** Runs one exec-script body. Resolves with the script's output data; rejects with the
 *  script's error (message only) or a ScriptTimeoutError. */
export async function runSandboxedScript(
  code: string,
  data: Record<string, unknown>,
  log: ScriptLog,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  const timeout = Math.min(Math.max(Number(timeoutMs) || 5000, 1), MAX_TIMEOUT_MS)
  const input = JSON.stringify(data ?? {}, hostReplacer) ?? '{}'
  const bridge = (level: unknown, msg: unknown) => {
    try {
      const m = typeof msg === 'string' ? msg : ''
      if (level === 'warn') log.warn(m)
      else if (level === 'error') log.error(m)
      else if (level === 'debug') log.debug(m)
      else log.info(m)
    } catch {
      /* the bridge never throws into the sandbox */
    }
  }
  // A null-prototype sandbox: `globalThis.constructor` must not resolve to the HOST Object (and
  // from there the host Function constructor) — with no prototype the lookup falls through to
  // the context's own global.
  const sandbox = Object.create(null) as Record<string, unknown>
  sandbox.__nvrBridge = bridge
  sandbox.__nvrInput = input
  const context = vm.createContext(sandbox, {
    name: 'flow-exec-script',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate'
  })
  vm.runInContext(PRELUDE, context, { timeout })
  // compileFunction parses the code as a function BODY — it cannot close the function and run
  // statements at the top of the prelude's scope.
  const fn = vm.compileFunction(`"use strict";\n${code}`, ['data', 'log'], {
    parsingContext: context,
    filename: 'exec-script.js'
  })
  Object.defineProperty(context, '__nvrFn', { value: fn })
  try {
    vm.runInContext('__nvrRun(__nvrFn)', context, { timeout })
  } catch (err) {
    // The timeout error may come from the context's realm: read OWN data properties only — a
    // getter the script planted on the context's Error.prototype must never run out here.
    if (
      ownString(err, 'code') === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      /^Script execution timed out/.test(ownString(err, 'message') ?? '')
    ) {
      throw new ScriptTimeoutError(`Script timed out after ${timeout}ms`)
    }
    throw new Error(ownString(err, 'message') ?? 'Script failed')
  }
  const state = vm.runInContext('__nvrResult()', context, { timeout })
  if (typeof state !== 'string' || state === 'P') {
    // A promise that never settles (there are no timers in the sandbox) — what the old
    // implementation reported once its timer ran out.
    throw new ScriptTimeoutError(`Script timed out after ${timeout}ms`)
  }
  if (state.startsWith('E')) throw new Error(state.slice(1))
  const parsed = JSON.parse(state.slice(1), hostReviver) as unknown
  return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}
