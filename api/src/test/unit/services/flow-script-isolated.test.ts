import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap `exec`: on a Hub shared deployment every exec-script run gets its own child process
// (flow-script-isolated.ts). The shared contract + escape suite runs against it in
// flow-script-sandbox.test.ts; this file proves what only the child adds: the lock-down (no
// files, no child processes, no network, no env, a realm with only ECMAScript built-ins), memory
// limits inside and outside the V8 heap, output / slot limits, and that it fails closed when the
// permission model is missing.

const tenant = vi.hoisted(() => ({ key: '' }))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => tenant.key }))

const {
  CHILD_LOCKDOWN,
  CHILD_SOURCE,
  childEnv,
  cgroupHeadroom,
  childFlags,
  OFF_HEAP_GLOBALS,
  permissionFlag,
  RSS_MARGIN_MB,
  memoryHeadroomBytes,
  readRssBytes,
  runIsolatedScript,
  BLOCKING_WAIT_MS,
  ScriptBusyError,
  ScriptLimitError,
  scriptGateState,
  setHeadroomReaderForTests,
  transferAllowanceMs,
  watchRss
} = await import('../../../services/flow-script-isolated.js')
const { scriptLimits } = await import('../../../services/flow-script-limits.js')
const { ScriptTimeoutError } = await import('../../../services/flow-script-sandbox.js')

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })

