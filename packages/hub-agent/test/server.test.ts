import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AgentConfig, loadAgentConfig } from '../src/config.js'
import type { Transport } from '../src/engine.js'
import { isEntryPoint, startAgent } from '../src/main.js'
import { createServer, type Handlers } from '../src/server.js'

const TOKEN = 'Server-Token-0123456789-ABCDEFGHIJ-xyz'
const cfg: AgentConfig = loadAgentConfig(
  { HUB_AGENT_TOKEN_FILE: '/t', HUB_AGENT_EDGE: 'publish', HUB_AGENT_PUBLISH_PORTS: '3110-3119' },
  () => TOKEN
)

const HEALTH = {
  api: 1,
  agent_version: '0.1.0',
  engine_api: '1.45',
  swarm: { manager: true, node_id: 'n1' }
}

function makeHandlers(): Handlers & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    health: async () => ({ status: 200, body: HEALTH }),
    listStacks: async () => ({ status: 200, body: { data: [] } }),
    getStack: async (name, q) => {
      calls.push(['get', name, q])
      return { status: 200, body: { name } }
    },
    putStack: async (name, body) => {
      calls.push(['put', name, body])
      return { status: 202, body: { spec_hash: 'h', changed: [], unchanged: [] } }
    },
    restartStack: async (name, body) => {
      calls.push(['restart', name, body])
      return { status: 202, body: { services: [] } }
    },
    leftovers: async (name, q) => {
      calls.push(['leftovers', name, q])
      return { status: 200, body: {} }
    },
    deleteStack: async (name, q) => {
      calls.push(['delete', name, q])
      if (name === 'boom') throw new Error(`exploded with ${TOKEN}`)
      return { status: 200, body: { removed: {} } }
    }
  }
}

let server: http.Server
let v6: net.Server
let port = 0
let port6 = 0
let now = 1_000_000
let lines: Array<Record<string, unknown>> = []
let rawLog: string[] = []
let handlers: ReturnType<typeof makeHandlers>

beforeEach(async () => {
  now = 1_000_000
  lines = []
  rawLog = []
  handlers = makeHandlers()
  server = createServer(cfg, handlers, {
    now: () => now,
    log: (o) => {
      rawLog.push(JSON.stringify(o))
      lines.push(o as Record<string, unknown>)
    }
  }) as http.Server
  // Two client addresses: the server on 127.0.0.1, and a ::1 listener that hands its
  // connections to the same server. Both bind a specific address, so no other process
  // on this machine can answer in their place (a wildcard bind could lose to one).
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  v6 = net.createServer((socket) => server.emit('connection', socket))
  await new Promise<void>((r) => v6.listen(0, '::1', r))
  port6 = (v6.address() as AddressInfo).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((r) => v6.close(r))
  await new Promise((r) => server.close(r))
})

type Res = { status: number; body: any }

