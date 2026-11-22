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
  () => 'agent-token-0123456789-abcdefghij'
)

const publishCfg: AgentConfig = loadAgentConfig(
  { HUB_AGENT_TOKEN_FILE: '/t', HUB_AGENT_EDGE: 'publish', HUB_AGENT_PUBLISH_PORTS: '3110-3119' },
  () => 'agent-token-0123456789-abcdefghij'
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
    Networks: [{ Target: 'nvh_s_net' }, { Target: 'edge' }]
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
  [
    'POST',
    '/networks/create',
    { body: { Name: 'nvh_s_net', Driver: 'overlay', Attachable: false } }
  ],
  ['POST', '/secrets/create', { body: { Name: 'nvh_s_X_0123456789ab', Data: 'eA==' } }],
  ['POST', '/volumes/create', { body: { Name: 'nvh_s_uploads', Driver: 'local' } }],
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
    await engine.call('GET', '/tasks', { query: { filters: '{"label":["a&b=c"]}' } })
    expect(seen[0].url).toBe('/v1.44/tasks?filters=%7B%22label%22%3A%5B%22a%26b%3Dc%22%5D%7D')
    await engine.call('POST', '/secrets/create', { body: { Name: 'nvh_s_X_0123', Data: 'eA==' } })
    expect(seen[1].url).toBe('/v1.44/secrets/create')
    expect(JSON.parse(seen[1].body)).toEqual({ Name: 'nvh_s_X_0123', Data: 'eA==' })
    expect(seen[1].headers['content-type']).toBe('application/json')
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

describe('fix round 1: query allow-lists', () => {
  const Q: Array<[string, string, string, Record<string, unknown>]> = [
    [
      'service update with rollback=previous',
      'POST',
      '/services/abc/update',
      { body: service(), query: { version: 3, rollback: 'previous' } }
    ],
    [
      'service update with a non-integer version',
      'POST',
      '/services/abc/update',
      { body: service(), query: { version: '3; x' } }
    ],
    [
      'service update with a negative version',
      'POST',
      '/services/abc/update',
      { body: service(), query: { version: -1 } }
    ],
    [
      'service update with registryAuthFrom=bogus',
      'POST',
      '/services/abc/update',
      { body: service(), query: { registryAuthFrom: 'bogus' } }
    ],
    [
      'archive of /run/secrets',
      'GET',
      '/containers/abc/archive',
      { query: { path: '/run/secrets' } }
    ],
    [
      'archive of /extension/../run',
      'GET',
      '/containers/abc/archive',
      { query: { path: '/extension/../run' } }
    ],
    ['archive of /', 'GET', '/containers/abc/archive', { query: { path: '/' } }],
    [
      'archive with an extra key',
      'GET',
      '/containers/abc/archive',
      { query: { path: '/extension', noOverwriteDirNonDir: true } }
    ],
    ['container delete with v', 'DELETE', '/containers/abc', { query: { force: true, v: true } }],
    [
      'container delete with force=garbage',
      'DELETE',
      '/containers/abc',
      { query: { force: 'yes please' } }
    ],
    ['volume delete with force', 'DELETE', '/volumes/nvh_s_uploads', { query: { force: true } }],
    [
      'image pull with platform',
      'POST',
      '/images/create',
      { query: { fromImage: `nodeworks/nivaro@sha256:${D}`, platform: 'linux/amd64' } }
    ],
    [
      'image pull with repo',
      'POST',
      '/images/create',
      { query: { fromImage: `nodeworks/nivaro@sha256:${D}`, repo: 'x' } }
    ],
    ['service list with status', 'GET', '/services', { query: { status: true } }],
    ['task list with an extra key', 'GET', '/tasks', { query: { filters: '{}', x: 1 } }],
    [
      'service inspect with insertDefaults',
      'GET',
      '/services/abc',
      { query: { insertDefaults: true } }
    ],
    ['version with a query', 'GET', '/version', { query: { x: 1 } }],
    ['service delete with a query', 'DELETE', '/services/abc', { query: { force: true } }],
    [
      'service create with a query',
      'POST',
      '/services/create',
      { body: service(), query: { x: 'y' } }
    ],
    ['a __proto__ query key', 'GET', '/services', { query: JSON.parse('{"__proto__":"x"}') }],
    ['a constructor query key', 'GET', '/services', { query: { constructor: 'x' } }]
  ]

  it.each(Q)('%s is refused before any I/O', async (_name, method, path, opts) => {
    const engine = createEngine(cfg, transport)
    await expect(engine.call(method as 'GET', path, opts as never)).rejects.toBeInstanceOf(
      EngineForbiddenError
    )
    await expect(engine.stream(method as 'GET', path, opts as never)).rejects.toBeInstanceOf(
      EngineForbiddenError
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('accepts the queries the rules name', async () => {
    const engine = createEngine(cfg, transport)
    await engine.call('POST', '/services/abc/update', {
      body: service(),
      query: { version: '12', registryAuthFrom: 'spec' }
    })
    await engine.call('DELETE', '/containers/abc', { query: { force: true } })
    await engine.call('DELETE', '/containers/abc')
    await engine.call('GET', '/services', { query: { filters: '{}', other: undefined } })
    expect(seen.map((x) => x.url)).toEqual([
      '/v1.44/services/abc/update?version=12&registryAuthFrom=spec',
      '/v1.44/containers/abc?force=true',
      '/v1.44/containers/abc',
      '/v1.44/services?filters=%7B%7D'
    ])
  })
})

describe('fix round 1: volumes, networks, secrets, runtimes, ports, headers', () => {
  const withMount = (m: Record<string, unknown>) => service({ Mounts: [m] })
  const withTask = (extra: Record<string, unknown>) => ({
    ...service(),
    TaskTemplate: { ...service().TaskTemplate, ...extra }
  })
  const B: Array<[string, string, string, Record<string, unknown>]> = [
    [
      'volume mount with a bind DriverConfig',
      'POST',
      '/services/create',
      {
        body: withMount({
          Type: 'volume',
          Source: 'nvh_s_x',
          Target: '/x',
          VolumeOptions: {
            DriverConfig: { Name: 'local', Options: { type: 'none', o: 'bind', device: '/' } }
          }
        })
      }
    ],
    [
      'volume mount with any DriverConfig',
      'POST',
      '/services/abc/update',
      {
        body: withMount({
          Type: 'volume',
          Source: 'nvh_s_x',
          Target: '/x',
          VolumeOptions: { DriverConfig: { Name: 'nfs' } }
        })
      }
    ],
    [
      'volume mount of a foreign volume',
      'POST',
      '/services/create',
      { body: withMount({ Type: 'volume', Source: 'efp_uploads', Target: '/x' }) }
    ],
    [
      'volume create with bind DriverOpts',
      'POST',
      '/volumes/create',
      {
        body: {
          Name: 'nvh_s_x',
          Driver: 'local',
          DriverOpts: { type: 'none', o: 'bind', device: '/' }
        }
      }
    ],
    [
      'volume create with another driver',
      'POST',
      '/volumes/create',
      { body: { Name: 'nvh_s_x', Driver: 'nfs' } }
    ],
    ['volume create with no driver', 'POST', '/volumes/create', { body: { Name: 'nvh_s_x' } }],
    [
      'volume create without the nvh_ prefix',
      'POST',
      '/volumes/create',
      { body: { Name: 'efp_uploads', Driver: 'local' } }
    ],
    [
      'volume create with a cluster spec',
      'POST',
      '/volumes/create',
      { body: { Name: 'nvh_s_x', Driver: 'local', ClusterVolumeSpec: {} } }
    ],
    [
      'service on a network named by id',
      'POST',
      '/services/create',
      { body: withTask({ Networks: [{ Target: 'abc123def456' }] }) }
    ],
    [
      'service on the host network',
      'POST',
      '/services/create',
      { body: withTask({ Networks: [{ Target: 'host' }] }) }
    ],
    [
      'service on ingress',
      'POST',
      '/services/create',
      { body: withTask({ Networks: [{ Target: 'ingress' }] }) }
    ],
    [
      'service with top-level Networks not ours',
      'POST',
      '/services/create',
      { body: { ...service(), Networks: [{ Target: 'efp_default' }] } }
    ],
    [
      'network create with the bridge driver',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s_net', Driver: 'bridge' } }
    ],
    ['network create with no driver', 'POST', '/networks/create', { body: { Name: 'nvh_s_net' } }],
    [
      'network create with Ingress',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s_net', Driver: 'overlay', Ingress: true } }
    ],
    [
      'network create with ConfigFrom',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s_net', Driver: 'overlay', ConfigFrom: { Network: 'x' } } }
    ],
    [
      'network create with ConfigOnly',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s_net', Driver: 'overlay', ConfigOnly: true } }
    ],
    [
      'network create without the nvh_ prefix',
      'POST',
      '/networks/create',
      { body: { Name: 'efp_net', Driver: 'overlay' } }
    ],
    [
      'service with Runtime plugin',
      'POST',
      '/services/create',
      { body: withTask({ Runtime: 'plugin' }) }
    ],
    [
      'service with a PluginSpec',
      'POST',
      '/services/create',
      { body: withTask({ PluginSpec: { Name: 'x' } }) }
    ],
    [
      'bind mount with Propagation',
      'POST',
      '/services/create',
      {
        body: withMount({
          Type: 'bind',
          Source: '/srv/ext/s/a',
          Target: '/x',
          ReadOnly: true,
          BindOptions: { Propagation: 'rshared' }
        })
      }
    ],
    [
      'bind mount with ReadOnlyNonRecursive',
      'POST',
      '/services/create',
      {
        body: withMount({
          Type: 'bind',
          Source: '/srv/ext/s/a',
          Target: '/x',
          ReadOnly: true,
          BindOptions: { ReadOnlyNonRecursive: true }
        })
      }
    ],
    [
      'published port in traefik mode',
      'POST',
      '/services/create',
      {
        body: { ...service(), EndpointSpec: { Ports: [{ TargetPort: 3055, PublishedPort: 3110 }] } }
      }
    ],
    [
      'secret create with a Driver',
      'POST',
      '/secrets/create',
      { body: { Name: 'nvh_s_X_1', Data: 'eA==', Driver: { Name: 'vault' } } }
    ],
    [
      'secret create with Templating',
      'POST',
      '/secrets/create',
      { body: { Name: 'nvh_s_X_1', Data: 'eA==', Templating: { Name: 'golang' } } }
    ],
    [
      'secret create without the nvh_ prefix',
      'POST',
      '/secrets/create',
      { body: { Name: 'efp_db', Data: 'eA==' } }
    ],
    ['X-Registry-Auth on /version', 'GET', '/version', { headers: { 'X-Registry-Auth': 'e30=' } }],
    [
      'X-Registry-Auth on /networks/create',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s_net', Driver: 'overlay' }, headers: { 'X-Registry-Auth': 'e30=' } }
    ],
    [
      'X-Registry-Auth on /containers/create',
      'POST',
      '/containers/create',
      { body: { Image: IMAGE }, headers: { 'x-registry-auth': 'e30=' } }
    ]
  ]

  it.each(B)('%s is refused before any I/O', async (_name, method, path, opts) => {
    const engine = createEngine(cfg, transport)
    await expect(engine.call(method as 'GET', path, opts as never)).rejects.toBeInstanceOf(
      EngineForbiddenError
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('publish mode: a port inside the range passes, outside or unpinned is refused', async () => {
    const engine = createEngine(publishCfg, transport)
    const base = service({
      Mounts: [{ Type: 'volume', Source: 'nvh_s_uploads', Target: '/app/uploads' }]
    })
    const ok = {
      ...base,
      TaskTemplate: { ...base.TaskTemplate, Networks: [{ Target: 'nvh_s_net' }] }
    }
    await engine.call('POST', '/services/create', {
      body: { ...ok, EndpointSpec: { Ports: [{ TargetPort: 3055, PublishedPort: 3115 }] } }
    })
    expect(seen).toHaveLength(1)
    for (const port of [
      { TargetPort: 3055, PublishedPort: 3120 },
      { TargetPort: 3055, PublishedPort: 22 },
      { TargetPort: 3055 },
      { TargetPort: 3055, PublishedPort: 3115, Protocol: 'udp' }
    ]) {
      await expect(
        engine.call('POST', '/services/create', {
          body: { ...ok, EndpointSpec: { Ports: [port] } }
        })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
    // The edge network does not exist in publish mode, so it is not an allowed target there.
    await expect(
      engine.call('POST', '/services/create', {
        body: { ...ok, TaskTemplate: { ...ok.TaskTemplate, Networks: [{ Target: 'edge' }] } }
      })
    ).rejects.toBeInstanceOf(EngineForbiddenError)
    expect(seen).toHaveLength(1)
  })

  it('accepts runtime container, a plain bind with no options and a volume with only Labels', async () => {
    const engine = createEngine(cfg, transport)
    const t = service({
      Mounts: [
        {
          Type: 'volume',
          Source: 'nvh_s_uploads',
          Target: '/app/uploads',
          VolumeOptions: { Labels: { a: 'b' } }
        },
        {
          Type: 'bind',
          Source: '/srv/ext/s/a',
          Target: '/x',
          ReadOnly: true,
          BindOptions: { NonRecursive: false }
        },
        { Type: 'tmpfs', Target: '/tmp' }
      ]
    })
    await engine.call('POST', '/services/create', {
      body: { ...t, TaskTemplate: { ...t.TaskTemplate, Runtime: 'container' } }
    })
    expect(seen).toHaveLength(1)
  })
})

describe('ruling P4-12: NFS volumes, never bind', () => {
  const nfs = { type: 'nfs', o: 'addr=10.0.0.5,rw', device: ':/export/uploads' }
  const nfsCfg: AgentConfig = loadAgentConfig(
    {
      HUB_AGENT_TOKEN_FILE: '/t',
      HUB_AGENT_EDGE_NETWORK: 'edge',
      HUB_AGENT_HOST_SUFFIXES: '.apps.corp',
      HUB_AGENT_VOLUME_OPTS_FILE: '/v'
    },
    (p) => (p === '/v' ? JSON.stringify(nfs) : 'agent-token-0123456789-abcdefghij')
  )

  it('an NFS volume matching the config is created', async () => {
    const engine = createEngine(nfsCfg, transport)
    await engine.call('POST', '/volumes/create', {
      body: { Name: 'nvh_s_uploads', Driver: 'local', DriverOpts: { ...nfs } }
    })
    expect(seen).toHaveLength(1)
  })

  it('options that differ from the config are refused', async () => {
    const engine = createEngine(nfsCfg, transport)
    for (const DriverOpts of [
      { type: 'none', o: 'bind', device: '/' },
      { ...nfs, device: '/var/run' },
      { ...nfs, o: 'addr=x,bind' },
      {}
    ]) {
      await expect(
        engine.call('POST', '/volumes/create', {
          body: { Name: 'nvh_s_x', Driver: 'local', DriverOpts }
        })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('the engine re-checks the rule even when the options equal a (bad) config', async () => {
    for (const bad of [
      { type: 'none', o: 'bind', device: '/' },
      { type: 'nfs', o: 'addr=10.0.0.5', device: '/var/run' },
      { type: 'nfs', o: 'addr=x,bind', device: ':/export' }
    ]) {
      const engine = createEngine({ ...nfsCfg, volumeOpts: bad }, transport)
      await expect(
        engine.call('POST', '/volumes/create', {
          body: { Name: 'nvh_s_x', Driver: 'local', DriverOpts: { ...bad } }
        })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
    expect(transport).not.toHaveBeenCalled()
  })
})
