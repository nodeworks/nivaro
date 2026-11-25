import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runIsolatedScript,
  setHeadroomReaderForTests
} from '../../../services/flow-script-isolated.js'
import {
  runSandboxedScript as inProcess,
  ScriptTimeoutError
} from '../../../services/flow-script-sandbox.js'

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })

// Each child-process case starts a node: well past the default 5 s under a full suite's load.
vi.setConfig({ testTimeout: 20_000 })
// The machine running the tests may be short of free memory (flow-script-isolated.test.ts tests
// the headroom gate itself).
beforeEach(() => setHeadroomReaderForTests(async () => Number.POSITIVE_INFINITY))

// The same contract and the same escapes, for the in-process context (a dedicated app) and for
// the child process a Hub shared deployment runs each script in (flow-script-isolated.ts).
describe.each([
  ['in process (dedicated)', inProcess],
  ['child process (shared deployment)', runIsolatedScript]
])('exec-script sandbox (C2) — %s', (_where, runSandboxedScript) => {
  it('keeps the documented contract: modify data and return it', async () => {
    const out = await runSandboxedScript(
      'data.computed = data.payload?.amount * 1.1; return data;',
      { payload: { amount: 10 } },
      quietLog()
    )
    expect(out.computed).toBeCloseTo(11)
    expect(out.payload).toEqual({ amount: 10 })
  })

  it('mutating data and returning nothing passes the mutated data on', async () => {
    const out = await runSandboxedScript('data.flag = true', { a: 1 }, quietLog())
    expect(out).toEqual({ a: 1, flag: true })
  })

  it('a returned object replaces the data; a returned primitive keeps it', async () => {
    expect(await runSandboxedScript('return { only: 1 }', { a: 1 }, quietLog())).toEqual({
      only: 1
    })
    expect(await runSandboxedScript('return 42', { a: 1 }, quietLog())).toEqual({ a: 1 })
  })

  it('awaits a returned promise', async () => {
    const out = await runSandboxedScript(
      'return Promise.resolve().then(() => ({ ...data, later: true }))',
      { a: 1 },
      quietLog()
    )
    expect(out).toEqual({ a: 1, later: true })
  })

  it('keeps Dates as Dates both ways', async () => {
    const at = new Date('2026-10-27T12:00:00.000Z')
    const out = await runSandboxedScript(
      'data.isDate = data.at instanceof Date; data.next = new Date(data.at.getTime() + 1000); return data',
      { at },
      quietLog()
    )
    expect(out.isDate).toBe(true)
    expect(out.at).toEqual(at)
    expect(out.next).toEqual(new Date('2026-10-27T12:00:01.000Z'))
  })

  it('log and console reach the flow logger as strings', async () => {
    const log = quietLog()
    await runSandboxedScript(
      'log.info("hello"); log.warn({ a: 1 }); log.error("bad", 2); console.log("c")',
      {},
      log
    )
    expect(log.info).toHaveBeenCalledWith('hello')
    expect(log.warn).toHaveBeenCalledWith('{"a":1}')
    expect(log.error).toHaveBeenCalledWith('bad 2')
    expect(log.info).toHaveBeenCalledWith('c')
  })

  it.each([
    ['process', 'return { t: typeof process }'],
    ['require', 'return { t: typeof require }'],
    ['setTimeout', 'return { t: typeof setTimeout }'],
    ['fetch', 'return { t: typeof fetch }'],
    ['Buffer', 'return { t: typeof Buffer }']
  ])('has no %s', async (_name, code) => {
    expect(await runSandboxedScript(code, {}, quietLog())).toEqual({ t: 'undefined' })
  })

  it.each([
    ['data constructor chain', 'return { v: data.constructor.constructor("return process")() }'],
    ['log function constructor', 'return { v: log.info.constructor("return process")() }'],
    [
      'globalThis constructor',
      'return { v: globalThis.constructor.constructor("return process")() }'
    ],
    ['eval', 'return { v: eval("1 + 1") }'],
    ['new Function', 'return { v: new Function("return 1")() }']
  ])('blocks escape via %s', async (_name, code) => {
    await expect(runSandboxedScript(code, { a: 1 }, quietLog())).rejects.toThrow()
  })

  it('cannot reach process.env through anything it is handed', async () => {
    const out = await runSandboxedScript(
      `const seen = []
       for (const v of [data, log, log.info, console, globalThis]) {
         try { const p = v.constructor.constructor('return this')(); seen.push(typeof p.process) } catch (e) { seen.push('blocked') }
       }
       return { seen }`,
      {},
      quietLog()
    )
    expect((out.seen as string[]).every((s) => s === 'blocked' || s === 'undefined')).toBe(true)
  })

  it('a getter planted on Error.prototype never runs on the host side', async () => {
    await expect(
      runSandboxedScript(
        `for (const k of ['code', 'message', 'stack']) Object.defineProperty(Error.prototype, k, { get() { while (true) {} } })
         while (true) {}`,
        {},
        quietLog(),
        100
      )
    ).rejects.toBeInstanceOf(ScriptTimeoutError)
  })

  it('the global prototype chain stays inside the context', async () => {
    await expect(
      runSandboxedScript(
        'return { v: Object.getPrototypeOf(globalThis).constructor.constructor("return process")() }',
        {},
        quietLog()
      )
    ).rejects.toThrow()
  })

  it('cannot break out of the function body', async () => {
    await expect(
      runSandboxedScript('}); globalThis.x = 1; (function () {', {}, quietLog())
    ).rejects.toThrow()
  })

  it('stops a synchronous infinite loop at the timeout', async () => {
    await expect(runSandboxedScript('while (true) {}', {}, quietLog(), 100)).rejects.toBeInstanceOf(
      ScriptTimeoutError
    )
  })

  it('stops a microtask loop at the timeout', async () => {
    await expect(
      runSandboxedScript(
        'const spin = () => Promise.resolve().then(spin); spin(); return data',
        {},
        quietLog(),
        100
      )
    ).rejects.toBeInstanceOf(ScriptTimeoutError)
  })

  it('reports a never-settling promise as a timeout', async () => {
    await expect(
      runSandboxedScript('return new Promise(() => {})', {}, quietLog(), 100)
    ).rejects.toThrow('Script timed out after 100ms')
  })

  it("surfaces the script's own error message", async () => {
    await expect(runSandboxedScript('throw new Error("nope")', {}, quietLog())).rejects.toThrow(
      'nope'
    )
  })

  it('holds no host function: log and console are the context’s own (review P1/M3)', async () => {
    expect(
      await runSandboxedScript(
        'return { same: log.info.constructor === Function && console.log.constructor === Function && log.warn.constructor === Function }',
        {},
        quietLog()
      )
    ).toEqual({ same: true })
  })

  it('a stack overflow on a log call never yields a host Function (review P1)', async () => {
    const out = await runSandboxedScript(
      `let found = 'none'
       const probe = (d) => {
         try { probe(d + 1) } catch (e) {
           try { log.info('x') } catch (e2) {
             try { found = typeof e2.constructor.constructor('return process')() } catch (e3) { if (found === 'none') found = 'blocked' }
           }
         }
       }
       probe(0)
       return { found }`,
      {},
      quietLog()
    )
    expect(out.found).not.toBe('object')
  })

  it('a thrown value whose message getter throws a looping Proxy never hangs the host (review P2)', async () => {
    const started = Date.now()
    await expect(
      runSandboxedScript(
        `const trap = () => { for (;;) {} }
         const p = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, has: trap, ownKeys: trap, getPrototypeOf: trap })
         throw { get message() { throw p } }`,
        {},
        quietLog(),
        200
      )
    ).rejects.toThrow()
    await expect(
      runSandboxedScript(
        `const trap = () => { for (;;) {} }
         throw new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, has: trap, ownKeys: trap, getPrototypeOf: trap })`,
        {},
        quietLog(),
        200
      )
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('has no FinalizationRegistry or WeakRef (their callbacks would run past the timeout, review P3)', async () => {
    expect(
      await runSandboxedScript(
        'return { f: typeof FinalizationRegistry, w: typeof WeakRef }',
        {},
        quietLog()
      )
    ).toEqual({ f: 'undefined', w: 'undefined' })
  })

  it('log lines reach the logger even when the script fails, capped at 200', async () => {
    const log = quietLog()
    await expect(
      runSandboxedScript(
        'for (let i = 0; i < 300; i++) log.info("n" + i); throw new Error("after")',
        {},
        log
      )
    ).rejects.toThrow('after')
    expect(log.info).toHaveBeenCalledTimes(200)
    expect(log.info).toHaveBeenNthCalledWith(1, 'n0')
  })

  it('does not change the caller object', async () => {
    const input = { a: 1 }
    await runSandboxedScript('data.a = 2; return data', input, quietLog())
    expect(input).toEqual({ a: 1 })
  })
})