// Each case here starts a node: well past the default 5 s under a full suite's load (review L6).
vi.setConfig({ testTimeout: 20_000 })
const ENV_KEYS = [
  'FLOW_SCRIPT_CONCURRENCY',
  'FLOW_SCRIPT_PER_APP',
  'FLOW_SCRIPT_MEMORY_MB',
  'FLOW_SCRIPT_MAX_WAIT_MS',
  'FLOW_SCRIPT_MAX_MB'
]
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  tenant.key = ''
  // The machine running the tests may be short of free memory; the headroom gate has its own
  // cases below.
  setHeadroomReaderForTests(async () => ({ bytes: Number.POSITIVE_INFINITY, limited: true }))
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

  /** Runs the lock-down, then `body`. `R` / `P` are require / process captured BEFORE it: they
   *  stand for an escape that somehow kept them (the real child keeps neither). `emit(obj)`
   *  answers through stdout. */
  const probe = (flags: string[], body: string, env: Record<string, string> = childEnv()) => {
    const r = spawnSync(
      process.execPath,
      [
        ...flags,
        '-e',
        `(() => { const R = require; const P = process; const emit = (o) => P.stdout.write(JSON.stringify(o) + '\\n')
         ${CHILD_LOCKDOWN}
         ${body} })()`
      ],
      { env, encoding: 'utf8', timeout: 20_000 }
    )
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  }

  it('this Node has a permission model', () => {
    expect(permissionFlag()).toMatch(/permission$/)
  })

  // Every route to a file, a process, a worker or a socket an escaped script could try.
  const PATHS: Record<string, string> = {
    fsRead: "R('node:fs').readFileSync('/etc/hosts')",
    fsWrite: "R('node:fs').writeFileSync('/tmp/nvr-flow-script-probe', 'x')",
    childProcess: "R('node:child_process').execFileSync('true')",
    childSpawn: "R('node:child_process').spawn('true')",
    worker: "new (R('node:worker_threads').Worker)('1', { eval: true })",
    codeFromStrings: "new Function('return 1')()",
    netConnect: "R('node:net').connect(PORT, '127.0.0.1')",
    netCreateConnection: "R('node:net').createConnection(PORT, '127.0.0.1')",
    netSocket: "new (R('node:net').Socket)().connect(PORT, '127.0.0.1')",
    netServer: "R('node:net').createServer().listen(0)",
    tls: "R('node:tls').connect(PORT, '127.0.0.1')",
    http: "R('node:http').request('http://127.0.0.1:PORT/')",
    httpGet: "R('node:http').get('http://127.0.0.1:PORT/')",
    https: "R('node:https').request('https://127.0.0.1:PORT/')",
    http2: "R('node:http2').connect('http://127.0.0.1:PORT')",
    dgramCreate: "R('node:dgram').createSocket('udp4')",
    dgramSend: "R('node:dgram').Socket.prototype.send.call({}, 'x', PORT, '127.0.0.1')",
    dgramBind: "R('node:dgram').Socket.prototype.bind.call({}, 0)",
    dgramConnect: "R('node:dgram').Socket.prototype.connect.call({}, PORT)",
    dnsLookup: "R('node:dns').lookup('localhost', () => {})",
    dnsResolve: "R('node:dns').resolve4('localhost', () => {})",
    dnsResolveAny: "R('node:dns').resolveAny('localhost', () => {})",
    dnsReverse: "R('node:dns').reverse('127.0.0.1', () => {})",
    dnsResolver: "new (R('node:dns').Resolver)().resolve4('localhost', () => {})",
    dnsPromises: "R('node:dns').promises.lookup('localhost')",
    dnsPromisesModule: "R('node:dns/promises').resolve4('localhost')",
    dnsPromisesResolver: "new (R('node:dns/promises').Resolver)().resolve4('localhost')",
    getBuiltinModule: "P.getBuiltinModule('node:net')",
    binding: "P.binding('tcp_wrap')",
    linkedBinding: "P._linkedBinding('x')",
    dlopen: "P.dlopen({ exports: {} }, '/x.node')",
    inspectorOpen: "R('node:inspector').open(0)",
    inspectorSession: "new (R('node:inspector').Session)().connect()",
    wasi: "new (R('node:wasi').WASI)({ version: 'preview1' })",
    killParent: 'P._kill(P.ppid, 0)',
    debugParent: 'P._debugProcess(P.ppid)',
    debugEnd: 'P._debugEnd()',
    reallyExit: 'P.reallyExit(0)',
    abort: 'P.abort()',
    netServerHandle: "R('node:net')._createServerHandle('127.0.0.1', 0)",
    netListen2: "R('node:net').Server.prototype._listen2.call({})",
    netSocketPrivateConnect: "R('node:net').Socket.prototype._connect.call({})",
    v8Flags: "R('node:v8').setFlagsFromString('--allow-natives-syntax')",
    osRenice: "R('node:os').setPriority(P.ppid, 19)",
    createRequire: "R('node:module').createRequire('/x.js')"
  }

  it('refuses every route to files, processes, workers and the network', () => {
    const flag = permissionFlag() as string
    const checks = Object.entries(PATHS)
      .map(([k, code]) => `t(${JSON.stringify(k)}, () => ${code.replaceAll('PORT', String(port))})`)
      .join('\n')
    const r = probe(
      childFlags(flag, 64),
      `const io = lockdown()
       const r = { ok: io !== null }
       const t = (k, f) => { try { const v = f(); r[k] = v && typeof v.then === 'function' ? 'promise' : 'open' } catch (e) { r[k] = 'refused' } }
       ${checks}
       emit(r)`
    )
    const expected: Record<string, unknown> = { ok: true }
    for (const k of Object.keys(PATHS)) expected[k] = 'refused'
    expect(r).toEqual(expected)
  })

  it('leaves the realm only ECMAScript built-ins: no require, process, fetch, WebSocket or module globals', () => {
    const flag = permissionFlag() as string
    const r = probe(
      childFlags(flag, 64),
      `const io = lockdown()
       emit({
         ok: io !== null,
         gone: ['require', 'process', 'module', 'Buffer', 'fetch', 'WebSocket', 'EventSource',
           'net', 'dns', 'dgram', 'http', 'child_process', 'worker_threads', 'inspector', 'wasi',
           'setTimeout', 'queueMicrotask', 'structuredClone', 'navigator', 'crypto']
           .filter((k) => k in globalThis),
         env: Object.keys(P.env)
       })`,
      { ...childEnv(), SECRET_FROM_PARENT: 'no' }
    )
    // The probe passed one variable on purpose: the lock-down empties even that.
    expect(r).toEqual({ ok: true, gone: [], env: [] })
  })

  it('refuses to run without the permission model (fails closed)', () => {
    expect(probe(['--no-warnings'], 'emit({ ok: lockdown() !== null })')).toEqual({ ok: false })
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

  it('freezes the child realm’s own intrinsics (--frozen-intrinsics)', () => {
    const r = probe(
      childFlags(permissionFlag() as string, 64),
      'const io = lockdown(); emit({ ok: io !== null, frozen: Object.isFrozen(Object.prototype) && Object.isFrozen(Array.prototype) })'
    )
    expect(r).toEqual({ ok: true, frozen: true })
  })

  it('a script cannot import() a module, and the refusal it gets is no way out', async () => {
    await expect(
      runIsolatedScript('return import("node:net").then(() => ({ got: true }))', {}, quietLog())
    ).rejects.toThrow(/dynamic import callback/i)
    // The refusal is a host-realm error (Node's loader): it must not lead anywhere.
    expect(
      await runIsolatedScript(
        `return import('node:net').then(null, (e) => {
           const r = {}
           try { r.fn = typeof e.constructor.constructor('return process')() } catch { r.fn = 'refused' }
           // The host realm's intrinsics (the root of the error's prototype chain) are frozen.
           let root = e
           while (Object.getPrototypeOf(root)) root = Object.getPrototypeOf(root)
           try { root.nvrPoked = 1; r.proto = 'wrote' } catch { r.proto = 'frozen' }
           return r
         })`,
        {},
        quietLog()
      )
    ).toEqual({ fn: 'refused', proto: 'frozen' })
  })

  it('exits right after its answer, and on its own when the API goes away', async () => {
    const flags = childFlags(permissionFlag() as string, 64)
    const exitOf = (c: ReturnType<typeof spawn>) =>
      new Promise<number | null>((resolve) => c.on('exit', (code) => resolve(code)))
    // Answers, then exits although its stdin stays open.
    const a = spawn(process.execPath, [...flags, '-e', CHILD_SOURCE], { env: childEnv() })
    let out = ''
    a.stdout?.setEncoding('utf8')
    a.stdout?.on('data', (t: string) => {
      out += t
    })
    a.stdin?.write(`${JSON.stringify({ code: 'data.x = 1', input: '{}', timeout: 1000 })}\n`)
    expect(await exitOf(a)).toBe(0)
    expect(out).toContain('"t":"done"')
    a.stdin?.destroy()
    // No job and the parent closes the pipe (it went away): the child exits instead of waiting.
    const b = spawn(process.execPath, [...flags, '-e', CHILD_SOURCE], { env: childEnv() })
    const bExit = exitOf(b)
    b.stdin?.end()
    expect(await bExit).toBe(1)
  })
})

