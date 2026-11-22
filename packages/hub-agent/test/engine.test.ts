import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AgentConfig, loadAgentConfig } from '../src/config.js'
import {
  createEngine,
  ENGINE_ALLOWED,
  EngineForbiddenError,
  type Transport
} from '../src/engine.js'

const D = 'b'.repeat(64)
const IMAGE = `nodeworks/nivaro@sha256:${D}`
const REDIS = `redis@sha256:${'c'.repeat(64)}`

const cfg: AgentConfig = loadAgentConfig(
  {
    HUB_AGENT_TOKEN_FILE: '/t',
    HUB_AGENT_EDGE_NETWORK: 'edge',
    HUB_AGENT_HOST_SUFFIXES: '.apps.corp',
    HUB_AGENT_REDIS_IMAGE: REDIS,
    HUB_AGENT_EXTENSIONS_HOST_ROOT: '/srv/ext'
  },
  () => 'k'.repeat(40)
)

// The fake Engine: an HTTP stub on a loopback port. Never the host's real Docker socket.
type Seen = { method: string; url: string; body: string; headers: http.IncomingHttpHeaders }
const seen: Seen[] = []
let stub: http.Server
let port = 0

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body, headers: req.headers })
      if (req.url?.includes('/archive')) {
        res.writeHead(200, { 'content-type': 'application/x-tar' })
        res.end(Buffer.from('TARBYTES'))
        return
      }
      if (req.url?.startsWith('/v1.44/services/missing')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"message":"service missing not found"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, url: req.url }))
    })
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  port = (stub.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise((r) => stub.close(r))
})

function spyTransport() {
  const fn = vi.fn<Transport>((options, onResponse) =>
    http.request({ ...options, socketPath: undefined, host: '127.0.0.1', port }, onResponse)
  )
  return fn
}

let transport: ReturnType<typeof spyTransport>
beforeEach(() => {
  seen.length = 0
  transport = spyTransport()
})

const service = (extra: Record<string, unknown> = {}) => ({
  Name: 's_web',
  TaskTemplate: {
    ContainerSpec: {
      Image: IMAGE,
      Mounts: [
        { Type: 'volume', Source: 'nvh_s_uploads', Target: '/app/uploads' },
        {
          Type: 'bind',
          Source: '/srv/ext/s/efp-ops@abc',
          Target: '/app/api/extensions/efp-ops',
          ReadOnly: true
        }
      ],
      ...extra
    },
    Networks: [{ Target: 's_net' }]
  }
})

const ALLOWED_CALLS: Array<[string, string, Record<string, unknown>?]> = [
  ['GET', '/version'],
  ['GET', '/info'],
  ['GET', '/services', { query: { filters: '{"label":["nivaro.hub.managed=1"]}' } }],
  ['GET', '/services/abc123'],
  ['GET', '/tasks'],
  ['GET', '/networks'],
  ['GET', '/secrets'],
  ['GET', '/volumes'],
  ['GET', `/images/${IMAGE}/json`],
  ['GET', '/containers/abc123/archive', { query: { path: '/extension' } }],
  ['POST', '/services/create', { body: service(), headers: { 'X-Registry-Auth': 'e30=' } }],
  ['POST', '/services/abc123/update', { body: service(), query: { version: 7 } }],
  ['POST', '/networks/create', { body: { Name: 's_net', Driver: 'overlay' } }],
  ['POST', '/secrets/create', { body: { Name: 'nvh_s_X_0123456789ab', Data: 'eA==' } }],
  ['POST', '/volumes/create', { body: { Name: 'nvh_s_uploads' } }],
  ['POST', '/images/create', { query: { fromImage: IMAGE } }],
  ['POST', '/containers/create', { body: { Image: IMAGE, Labels: { 'nivaro.hub.managed': '1' } } }],
  ['DELETE', '/services/abc123'],
  ['DELETE', '/secrets/abc123'],
  ['DELETE', '/networks/abc123'],
  ['DELETE', '/volumes/nvh_s_uploads'],
  ['DELETE', '/containers/abc123', { query: { force: true } }]
]