function req(
  method: string,
  path: string,
  opts: {
    token?: string | null
    body?: string | Buffer
    from?: '127.0.0.1' | '::1'
    chunked?: boolean
    auth?: string
  } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (opts.auth) headers.authorization = opts.auth
    else if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`
    if (opts.body !== undefined && !opts.chunked)
      headers['content-length'] = String(Buffer.byteLength(opts.body))
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const from = opts.from ?? '127.0.0.1'
    const r = http.request(
      {
        host: from,
        port: from === '::1' ? port6 : port,
        method,
        path,
        headers,
        localAddress: from
      },
      (res) => {
        let data = ''
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => {
          let body: unknown = data
          try {
            body = JSON.parse(data)
          } catch {}
          resolve({ status: res.statusCode ?? 0, body })
        })
      }
    )
    r.on('error', (err: NodeJS.ErrnoException) => {
      // The server may cut an over-long upload; the answer was already read.
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return
      reject(err)
    })
    if (opts.body !== undefined) r.write(opts.body)
    r.end()
  })
}

describe('auth', () => {
  it('no bearer, a wrong bearer or another scheme → 401', async () => {
    for (const o of [
      { token: null },
      { token: 'wrong' },
      { token: `${TOKEN}x` },
      { auth: `Basic ${TOKEN}` }
    ]) {
      const r = await req('GET', '/v1/health', o)
      expect(r.status).toBe(401)
      expect(r.body).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' })
    }
  })

  it('auth comes before routing: an unknown route without a token is 401', async () => {
    expect((await req('GET', '/v1/nope', { token: null })).status).toBe(401)
  })

  it('the 21st bad token from one address within 60 s → 429; another address still works', async () => {
    for (let i = 0; i < 20; i++) {
      now += 1000
      expect((await req('GET', '/v1/health', { token: `bad-${i}` })).status).toBe(401)
    }
    now += 1000
    const r21 = await req('GET', '/v1/health', { token: 'bad-21' })
    expect(r21.status).toBe(429)
    expect(r21.body.code).toBe('TOO_MANY_BAD_TOKENS')
    // Further bad tokens stay locked; the right token is checked first and is never locked out.
    expect((await req('GET', '/v1/health', { token: 'bad-22' })).status).toBe(429)
    expect((await req('GET', '/v1/health')).status).toBe(200)
    expect((await req('GET', '/v1/health', { token: 'bad-23' })).status).toBe(429)
    // Another address is unaffected: its bad token is a plain 401.
    expect((await req('GET', '/v1/health', { from: '::1', token: 'bad' })).status).toBe(401)
    expect((await req('GET', '/v1/health', { from: '::1' })).status).toBe(200)
    // Once the bad tokens are older than 60 s, a bad token is a 401 again.
    now += 61_000
    expect((await req('GET', '/v1/health', { token: 'bad-24' })).status).toBe(401)
  })

  it('bad tokens spread over more than 60 s never lock', async () => {
    for (let i = 0; i < 40; i++) {
      now += 4000
      expect((await req('GET', '/v1/health', { token: 'bad' })).status).toBe(401)
    }
  })
})

describe('routing', () => {
  it('passes the health answer through', async () => {
    const r = await req('GET', '/v1/health')
    expect(r).toEqual({ status: 200, body: HEALTH })
  })

  it('unknown route → 404 NOT_FOUND; known path, wrong method → 405', async () => {
    const r = await req('GET', '/v1/nope')
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Not found', code: 'NOT_FOUND' })
    expect((await req('POST', '/v1/health')).status).toBe(405)
  })

  it('routes every stack call with its parameters', async () => {
    expect((await req('GET', '/v1/stacks')).status).toBe(200)
    expect((await req('GET', '/v1/stacks/acme-prod?expect=abc')).status).toBe(200)
    const put = await req('PUT', '/v1/stacks/acme-prod', { body: '{"environment":"prod"}' })
    expect(put.status).toBe(202)
    expect(
      (await req('POST', '/v1/stacks/acme-prod/restart', { body: '{"environment":"prod"}' })).status
    ).toBe(202)
    expect((await req('POST', '/v1/stacks/acme-prod/restart')).status).toBe(400)
    expect(
      (
        await req(
          'DELETE',
          '/v1/stacks/acme-prod?confirm=acme-prod&remove_volumes=1&app=acme&environment=prod'
        )
      ).status
    ).toBe(200)
    expect((await req('DELETE', '/v1/stacks/acme-prod')).status).toBe(200)
    expect(
      (await req('GET', '/v1/stacks/acme-prod/leftovers?app=acme&environment=prod')).status
    ).toBe(200)
    expect((await req('POST', '/v1/stacks/acme-prod/leftovers')).status).toBe(405)
    expect(handlers.calls).toEqual([
      ['get', 'acme-prod', { expect: 'abc' }],
      ['put', 'acme-prod', { environment: 'prod' }],
      ['restart', 'acme-prod', { environment: 'prod' }],
      [
        'delete',
        'acme-prod',
        {
          confirm: 'acme-prod',
          removeVolumes: true,
          app: 'acme',
          shared: null,
          environment: 'prod'
        }
      ],
      [
        'delete',
        'acme-prod',
        { confirm: null, removeVolumes: false, app: null, shared: null, environment: null }
      ],
      ['leftovers', 'acme-prod', { app: 'acme', shared: null, environment: 'prod' }]
    ])
  })

  it('a stack name outside the name rule → 400 and no handler call', async () => {
    for (const p of [
      '/v1/stacks/Acme',
      '/v1/stacks/a',
      '/v1/stacks/a%2Fb',
      '/v1/stacks/9abc',
      `/v1/stacks/${'a'.repeat(42)}`
    ]) {
      const r = await req('GET', p)
      expect(r.status, p).toBe(400)
      expect(r.body.code).toBe('STACK_NAME_INVALID')
    }
    expect(handlers.calls).toEqual([])
  })

  it('bad JSON → 400 BAD_JSON', async () => {
    const r = await req('PUT', '/v1/stacks/acme-prod', { body: '{nope' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('BAD_JSON')
    expect(handlers.calls).toEqual([])
  })

  it('a body over 1 MB → 413, with or without a length', async () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 0x61)
    const r1 = await req('PUT', '/v1/stacks/acme-prod', { body: big })
    expect(r1.status).toBe(413)
    expect(r1.body.code).toBe('PAYLOAD_TOO_LARGE')
    const r2 = await req('PUT', '/v1/stacks/acme-prod', { body: big, chunked: true })
    expect(r2.status).toBe(413)
    expect(handlers.calls).toEqual([])
    // Exactly 1 MB is fine as far as the size goes (it is not JSON, so 400).
    const r3 = await req('PUT', '/v1/stacks/acme-prod', { body: Buffer.alloc(1024 * 1024, 0x61) })
    expect(r3.status).toBe(400)
  })

  it('a handler that throws → 500 INTERNAL, no message', async () => {
    const r = await req('DELETE', '/v1/stacks/boom?confirm=boom')
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal error', code: 'INTERNAL' })
    expect(JSON.stringify(r.body)).not.toContain(TOKEN)
  })
})

describe('request log', () => {
  it('one line per request with a template route, never the token, header names, bodies or query values', async () => {
    await req('GET', '/v1/health')
    await req('GET', '/v1/health', { token: 'bad-token-value' })
    await req('GET', '/v1/stacks/acme-prod?expect=SECRETHASH')
    await req('PUT', '/v1/stacks/acme-prod', {
      body: '{"secrets":{"DB_PASSWORD":"hunter2-value"}}'
    })
    await req('DELETE', '/v1/stacks/boom?confirm=boom')
    await req('GET', '/v1/stacks/Bad_Name')
    await req('GET', '/v1/elsewhere?x=QUERYVALUE')
    expect(lines).toHaveLength(7)
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(['method', 'ms', 'route', 'stack', 'status', 't'])
      expect(typeof l.ms).toBe('number')
    }
    expect(lines.map((l) => l.route)).toEqual([
      '/v1/health',
      '/v1/health',
      '/v1/stacks/:name',
      '/v1/stacks/:name',
      '/v1/stacks/:name',
      '/v1/stacks/:name',
      'unknown'
    ])
    expect(lines.map((l) => l.stack)).toEqual([
      null,
      null,
      'acme-prod',
      'acme-prod',
      'boom',
      null,
      null
    ])
    expect(lines.map((l) => l.status)).toEqual([200, 401, 200, 202, 500, 400, 404])
    const all = rawLog.join('\n')
    for (const needle of [
      TOKEN,
      'bad-token-value',
      'authorization',
      'Bearer',
      'hunter2',
      'DB_PASSWORD',
      'SECRETHASH',
      'QUERYVALUE',
      'Bad_Name',
      'exploded'
    ]) {
      expect(all).not.toContain(needle)
    }
  })
})

describe('startAgent', () => {
  const env = {
    HUB_AGENT_TOKEN_FILE: '/t',
    HUB_AGENT_EDGE: 'publish',
    HUB_AGENT_PUBLISH_PORTS: '3110-3119',
    HUB_AGENT_LISTEN: '127.0.0.1:0'
  }

  function fakeEngine(version: string, controlAvailable: boolean) {
    const stub = http.createServer((rq, rs) => {
      rs.writeHead(200, { 'content-type': 'application/json' })
      if (rq.url === '/v1.44/version') rs.end(JSON.stringify({ ApiVersion: version }))
      else if (rq.url === '/v1.44/info')
        rs.end(JSON.stringify({ Swarm: { ControlAvailable: controlAvailable, NodeID: 'node-1' } }))
      else rs.end('{}')
    })
    return stub
  }

  async function withEngine<T>(
    version: string,
    manager: boolean,
    fn: (t: Transport) => Promise<T>
  ) {
    const stub = fakeEngine(version, manager)
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
    const p = (stub.address() as AddressInfo).port
    const t: Transport = (o, cb) =>
      http.request({ ...o, socketPath: undefined, host: '127.0.0.1', port: p }, cb)
    try {
      return await fn(t)
    } finally {
      await new Promise((r) => stub.close(r))
    }
  }

  it('exits with the config code only', async () => {
    const r = await startAgent({
      env: { ...env, HUB_AGENT_TOKEN_FILE: '' },
      readFile: () => TOKEN,
      log: () => {}
    })
    expect(r).toEqual({ ok: false, code: 'TOKEN_MISSING' })
  })

  it('refuses an engine older than API 1.44', async () => {
    const r = await withEngine('1.43', true, (transport) =>
      startAgent({ env, readFile: () => TOKEN, transport, log: () => {} })
    )
    expect(r).toEqual({ ok: false, code: 'ENGINE_TOO_OLD' })
  })

  it('refuses a node that is not a swarm manager', async () => {
    const r = await withEngine('1.45', false, (transport) =>
      startAgent({ env, readFile: () => TOKEN, transport, log: () => {} })
    )
    expect(r).toEqual({ ok: false, code: 'NOT_A_MANAGER' })
  })

  it('serves health on a manager', async () => {
    const log = vi.fn()
    await withEngine('1.45', true, async (transport) => {
      const r = await startAgent({ env, readFile: () => TOKEN, transport, log })
      if (!r.ok) throw new Error(r.code)
      try {
        const p = (r.server.address() as AddressInfo).port
        const res = await fetch(`http://127.0.0.1:${p}/v1/health`, {
          headers: { authorization: `Bearer ${TOKEN}` }
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
          api: 1,
          engine_api: '1.45',
          swarm: { manager: true, node_id: 'node-1' },
          images: ['nodeworks/nivaro'],
          host_suffixes: [],
          edge: 'publish',
          publish_ports: [3110, 3119],
          extensions_shared: false,
          redis_bundled: false
        })
      } finally {
        await new Promise((res) => r.server.close(res))
      }
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
  })
})

describe('isEntryPoint', () => {
  it('matches the real path, a symlink and a name without .js; nothing else', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agent-entry-')))
    try {
      const file = path.join(dir, 'main.js')
      fs.writeFileSync(file, '')
      fs.symlinkSync(file, path.join(dir, 'link.js'))
      const url = pathToFileURL(file).href
      expect(isEntryPoint(file, url)).toBe(true)
      expect(isEntryPoint(path.join(dir, 'link.js'), url)).toBe(true)
      expect(isEntryPoint(path.join(dir, 'main'), url)).toBe(true)
      expect(isEntryPoint(path.join(dir, 'other.js'), url)).toBe(false)
      expect(isEntryPoint(undefined, url)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