describe('output decoding (review H1)', () => {
  it('multi-byte characters split across pipe reads come back whole', async () => {
    const word = 'Müller café 日本 😀 '
    const out = await runIsolatedScript(
      `data.s = ${JSON.stringify(word)}.repeat(12000); return data`,
      {},
      quietLog()
    )
    expect(out.s).toBe(word.repeat(12000))
    expect(String(out.s)).not.toContain('\uFFFD')
  })

  it('log lines with multi-byte text come back whole', async () => {
    const log = quietLog()
    await runIsolatedScript('log.info("é".repeat(3999))', {}, log)
    expect(log.info).toHaveBeenCalledWith('é'.repeat(3999))
  })
})

describe('container memory headroom (review M2)', () => {
  it('reads the headroom of this container or machine (null where it cannot be read)', async () => {
    const h = await memoryHeadroomBytes()
    if (process.platform === 'linux') expect(h).toBeGreaterThan(0)
    else expect(h).toBeNull()
  })

  it('judges by working set: inactive page cache does not count as used (review N1)', () => {
    const GB = 1024 ** 3
    // v2: 4 GB limit, 3.8 GB used of which 2 GB is inactive file cache → 2.2 GB free.
    expect(
      cgroupHeadroom(
        String(4 * GB),
        String(3.8 * GB),
        `anon 1\ninactive_file ${2 * GB}\nactive_file 5`,
        'inactive_file'
      )
    ).toBeCloseTo(2.2 * GB, -3)
    // v1 names it total_inactive_file.
    expect(
      cgroupHeadroom(
        String(4 * GB),
        String(3 * GB),
        `total_inactive_file ${GB}`,
        'total_inactive_file'
      )
    ).toBe(2 * GB)
    // No limit → null; a stat without the line counts nothing as reclaimable.
    expect(cgroupHeadroom('max', '1', '', 'inactive_file')).toBeNull()
    expect(cgroupHeadroom(String(2 ** 62), '1', '', 'total_inactive_file')).toBeNull()
    expect(cgroupHeadroom(String(4 * GB), String(3 * GB), null, 'inactive_file')).toBe(GB)
  })

  it('where free memory cannot be read, steps start without the check (one warning), never refused (review N3)', async () => {
    process.env.FLOW_SCRIPT_MAX_WAIT_MS = '50'
    setHeadroomReaderForTests(async () => null)
    const log = quietLog()
    expect(await runIsolatedScript('data.ok = true', {}, log)).toEqual({ ok: true })
    expect(await runIsolatedScript('data.ok = 2', {}, log)).toEqual({ ok: 2 })
    expect(
      log.warn.mock.calls.filter((c) => String(c[0]).includes('Free memory cannot be read')).length
    ).toBeLessThanOrEqual(1)
  })

  it('a step waits for memory, then is refused when there is none; its slot is freed', async () => {
    process.env.FLOW_SCRIPT_MAX_WAIT_MS = '300'
    setHeadroomReaderForTests(async () => ({ bytes: 10 * 1024 * 1024, limited: true }))
    await expect(runIsolatedScript('return data', {}, quietLog())).rejects.toThrow(
      new ScriptBusyError(
        'Not enough free memory on this server to start a script step right now. Try again in a moment.'
      )
    )
    expect(scriptGateState()).toEqual({ active: 0, waiting: 0 })
  })

  it('starts as soon as the memory is there', async () => {
    process.env.FLOW_SCRIPT_MAX_WAIT_MS = '5000'
    let calls = 0
    setHeadroomReaderForTests(async () => ({
      bytes: ++calls < 3 ? 0 : 4 * 1024 * 1024 * 1024,
      limited: true
    }))
    expect(await runIsolatedScript('data.ok = true', {}, quietLog())).toEqual({ ok: true })
    expect(calls).toBe(3)
  })
})