describe('engine allow-list', () => {
  it('lists exactly the planned method + path pairs', () => {
    expect(ENGINE_ALLOWED.length).toBe(22)
    expect(new Set(ENGINE_ALLOWED.map(([m]) => m))).toEqual(new Set(['GET', 'POST', 'DELETE']))
  })

  it.each(ALLOWED_CALLS)('%s %s reaches the transport under /v1.44', async (method, path, opts) => {
    const engine = createEngine(cfg, transport)
    const r = await engine.call(method as 'GET', path, opts as never)
    expect(r.status).toBe(200)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe(method)
    expect(seen[0].url.startsWith(`/v1.44${path}`)).toBe(true)
    // The default transport speaks to the configured unix socket.
    expect(transport.mock.calls[0][0].socketPath).toBe('/var/run/docker.sock')
  })

  const FORBIDDEN: Array<[string, string]> = [
    ['POST', '/containers/abc/start'],
    ['POST', '/containers/abc/exec'],
    ['POST', '/containers/abc/attach'],
    ['GET', '/containers/abc/logs'],
    ['GET', '/services/abc/logs'],
    ['POST', '/build'],
    ['POST', '/commit'],
    ['GET', '/swarm'],
    ['POST', '/swarm/init'],
    ['POST', '/nodes/x/update'],
    ['GET', '/nodes'],
    ['POST', '/plugins/pull'],
    ['DELETE', '/images/x'],
    ['POST', '/images/x/push'],
    ['GET', '/configs'],
    ['PUT', '/containers/abc/archive'],
    ['POST', '/services/abc'],
    ['GET', '/containers/json'],
    ['POST', '/exec/abc/start'],
    ['GET', '/v1.44/version'],
    ['GET', '/services/../swarm'],
    ['GET', '/services/abc/../../swarm'],
    ['GET', '/services/./abc'],
    ['GET', '/services/%2e%2e/swarm'],
    ['GET', '/services//abc'],
    ['GET', '/services/abc/'],
    ['GET', '/images/../swarm/json'],
    ['GET', '/services/abc?x=1'],
    ['GET', '/services/abc#x'],
    ['GET', 'services'],
    ['GET', '/services\\..\\swarm'],
    ['DELETE', '/volumes/a b']
  ]

  it.each(
    FORBIDDEN
  )('%s %s throws EngineForbiddenError and never reaches the transport', async (method, path) => {
    const engine = createEngine(cfg, transport)
    await expect(engine.call(method as 'GET', path)).rejects.toBeInstanceOf(EngineForbiddenError)
    await expect(engine.stream(method as 'GET', path)).rejects.toBeInstanceOf(EngineForbiddenError)
    expect(transport).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })

  it('throws synchronously-checked errors before any I/O even with a bad transport', async () => {
    const boom = vi.fn<Transport>(() => {
      throw new Error('transport must not be called')
    })
    const engine = createEngine(cfg, boom)
    await expect(engine.call('POST', '/containers/abc/start')).rejects.toBeInstanceOf(
      EngineForbiddenError
    )
    expect(boom).not.toHaveBeenCalled()
  })
})

