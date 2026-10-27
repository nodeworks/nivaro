import { describe, expect, it, vi } from 'vitest'
import { runSandboxedScript, ScriptTimeoutError } from '../../../services/flow-script-sandbox.js'

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })

describe('exec-script sandbox (C2)', () => {
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

  it('does not change the caller object', async () => {
    const input = { a: 1 }
    await runSandboxedScript('data.a = 2; return data', input, quietLog())
    expect(input).toEqual({ a: 1 })
  })
})