describe('a dedicated app (one app per process)', () => {
  it('keeps binary types; its heap cap is FLOW_SCRIPT_MAX_MB (default 256) and 2 steps at once', async () => {
    expect(
      await runIsolatedScript(
        'const b = new Uint8Array(4); b[0] = 7; return { first: b[0], ab: typeof ArrayBuffer }',
        {},
        quietLog(),
        5000,
        { dedicated: true }
      )
    ).toEqual({ first: 7, ab: 'function' })
    for (const k of ENV_KEYS) delete process.env[k]
    expect(scriptLimits(true)).toEqual({ total: 2, perApp: 2, memoryMb: 256, maxWaitMs: 30_000 })
    process.env.FLOW_SCRIPT_MAX_MB = '4096'
    expect(scriptLimits(true).memoryMb).toBe(2048)
    process.env.FLOW_SCRIPT_MAX_MB = '10'
    expect(scriptLimits(true).memoryMb).toBe(256)
  })

  it('may use every slot (no per-app cap) and skips the memory check on a host without a container limit', async () => {
    process.env.FLOW_SCRIPT_CONCURRENCY = '3'
    process.env.FLOW_SCRIPT_PER_APP = '1'
    setHeadroomReaderForTests(async () => ({ bytes: 0, limited: false }))
    const runs = [0, 1, 2].map(() =>
      runIsolatedScript(busy(300), {}, quietLog(), 5000, { dedicated: true })
    )
    expect(scriptGateState()).toEqual({ active: 3, waiting: 0 })
    await Promise.all(runs)
  })
})

