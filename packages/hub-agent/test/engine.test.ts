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
import { nfsUploadsName } from '../src/volumes.js'

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
      // What the ownership guard reads before a write: ours are labelled, efp's are not.
      const svc = /^\/v1\.44\/services\/([a-z][a-z0-9-]*)_([a-z]+)$/.exec(req.url ?? '')
      if (req.method === 'GET' && svc) {
        const labels = svc[1] === 'efp' ? { 'com.docker.stack.namespace': 'efp' } : OWNED(svc[1])
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ID: 'x1', Spec: { Name: `${svc[1]}_${svc[2]}`, Labels: labels } }))
        return
      }
      const ctr = /^\/v1\.44\/containers\/(nvh_[a-z0-9-]+_unpack_[a-f0-9]+)\/json$/.exec(
        req.url ?? ''
      )
      if (req.method === 'GET' && ctr) {
        const labels =
          ctr[1] === 'nvh_s_unpack_deadbeef00'
            ? {}
            : ctr[1] === 'nvh_s_unpack_feedface00'
              ? { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': 't' }
              : { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': 's' }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ Id: 'c1', Name: `/${ctr[1]}`, Config: { Labels: labels } }))
        return
      }
      const lists: Record<string, unknown> = {
        '/v1.44/secrets': [
          { ID: 'sec1', Spec: { Name: 'nvh_s_X_0123456789ab', Labels: OWNED('s') } },
          { ID: 'sec2', Spec: { Name: 'nvh_s_FOREIGN_0123456789ab', Labels: {} } }
        ],
        '/v1.44/networks': [
          { Id: 'net1', Name: 'nvh_s', Labels: OWNED('s') },
          { Id: 'net2', Name: 'nvh_q', Labels: OWNED('t') }
        ],
        '/v1.44/volumes': {
          Volumes: [
            { Name: 'nvh_s_uploads', Labels: OWNED('s') },
            { Name: 'nvh_s_foreign', Labels: { 'com.docker.stack.namespace': 's' } }
          ]
        }
      }
      if (req.method === 'GET' && req.url && Object.hasOwn(lists, req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(lists[req.url]))
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

const OWN = { 'nivaro.hub.managed': '1', 'com.docker.stack.namespace': 's' }
function OWNED(stack: string) {
  return { 'nivaro.hub.managed': '1', 'com.docker.stack.namespace': stack }
}
const UNPACK = 'nvh_s_unpack_0123abcd'

const service = (extra: Record<string, unknown> = {}) => ({
  Name: 's_web',
  Labels: { ...OWN },
  TaskTemplate: {
    ContainerSpec: {
      Image: IMAGE,
      Labels: { ...OWN },
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
    Networks: [{ Target: 'nvh_s' }, { Target: 'edge' }]
  }
})

const UNLABELLED_UNPACK = 'nvh_s_unpack_deadbeef00'
const OTHER_STACK_UNPACK = 'nvh_s_unpack_feedface00'

const CREATE_UNPACK = {
  query: { name: UNPACK },
  body: { Image: IMAGE, Labels: { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': 's' } }
}

function needsOwnershipRead(method: string, path: string): boolean {
  return (
    (method === 'DELETE' && /^\/(services|secrets|networks|volumes|containers)\//.test(path)) ||
    (method === 'POST' && /^\/services\/[^/]+\/update$/.test(path))
  )
}

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
  ['GET', `/containers/${UNPACK}/archive`, { query: { path: '/extension' } }],
  ['POST', '/services/create', { body: service(), headers: { 'X-Registry-Auth': 'e30=' } }],
  ['POST', '/services/s_web/update', { body: service(), query: { version: 7 } }],
  [
    'POST',
    '/networks/create',
    { body: { Name: 'nvh_s', Driver: 'overlay', Attachable: false, Labels: { ...OWN } } }
  ],
  [
    'POST',
    '/secrets/create',
    { body: { Name: 'nvh_s_X_0123456789ab', Data: 'eA==', Labels: { ...OWN } } }
  ],
  [
    'POST',
    '/volumes/create',
    { body: { Name: 'nvh_s_uploads', Driver: 'local', Labels: { ...OWN } } }
  ],
  ['POST', '/images/create', { query: { fromImage: IMAGE } }],
  [
    'POST',
    '/containers/create',
    {
      query: { name: UNPACK },
      body: { Image: IMAGE, Labels: { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': 's' } }
    }
  ],
  ['DELETE', '/services/s_web'],
  ['DELETE', '/secrets/nvh_s_X_0123456789ab'],
  ['DELETE', '/networks/nvh_s'],
  ['DELETE', '/volumes/nvh_s_uploads'],
  ['DELETE', `/containers/${UNPACK}`, { query: { force: true } }],
  ['GET', '/containers/json', { query: { all: true, filters: '{"label":["nivaro.hub.unpack"]}' } }],
  ['GET', `/containers/${UNPACK}/json`]
]

describe('Task 15: the exporter service', () => {
  it('`<stack>_exporter` is a Hub service name the guard lets through; an unknown role is not', async () => {
    const engine = createEngine(cfg, transport)
    const body = { ...service(), Name: 's_exporter' }
    const r = await engine.call('POST', '/services/create', { body } as never)
    expect(r.status).toBeLessThan(500)
    await expect(
      engine.call('POST', '/services/create', { body: { ...service(), Name: 's_canary' } } as never)
    ).rejects.toThrow(EngineForbiddenError)
  })
})

describe('P4-34: pinned images with an informational tag', () => {
  it('a service image repo:tag@sha256 from the allow-list passes the guard; a tag alone does not', async () => {
    const engine = createEngine(cfg, transport)
    const tagged = IMAGE.replace('@', ':0.3.208@')
    const body = service()
    ;(body.TaskTemplate.ContainerSpec as { Image: string }).Image = tagged
    const r = await engine.call('POST', '/services/create', { body } as never)
    expect(r.status).toBeLessThan(500)
    const bad = service()
    ;(bad.TaskTemplate.ContainerSpec as { Image: string }).Image = 'nodeworks/nivaro:0.3.208'
    await expect(engine.call('POST', '/services/create', { body: bad } as never)).rejects.toThrow()
  })
})

describe('an image on a registry with a port', () => {
  // HUB_AGENT_IMAGES takes host:port repositories (a GitLab registry on :5050, a local
  // registry); the inspect path must too, or every pull of such an image ends ENGINE_FORBIDDEN.
  const portCfg = loadAgentConfig(
    {
      HUB_AGENT_TOKEN_FILE: '/t',
      HUB_AGENT_EDGE: 'publish',
      HUB_AGENT_PUBLISH_PORTS: '3110-3119',
      HUB_AGENT_IMAGES: 'nodeworks/nivaro,registry.corp:5050/apps/ext,localhost:5100/pole-ops'
    },
    () => 'agent-token-0123456789-abcdefghij'
  )
  it.each([
    `registry.corp:5050/apps/ext@sha256:${D}`,
    `localhost:5100/pole-ops@sha256:${D}`
  ])('pull and inspect of %s pass the guard', async (ref) => {
    const engine = createEngine(portCfg, transport)
    const pulled = await engine.call('POST', '/images/create', { query: { fromImage: ref } })
    expect(pulled.status).toBe(200)
    const seenImage = await engine.call('GET', `/images/${ref}/json`)
    expect(seenImage.status).toBe(200)
  })
  it('a port that is not a number, or a path segment with a colon, is still refused', async () => {
    const engine = createEngine(portCfg, transport)
    await expect(
      engine.call('GET', `/images/registry.corp:x/apps/ext@sha256:${D}/json`)
    ).rejects.toThrow('not on the allow-list')
    await expect(
      engine.call('GET', `/images/apps/registry.corp:5050/ext@sha256:${D}/json`)
    ).rejects.toThrow('not on the allow-list')
  })
})

describe('engine allow-list', () => {
  it('lists exactly the planned method + path pairs', () => {
    expect(ENGINE_ALLOWED.length).toBe(24)
    expect(new Set(ENGINE_ALLOWED.map(([m]) => m))).toEqual(new Set(['GET', 'POST', 'DELETE']))
  })

  it.each(ALLOWED_CALLS)('%s %s reaches the transport under /v1.44', async (method, path, opts) => {
    const engine = createEngine(cfg, transport)
    // The unpack container is only reachable once this engine created it.
    if (path.includes(UNPACK)) await engine.call('POST', '/containers/create', CREATE_UNPACK)
    seen.length = 0
    transport.mockClear()
    const r = await engine.call(method as 'GET', path, opts as never)
    expect(r.status).toBe(200)
    // Updates and deletes of services, secrets, networks and volumes read ownership first.
    const reads = needsOwnershipRead(method, path) ? 1 : 0
    expect(transport).toHaveBeenCalledTimes(1 + reads)
    expect(seen).toHaveLength(1 + reads)
    expect(seen[reads].method).toBe(method)
    expect(seen[reads].url.startsWith(`/v1.44${path}`)).toBe(true)
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
    await engine.call('POST', '/secrets/create', {
      body: { Name: 'nvh_s_X_0123', Data: 'eA==', Labels: OWN }
    })
    expect(seen[1].url).toBe('/v1.44/secrets/create')
    expect(JSON.parse(seen[1].body)).toEqual({ Name: 'nvh_s_X_0123', Data: 'eA==', Labels: OWN })
    expect(seen[1].headers['content-type']).toBe('application/json')
  })

  it('passes a non-2xx status and body through', async () => {
    const engine = createEngine(cfg, transport)
    const r = await engine.call<{ message: string }>('GET', '/services/missing')
    expect(r).toEqual({ status: 404, body: { message: 'service missing not found' } })
  })

  it('streams the archive of a container', async () => {
    const engine = createEngine(cfg, transport)
    await engine.call('POST', '/containers/create', CREATE_UNPACK)
    const r = await engine.stream('GET', `/containers/${UNPACK}/archive`, {
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
    await engine.call('POST', '/services/s_web/update', {
      body: service(),
      query: { version: '12', registryAuthFrom: 'spec' }
    })
    await engine.call('POST', '/containers/create', CREATE_UNPACK)
    await engine.call('DELETE', `/containers/${UNPACK}`, { query: { force: true } })
    await engine.call('POST', '/containers/create', CREATE_UNPACK)
    await engine.call('DELETE', `/containers/${UNPACK}`)
    await engine.call('GET', '/services', { query: { filters: '{}', other: undefined } })
    expect(
      seen
        .filter((x) => !/create|^\/v1\.44\/services\/s_web$|\/json$/.test(x.url))
        .map((x) => x.url)
    ).toEqual([
      '/v1.44/services/s_web/update?version=12&registryAuthFrom=spec',
      `/v1.44/containers/${UNPACK}?force=true`,
      `/v1.44/containers/${UNPACK}`,
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
          DriverOpts: { type: 'none', o: 'bind', device: '/' },
          Labels: OWN
        }
      }
    ],
    [
      'volume create with another driver',
      'POST',
      '/volumes/create',
      { body: { Name: 'nvh_s_x', Driver: 'nfs', Labels: OWN } }
    ],
    [
      'volume create with no driver',
      'POST',
      '/volumes/create',
      { body: { Name: 'nvh_s_x', Labels: OWN } }
    ],
    [
      'volume create without the nvh_ prefix',
      'POST',
      '/volumes/create',
      { body: { Name: 'efp_uploads', Driver: 'local', Labels: OWN } }
    ],
    [
      'volume create with a cluster spec',
      'POST',
      '/volumes/create',
      { body: { Name: 'nvh_s_x', Driver: 'local', ClusterVolumeSpec: {}, Labels: OWN } }
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
      { body: { Name: 'nvh_s', Driver: 'bridge', Labels: OWN } }
    ],
    [
      'network create with no driver',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s', Labels: OWN } }
    ],
    [
      'network create with Ingress',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s', Driver: 'overlay', Ingress: true, Labels: OWN } }
    ],
    [
      'network create with ConfigFrom',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s', Driver: 'overlay', ConfigFrom: { Network: 'x' }, Labels: OWN } }
    ],
    [
      'network create with ConfigOnly',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s', Driver: 'overlay', ConfigOnly: true, Labels: OWN } }
    ],
    [
      'network create without the nvh_ prefix',
      'POST',
      '/networks/create',
      { body: { Name: 'efp_net', Driver: 'overlay', Labels: OWN } }
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
      { body: { Name: 'nvh_s_X_1', Data: 'eA==', Driver: { Name: 'vault' }, Labels: OWN } }
    ],
    [
      'secret create with Templating',
      'POST',
      '/secrets/create',
      { body: { Name: 'nvh_s_X_1', Data: 'eA==', Templating: { Name: 'golang' }, Labels: OWN } }
    ],
    [
      'secret create without the nvh_ prefix',
      'POST',
      '/secrets/create',
      { body: { Name: 'efp_db', Data: 'eA==', Labels: OWN } }
    ],
    ['X-Registry-Auth on /version', 'GET', '/version', { headers: { 'X-Registry-Auth': 'e30=' } }],
    [
      'X-Registry-Auth on /networks/create',
      'POST',
      '/networks/create',
      {
        body: { Name: 'nvh_s', Driver: 'overlay', Labels: OWN },
        headers: { 'X-Registry-Auth': 'e30=' }
      }
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
      TaskTemplate: { ...base.TaskTemplate, Networks: [{ Target: 'nvh_s' }] }
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

  // 0.2.3: the configured device is the export ROOT; each stack gets <export>/<stack>/uploads.
  const own = { ...nfs, device: ':/export/uploads/s/uploads' }
  const ownName = nfsUploadsName('s', 'local', own)

  it("the stack's own NFS folder, under the name its digest gives, is created", async () => {
    const engine = createEngine(nfsCfg, transport)
    expect(ownName).toMatch(/^nvh_s_uploads-[0-9a-f]{10}$/)
    await engine.call('POST', '/volumes/create', {
      body: { Name: ownName, Driver: 'local', DriverOpts: { ...own }, Labels: OWN }
    })
    const adopted = { ...nfs, device: ':/export/uploads/legacy/files' }
    const body = {
      Name: nfsUploadsName('s', 'local', adopted),
      Driver: 'local',
      DriverOpts: adopted,
      Labels: OWN
    }
    // L2: an adopted folder only when the call names it as the stack's folder.
    await expect(engine.call('POST', '/volumes/create', { body })).rejects.toBeInstanceOf(
      EngineForbiddenError
    )
    await expect(
      engine.call('POST', '/volumes/create', { body, uploadsFolder: 'other' })
    ).rejects.toBeInstanceOf(EngineForbiddenError)
    await engine.call('POST', '/volumes/create', { body, uploadsFolder: 'legacy/files' })
    // Another stack's own folder, under a name digest made for this stack: refused.
    const theirs = { ...nfs, device: ':/export/uploads/t/uploads' }
    await expect(
      engine.call('POST', '/volumes/create', {
        body: { ...body, Name: nfsUploadsName('s', 'local', theirs), DriverOpts: theirs }
      })
    ).rejects.toBeInstanceOf(EngineForbiddenError)
    expect(seen).toHaveLength(2)
    expect(seen[1].body).not.toContain('uploadsFolder')
  })

  it('the export root, a device outside it, a wrong digest or the old name are refused', async () => {
    const engine = createEngine(nfsCfg, transport)
    const cases: Array<[string, Record<string, string>]> = [
      ['nvh_s_uploads', { ...nfs }],
      [nfsUploadsName('s', 'local', { ...nfs }), { ...nfs }],
      [
        nfsUploadsName('s', 'local', { ...nfs, device: ':/other/s' }),
        { ...nfs, device: ':/other/s' }
      ],
      [
        nfsUploadsName('s', 'local', { ...nfs, device: ':/export/uploads/../x' }),
        { ...nfs, device: ':/export/uploads/../x' }
      ],
      [ownName, { ...own, device: ':/export/uploads/t/uploads' }],
      ['nvh_s_uploads', { ...own }],
      [
        nfsUploadsName('s', 'local', { ...own, o: 'addr=10.0.0.6' }),
        { ...own, o: 'addr=10.0.0.6' }
      ],
      ['nvh_s_x', { ...own }]
    ]
    for (const [Name, DriverOpts] of cases) {
      await expect(
        engine.call('POST', '/volumes/create', {
          body: { Name, Driver: 'local', DriverOpts, Labels: OWN }
        })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('Redis gets a local volume beside NFS uploads, never the NFS options', async () => {
    const engine = createEngine(nfsCfg, transport)
    expect(nfsCfg.redisVolumeDriver).toBe('local')
    expect(nfsCfg.redisVolumeOpts).toEqual({})
    await engine.call('POST', '/volumes/create', {
      body: { Name: 'nvh_s_redis', Driver: 'local', DriverOpts: {}, Labels: OWN }
    })
    expect(seen).toHaveLength(1)
    for (const DriverOpts of [{ ...nfs }, { ...own }]) {
      await expect(
        engine.call('POST', '/volumes/create', {
          body: { Name: 'nvh_s_redis', Driver: 'local', DriverOpts, Labels: OWN }
        })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
  })

  it('a mount DriverConfig must be the one its volume gets', async () => {
    const engine = createEngine(nfsCfg, transport)
    const mount = (Source: string, Options: Record<string, string>) =>
      service({
        Mounts: [
          {
            Type: 'volume',
            Source,
            Target: '/app/uploads',
            VolumeOptions: { Labels: OWN, DriverConfig: { Name: 'local', Options } }
          }
        ]
      })
    await engine.call('POST', '/services/create', { body: mount(ownName, own) })
    await engine.call('POST', '/services/create', { body: mount('nvh_s_redis', {}) })
    expect(seen).toHaveLength(2)
    for (const [src, opts] of [
      ['nvh_s_redis', own],
      [ownName, {}],
      [ownName, { ...own, device: ':/export/uploads/t/uploads' }]
    ] as Array<[string, Record<string, string>]>) {
      await expect(
        engine.call('POST', '/services/create', { body: mount(src, opts) })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
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
          body: { Name: 'nvh_s_x', Driver: 'local', DriverOpts, Labels: OWN }
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
          body: { Name: 'nvh_s_x', Driver: 'local', DriverOpts: { ...bad }, Labels: OWN }
        })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('Task 3: ownership in the guard (defence in depth)', () => {
  const OTHER = { 'nivaro.hub.managed': '1', 'com.docker.stack.namespace': 't' }
  const withContainer = (extra: Record<string, unknown>) => service(extra)
  const O: Array<[string, string, string, Record<string, unknown>]> = [
    [
      'a service without the managed label',
      'POST',
      '/services/create',
      { body: { ...service(), Labels: { 'com.docker.stack.namespace': 's' } } }
    ],
    [
      'a service labelled for another stack',
      'POST',
      '/services/create',
      { body: { ...service(), Labels: OTHER } }
    ],
    [
      'a service whose name is not <stack>_<role>',
      'POST',
      '/services/create',
      { body: { ...service(), Name: 'efp-web' } }
    ],
    [
      'container labels missing',
      'POST',
      '/services/create',
      { body: withContainer({ Labels: undefined }) }
    ],
    [
      'an update addressed by id',
      'POST',
      '/services/abc123def/update',
      { body: service(), query: { version: 1 } }
    ],
    [
      'an update whose path names another service',
      'POST',
      '/services/efp_web/update',
      { body: service(), query: { version: 1 } }
    ],
    [
      "a secret reference to another stack's secret",
      'POST',
      '/services/create',
      {
        body: withContainer({
          Secrets: [{ SecretID: 'abc123', SecretName: 'nvh_t_DB_PASSWORD_0123456789ab' }]
        })
      }
    ],
    [
      'a secret reference to a foreign secret name',
      'POST',
      '/services/create',
      { body: withContainer({ Secrets: [{ SecretID: 'abc123', SecretName: 'efp_db_password' }] }) }
    ],
    [
      'a secret reference with a strange id',
      'POST',
      '/services/create',
      {
        body: withContainer({
          Secrets: [{ SecretID: '../x', SecretName: 'nvh_s_DB_PASSWORD_0123456789ab' }]
        })
      }
    ],
    [
      'a config reference',
      'POST',
      '/services/create',
      { body: withContainer({ Configs: [{ ConfigID: 'abc', ConfigName: 'nvh_s_x' }] }) }
    ],
    [
      "a mount of another stack's volume",
      'POST',
      '/services/create',
      {
        body: withContainer({
          Mounts: [{ Type: 'volume', Source: 'nvh_t_uploads', Target: '/app/uploads' }]
        })
      }
    ],
    [
      "a bind of another stack's extension folder",
      'POST',
      '/services/create',
      {
        body: withContainer({
          Mounts: [{ Type: 'bind', Source: '/srv/ext/t/x@abc', Target: '/x', ReadOnly: true }]
        })
      }
    ],
    [
      "another stack's network",
      'POST',
      '/services/create',
      {
        body: {
          ...service(),
          TaskTemplate: { ...service().TaskTemplate, Networks: [{ Target: 'nvh_t' }] }
        }
      }
    ],
    [
      'a network named other than nvh_<stack>',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s_extra', Driver: 'overlay', Labels: OWN } }
    ],
    [
      'an attachable network',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s', Driver: 'overlay', Attachable: true, Labels: OWN } }
    ],
    [
      'a network without labels',
      'POST',
      '/networks/create',
      { body: { Name: 'nvh_s', Driver: 'overlay' } }
    ],
    [
      'a secret labelled for another stack',
      'POST',
      '/secrets/create',
      { body: { Name: 'nvh_s_X_1', Data: 'eA==', Labels: OTHER } }
    ],
    [
      'a volume without labels',
      'POST',
      '/volumes/create',
      { body: { Name: 'nvh_s_uploads', Driver: 'local' } }
    ],
    [
      'an unpack container without a name',
      'POST',
      '/containers/create',
      { body: { Image: IMAGE, Labels: { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': 's' } } }
    ],
    [
      'an unpack container labelled for another stack',
      'POST',
      '/containers/create',
      {
        query: { name: UNPACK },
        body: { Image: IMAGE, Labels: { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': 't' } }
      }
    ],
    [
      'an unpack container with a foreign name',
      'POST',
      '/containers/create',
      {
        query: { name: 'efp_tools' },
        body: { Image: IMAGE, Labels: { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': 's' } }
      }
    ],
    ['a service delete by id', 'DELETE', '/services/abc123def', {}],
    ['a secret delete by id', 'DELETE', '/secrets/abc123def', {}],
    ['a foreign secret delete', 'DELETE', '/secrets/efp_db_password', {}],
    ['a foreign network delete', 'DELETE', '/networks/efp_default', {}],
    ['a foreign volume delete', 'DELETE', '/volumes/efp_uploads', {}],
    [
      'a foreign container delete',
      'DELETE',
      '/containers/efp_web.1.abc',
      { query: { force: true } }
    ],
    [
      'an archive of a foreign container',
      'GET',
      '/containers/efp_web.1.abc/archive',
      { query: { path: '/extension' } }
    ]
  ]

  it.each(O)('%s is refused before any I/O', async (_name, method, path, opts) => {
    const engine = createEngine(cfg, transport)
    await expect(engine.call(method as 'GET', path, opts as never)).rejects.toBeInstanceOf(
      EngineForbiddenError
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('a volume mount may carry exactly the configured driver config, nothing else', async () => {
    const engine = createEngine(cfg, transport)
    const mount = (DriverConfig: unknown) =>
      service({
        Mounts: [
          {
            Type: 'volume',
            Source: 'nvh_s_uploads',
            Target: '/app/uploads',
            VolumeOptions: { Labels: OWN, DriverConfig }
          }
        ]
      })
    await engine.call('POST', '/services/create', {
      body: mount({ Name: 'local', Options: {} })
    })
    expect(seen).toHaveLength(1)
    for (const bad of [
      { Name: 'local', Options: { type: 'nfs' } },
      { Name: 'other', Options: {} },
      { Name: 'local', Options: {}, Extra: 1 }
    ]) {
      await expect(
        engine.call('POST', '/services/create', { body: mount(bad) })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
    expect(seen).toHaveLength(1)
  })

  it('reads stay open: inspecting any service by id is allowed', async () => {
    const engine = createEngine(cfg, transport)
    await engine.call('GET', '/services/abc123def')
    expect(seen).toHaveLength(1)
  })
})

describe('fix round 1: the guard reads ownership before a write', () => {
  const efpBody = (name: string) => ({
    ...service(),
    Name: name,
    Labels: OWNED('efp'),
    TaskTemplate: {
      ...service().TaskTemplate,
      ContainerSpec: {
        ...service().TaskTemplate.ContainerSpec,
        Labels: OWNED('efp'),
        Mounts: [{ Type: 'volume', Source: 'nvh_efp_uploads', Target: '/app/uploads' }]
      },
      Networks: [{ Target: 'nvh_efp' }]
    }
  })
  const writes = () => seen.filter((x) => x.method !== 'GET')

  it.each([
    'efp_web',
    'efp_importer',
    'efp_redis'
  ])('DELETE /services/%s (not labelled managed) is refused after the read', async (name) => {
    const engine = createEngine(cfg, transport)
    await expect(engine.call('DELETE', `/services/${name}`)).rejects.toBeInstanceOf(
      EngineForbiddenError
    )
    expect(writes()).toEqual([])
    expect(seen.map((x) => x.url)).toEqual([`/v1.44/services/${name}`])
  })

  it('a same-name efp_importer update with a self-labelled body is refused', async () => {
    const engine = createEngine(cfg, transport)
    await expect(
      engine.call('POST', '/services/efp_importer/update', {
        body: efpBody('efp_importer'),
        query: { version: 1 }
      })
    ).rejects.toBeInstanceOf(EngineForbiddenError)
    expect(writes()).toEqual([])
  })

  it.each([
    ['a secret whose live labels are not ours', '/secrets/nvh_s_FOREIGN_0123456789ab'],
    ['a network labelled for another stack', '/networks/nvh_q'],
    ['a volume without the managed label', '/volumes/nvh_s_foreign']
  ])('DELETE of %s is refused after the read', async (_n, path) => {
    const engine = createEngine(cfg, transport)
    await expect(engine.call('DELETE', path)).rejects.toBeInstanceOf(EngineForbiddenError)
    expect(writes()).toEqual([])
  })

  it('a delete of an object that is not there answers 404 without being forwarded', async () => {
    const engine = createEngine(cfg, transport)
    const r = await engine.call('DELETE', '/secrets/nvh_s_GONE_0123456789ab')
    expect(r.status).toBe(404)
    expect(writes()).toEqual([])
  })

  it('a container delete needs the unpack name AND the live unpack labels; the archive needs a container this engine made', async () => {
    const engine = createEngine(cfg, transport)
    await expect(
      engine.stream('GET', `/containers/${UNPACK}/archive`, { query: { path: '/extension' } })
    ).rejects.toBeInstanceOf(EngineForbiddenError)
    await expect(
      engine.call('DELETE', '/containers/abc123', { query: { force: true } })
    ).rejects.toBeInstanceOf(EngineForbiddenError)
    expect(seen).toEqual([])
    // Right name shape, but the live container is not labelled as ours.
    await expect(
      engine.call('DELETE', `/containers/${UNLABELLED_UNPACK}`, { query: { force: true } })
    ).rejects.toBeInstanceOf(EngineForbiddenError)
    // Labelled for another stack than its name says.
    await expect(engine.call('DELETE', `/containers/${OTHER_STACK_UNPACK}`)).rejects.toBeInstanceOf(
      EngineForbiddenError
    )
    expect(seen.filter((x) => x.method !== 'GET')).toEqual([])
    // A leftover from an earlier run (not created by this engine) with the right labels goes.
    await engine.call('DELETE', `/containers/${UNPACK}`, { query: { force: true, v: true } })
    expect(seen.at(-1)?.url).toBe(`/v1.44/containers/${UNPACK}?force=true&v=true`)
  })

  it('the container list must filter on the unpack label', async () => {
    const engine = createEngine(cfg, transport)
    for (const filters of [
      undefined,
      '{}',
      '{"label":["nivaro.hub.managed=1"]}',
      '{"label":["nivaro.hub.unpack","com.docker.stack.namespace=efp"]}',
      '{"label":["nivaro.hub.unpack"],"name":["efp"]}',
      'not json'
    ]) {
      await expect(
        engine.call('GET', '/containers/json', { query: { all: true, filters } })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
    await engine.call('GET', '/containers/json', {
      query: { all: true, filters: '{"label":["nivaro.hub.unpack"]}' }
    })
    expect(seen).toHaveLength(1)
  })

  it('v=true is allowed only on the container delete', async () => {
    const engine = createEngine(cfg, transport)
    await expect(
      engine.call('DELETE', '/volumes/nvh_s_uploads', { query: { v: true } })
    ).rejects.toBeInstanceOf(EngineForbiddenError)
    await expect(
      engine.call('DELETE', '/services/s_web', { query: { v: true } })
    ).rejects.toBeInstanceOf(EngineForbiddenError)
    expect(seen).toEqual([])
  })
})

describe('0.2.3: the service User', () => {
  it("only the image's own user (run_as: 'app') is taken", async () => {
    const engine = createEngine(cfg, transport)
    await engine.call('POST', '/services/create', { body: service({ User: '1000:1000' }) })
    expect(seen).toHaveLength(1)
    for (const User of ['0', 'root', '0:0', '1000', '1001:1001', '']) {
      await expect(
        engine.call('POST', '/services/create', { body: service({ User }) })
      ).rejects.toBeInstanceOf(EngineForbiddenError)
    }
    expect(seen).toHaveLength(1)
  })
})
