import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDockerFetchForTests } from '../docker-source.js'
import { formatContainerPorts, formatSwarmPorts, splitImage } from './engine.js'
import {
  CONFIG_DATA,
  configs,
  containers,
  IMG_NEW,
  IMG_OLD,
  inspectHealthy,
  managerInfo,
  nodes,
  plainInfo,
  secrets,
  services,
  tasks,
  workerInfo
} from './fixtures.test-data.js'
import {
  deriveHealthDetail,
  deriveHealthList,
  firstHealthyAt,
  type HealthStore,
  healthKey,
  loadHealthList,
  readTransitions,
  recordHealth,
  unhealthyCount
} from './health.js'
import { deriveSecrets, loadSecrets, splitVersion, stripObject } from './secrets.js'
import { deriveStacks, healthFromStatus, loadStacks, nodeNames } from './stacks.js'
import { certFromMetric, deriveSwarm, loadSwarm } from './swarm.js'
import { deriveUpdates, rolloutGroups } from './updates.js'

/** Map-backed stand-in for the Redis list commands the health ring uses. */
function fakeStore(): HealthStore & { lists: Map<string, string[]>; ttl: Map<string, number> } {
  const lists = new Map<string, string[]>()
  const ttl = new Map<string, number>()
  const get = (k: string) => lists.get(k) ?? []
  return {
    lists,
    ttl,
    async lindex(k, i) {
      return get(k)[i] ?? null
    },
    async lpush(k, v) {
      lists.set(k, [v, ...get(k)])
      return get(k).length
    },
    async ltrim(k, a, b) {
      lists.set(k, get(k).slice(a, b + 1))
    },
    async expire(k, s) {
      ttl.set(k, s)
    },
    async lrange(k, a, b) {
      return get(k).slice(a, b + 1)
    }
  }
}

/** Routes Engine paths to fixture bodies, as the socket proxy would answer them. */
function engine(routes: Record<string, unknown>) {
  const seen: string[] = []
  setDockerFetchForTests(async (url) => {
    const path = new URL(url).pathname
    seen.push(url)
    if (!(path in routes)) return new Response('{"message":"forbidden"}', { status: 403 })
    return new Response(JSON.stringify(routes[path]), { status: 200 })
  })
  return seen
}

const host = { name: 'staging', url: 'http://proxy:2375' }
const saved = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.DOCKER_HOSTS = 'staging=http://proxy:2375'
})
afterEach(() => {
  process.env = { ...saved }
  setDockerFetchForTests(null)
})

describe('engine helpers', () => {
  it('splits image digests and formats ports', () => {
    expect(splitImage(IMG_NEW)).toEqual({
      image: 'nodeworks/nivaro:0.2.79',
      digest: '2222222222222222'.slice(0, 12)
    })
    expect(splitImage('redis:7')).toEqual({ image: 'redis:7', digest: null })
    expect(
      formatSwarmPorts([
        { Protocol: 'tcp', TargetPort: 80, PublishedPort: 8080, PublishMode: 'host' }
      ])
    ).toEqual(['8080:80/tcp (host)'])
    expect(formatContainerPorts(containers[1].Ports)).toEqual(['3000:3000/tcp'])
  })
})

