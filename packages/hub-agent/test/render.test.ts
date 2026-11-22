import { describe, expect, it } from 'vitest'
import {
  type EngineServiceSpec,
  type RenderConfig,
  type RenderContext,
  renderServices
} from '../src/render.js'
import type { StackSpec } from '../src/spec.js'

const DIGEST = `sha256:${'a'.repeat(64)}`
const IMAGE = `nodeworks/nivaro@${DIGEST}`
const REDIS = `redis@sha256:${'b'.repeat(64)}`
const EXT = `registry.example.com/acme/tools-ext@sha256:${'c'.repeat(64)}`
const ROOT = '/var/lib/nivaro-hub-agent/extensions'

const cfg = (over: Partial<RenderConfig> = {}): RenderConfig => ({
  edge: 'traefik',
  edgeNetwork: 'edge',
  entrypoints: ['websecure'],
  certResolver: 'le',
  extensionsShared: false,
  extensionsHostRoot: ROOT,
  volumeDriver: 'local',
  volumeOpts: null,
  redisImage: REDIS,
  ...over
})

const large = (over: Partial<StackSpec> = {}): StackSpec => ({
  owner: { app: 'acme' },
  environment: 'prod',
  image: IMAGE,
  roles: [
    { role: 'web', replicas: 3, cpus: 2, memory_mb: 3072, env: { SOCKETS: 'off' } },
    { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 },
    { role: 'realtime', replicas: 2, cpus: 1, memory_mb: 1024 },
    { role: 'importer', replicas: 1, cpus: 2, memory_mb: 4096 }
  ],
  env: { DB_HOST: 'db', PUBLIC_URL: 'https://a.apps.corp', SOCKETS: 'on' },
  secrets: { SESSION_SECRET: 'super-secret-value' },
  hostnames: ['a.apps.corp', 'b.apps.corp'],
  redis: 'bundled',
  extensions: {},
  ...over
})

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  hash: 'h'.repeat(64),
  secretIds: { SESSION_SECRET: { id: 'sec1', name: 'nvh_st_SESSION_SECRET_0123456789ab' } },
  extensionPaths: {},
  agentNodeId: 'node-1',
  network: 'nvh_st',
  ...over
})

const byName = (svcs: EngineServiceSpec[], name: string) => {
  const s = svcs.find((x) => x.Name === name)
  if (!s) throw new Error(`no service ${name}`)
  return s
}
const envOf = (s: EngineServiceSpec) =>
  Object.fromEntries(
    s.TaskTemplate.ContainerSpec.Env.map((e) => [
      e.slice(0, e.indexOf('=')),
      e.slice(e.indexOf('=') + 1)
    ])
  )