describe('engine body guards (defence in depth)', () => {
  const cases: Array<[string, string, string, Record<string, unknown>]> = [
    [
      'service with Privileges',
      'POST',
      '/services/create',
      { body: service({ Privileges: { NoNewPrivileges: false } }) }
    ],
    [
      'service with CapabilityAdd',
      'POST',
      '/services/create',
      { body: service({ CapabilityAdd: ['SYS_ADMIN'] }) }
    ],
    [
      'service with Sysctls',
      'POST',
      '/services/abc/update',
      { body: service({ Sysctls: { 'net.ipv4.ip_forward': '1' } }) }
    ],
    [
      'service bind mount outside the extension root',
      'POST',
      '/services/create',
      {
        body: service({
          Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/x', ReadOnly: true }]
        })
      }
    ],
    [
      'service bind mount escaping the root',
      'POST',
      '/services/create',
      {
        body: service({
          Mounts: [{ Type: 'bind', Source: '/srv/ext/../../etc', Target: '/x', ReadOnly: true }]
        })
      }
    ],
    [
      'writable extension bind mount',
      'POST',
      '/services/create',
      { body: service({ Mounts: [{ Type: 'bind', Source: '/srv/ext/s/a', Target: '/x' }] }) }
    ],
    [
      'service image outside the allow-list',
      'POST',
      '/services/create',
      { body: service({ Image: `evil/nivaro@sha256:${D}` }) }
    ],
    [
      'service image not pinned',
      'POST',
      '/services/create',
      { body: service({ Image: 'nodeworks/nivaro:0.3.208' }) }
    ],
    [
      'service on the host network',
      'POST',
      '/services/create',
      {
        body: {
          ...service(),
          TaskTemplate: { ...service().TaskTemplate, Networks: [{ Target: 'host' }] }
        }
      }
    ],
    [
      'container with a HostConfig',
      'POST',
      '/containers/create',
      { body: { Image: IMAGE, HostConfig: { Privileged: true } } }
    ],
    [
      'container with binds',
      'POST',
      '/containers/create',
      { body: { Image: IMAGE, HostConfig: { Binds: ['/:/host'] } } }
    ],
    [
      'container image outside the allow-list',
      'POST',
      '/containers/create',
      { body: { Image: 'alpine' } }
    ],
    [
      'pull outside the allow-list',
      'POST',
      '/images/create',
      { query: { fromImage: 'evil/thing', tag: 'latest' } }
    ],
    [
      'pull by tag',
      'POST',
      '/images/create',
      { query: { fromImage: 'nodeworks/nivaro', tag: '0.3.208' } }
    ],
    ['pull with no image', 'POST', '/images/create', {}],
    ['a body on a GET', 'GET', '/services', { body: { a: 1 } }],
    ['a non-object POST body', 'POST', '/networks/create', { body: 'x' }],
    ['an unknown header', 'GET', '/version', { headers: { Host: 'evil' } }]
  ]

  it.each(cases)('%s is refused before any I/O', async (_name, method, path, opts) => {
    const engine = createEngine(cfg, transport)
    await expect(engine.call(method as 'GET', path, opts as never)).rejects.toBeInstanceOf(
      EngineForbiddenError
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('accepts the configured redis image and a digest pull given as tag', async () => {
    const engine = createEngine(cfg, transport)
    await engine.call('POST', '/services/create', { body: service({ Image: REDIS, Mounts: [] }) })
    await engine.call('POST', '/images/create', {
      query: { fromImage: 'nodeworks/nivaro', tag: `sha256:${D}` }
    })
    expect(seen).toHaveLength(2)
  })
})

describe('engine I/O', () => {
  it('encodes the query and sends the JSON body', async () => {
    const engine = createEngine(cfg, transport)
    await engine.call('POST', '/secrets/create', {
      body: { Name: 'n', Data: 'eA==' },
      query: { a: 'x&y=z', b: 2 }
    })
    expect(seen[0].url).toBe('/v1.44/secrets/create?a=x%26y%3Dz&b=2')
    expect(JSON.parse(seen[0].body)).toEqual({ Name: 'n', Data: 'eA==' })
    expect(seen[0].headers['content-type']).toBe('application/json')
  })

  it('passes a non-2xx status and body through', async () => {
    const engine = createEngine(cfg, transport)
    const r = await engine.call<{ message: string }>('GET', '/services/missing')
    expect(r).toEqual({ status: 404, body: { message: 'service missing not found' } })
  })

  it('streams the archive of a container', async () => {
    const engine = createEngine(cfg, transport)
    const r = await engine.stream('GET', '/containers/abc/archive', {
      query: { path: '/extension' }
    })
    expect(r.status).toBe(200)
    const chunks: Buffer[] = []
    for await (const c of r.stream) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('TARBYTES')
  })

  it('reports an unreachable engine with a code', async () => {
    const engine = createEngine({ ...cfg, socket: '/nonexistent/docker.sock' })
    await expect(engine.call('GET', '/version')).rejects.toMatchObject({
      code: 'ENGINE_UNREACHABLE'
    })
  })
})