describe('#2826 stacks', () => {
  const derived = () => deriveStacks({ info: managerInfo, services, tasks, nodes, containers })

  it('groups swarm services by stack with desired vs running and failing reasons', () => {
    const s = derived()
    expect(s.swarm).toBe('manager')
    expect(s.stacks.map((g) => g.name)).toEqual(['nivaro', ''])
    const app = s.stacks[0].services.find((x) => x.name === 'nivaro_app')
    expect(app).toMatchObject({
      short_name: 'app',
      desired: 2,
      running: 2,
      image: 'nodeworks/nivaro:0.2.79',
      digest: '222222222222',
      ports: ['8080:3055/tcp'],
      failing: false,
      update_status: { state: 'updating', started_at: '2026-10-21T20:00:00Z' }
    })
    const worker = s.stacks[0].services.find((x) => x.name === 'nivaro_worker')
    expect(worker?.failing).toBe(true)
    expect(worker?.failing_reason).toContain('0 of 1 running')
    expect(worker?.failing_reason).toContain('no suitable node')
  })

  it('keeps per-slot task history newest first, with errors and node names', () => {
    const app = derived().stacks[0].services.find((x) => x.name === 'nivaro_app')
    expect(app?.tasks.map((t) => t.id)).toEqual(['tapp1new', 'tapp1old', 'tapp2old', 'tapp2fail'])
    const failed = app?.tasks.find((t) => t.id === 'tapp2fail')
    expect(failed).toMatchObject({
      state: 'failed',
      error: 'task: non-zero exit (137)',
      exit_code: 137,
      node: 'stage-mgr-2'
    })
    const worker = derived().stacks[0].services.find((x) => x.name === 'nivaro_worker')
    expect(worker?.tasks.map((t) => t.error)).toEqual([
      'no suitable node (scheduling constraints not satisfied on 3 nodes)',
      'No such container: nivaro_worker.1.tworker0'
    ])
  })

  it('treats a global service as one task per node', () => {
    const redis = derived().stacks[1].services[0]
    expect(redis).toMatchObject({ mode: 'global', desired: 2, running: 2, failing: false })
    expect(redis.tasks).toHaveLength(2)
  })

  it('shows compose projects (swarm task containers hidden on a manager) and counts', () => {
    const s = derived()
    expect(s.projects.map((p) => `${p.kind}:${p.name}`)).toEqual(['compose:grafana', 'standalone:'])
    const grafana = s.projects[0].containers
    expect(grafana.map((c) => [c.service, c.health, c.failing])).toEqual([
      ['grafana', 'unhealthy', true],
      ['migrate', null, false],
      ['renderer', null, true]
    ])
    expect(s.counts).toEqual({
      services: 3,
      running: 4,
      desired: 5,
      failing: 1,
      containers: 4,
      containers_running: 2,
      containers_failing: 2
    })
  })

  it('a worker shows its own swarm tasks as local groups; a plain host only compose', () => {
    const w = deriveStacks({
      info: workerInfo,
      services: null,
      tasks: null,
      nodes: null,
      containers
    })
    expect(w.swarm).toBe('worker')
    expect(w.projects.find((p) => p.kind === 'swarm-local')?.name).toBe('nivaro')
    const p = deriveStacks({
      info: plainInfo,
      services: null,
      tasks: null,
      nodes: null,
      containers: containers.slice(1)
    })
    expect(p.swarm).toBe('none')
    expect(p.stacks).toEqual([])
  })

  it('loads through the Docker source with services?status=true', async () => {
    const seen = engine({
      '/info': managerInfo,
      '/services': services,
      '/tasks': tasks,
      '/nodes': nodes,
      '/containers/json': containers
    })
    const s = await loadStacks(host)
    expect(s.counts.services).toBe(3)
    expect(seen.some((u) => u.includes('/services?status=true'))).toBe(true)
    expect(seen.some((u) => u.includes('/containers/json?all=true'))).toBe(true)
  })

  it('reads health from the container status line', () => {
    expect(healthFromStatus('Up 2 minutes (health: starting)')).toBe('starting')
    expect(healthFromStatus('Up 1 day')).toBeNull()
  })
})