describe('renderServices — services and env', () => {
  it('large: five services, one per role plus redis', () => {
    const svcs = renderServices('st', large(), cfg(), ctx())
    expect(svcs.map((s) => s.Name)).toEqual([
      'st_web',
      'st_worker',
      'st_realtime',
      'st_importer',
      'st_redis'
    ])
  })

  it('sets NIVARO_ROLE per role, REDIS_URL and STORAGE_LOCAL_ROOT', () => {
    const svcs = renderServices('st', large(), cfg(), ctx())
    for (const role of ['web', 'worker', 'realtime', 'importer']) {
      const e = envOf(byName(svcs, `st_${role}`))
      expect(e.NIVARO_ROLE).toBe(role)
      expect(e.REDIS_URL).toBe('redis://st_redis:6379')
      expect(e.STORAGE_LOCAL_ROOT).toBe('/app/uploads')
      expect(e.DB_HOST).toBe('db')
    }
  })

  it('role env wins over spec env; SOCKETS=off only where given', () => {
    const svcs = renderServices('st', large(), cfg(), ctx())
    expect(envOf(byName(svcs, 'st_web')).SOCKETS).toBe('off')
    expect(envOf(byName(svcs, 'st_realtime')).SOCKETS).toBe('on')
    const plain = large({ env: { DB_HOST: 'db' } })
    const s2 = renderServices('st', plain, cfg(), ctx())
    expect(envOf(byName(s2, 'st_web')).SOCKETS).toBe('off')
    for (const n of ['st_worker', 'st_realtime', 'st_importer']) {
      expect(envOf(byName(s2, n)).SOCKETS).toBeUndefined()
    }
  })

  it("'all' gets no NIVARO_ROLE; external redis adds no service and no REDIS_URL", () => {
    const small = large({ roles: [{ role: 'all', replicas: 1 }], redis: 'external' })
    const svcs = renderServices('st', small, cfg(), ctx())
    expect(svcs.map((s) => s.Name)).toEqual(['st_all'])
    const e = envOf(svcs[0])
    expect(e.NIVARO_ROLE).toBeUndefined()
    expect(e.REDIS_URL).toBeUndefined()
    expect(svcs[0].Mode).toEqual({ Replicated: { Replicas: 1 } })
  })

  it('never puts a secret value into env or labels', () => {
    const svcs = renderServices('st', large(), cfg(), ctx())
    expect(JSON.stringify(svcs)).not.toContain('super-secret-value')
  })

  it('mounts each secret as a read-only file named after its key', () => {
    const web = byName(renderServices('st', large(), cfg(), ctx()), 'st_web')
    expect(web.TaskTemplate.ContainerSpec.Secrets).toEqual([
      {
        SecretID: 'sec1',
        SecretName: 'nvh_st_SESSION_SECRET_0123456789ab',
        File: { Name: 'SESSION_SECRET', UID: '1000', GID: '1000', Mode: 0o400 }
      }
    ])
    const redis = byName(renderServices('st', large(), cfg(), ctx()), 'st_redis')
    expect(redis.TaskTemplate.ContainerSpec.Secrets).toEqual([])
  })

  it('sets resource limits from cpus and memory_mb', () => {
    const web = byName(renderServices('st', large(), cfg(), ctx()), 'st_web')
    expect(web.TaskTemplate.Resources).toEqual({
      Limits: { NanoCPUs: 2e9, MemoryBytes: 3072 * 1024 * 1024 }
    })
    const all = renderServices('st', large({ roles: [{ role: 'all', replicas: 1 }] }), cfg(), ctx())
    expect(all[0].TaskTemplate.Resources).toEqual({})
  })

  it('redis uses the agent image and its own volume', () => {
    const redis = byName(renderServices('st', large(), cfg(), ctx()), 'st_redis')
    expect(redis.TaskTemplate.ContainerSpec.Image).toBe(REDIS)
    expect(
      redis.TaskTemplate.ContainerSpec.Mounts.map((m) => [m.Type, m.Source, m.Target])
    ).toEqual([['volume', 'nvh_st_redis', '/data']])
    expect(redis.TaskTemplate.Networks).toEqual([{ Target: 'nvh_st' }])
    expect(redis.Labels['traefik.enable']).toBeUndefined()
  })
})

describe('renderServices — safety', () => {
  const allSvcs = () =>
    renderServices(
      'st',
      large({ extensions: { 'acme-tools': EXT } }),
      cfg(),
      ctx({ extensionPaths: { 'acme-tools': `${ROOT}/st/acme-tools@cccccccccccc` } })
    )

  it('no service is privileged, adds capabilities, binds outside the extension root or uses the host network', () => {
    for (const s of allSvcs()) {
      const text = JSON.stringify(s)
      for (const k of [
        'Privileged',
        'CapabilityAdd',
        'CapAdd',
        'Binds',
        'NetworkMode',
        'Devices',
        'Sysctls'
      ]) {
        expect(text).not.toContain(`"${k}"`)
      }
      expect(text).not.toContain('docker.sock')
      for (const n of s.TaskTemplate.Networks) expect(['nvh_st', 'edge']).toContain(n.Target)
      for (const m of s.TaskTemplate.ContainerSpec.Mounts) {
        if (m.Type === 'bind') {
          expect(m.Source.startsWith(`${ROOT}/`)).toBe(true)
          expect(m.ReadOnly).toBe(true)
          expect(m.Target).toMatch(/^\/app\/api\/extensions\/[a-z0-9-]+$/)
        } else {
          expect(m.Type).toBe('volume')
          expect(m.Source).toMatch(/^nvh_st_(uploads|redis)$/)
        }
      }
    }
  })

  it('every service updates start-first and rolls back on failure', () => {
    for (const s of allSvcs()) {
      expect(s.UpdateConfig).toEqual({
        Parallelism: 1,
        Delay: 10e9,
        Order: 'start-first',
        FailureAction: 'rollback',
        Monitor: 60e9
      })
      expect(s.RollbackConfig).toEqual({ Parallelism: 1, Order: 'start-first' })
      expect(s.TaskTemplate.RestartPolicy).toEqual({ Condition: 'any' })
    }
  })

  it('mounts uploads and each extension (read-only) on every Nivaro role', () => {
    const web = byName(allSvcs(), 'st_web')
    expect(web.TaskTemplate.ContainerSpec.Mounts).toEqual([
      expect.objectContaining({ Type: 'volume', Source: 'nvh_st_uploads', Target: '/app/uploads' }),
      {
        Type: 'bind',
        Source: `${ROOT}/st/acme-tools@cccccccccccc`,
        Target: '/app/api/extensions/acme-tools',
        ReadOnly: true
      }
    ])
  })

  for (const p of [
    `${ROOT}/../../etc`,
    `${ROOT}/st/../../../var/run`,
    '/var/run/docker.sock',
    ROOT,
    `${ROOT}x/evil`,
    'relative/path'
  ]) {
    it(`refuses an extension path outside the root: ${p}`, () => {
      expect(() =>
        renderServices(
          'st',
          large({ extensions: { 'acme-tools': EXT } }),
          cfg(),
          ctx({ extensionPaths: { 'acme-tools': p } })
        )
      ).toThrow()
    })
  }

  it('refuses an extension without a prepared path', () => {
    expect(() =>
      renderServices('st', large({ extensions: { 'acme-tools': EXT } }), cfg(), ctx())
    ).toThrow()
  })

  it('refuses a secret without a created swarm secret', () => {
    expect(() => renderServices('st', large(), cfg(), ctx({ secretIds: {} }))).toThrow()
  })

  for (const stack of ['../x', 'a', 'A', 'a_b', 'efp/x']) {
    it(`refuses stack name ${JSON.stringify(stack)}`, () => {
      expect(() => renderServices(stack, large(), cfg(), ctx())).toThrow()
    })
  }

  it('refuses a hostname that would break out of the Traefik rule', () => {
    expect(() =>
      renderServices('st', large({ hostnames: ['a`) || Host(`evil.com'] }), cfg(), ctx())
    ).toThrow()
  })

  it('refuses bundled redis without a redis image', () => {
    expect(() => renderServices('st', large(), cfg({ redisImage: null }), ctx())).toThrow()
  })
})

