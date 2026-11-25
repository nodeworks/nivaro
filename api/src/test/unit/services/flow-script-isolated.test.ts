import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap `exec`: on a Hub shared deployment every exec-script run gets its own child process
// (flow-script-isolated.ts). The shared contract + escape suite runs against it in
// flow-script-sandbox.test.ts; this file proves what only the child adds: the lock-down (no
// files, no child processes, no network, no env), memory / output / slot limits, and that it
// fails closed when the permission model is missing.

const tenant = vi.hoisted(() => ({ key: '' }))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => tenant.key }))

const {
  CHILD_LOCKDOWN,
  CHILD_SOURCE,
  childEnv,
  childFlags,
  permissionFlag,
  runIsolatedScript,
  ScriptLimitError,
  scriptGateState
} = await import('../../../services/flow-script-isolated.js')
const { scriptLimits } = await import('../../../services/flow-script-limits.js')
const { ScriptTimeoutError } = await import('../../../services/flow-script-sandbox.js')

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
const ENV_KEYS = [
  'FLOW_SCRIPT_CONCURRENCY',
  'FLOW_SCRIPT_PER_APP',
  'FLOW_SCRIPT_MEMORY_MB',
  'FLOW_SCRIPT_MAX_WAIT_MS'
]
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  tenant.key = ''
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** Busy for `ms` inside the sandbox (it has no timers). */
const busy = (ms: number) =>
  `const end = Date.now() + ${ms}; while (Date.now() < end) {} return data`