describe('#2827 rolling updates', () => {
  const healthyAt = new Map([['c0ffee000001', '2026-10-21T20:00:45.100Z']])
  const u = () =>
    deriveUpdates({ info: managerInfo, services, tasks, nodes: nodeNames(nodes), healthyAt })

  it('lists the in-flight update first with its policy', () => {
    const r = u()
    expect(r.in_flight).toBe(true)
    const app = r.services[0]
    expect(app.name).toBe('nivaro_app')
    expect(app.in_flight).toBe(true)
    expect(app.auto_rollback).toBe(true)
    expect(app.policy).toEqual({
      order: 'start-first',
      failure_action: 'rollback',
      parallelism: 1,
      delay_ms: 10_000,
      monitor_ms: 30_000,
      max_failure_ratio: 0
    })
    expect(app.rollback_policy?.order).toBe('stop-first')
    expect(app.failure_fired).toBeNull()
  })

  it('pairs old → new per slot with time to running, healthy and start-first overlap', () => {
    const app = u().services[0]
    expect(app.replacements).toHaveLength(1)
    expect(app.replacements[0]).toMatchObject({
      slot: 's1',
      node: 'stage-mgr-1',
      old: { task_id: 'tapp1old', digest: '111111111111', state: 'shutdown' },
      new: { task_id: 'tapp1new', digest: '222222222222', state: 'running', attempts: 1 },
      to_running_ms: 30_000,
      to_healthy_ms: 45_100,
      overlap_ms: 10_000
    })
  })

  it('derives past rollouts from task history, newest first', () => {
    const app = u().services[0]
    expect(app.history.map((h) => [h.digest, h.current])).toEqual([
      ['222222222222', true],
      ['111111111111', false]
    ])
    expect(app.history[0]).toMatchObject({ duration_ms: 30_000, approx: false, tasks: 1 })
    expect(app.history[1].failed).toBe(1)
  })

  it('treats a rollback to an earlier image as a new rollout', () => {
    const t = (id: string, created: string, image: string, state = 'shutdown') => ({
      ID: id,
      ServiceID: 's',
      Slot: 1,
      CreatedAt: created,
      Spec: { ContainerSpec: { Image: image } },
      Status: { State: state, Timestamp: created }
    })
    const groups = rolloutGroups([
      t('a', '2026-10-01T00:00:00Z', IMG_OLD),
      t('b', '2026-10-02T00:00:00Z', IMG_NEW),
      t('c', '2026-10-02T00:05:00Z', IMG_OLD, 'running')
    ])
    expect(groups.map((g) => g.tasks.map((x) => x.ID))).toEqual([['a'], ['b'], ['c']])
  })

  it('reports the failure action when it fired', () => {
    const paused = {
      ...services[0],
      UpdateStatus: { State: 'paused', Message: 'update paused due to failure' },
      Spec: { ...services[0].Spec, UpdateConfig: { FailureAction: 'pause' } }
    }
    const r = deriveUpdates({ info: managerInfo, services: [paused], tasks: [], nodes: new Map() })
    expect(r.services[0].failure_fired).toBe('Paused after a task failed')
    expect(r.in_flight).toBe(false)
  })

  it('is empty off a manager', () => {
    expect(
      deriveUpdates({ info: workerInfo, services: null, tasks: null, nodes: new Map() })
    ).toEqual({
      manager: false,
      in_flight: false,
      services: []
    })
  })
})