describe('renderServices — labels', () => {
  it('stamps ownership, spec hash and role on service and container', () => {
    const svcs = renderServices('st', large(), cfg(), ctx())
    for (const s of svcs) {
      const role = s.Name.slice(3)
      const want = {
        'nivaro.hub.managed': '1',
        'com.docker.stack.namespace': 'st',
        'nivaro.hub.app': 'acme',
        'nivaro.hub.env': 'prod',
        'nivaro.hub.spec-hash': 'h'.repeat(64),
        'nivaro.hub.role': role
      }
      expect(s.Labels).toEqual(expect.objectContaining(want))
      expect(s.TaskTemplate.ContainerSpec.Labels).toEqual(want)
      expect(s.Labels['nivaro.hub.shared']).toBeUndefined()
    }
  })

  it('labels a shared owner as shared', () => {
    const [s] = renderServices(
      'st',
      large({
        owner: { shared: 'tools' },
        roles: [{ role: 'all', replicas: 1 }],
        redis: 'external'
      }),
      cfg(),
      ctx()
    )
    expect(s.Labels['nivaro.hub.shared']).toBe('tools')
    expect(s.Labels['nivaro.hub.app']).toBeUndefined()
  })

  it('traefik labels for two hostnames, exact', () => {
    const svcs = renderServices('st', large(), cfg(), ctx())
    const pick = (s: EngineServiceSpec) =>
      Object.fromEntries(Object.entries(s.Labels).filter(([k]) => k.startsWith('traefik.')))
    expect(pick(byName(svcs, 'st_web'))).toEqual({
      'traefik.enable': 'true',
      'traefik.docker.network': 'edge',
      'traefik.http.routers.nvh-st.rule': 'Host(`a.apps.corp`) || Host(`b.apps.corp`)',
      'traefik.http.routers.nvh-st.entrypoints': 'websecure',
      'traefik.http.routers.nvh-st.tls': 'true',
      'traefik.http.routers.nvh-st.tls.certresolver': 'le',
      'traefik.http.routers.nvh-st.service': 'nvh-st',
      'traefik.http.services.nvh-st.loadbalancer.server.port': '3055'
    })
    expect(pick(byName(svcs, 'st_realtime'))).toEqual({
      'traefik.enable': 'true',
      'traefik.docker.network': 'edge',
      'traefik.http.routers.nvh-st-rt.rule':
        '(Host(`a.apps.corp`) || Host(`b.apps.corp`)) && PathPrefix(`/socket.io`)',
      'traefik.http.routers.nvh-st-rt.priority': '100',
      'traefik.http.routers.nvh-st-rt.entrypoints': 'websecure',
      'traefik.http.routers.nvh-st-rt.tls': 'true',
      'traefik.http.routers.nvh-st-rt.tls.certresolver': 'le',
      'traefik.http.routers.nvh-st-rt.service': 'nvh-st-rt',
      'traefik.http.services.nvh-st-rt.loadbalancer.server.port': '3055',
      'traefik.http.services.nvh-st-rt.loadbalancer.sticky.cookie': 'true',
      'traefik.http.services.nvh-st-rt.loadbalancer.sticky.cookie.name': 'nvh_rt',
      'traefik.http.services.nvh-st-rt.loadbalancer.sticky.cookie.secure': 'true',
      'traefik.http.services.nvh-st-rt.loadbalancer.sticky.cookie.httponly': 'true'
    })
    for (const n of ['st_worker', 'st_importer', 'st_redis'])
      expect(pick(byName(svcs, n))).toEqual({})
  })

  it('no certresolver label when none is set; several entrypoints joined', () => {
    const web = byName(
      renderServices(
        'st',
        large(),
        cfg({ certResolver: undefined, entrypoints: ['web', 'websecure'] }),
        ctx()
      ),
      'st_web'
    )
    expect(web.Labels['traefik.http.routers.nvh-st.tls.certresolver']).toBeUndefined()
    expect(web.Labels['traefik.http.routers.nvh-st.entrypoints']).toBe('web,websecure')
  })

  it('edge network only on web/all/realtime in traefik mode', () => {
    const svcs = renderServices('st', large(), cfg(), ctx())
    const nets = (n: string) => byName(svcs, n).TaskTemplate.Networks.map((x) => x.Target)
    expect(nets('st_web')).toEqual(['nvh_st', 'edge'])
    expect(nets('st_realtime')).toEqual(['nvh_st', 'edge'])
    expect(nets('st_worker')).toEqual(['nvh_st'])
    expect(nets('st_importer')).toEqual(['nvh_st'])
  })
})