describe('the child lock-down', () => {
  let server: Server
  let port = 0
  beforeAll(async () => {
    server = createServer((s) => s.end('hi'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as { port: number }).port
  })
  afterAll(() => server.close())

  const probe = (flags: string[], body: string, env: Record<string, string> = childEnv()) => {
    const r = spawnSync(
      process.execPath,
      [...flags, '-e', `(() => { ${CHILD_LOCKDOWN}\n${body} })()`],
      { env, encoding: 'utf8', timeout: 20_000 }
    )
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  }

  it('this Node has a permission model', () => {
    expect(permissionFlag()).toMatch(/permission$/)
  })

  it('denies files, child processes, workers, code from strings, the network and the env', () => {
    const flag = permissionFlag() as string
    const r = probe(
      childFlags(flag, 64),
      `const r = { ok: lockdown() }
       const t = (k, f) => { try { f(); r[k] = 'open' } catch (e) { r[k] = 'denied' } }
       t('fsRead', () => require('node:fs').readFileSync('/etc/hosts'))
       t('fsWrite', () => require('node:fs').writeFileSync('/tmp/nvr-flow-script-probe', 'x'))
       t('child', () => require('node:child_process').execSync('true'))
       t('worker', () => new (require('node:worker_threads').Worker)('1', { eval: true }))
       t('fn', () => new Function('return 1')())
       t('net', () => require('node:net').connect(${port}, '127.0.0.1'))
       t('socket', () => new (require('node:net').Socket)().connect(${port}, '127.0.0.1'))
       t('http', () => require('node:http').request('http://127.0.0.1:${port}/'))
       t('dgram', () => require('node:dgram').createSocket('udp4'))
       r.fetch = typeof globalThis.fetch
       r.env = Object.keys(process.env).filter((k) => k !== 'TZ' && !k.startsWith('__CF_'))
       console.log(JSON.stringify(r))`,
      { ...childEnv(), SECRET_FROM_PARENT: 'no' }
    )
    expect(r).toEqual({
      ok: true,
      fsRead: 'denied',
      fsWrite: 'denied',
      child: 'denied',
      worker: 'denied',
      fn: 'denied',
      net: 'denied',
      socket: 'denied',
      http: 'denied',
      dgram: 'denied',
      fetch: 'undefined',
      // the probe passed one variable on purpose: the real child gets childEnv() only
      env: ['SECRET_FROM_PARENT']
    })
  })

  it('refuses to run without the permission model (fails closed)', () => {
    expect(probe(['--no-warnings'], 'console.log(JSON.stringify({ ok: lockdown() }))')).toEqual({
      ok: false
    })
    const r = spawnSync(process.execPath, ['-e', CHILD_SOURCE], {
      env: childEnv(),
      input: JSON.stringify({ code: 'return { ran: true }', input: '{}', timeout: 1000 }),
      encoding: 'utf8',
      timeout: 20_000
    })
    expect(JSON.parse(r.stdout.trim())).toEqual({
      t: 'done',
      ok: false,
      kind: 'setup',
      err: 'The script sandbox could not start'
    })
  })

  it('the child environment carries no secret: TZ at most', () => {
    const before = { ...process.env }
    process.env.DB_PASSWORD = 'secret'
    process.env.ENCRYPTION_KEY = 'secret'
    try {
      expect(Object.keys(childEnv()).every((k) => k === 'TZ')).toBe(true)
    } finally {
      process.env = before
    }
  })
})

describe('limits', () => {
  it('defaults: 4 per process, 2 per app, 64 MB, 30 s wait; env overrides within bounds', () => {
    for (const k of ENV_KEYS) delete process.env[k]
    expect(scriptLimits()).toEqual({ total: 4, perApp: 2, memoryMb: 64, maxWaitMs: 30_000 })
    process.env.FLOW_SCRIPT_CONCURRENCY = '1'
    process.env.FLOW_SCRIPT_PER_APP = '5'
    process.env.FLOW_SCRIPT_MEMORY_MB = '4'
    expect(scriptLimits()).toMatchObject({ total: 1, perApp: 1, memoryMb: 64 })
  })

  it('a script that takes more memory than allowed is stopped', async () => {
    process.env.FLOW_SCRIPT_MEMORY_MB = '32'
    await expect(
      runIsolatedScript(
        'const keep = []; for (;;) keep.push(new Array(1e6).fill(1.5))',
        {},
        quietLog(),
        20_000
      )
    ).rejects.toThrow(new ScriptLimitError('Script used more than 32 MB of memory'))
  }, 30_000)

  it('output past 8 MB is refused', async () => {
    process.env.FLOW_SCRIPT_MEMORY_MB = '256'
    await expect(
      runIsolatedScript("return { s: 'x'.repeat(9 * 1024 * 1024) }", {}, quietLog(), 20_000)
    ).rejects.toBeInstanceOf(ScriptLimitError)
  }, 30_000)

  it('log lines are capped at 200', async () => {
    const log = quietLog()
    await runIsolatedScript('for (let i = 0; i < 500; i++) log.info("x" + i)', {}, log)
    expect(log.info).toHaveBeenCalledTimes(200)
  })

  it('an infinite loop is a timeout, not a hang', async () => {
    await expect(runIsolatedScript('for (;;) {}', {}, quietLog(), 200)).rejects.toBeInstanceOf(
      ScriptTimeoutError
    )
  })
})

describe('slots', () => {
  it('one app waits for its own slot; another app runs at once', async () => {
    process.env.FLOW_SCRIPT_CONCURRENCY = '4'
    process.env.FLOW_SCRIPT_PER_APP = '1'
    const order: string[] = []
    tenant.key = 'app-a'
    const a1 = runIsolatedScript(busy(600), {}, quietLog()).then(() => order.push('a1'))
    const a2 = runIsolatedScript(busy(10), {}, quietLog()).then(() => order.push('a2'))
    tenant.key = 'app-b'
    const b1 = runIsolatedScript(busy(10), {}, quietLog()).then(() => order.push('b1'))
    expect(scriptGateState()).toEqual({ active: 2, waiting: 1 })
    await Promise.all([a1, a2, b1])
    // b1 never waited behind app A; a2 waited for a1.
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a1'))
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'))
    expect(scriptGateState()).toEqual({ active: 0, waiting: 0 })
  }, 30_000)

  it('a run that waits too long for a slot is refused, never run past the cap', async () => {
    process.env.FLOW_SCRIPT_CONCURRENCY = '1'
    process.env.FLOW_SCRIPT_MAX_WAIT_MS = '50'
    const first = runIsolatedScript(busy(800), {}, quietLog())
    await expect(runIsolatedScript('return data', {}, quietLog())).rejects.toBeInstanceOf(
      ScriptLimitError
    )
    await first
    expect(scriptGateState()).toEqual({ active: 0, waiting: 0 })
  }, 30_000)

  it('a failing script gives its slot back', async () => {
    process.env.FLOW_SCRIPT_CONCURRENCY = '1'
    await expect(runIsolatedScript('throw new Error("x")', {}, quietLog())).rejects.toThrow('x')
    expect(scriptGateState()).toEqual({ active: 0, waiting: 0 })
    expect(await runIsolatedScript('data.b = 1', { a: 1 }, quietLog())).toEqual({ a: 1, b: 1 })
  })
})