describe('#2828 health history', () => {
  it('keeps only transitions, trimmed, with a three-day TTL', async () => {
    const s = fakeStore()
    const at = (m: number) => new Date(Date.UTC(2026, 9, 21, 10, m))
    expect(await recordHealth(s, 'staging', 'c0ffee000001aaaa', 'starting', at(0))).toBe(true)
    expect(await recordHealth(s, 'staging', 'c0ffee000001aaaa', 'starting', at(1))).toBe(false)
    await recordHealth(s, 'staging', 'c0ffee000001', 'healthy', at(2))
    await recordHealth(s, 'staging', 'c0ffee000001', 'unhealthy', at(3))
    await recordHealth(s, 'staging', 'c0ffee000001', 'healthy', at(4))
    await recordHealth(s, 'staging', 'c0ffee000001', 'unhealthy', at(5))
    const key = healthKey('staging', 'c0ffee000001aaaa')
    expect(key).toBe('nvr:infra:health:staging:c0ffee000001')
    expect(s.ttl.get(key)).toBe(3 * 24 * 3600)
    const tr = await readTransitions(s, 'staging', 'c0ffee000001')
    expect(tr.map((t) => t.status)).toEqual([
      'starting',
      'healthy',
      'unhealthy',
      'healthy',
      'unhealthy'
    ])
    expect(unhealthyCount(tr, at(4).getTime())).toBe(1)
    expect(unhealthyCount(tr, 0)).toBe(2)
  })

  it('first healthy: the engine log while complete, else the ring', () => {
    expect(firstHealthyAt(inspectHealthy, [])).toBe('2026-10-21T20:00:45.100Z')
    const full = {
      State: {
        ...inspectHealthy.State,
        Health: {
          Status: 'healthy',
          Log: Array(5).fill({ ExitCode: 0, End: '2026-10-21T21:00:00Z' })
        }
      }
    }
    expect(firstHealthyAt(full, [])).toBeNull()
    expect(
      firstHealthyAt(full, [
        { status: 'healthy', at: '2026-10-21T19:00:00Z' },
        { status: 'healthy', at: '2026-10-21T20:01:00Z' }
      ])
    ).toBe('2026-10-21T20:01:00.000Z')
  })

  it('detail: probes newest first, trimmed output, no labels or config leak', () => {
    const d = deriveHealthDetail(inspectHealthy, [], Date.parse('2026-10-21T21:00:00Z'))
    expect(d).toMatchObject({
      id: 'c0ffee000001',
      name: 'nivaro_app.1.tapp1new',
      version: '0.2.79',
      health: 'healthy',
      to_healthy_ms: 15_600
    })
    expect(d.probes[0]).toMatchObject({ exit_code: 0, duration_ms: 100, output: '{"status":"ok"}' })
    expect(JSON.stringify(d)).not.toContain('not-returned')
    const long = deriveHealthDetail(
      { Id: 'x', State: { Health: { Log: [{ Output: 'y'.repeat(2000) }] } } },
      []
    )
    expect(long.probes[0].output.length).toBeLessThan(410)
  })

  it('list: health rows, flap counts and a trend by image version', () => {
    const now = Date.parse('2026-10-21T21:00:00Z')
    const rings = new Map([
      [
        'beef00000002',
        [
          { status: 'starting' as const, at: '2026-10-21T10:00:00Z' },
          { status: 'healthy' as const, at: '2026-10-21T10:00:20Z' },
          { status: 'unhealthy' as const, at: '2026-10-21T12:00:00Z' },
          { status: 'healthy' as const, at: '2026-10-21T12:05:00Z' },
          { status: 'unhealthy' as const, at: '2026-10-21T20:00:00Z' }
        ]
      ]
    ])
    const h = deriveHealthList(containers, rings, now)
    expect(h.counts).toEqual({ with_healthcheck: 2, healthy: 1, unhealthy: 1, starting: 0 })
    expect(h.containers[0]).toMatchObject({
      name: 'grafana-grafana-1',
      health: 'unhealthy',
      unhealthy_24h: 2,
      project: 'grafana'
    })
    const g = h.trend.find((t) => t.version === '11.2.0')
    expect(g).toMatchObject({
      containers: 1,
      unhealthy_now: 1,
      unhealthy_3d: 2,
      avg_to_healthy_ms: 20_000
    })
  })

  it('reading the list samples every container into its ring', async () => {
    engine({ '/containers/json': containers })
    const s = fakeStore()
    const h = await loadHealthList(s, host)
    expect(h.containers).toHaveLength(2)
    expect([...s.lists.keys()].sort()).toEqual([
      'nvr:infra:health:staging:beef00000002',
      'nvr:infra:health:staging:c0ffee000001'
    ])
  })
})

describe('#2838 swarm internals', () => {
  const now = Date.parse('2026-10-21T21:00:00Z')

  it('reads managers, nodes and cluster settings, and warns on lost managers and down nodes', () => {
    const s = deriveSwarm({
      info: managerInfo,
      nodes,
      cluster: managerInfo.Swarm?.Cluster ?? null,
      certSeconds: null,
      now
    })
    expect(s.manager).toBe(true)
    expect(s.counts).toEqual({ nodes: 3, managers: 2, reachable_managers: 1 })
    expect(s.nodes[0]).toMatchObject({
      hostname: 'stage-mgr-1',
      leader: true,
      self: true,
      engine: '27.3.1',
      cpus: 8,
      labels: { zone: 'a' }
    })
    expect(s.cluster).toMatchObject({
      node_cert_expiry_ms: 90 * 24 * 3600 * 1000,
      task_history_limit: 5,
      autolock: false,
      dispatcher_heartbeat_ms: 5000,
      default_addr_pool: ['10.0.0.0/8']
    })
    expect(s.warnings.join(' ')).toContain('Only 1 of 2 managers are reachable')
    expect(s.warnings.join(' ')).toContain('stage-wrk-1 is down — heartbeat failure')
    expect(s.warnings.join(' ').toLowerCase()).not.toContain('autolock')
    expect(s.cert_source).toBe('not-collected')
  })

  it('cert expiry from the host-facts metric, warning under 14 days', () => {
    const in10 = now / 1000 + 10 * 86400 + 60
    expect(certFromMetric(in10, now)).toMatchObject({ days_left: 10, warn: true })
    expect(certFromMetric(now / 1000 + 60 * 86400 + 60, now)?.warn).toBe(false)
    expect(certFromMetric(20 * 86400 + 60, now)?.days_left).toBe(20)
    expect(certFromMetric(null)).toBeNull()
    const s = deriveSwarm({ info: managerInfo, nodes: null, cluster: null, certSeconds: in10, now })
    expect(s.cert_source).toBe('metric')
    expect(s.warnings.join(' ')).toContain('expires in 10 days')
  })

  it('never copies join tokens out of /swarm and degrades when /swarm is off', async () => {
    const infoNoCluster = { ...managerInfo, Swarm: { ...managerInfo.Swarm, Cluster: undefined } }
    engine({
      '/info': infoNoCluster,
      '/nodes': nodes,
      '/swarm': {
        ...managerInfo.Swarm?.Cluster,
        JoinTokens: { Worker: 'SWMTKN-1-worker-secret', Manager: 'SWMTKN-1-manager-secret' }
      }
    })
    const s = await loadSwarm(host, new Map())
    expect(s.cluster?.task_history_limit).toBe(5)
    expect(JSON.stringify(s)).not.toContain('SWMTKN')
    setDockerFetchForTests(null)
    engine({ '/info': infoNoCluster, '/nodes': nodes })
    const off = await loadSwarm(host, new Map())
    expect(off.cluster).toBeNull()
    expect(off.nodes).toHaveLength(3)
  })
})