describe('renderServices — publish mode', () => {
  const pub = cfg({ edge: 'publish' })
  it('publishes 3055 only on web, and adds no traefik labels or edge network', () => {
    const svcs = renderServices('st', large({ publish_port: 31000 }), pub, ctx())
    for (const s of svcs) {
      if (s.Name === 'st_web') {
        expect(s.EndpointSpec).toEqual({ Ports: [{ TargetPort: 3055, PublishedPort: 31000 }] })
      } else expect(s.EndpointSpec).toBeUndefined()
      expect(Object.keys(s.Labels).some((k) => k.startsWith('traefik.'))).toBe(false)
      expect(s.TaskTemplate.Networks).toEqual([{ Target: 'nvh_st' }])
    }
  })
  it("publishes on 'all'", () => {
    const [s] = renderServices(
      'st',
      large({ roles: [{ role: 'all', replicas: 1 }], redis: 'external', publish_port: 31001 }),
      pub,
      ctx()
    )
    expect(s.EndpointSpec).toEqual({ Ports: [{ TargetPort: 3055, PublishedPort: 31001 }] })
  })
  it('traefik mode publishes nothing', () => {
    for (const s of renderServices('st', large({ publish_port: 31000 }), cfg(), ctx())) {
      expect(s.EndpointSpec).toBeUndefined()
    }
  })
})

describe('renderServices — placement', () => {
  const withExt = large({ extensions: { 'acme-tools': EXT } })
  const ectx = ctx({ extensionPaths: { 'acme-tools': `${ROOT}/st/acme-tools@cccccccccccc` } })
  const constraints = (svcs: EngineServiceSpec[], n: string) =>
    byName(svcs, n).TaskTemplate.Placement
  it('pins Nivaro roles to the agent node when extensions exist and are not shared', () => {
    const svcs = renderServices('st', withExt, cfg(), ectx)
    for (const n of ['st_web', 'st_worker', 'st_realtime', 'st_importer']) {
      expect(constraints(svcs, n)).toEqual({ Constraints: ['node.id==node-1'] })
    }
    expect(constraints(svcs, 'st_redis')).toBeUndefined()
  })
  it('no constraint when extensions are shared', () => {
    const svcs = renderServices('st', withExt, cfg({ extensionsShared: true }), ectx)
    for (const s of svcs) expect(s.TaskTemplate.Placement).toBeUndefined()
  })
  it('no constraint without extensions', () => {
    for (const shared of [true, false]) {
      for (const s of renderServices('st', large(), cfg({ extensionsShared: shared }), ctx())) {
        expect(s.TaskTemplate.Placement).toBeUndefined()
      }
    }
  })
})
