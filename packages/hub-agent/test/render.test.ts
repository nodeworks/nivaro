import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LABEL_HOSTS } from '../src/names.js'
import {
  type EngineServiceSpec,
  patternRouterName,
  REALTIME_PATHS,
  type RenderConfig,
  type RenderContext,
  realtimeRouterName,
  renderServices,
  webRouterName
} from '../src/render.js'
import { AGENT_SET_ENV_KEYS, type StackSpec } from '../src/spec.js'
import { hostTaken } from '../src/stacks.js'

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
  env: { DB_HOST: 'db', PUBLIC_URL: 'https://a.apps.corp' },
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

  it('SOCKETS=off only where the role env gives it', () => {
    const s2 = renderServices('st', large(), cfg(), ctx())
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
      'traefik.swarm.network': 'edge',
      'traefik.http.routers.nvh_web_st.rule': 'Host(`a.apps.corp`) || Host(`b.apps.corp`)',
      'traefik.http.routers.nvh_web_st.entrypoints': 'websecure',
      'traefik.http.routers.nvh_web_st.tls': 'true',
      'traefik.http.routers.nvh_web_st.tls.certresolver': 'le',
      'traefik.http.routers.nvh_web_st.service': 'nvh_web_st',
      'traefik.http.services.nvh_web_st.loadbalancer.server.port': '3055'
    })
    expect(pick(byName(svcs, 'st_realtime'))).toEqual({
      'traefik.enable': 'true',
      'traefik.swarm.network': 'edge',
      'traefik.http.routers.nvh_rt_st.rule':
        '(Host(`a.apps.corp`) || Host(`b.apps.corp`)) && (PathPrefix(`/socket.io/`) || Path(`/api/graphql-ws`) || Path(`/api/graphql/stream`) || Path(`/api/events/stream`) || PathRegexp(`^/api/events/views/[^/]+/stream$`))',
      'traefik.http.routers.nvh_rt_st.entrypoints': 'websecure',
      'traefik.http.routers.nvh_rt_st.tls': 'true',
      'traefik.http.routers.nvh_rt_st.tls.certresolver': 'le',
      'traefik.http.routers.nvh_rt_st.service': 'nvh_rt_st',
      'traefik.http.services.nvh_rt_st.loadbalancer.server.port': '3055',
      'traefik.http.services.nvh_rt_st.loadbalancer.sticky.cookie': 'true',
      'traefik.http.services.nvh_rt_st.loadbalancer.sticky.cookie.name': 'nvh_rt',
      'traefik.http.services.nvh_rt_st.loadbalancer.sticky.cookie.secure': 'true',
      'traefik.http.services.nvh_rt_st.loadbalancer.sticky.cookie.httponly': 'true'
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
    expect(web.Labels['traefik.http.routers.nvh_web_st.tls.certresolver']).toBeUndefined()
    expect(web.Labels['traefik.http.routers.nvh_web_st.entrypoints']).toBe('web,websecure')
  })

  it('the web service claims its hostnames with the template host label, in every edge mode', () => {
    for (const edge of ['traefik', 'publish'] as const) {
      const svcs = renderServices('st', large({ publish_port: 31000 }), cfg({ edge }), ctx())
      expect(byName(svcs, 'st_web').Labels[LABEL_HOSTS]).toBe('a.apps.corp,b.apps.corp')
      for (const n of ['st_worker', 'st_realtime', 'st_importer', 'st_redis'])
        expect(byName(svcs, n).Labels[LABEL_HOSTS]).toBeUndefined()
    }
    const [all] = renderServices(
      'st',
      large({ roles: [{ role: 'all', replicas: 1 }], redis: 'external' }),
      cfg(),
      ctx()
    )
    expect(all.Labels[LABEL_HOSTS]).toBe('a.apps.corp,b.apps.corp')
  })

  it('the GitLab app template uses the same host-claim label (one name on both deploy paths)', () => {
    const tpl = resolve(import.meta.dirname, '../../../deploy/hub-app-template/manager')
    expect(LABEL_HOSTS).toBe('nivaro.hub.hosts')
    expect(readFileSync(resolve(tpl, 'docker-stack.yml'), 'utf8')).toContain(
      `- ${LABEL_HOSTS}=\${APP_HOSTS}`
    )
    const wrapper = readFileSync(resolve(tpl, 'nivaro-hub-deploy'), 'utf8')
    expect(wrapper).toContain(`--filter label=${LABEL_HOSTS} `)
    expect(wrapper).toContain(`{{index .Spec.Labels "${LABEL_HOSTS}"}}`)
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

describe('renderServices — router names and priority', () => {
  const traefikNames = (svcs: EngineServiceSpec[]) => {
    const names = new Set<string>()
    for (const s of svcs) {
      for (const k of Object.keys(s.Labels)) {
        const m = /^traefik\.http\.(routers|services)\.([^.]+)\./.exec(k)
        if (m) names.add(`${m[1]}:${m[2]}`)
      }
    }
    return names
  }
  it('stack a and stack a-rt share no router or service name', () => {
    const a = traefikNames(renderServices('ab', large(), cfg(), ctx({ network: 'nvh_ab' })))
    const b = traefikNames(renderServices('ab-rt', large(), cfg(), ctx({ network: 'nvh_ab-rt' })))
    expect(a.size).toBe(4)
    expect(b.size).toBe(4)
    for (const n of a) expect(b.has(n)).toBe(false)
  })
  it('P4-27: the realtime router takes every realtime path deploy/realtime routes (web runs SOCKETS=off)', () => {
    expect(REALTIME_PATHS).toEqual([
      '/socket.io/',
      '/api/graphql-ws',
      '/api/graphql/stream',
      '/api/events/stream',
      '/api/events/views/:id/stream'
    ])
    const svcs = renderServices('st', large(), cfg(), ctx())
    const rule = byName(svcs, 'st_realtime').Labels['traefik.http.routers.nvh_rt_st.rule']
    for (const part of [
      'PathPrefix(`/socket.io/`)',
      'Path(`/api/graphql-ws`)',
      'Path(`/api/graphql/stream`)',
      'Path(`/api/events/stream`)',
      'PathRegexp(`^/api/events/views/[^/]+/stream$`)'
    ])
      expect(rule).toContain(part)
    // The same paths the compose example routes (deploy/realtime/docker-compose.yml).
    const compose = readFileSync(
      resolve(import.meta.dirname, '../../../deploy/realtime/docker-compose.yml'),
      'utf8'
    )
    const line = compose.split('\n').find((l) => l.includes('routers.nivaro-realtime.rule=')) ?? ''
    expect(line.slice(line.indexOf('&&')).replace('$$', '$').trim()).toBe(
      rule.slice(rule.indexOf('&&')).trim()
    )
  })

  it('names use a separator a stack name cannot hold', () => {
    expect(webRouterName('ab')).toBe('nvh_web_ab')
    expect(realtimeRouterName('ab')).toBe('nvh_rt_ab')
    expect(webRouterName('ab-rt')).not.toBe(realtimeRouterName('ab'))
  })
  it('sets no explicit priority; with 10 long hostnames the realtime rule is still the longer', () => {
    const hostnames = Array.from({ length: 10 }, (_, i) => `${'h'.repeat(60)}${i}.apps.corp`)
    const svcs = renderServices('st', large({ hostnames }), cfg(), ctx())
    const all = svcs.flatMap((s) => Object.keys(s.Labels))
    expect(all.some((k) => k.endsWith('.priority'))).toBe(false)
    const web = byName(svcs, 'st_web').Labels['traefik.http.routers.nvh_web_st.rule']
    const rt = byName(svcs, 'st_realtime').Labels['traefik.http.routers.nvh_rt_st.rule']
    expect(rt.length).toBeGreaterThan(web.length)
    expect(rt.startsWith(`(${web})`)).toBe(true)
  })
})

describe('renderServices — env keys the agent sets', () => {
  it('every env key not taken from spec.env is in AGENT_SET_ENV_KEYS', () => {
    const spec = large({
      roles: [
        {
          role: 'web',
          replicas: 1,
          env: {
            SOCKETS: 'off',
            CRON_TICKS: 'off',
            IMPORT_WORKER: 'off',
            MEDIA_WORKER: 'off',
            VIDEO_RENDER: 'off'
          }
        },
        { role: 'worker', replicas: 1 }
      ]
    })
    const set = new Set<string>()
    for (const s of renderServices('st', spec, cfg(), ctx())) {
      if (s.Name === 'st_redis') continue
      for (const k of Object.keys(envOf(s))) if (!(k in spec.env)) set.add(k)
    }
    expect([...set].sort()).toEqual([...AGENT_SET_ENV_KEYS].sort())
  })
})

describe('renderServices — safety scan over sizes and edge modes', () => {
  const sizes: Record<string, Partial<StackSpec>> = {
    small: { roles: [{ role: 'all', replicas: 1, cpus: 2, memory_mb: 3072 }], redis: 'external' },
    medium: {
      roles: [
        { role: 'web', replicas: 2, cpus: 2, memory_mb: 3072 },
        { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 }
      ]
    },
    large: {}
  }
  const CONTAINER_KEYS = ['Env', 'Image', 'Labels', 'Mounts', 'Secrets']
  const SERVICE_KEYS = ['Labels', 'Mode', 'Name', 'RollbackConfig', 'TaskTemplate', 'UpdateConfig']
  for (const [size, over] of Object.entries(sizes)) {
    for (const edge of ['traefik', 'publish'] as const) {
      for (const withExt of [false, true]) {
        it(`${size} / ${edge} / ${withExt ? 'extensions' : 'no extensions'}`, () => {
          const spec = large({
            ...over,
            ...(edge === 'publish' ? { publish_port: 31000 } : {}),
            extensions: withExt ? { 'acme-tools': EXT } : {}
          })
          const svcs = renderServices(
            'st',
            spec,
            cfg({ edge }),
            ctx({
              extensionPaths: withExt ? { 'acme-tools': `${ROOT}/st/acme-tools@cccccccccccc` } : {}
            })
          )
          for (const s of svcs) {
            const isRedis = s.Name === 'st_redis'
            const publishes = edge === 'publish' && (s.Name === 'st_web' || s.Name === 'st_all')
            expect(Object.keys(s).sort()).toEqual(
              [...SERVICE_KEYS, ...(publishes ? ['EndpointSpec'] : [])].sort()
            )
            expect(Object.keys(s.TaskTemplate.ContainerSpec).sort()).toEqual(CONTAINER_KEYS)
            const pinned = withExt && !isRedis
            expect(Object.keys(s.TaskTemplate).sort()).toEqual(
              [
                'ContainerSpec',
                'Networks',
                'Resources',
                'RestartPolicy',
                ...(pinned ? ['Placement'] : [])
              ].sort()
            )
            for (const m of s.TaskTemplate.ContainerSpec.Mounts) {
              if (m.Type === 'bind') {
                expect(Object.keys(m).sort()).toEqual(['ReadOnly', 'Source', 'Target', 'Type'])
                expect(m.ReadOnly).toBe(true)
                expect(m.Source.startsWith(`${ROOT}/`)).toBe(true)
              } else {
                expect(Object.keys(m).sort()).toEqual(['Source', 'Target', 'Type', 'VolumeOptions'])
                expect(m.Source).toMatch(/^nvh_st_(uploads|redis)$/)
              }
            }
            for (const n of s.TaskTemplate.Networks) {
              expect(Object.keys(n)).toEqual(['Target'])
              expect(edge === 'traefik' ? ['nvh_st', 'edge'] : ['nvh_st']).toContain(n.Target)
            }
            if (s.EndpointSpec) {
              expect(s.EndpointSpec).toEqual({
                Ports: [{ TargetPort: 3055, PublishedPort: 31000 }]
              })
            }
            expect(JSON.stringify(s)).not.toContain('docker.sock')
          }
        })
      }
    }
  }
})

describe('renderServices — shared deployment host pattern (phase 6)', () => {
  const sharedSpec = (over: Partial<StackSpec> = {}): StackSpec =>
    large({
      owner: { shared: 'tools' },
      environment: 'shared',
      roles: [
        { role: 'web', replicas: 2 },
        { role: 'worker', replicas: 1 }
      ],
      hostnames: ['a.apps.corp'],
      host_pattern: '*.apps.corp',
      ...over
    })
  const traefik = (s: EngineServiceSpec) =>
    Object.fromEntries(Object.entries(s.Labels).filter(([k]) => k.startsWith('traefik.')))

  it('the pattern router: escaped HostRegexp, priority=1, the web service, a wildcard TLS domain', () => {
    const web = byName(renderServices('sh', sharedSpec(), cfg(), ctx()), 'sh_web')
    const r = patternRouterName('sh')
    expect(r).toBe('nvh_pat_sh')
    expect(traefik(web)).toEqual({
      'traefik.enable': 'true',
      'traefik.swarm.network': 'edge',
      'traefik.http.routers.nvh_web_sh.rule': 'Host(`a.apps.corp`)',
      'traefik.http.routers.nvh_web_sh.entrypoints': 'websecure',
      'traefik.http.routers.nvh_web_sh.tls': 'true',
      'traefik.http.routers.nvh_web_sh.tls.certresolver': 'le',
      'traefik.http.routers.nvh_web_sh.service': 'nvh_web_sh',
      'traefik.http.routers.nvh_pat_sh.rule': 'HostRegexp(`^[a-z0-9-]+\\.apps\\.corp$`)',
      'traefik.http.routers.nvh_pat_sh.priority': '1',
      'traefik.http.routers.nvh_pat_sh.entrypoints': 'websecure',
      'traefik.http.routers.nvh_pat_sh.tls': 'true',
      'traefik.http.routers.nvh_pat_sh.tls.certresolver': 'le',
      'traefik.http.routers.nvh_pat_sh.tls.domains[0].main': '*.apps.corp',
      'traefik.http.routers.nvh_pat_sh.service': 'nvh_web_sh',
      'traefik.http.services.nvh_web_sh.loadbalancer.server.port': '3055'
    })
    // The regex as Traefik reads it: one label, dots literal, anchored.
    const re = /`(.*)`/.exec(web.Labels['traefik.http.routers.nvh_pat_sh.rule'])?.[1] ?? ''
    expect(re).toBe('^[a-z0-9-]+\\.apps\\.corp$')
    const rx = new RegExp(re)
    expect(rx.test('x.apps.corp')).toBe(true)
    expect(rx.test('a.b.apps.corp')).toBe(false)
    expect(rx.test('xapps.corp')).toBe(false)
    expect(rx.test('x.apps.corp.evil.com')).toBe(false)
  })

  it('without a cert resolver the pattern router names no TLS domain', () => {
    const web = byName(
      renderServices('sh', sharedSpec(), cfg({ certResolver: null }), ctx()),
      'sh_web'
    )
    const keys = Object.keys(web.Labels).filter((k) => k.includes('nvh_pat_sh.tls'))
    expect(keys).toEqual(['traefik.http.routers.nvh_pat_sh.tls'])
  })

  it('a pattern alone (no hostnames) still routes: pattern router + web service, no Host router', () => {
    const web = byName(renderServices('sh', sharedSpec({ hostnames: [] }), cfg(), ctx()), 'sh_web')
    const t = traefik(web)
    expect(t['traefik.http.routers.nvh_pat_sh.service']).toBe('nvh_web_sh')
    expect(t['traefik.http.services.nvh_web_sh.loadbalancer.server.port']).toBe('3055')
    expect(t['traefik.http.routers.nvh_web_sh.rule']).toBeUndefined()
    expect(web.TaskTemplate.Networks).toEqual([{ Target: 'nvh_st' }, { Target: 'edge' }])
  })

  it('a pattern is not a host claim (no LABEL_HOSTS from it)', () => {
    const web = byName(renderServices('sh', sharedSpec({ hostnames: [] }), cfg(), ctx()), 'sh_web')
    expect(web.Labels[LABEL_HOSTS]).toBeUndefined()
    const withHost = byName(renderServices('sh', sharedSpec(), cfg(), ctx()), 'sh_web')
    expect(withHost.Labels[LABEL_HOSTS]).toBe('a.apps.corp')
  })

  it('the pattern router sits only on the web (or all) service', () => {
    const svcs = renderServices('sh', sharedSpec(), cfg(), ctx())
    for (const s of svcs.filter((x) => x.Name !== 'sh_web')) {
      expect(Object.keys(s.Labels).some((k) => k.includes('nvh_pat_'))).toBe(false)
    }
    const all = renderServices(
      'sh',
      sharedSpec({ roles: [{ role: 'all', replicas: 1 }] }),
      cfg(),
      ctx()
    )
    expect(byName(all, 'sh_all').Labels['traefik.http.routers.nvh_pat_sh.priority']).toBe('1')
  })

  it('no pattern router in publish mode', () => {
    const svcs = renderServices(
      'sh',
      sharedSpec({ publish_port: 31000 }),
      cfg({ edge: 'publish' }),
      ctx()
    )
    expect(JSON.stringify(svcs)).not.toContain('nvh_pat_')
  })

  it('refuses a pattern on an app owner or a malformed one (the validator is the first line)', () => {
    expect(() =>
      renderServices('sh', large({ host_pattern: '*.apps.corp' }), cfg(), ctx())
    ).toThrow()
    for (const p of ['*.apps.corp`) || Host(`evil.com', 'apps.corp', '*.bad_name'])
      expect(() => renderServices('sh', sharedSpec({ host_pattern: p }), cfg(), ctx())).toThrow()
  })

  it("another stack's Host(`a.apps.corp`) is not HOSTNAME_TAKEN against the pattern", () => {
    const web = byName(renderServices('sh', sharedSpec({ hostnames: [] }), cfg(), ctx()), 'sh_web')
    const rules = Object.entries(web.Labels)
      .filter(([k]) => /^traefik\.http\.routers\..+\.rule$/.test(k))
      .map(([, v]) => v.toLowerCase())
    expect(rules).toHaveLength(1)
    expect(hostTaken('a.apps.corp', rules)).toBe(false)
    expect(hostTaken('apps.corp', rules)).toBe(false)
  })
})

describe('E2E B1 (P6-34): exactly one Traefik network label', () => {
  const netLabels = (s: EngineServiceSpec) =>
    Object.keys(s.Labels).filter((k) => /^traefik\.(docker|swarm)\./.test(k))

  it('Traefik v3 (the default): only traefik.swarm.network, on every routed service', () => {
    const svcs = renderServices('st', large(), cfg(), ctx())
    for (const name of ['st_web', 'st_realtime']) {
      expect(netLabels(byName(svcs, name))).toEqual(['traefik.swarm.network'])
      expect(byName(svcs, name).Labels['traefik.swarm.network']).toBe('edge')
    }
  })

  it('Traefik v2: only traefik.docker.network', () => {
    const svcs = renderServices('st', large(), cfg({ traefikVersion: 2 }), ctx())
    for (const name of ['st_web', 'st_realtime']) {
      expect(netLabels(byName(svcs, name))).toEqual(['traefik.docker.network'])
      expect(byName(svcs, name).Labels['traefik.docker.network']).toBe('edge')
    }
  })
})