describe('#2839 secret and config usage', () => {
  it('groups versions, flags unused objects and services on an older version', () => {
    const r = deriveSecrets({ secrets, configs, services })
    const db = r.groups.find((g) => g.kind === 'secret' && g.base === 'nivaro_db_password')
    expect(db?.versions.map((v) => [v.name, v.latest, v.unused])).toEqual([
      ['nivaro_db_password_v2', true, false],
      ['nivaro_db_password_v1', false, false]
    ])
    expect(db?.stale).toEqual([
      {
        service_id: 'svcapi',
        service: 'nivaro_worker',
        uses: 'nivaro_db_password_v1',
        latest: 'nivaro_db_password_v2'
      }
    ])
    expect(r.groups.find((g) => g.base === 'legacy_token')?.versions[0].unused).toBe(true)
    const traefik = r.groups.find((g) => g.kind === 'config')
    expect(traefik?.stale[0]).toMatchObject({
      service: 'nivaro_app',
      uses: 'traefik_yml_v1',
      latest: 'traefik_yml_v2'
    })
    expect(traefik?.versions[0].used_by).toEqual([])
    expect(traefik?.versions[1].used_by[0].target).toBe('/etc/traefik.yml')
    expect(r.counts).toEqual({ secrets: 3, configs: 2, unused: 2, stale: 2 })
  })

  it('splits version suffixes', () => {
    expect(splitVersion('db_password_v12')).toEqual({ base: 'db_password', version: 12 })
    expect(splitVersion('tls-cert.V2')).toEqual({ base: 'tls-cert', version: 2 })
    expect(splitVersion('plain')).toEqual({ base: 'plain', version: null })
  })

  it('never returns config Data (configs can hold credentials)', async () => {
    expect(JSON.stringify(stripObject(configs[0]))).not.toContain(CONFIG_DATA)
    expect(JSON.stringify(deriveSecrets({ secrets, configs, services }))).not.toContain(CONFIG_DATA)
    engine({
      '/info': managerInfo,
      '/services': services,
      '/tasks': tasks,
      '/nodes': nodes,
      '/secrets': secrets,
      '/configs': configs
    })
    const loaded = await loadSecrets(host)
    expect(loaded.counts.configs).toBe(2)
    const json = JSON.stringify(loaded)
    expect(json).not.toContain(CONFIG_DATA)
    expect(json).not.toContain('"Data"')
  })

  it('degrades when the proxy refuses the configs section', async () => {
    engine({
      '/info': managerInfo,
      '/services': services,
      '/tasks': tasks,
      '/nodes': nodes,
      '/secrets': secrets
    })
    const r = await loadSecrets(host)
    expect(r.unavailable).toEqual(['configs'])
    expect(r.counts.secrets).toBe(3)
  })
})