describe('a dedicated app under a container limit (review N6)', () => {
  it('starts a child only while its budget is at most half of the free memory', async () => {
    process.env.FLOW_SCRIPT_MAX_MB = '256'
    const MB = 1024 * 1024
    // Budget 256 + 96 MB: needs 704 MB free. 700 MB → waits; then 800 MB → starts.
    let calls = 0
    setHeadroomReaderForTests(async () => ({
      bytes: (++calls < 3 ? 700 : 800) * MB,
      limited: true
    }))
    expect(
      await runIsolatedScript('data.ok = true', {}, quietLog(), 5000, { dedicated: true })
    ).toEqual({ ok: true })
    expect(calls).toBe(3)
  })

  it('a flow that holds a record write waits at most 10 s, then is refused as busy (review N7)', async () => {
    expect(BLOCKING_WAIT_MS).toBe(10_000)
    setHeadroomReaderForTests(async () => ({ bytes: 0, limited: true }))
    const t = Date.now()
    await expect(
      runIsolatedScript('return data', {}, quietLog(), 5000, { dedicated: true, blocking: true })
    ).rejects.toBeInstanceOf(ScriptBusyError)
    const took = Date.now() - t
    expect(took).toBeGreaterThanOrEqual(9_500)
    expect(took).toBeLessThan(20_000)
    expect(scriptGateState()).toEqual({ active: 0, waiting: 0 })
  }, 40_000)

  it('a busy refusal carries 503 FLOW_SCRIPT_BUSY', () => {
    const e = new ScriptBusyError('x')
    expect(e).toBeInstanceOf(ScriptLimitError)
    expect([e.statusCode, e.code]).toEqual([503, 'FLOW_SCRIPT_BUSY'])
  })
})

describe('large input (review N5)', () => {
  it('60 MB of input runs, and is not reported as a timeout', async () => {
    process.env.FLOW_SCRIPT_MAX_MB = '1024'
    const blob = 'x'.repeat(60 * 1024 * 1024)
    const out = await runIsolatedScript(
      'return { n: data.blob.length }',
      { blob },
      quietLog(),
      1000,
      { dedicated: true }
    )
    expect(out).toEqual({ n: blob.length })
  }, 120_000)

  it('the input-transfer allowance grows with the input, capped at 60 s', () => {
    expect(transferAllowanceMs(0)).toBe(0)
    expect(transferAllowanceMs(60 * 1024 * 1024)).toBeGreaterThan(5_000)
    expect(transferAllowanceMs(10 ** 10)).toBe(60_000)
  })
})

describe('memory outside the V8 heap', () => {
  it('the script context has no binary types (their memory is off the heap)', async () => {
    const out = await runIsolatedScript(
      `data.seen = ${JSON.stringify(OFF_HEAP_GLOBALS)}.filter((k) => typeof globalThis[k] !== 'undefined')`,
      {},
      quietLog()
    )
    expect(out.seen).toEqual([])
  })

  it('a script allocating large ArrayBuffers fails cleanly', async () => {
    await expect(
      runIsolatedScript(
        'const keep = []; for (let i = 0; i < 64; i++) keep.push(new ArrayBuffer(256 * 1024 * 1024)); return data',
        {},
        quietLog()
      )
    ).rejects.toThrow('ArrayBuffer is not defined')
    expect(scriptGateState()).toEqual({ active: 0, waiting: 0 })
  })

  it('the RSS watch stops a process whose memory passes the limit outside V8', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'const b = Buffer.alloc(256 * 1024 * 1024, 1); setTimeout(() => b.length, 20000)'],
      { stdio: 'ignore' }
    )
    try {
      const over = await new Promise<boolean>((resolve) => {
        const stop = watchRss(child.pid as number, (64 + RSS_MARGIN_MB) * 1024 * 1024, () =>
          resolve(true)
        )
        setTimeout(() => {
          stop()
          resolve(false)
        }, 15_000)
      })
      expect(over).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  }, 20_000)

  it('reads the resident memory of a running process', async () => {
    expect(await readRssBytes(process.pid)).toBeGreaterThan(1024 * 1024)
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
