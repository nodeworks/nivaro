import { beforeEach, describe, expect, it, vi } from 'vitest'

const hosts = vi.hoisted(() => ({ list: [{ name: 'prod1', url: 'http://x' }] as any[] }))
const m = vi.hoisted(() => ({
  loadStacks: vi.fn(),
  loadContainers: vi.fn(),
  loadVolumes: vi.fn(),
  loadImages: vi.fn(),
  loadSecrets: vi.fn(),
  loadSwarm: vi.fn(),
  readCertMetrics: vi.fn(),
  loadUpdates: vi.fn(),
  loadHealthList: vi.fn(),
  loadHealthDetail: vi.fn(),
  logsReport: vi.fn(),
  rebootReport: vi.fn(),
  readHostFacts: vi.fn(),
  loadProxyView: vi.fn(),
  traefikConfigured: vi.fn(),
  resourcesAvailable: vi.fn(),
  loadContainerResources: vi.fn(),
  gitlabTarget: vi.fn(),
  loadGitlabHealth: vi.fn(),
  driftStatus: vi.fn()
}))

vi.mock('../../../services/docker-source.js', () => ({ dockerHosts: () => hosts.list }))
vi.mock('../../../services/infra-drift/store.js', () => ({ driftStatus: m.driftStatus }))
vi.mock('../../../services/infra-swarm/stacks.js', () => ({ loadStacks: m.loadStacks }))
vi.mock('../../../services/docker-inventory.js', () => ({
  loadContainers: m.loadContainers,
  loadVolumes: m.loadVolumes,
  loadImages: m.loadImages
}))
vi.mock('../../../services/infra-swarm/secrets.js', () => ({ loadSecrets: m.loadSecrets }))
vi.mock('../../../services/infra-swarm/swarm.js', () => ({
  loadSwarm: m.loadSwarm,
  readCertMetrics: m.readCertMetrics
}))
vi.mock('../../../services/infra-swarm/updates.js', () => ({ loadUpdates: m.loadUpdates }))
vi.mock('../../../services/infra-swarm/health.js', () => ({
  loadHealthList: m.loadHealthList,
  loadHealthDetail: m.loadHealthDetail
}))
vi.mock('../../../services/infra-host-checks.js', () => ({
  logsReport: m.logsReport,
  rebootReport: m.rebootReport
}))
vi.mock('../../../services/host-facts.js', () => ({
  readHostFacts: m.readHostFacts,
  patchStatus: (f: any) => ({
    level: 'warning',
    kernel_running: f.kernel_running,
    kernel_installed: f.kernel_installed,
    reboot_required: true,
    days_since_boot: 40,
    boot_free_bytes: 50,
    security_updates: 3,
    notes: ['reboot needed']
  }),
  hungStatus: () => ({
    level: 'ok',
    headline: null,
    dstate_processes: 0,
    hung_task_events: 0,
    nfs_not_responding: [],
    suspect_mount: null
  })
}))
vi.mock('../../../services/traefik-source.js', () => ({
  loadProxyView: m.loadProxyView,
  traefikConfigured: m.traefikConfigured
}))
vi.mock('../../../services/container-resources.js', () => ({
  resourcesAvailable: m.resourcesAvailable,
  loadContainerResources: m.loadContainerResources
}))
vi.mock('../../../services/gitlab-health.js', () => ({
  gitlabTarget: m.gitlabTarget,
  loadGitlabHealth: m.loadGitlabHealth
}))

import {
  executeInfraTool,
  INFRA_TOOL_NAMES,
  INFRA_TOOLS,
  InfraToolError,
  infraAvailable,
  uptimeSeconds
} from '../../../services/infra-ai-tools.js'

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  hosts.list = [{ name: 'prod1', url: 'http://x' }]
  m.traefikConfigured.mockReturnValue(true)
  m.resourcesAvailable.mockReturnValue(true)
})

const hostOf = (out: any) => out.hosts[0]

describe('through the telemetry tools', () => {
  it('runs without a telemetry store and is offered to Ask AI', async () => {
    const { ASK_TOOLS, executeTelemetryTool } = await import('../../../services/telemetry-ai.js')
    m.gitlabTarget.mockResolvedValue(null)
    expect(ASK_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining(['search_logs', 'infra_proxy'])
    )
    await expect(executeTelemetryTool('infra_gitlab', {})).resolves.toMatchObject({
      configured: false
    })
    await expect(executeTelemetryTool('request_stats', {})).rejects.toThrow(/not configured/)
  })
})

describe('infrastructure tool definitions', () => {
  it('are read-only by name, have schemas, and cover the questions', () => {
    for (const t of INFRA_TOOLS) {
      expect(t.name).toMatch(/^infra_/)
      expect(t.name).not.toMatch(/delete|write|create|set_|restart|exec|prune|propose/)
      expect(t.input_schema.type).toBe('object')
      expect(t.description?.length).toBeGreaterThan(40)
    }
    expect(INFRA_TOOL_NAMES.size).toBe(13)
  })
  it('rejects an unknown tool', async () => {
    await expect(executeInfraTool('infra_exec', {})).rejects.toThrow(InfraToolError)
  })
  it('reports availability from the sources', () => {
    expect(infraAvailable()).toBe(true)
    hosts.list = []
    m.traefikConfigured.mockReturnValue(false)
    m.resourcesAvailable.mockReturnValue(false)
    expect(infraAvailable()).toBe(false)
  })
})

describe('without a Docker host', () => {
  it('every Docker-backed tool answers configured: false', async () => {
    hosts.list = []
    for (const name of [
      'infra_stacks',
      'infra_containers',
      'infra_updates',
      'infra_storage',
      'infra_secrets',
      'infra_logs',
      'infra_reboot'
    ]) {
      const out: any = await executeInfraTool(name, {})
      expect(out.configured, name).toBe(false)
      expect(out.note).toMatch(/DOCKER_HOSTS/)
    }
    expect(m.loadStacks).not.toHaveBeenCalled()
  })
  it('proxy, resources, hosts and gitlab say what is missing', async () => {
    m.traefikConfigured.mockReturnValue(false)
    m.resourcesAvailable.mockReturnValue(false)
    m.readHostFacts.mockResolvedValue({
      store: false,
      error: null,
      facts: new Map(),
      signals: new Map()
    })
    m.gitlabTarget.mockResolvedValue(null)
    for (const name of ['infra_proxy', 'infra_resources', 'infra_hosts', 'infra_gitlab'])
      expect(((await executeInfraTool(name, {})) as any).configured, name).toBe(false)
  })
})

describe('stacks', () => {
  it('lists failing services with their failed tasks and failing containers', async () => {
    m.loadStacks.mockResolvedValue({
      swarm: 'manager',
      counts: { services: 2, running: 3, desired: 4, failing: 1 },
      stacks: [
        {
          name: 'nivaro',
          services: [
            { short_name: 'ok', failing: false, tasks: [] },
            {
              short_name: 'api',
              mode: 'replicated',
              running: 0,
              desired: 1,
              failing: true,
              failing_reason: 'task failed: no suitable node',
              update_status: { state: 'paused', message: 'update paused due to failure' },
              tasks: [
                {
                  slot: 1,
                  node: 'n1',
                  state: 'failed',
                  error: 'no suitable node',
                  exit_code: null,
                  state_at: 't'
                },
                { slot: 1, node: 'n1', state: 'running', error: null }
              ]
            }
          ]
        }
      ],
      projects: [
        {
          name: 'gitlab',
          containers: [
            {
              name: 'g1',
              failing: true,
              state: 'exited',
              status: 'Exited (1) 2 hours ago',
              health: null,
              exit_code: 1
            },
            { name: 'g2', failing: false }
          ]
        }
      ]
    })
    const out: any = await executeInfraTool('infra_stacks', {})
    const h = hostOf(out)
    expect(h.failing_services).toHaveLength(1)
    expect(h.failing_services[0]).toMatchObject({
      stack: 'nivaro',
      service: 'api',
      reason: expect.stringContaining('no suitable node')
    })
    expect(h.failing_services[0].failed_tasks).toHaveLength(1)
    expect(h.failing_containers[0]).toMatchObject({ container: 'g1', exit_code: 1 })
  })
  it('one failing host does not hide the others and an unknown host is refused', async () => {
    hosts.list = [
      { name: 'a', url: 'x' },
      { name: 'b', url: 'x' }
    ]
    m.loadStacks.mockImplementation(async (h: any) => {
      if (h.name === 'a') throw new Error('Docker host a did not answer')
      return { swarm: 'none', counts: {}, stacks: [], projects: [] }
    })
    const out: any = await executeInfraTool('infra_stacks', {})
    expect(out.hosts[0].error).toMatch(/did not answer/)
    expect(out.hosts[1].swarm).toBe('none')
    await expect(executeInfraTool('infra_stacks', { host: 'zzz' })).rejects.toThrow(/Unknown host/)
  })
})

describe('containers', () => {
  const row = (name: string, state: string, status: string) => ({
    name,
    state,
    status,
    owner: { label: `stack ${name}` },
    restart_policy: 'any'
  })
  it('finds containers started in the last day, not-running ones and flappers', async () => {
    m.loadContainers.mockResolvedValue([
      row('fresh', 'running', 'Up 5 minutes'),
      row('old', 'running', 'Up 3 days'),
      row('dead', 'exited', 'Exited (137) 1 hour ago')
    ])
    m.loadHealthList.mockResolvedValue({
      counts: { with_healthcheck: 2, healthy: 1, unhealthy: 1, starting: 0 },
      containers: [
        {
          id: 'a',
          name: 'flappy',
          stack: 's',
          service: 'x',
          version: '1',
          health: 'unhealthy',
          unhealthy_24h: 4,
          last_change_at: 't'
        },
        { id: 'b', name: 'fine', health: 'healthy', unhealthy_24h: 0 }
      ],
      trend: [{ version: '1', unhealthy_now: 1, unhealthy_3d: 5 }]
    })
    m.loadHealthDetail.mockResolvedValue({
      restart_count: 3,
      started_at: 't',
      failing_streak: 2,
      probes: [{ exit_code: 1, output: 'curl: (7) failed Bearer abcdefghijklmnop' }]
    })
    const out: any = await executeInfraTool('infra_containers', {}, { redis: {} as any })
    const h = hostOf(out)
    expect(h.started_last_24h.rows.map((r: any) => r.name)).toEqual(['fresh'])
    expect(h.not_running.rows[0]).toMatchObject({ name: 'dead' })
    expect(h.health.unhealthy_or_flapping.rows.map((r: any) => r.name)).toEqual(['flappy'])
    expect(h.health.worst_detail[0]).toMatchObject({ name: 'flappy', restart_count: 3 })
    expect(JSON.stringify(out)).not.toContain('abcdefghijklmnop')
  })
  it('says so when Redis is missing and still lists the container state', async () => {
    m.loadContainers.mockResolvedValue([row('fresh', 'running', 'Up 2 hours')])
    const h = hostOf(await executeInfraTool('infra_containers', {}))
    expect(h.health_history).toMatch(/not available/)
    expect(h.started_last_24h.total).toBe(1)
    expect(m.loadHealthList).not.toHaveBeenCalled()
  })
  it('parses uptime text', () => {
    expect(uptimeSeconds('Up 5 minutes')).toBe(300)
    expect(uptimeSeconds('Up About an hour (healthy)')).toBe(3600)
    expect(uptimeSeconds('Up 2 days')).toBe(172_800)
    expect(uptimeSeconds('Exited (0) 2 hours ago')).toBeNull()
  })
})

describe('updates, swarm, secrets', () => {
  it('updates lists only services that need attention', async () => {
    m.loadUpdates.mockResolvedValue({
      manager: true,
      in_flight: false,
      services: [
        {
          name: 'quiet',
          replacements: [],
          history: [],
          update: { state: 'completed' },
          policy: {},
          in_flight: false
        },
        {
          name: 'api',
          stack: 'n',
          image: 'i',
          update: { state: 'rollback_completed', message: 'rolled back' },
          in_flight: false,
          policy: { failure_action: 'rollback' },
          failure_fired: 'Rolled back',
          history: [{ started_at: 't', duration_ms: 5, failed: 1, tasks: 2 }],
          replacements: [
            { slot: '1', node: 'n1', new: { state: 'failed', error: 'oom', attempts: 3 } }
          ]
        }
      ]
    })
    const h = hostOf(await executeInfraTool('infra_updates', {}))
    expect(h.attention).toHaveLength(1)
    expect(h.attention[0]).toMatchObject({ service: 'api', failure_fired: 'Rolled back' })
    expect(h.attention[0].problem_replacements[0]).toMatchObject({ error: 'oom', attempts: 3 })
  })
  it('swarm never returns labels, addresses or cluster details', async () => {
    m.readCertMetrics.mockResolvedValue(new Map())
    m.loadSwarm.mockResolvedValue({
      state: 'active',
      manager: true,
      counts: { nodes: 1 },
      nodes: [
        {
          hostname: 'n1',
          role: 'manager',
          availability: 'active',
          state: 'ready',
          reachability: 'reachable',
          leader: true,
          engine: '27',
          addr: '10.0.0.1',
          labels: { token: 'sekret-join-token' }
        }
      ],
      cluster: { id: 'c', autolock: true },
      cert: { expires_at: 't', days_left: 5, warn: true },
      cert_source: 'metric',
      warnings: ['cert expires soon']
    })
    const out = await executeInfraTool('infra_swarm', {})
    const text = JSON.stringify(out)
    expect(text).not.toMatch(/sekret|10\.0\.0\.1|autolock/)
    expect(hostOf(out).cert.days_left).toBe(5)
  })
  it('secrets list names and used-by, never contents', async () => {
    m.loadSecrets.mockResolvedValue({
      manager: true,
      counts: { secrets: 2, configs: 0, unused: 1, stale: 1 },
      unavailable: ['configs'],
      groups: [
        {
          kind: 'secret',
          base: 'db_password',
          versions: [
            { name: 'db_password_v1', latest: false, unused: false, used_by: [{ service: 'api' }] },
            { name: 'db_password_v2', latest: true, unused: true, used_by: [] }
          ],
          stale: [{ service: 'api', uses: 'db_password_v1', latest: 'db_password_v2' }]
        }
      ]
    })
    const h = hostOf(await executeInfraTool('infra_secrets', {}))
    expect(h.groups[0]).toMatchObject({
      name: 'db_password',
      used_by: ['api'],
      unused_versions: ['db_password_v2']
    })
    expect(Object.keys(h.groups[0])).not.toContain('data')
  })
})

describe('disk, logs, reboot, hosts', () => {
  it('storage ranks volumes and unused images', async () => {
    m.loadVolumes.mockResolvedValue({
      reclaimable_bytes: 10,
      orphan_count: 1,
      volumes: [
        {
          name: 'small',
          kind: 'volume',
          size_bytes: 1,
          owner: null,
          orphaned: false,
          backup: 'none',
          flags: []
        },
        {
          name: 'big',
          kind: 'volume',
          size_bytes: 900,
          owner: 's',
          orphaned: true,
          backup: 'none',
          flags: [{ code: 'orphaned' }]
        }
      ]
    })
    m.loadImages.mockResolvedValue({
      totals: { unused: { count: 1, bytes: 5 } },
      build_cache: { total_bytes: 1 },
      prune: { plain_bytes: 7, all_bytes: 12 },
      images: [
        { tags: ['a:1'], status: 'in-use', size_bytes: 9, unique_bytes: 9 },
        { tags: ['b:1'], status: 'unused', size_bytes: 5, unique_bytes: 5 }
      ]
    })
    const h = hostOf(await executeInfraTool('infra_storage', {}))
    expect(h.volumes.largest[0].name).toBe('big')
    expect(h.images.largest_unused.map((i: any) => i.tags[0])).toEqual(['b:1'])
    expect(h.images.prune_frees_bytes).toBe(7)
  })
  it('logs names containers without rotation and filters by host', async () => {
    m.logsReport.mockResolvedValue({
      hosts: [
        {
          host: 'prod1',
          error: null,
          data: {
            facts_collected: true,
            filesystem: { mountpoint: '/var', avail_bytes: 1, size_bytes: 10 },
            total_bytes: 5,
            growth_per_day: 2,
            days_until_full: 0.5,
            unbounded: 1,
            containers: [
              {
                name: 'loud',
                bytes: 5,
                growth_per_day: 2,
                driver: 'json-file',
                max_size: null,
                unbounded: true
              },
              {
                name: 'ok',
                bytes: 1,
                growth_per_day: 0,
                driver: 'local',
                max_size: null,
                unbounded: false
              }
            ]
          }
        },
        { host: 'prod2', data: null, error: 'down' }
      ]
    })
    const out: any = await executeInfraTool('infra_logs', { host: 'prod1' })
    expect(out.hosts).toHaveLength(1)
    expect(out.hosts[0]).toMatchObject({ days_until_full: 0.5, unbounded_containers: ['loud'] })
  })
  it('reboot returns only the containers at risk', async () => {
    m.rebootReport.mockResolvedValue({
      hosts: [
        {
          host: 'prod1',
          error: null,
          data: {
            summary: '1 stays down',
            counts: { comes_back: 1, stays_down: 1, may_break: 0 },
            stopped: 0,
            temporary: [{ name: 'runner-1', image: 'node', why: 'GitLab CI job container' }],
            facts_collected: true,
            host_notes: [],
            containers: [
              {
                name: 'a',
                verdict: 'comes_back',
                managed_by: 'swarm',
                reason: 'ok',
                remote_mounts: []
              },
              {
                name: 'b',
                verdict: 'stays_down',
                managed_by: 'none',
                restart_policy: 'no',
                reason: 'no restart policy',
                remote_mounts: []
              }
            ]
          }
        }
      ]
    })
    const out: any = await executeInfraTool('infra_reboot', {})
    expect(out.hosts[0].at_risk.map((c: any) => c.name)).toEqual(['b'])
    expect(out.hosts[0].temporary_not_judged).toEqual([
      { name: 'runner-1', why: 'GitLab CI job container' }
    ])
  })
  it('hosts summarises patch and IO verdicts from host facts', async () => {
    m.readHostFacts.mockResolvedValue({
      store: true,
      error: null,
      facts: new Map([
        [
          'prod1',
          {
            collected_at: 1_700_000_000_000,
            stale: false,
            kernel_running: '5.1',
            kernel_installed: '5.2'
          }
        ]
      ]),
      signals: new Map()
    })
    const out: any = await executeInfraTool('infra_hosts', {})
    expect(out.hosts[0]).toMatchObject({
      host: 'prod1',
      reboot_required: true,
      kernel_installed: '5.2'
    })
  })
})

describe('proxy, resources, gitlab', () => {
  it('proxy lists routers with no healthy backend', async () => {
    m.loadProxyView.mockResolvedValue({
      version: 'v3',
      routers: [
        { name: 'good@docker', no_healthy_backend: false, servers: [], healthy: 1, errors: [] },
        {
          name: 'bad@docker',
          rule: 'Host(`x`)',
          service: 'bad',
          no_healthy_backend: true,
          servers: [{}, {}],
          healthy: 0,
          status: 'enabled',
          errors: [],
          rps_5xx: 2,
          rps: 3
        }
      ],
      services: [{ name: 'bad', servers: [{}, {}], healthy: 0, used_by: ['bad@docker'] }],
      shadowing: [{ sentence: 'a hides b' }],
      provider_errors: []
    })
    const out: any = await executeInfraTool('infra_proxy', {})
    expect(out.no_healthy_backend.rows.map((r: any) => r.router)).toEqual(['bad@docker'])
    expect(out.returning_5xx[0].router).toBe('bad@docker')
    expect(out.shadowed).toEqual(['a hides b'])
  })
  it('resources lists throttled and near-limit containers', async () => {
    m.loadContainerResources.mockResolvedValue([
      {
        container: 'a',
        host: 'h',
        flags: ['throttled'],
        throttled_share: 0.4,
        mem_share: 0.1,
        oom_events: 0
      },
      {
        container: 'b',
        host: 'h',
        flags: ['memory'],
        throttled_share: 0,
        mem_share: 0.95,
        oom_events: 1
      },
      { container: 'c', host: 'h', flags: [], oom_events: 0 }
    ])
    const out: any = await executeInfraTool('infra_resources', { window: '7d' })
    expect(m.loadContainerResources).toHaveBeenCalledWith('7d', null, false)
    expect(out.throttled.map((r: any) => r.container)).toEqual(['a'])
    expect(out.near_memory_limit.map((r: any) => r.container)).toEqual(['b'])
    expect(out.oom_kills.map((r: any) => r.container)).toEqual(['b'])
  })
  it('gitlab reports failing checks, flagged runners and unavailable parts', async () => {
    m.gitlabTarget.mockResolvedValue({ base: 'http://g' })
    m.loadGitlabHealth.mockResolvedValue({
      configured: true,
      version: { ok: true, error: null, data: { version: '17.0' } },
      health: {
        ok: true,
        error: null,
        data: {
          liveness: true,
          readiness: {
            ok: false,
            checks: [
              { name: 'db', status: 'failed' },
              { name: 'redis', status: 'ok' }
            ]
          }
        }
      },
      runners: {
        ok: true,
        error: null,
        data: {
          counts: { online: 1, offline: 1 },
          runners: [{ name: 'r1', state: 'offline', flagged: true, contacted_at: null }]
        }
      },
      pending: { ok: false, error: 'No token on the GitLab component', data: null },
      container: null
    })
    const out: any = await executeInfraTool('infra_gitlab', {})
    expect(out.health.failing_checks).toEqual([{ name: 'db', status: 'failed' }])
    expect(out.runners.flagged[0].name).toBe('r1')
    expect(out.pending_jobs.unavailable).toMatch(/No token/)
  })
})

describe('infra_drift', () => {
  it('lists drift without any env value, secret or not', async () => {
    m.driftStatus.mockResolvedValue({
      available: true,
      cloud: false,
      docker_configured: true,
      source_note: null,
      stacks: [
        {
          stack: 'efp',
          environment: 'production',
          baseline: { version: '0.3.4', release: 'r1', source: 'posted', services: 2, at: 'x' },
          last_check: { at: 'y', status: 'drift', message: null },
          live_note: null,
          drift: 3,
          findings: [
            {
              service: 'efp_api',
              field: 'env.LOG_LEVEL',
              kind: 'changed',
              expected: 'info',
              actual: 'debug',
              secret: false,
              origin: 'hand-run',
              first_seen: 'z'
            },
            {
              service: 'efp_api',
              field: 'env.DB_PASSWORD',
              kind: 'changed',
              expected: 'set',
              actual: 'set',
              secret: true,
              origin: 'hand-run',
              first_seen: 'z'
            },
            {
              service: 'efp_worker',
              field: 'replicas',
              kind: 'changed',
              expected: '1',
              actual: '3',
              secret: false,
              origin: 'hand-run',
              first_seen: 'z'
            }
          ]
        }
      ]
    })
    const out: any = await executeInfraTool('infra_drift', {})
    expect(out.configured).toBe(true)
    const f = out.stacks[0].findings
    expect(f[0]).not.toHaveProperty('actual')
    expect(f[1]).not.toHaveProperty('expected')
    expect(f[2]).toMatchObject({ expected: '1', actual: '3', origin: 'hand-run' })
    expect(JSON.stringify(out)).not.toContain('debug')
  })

  it('says when drift is not set up', async () => {
    m.driftStatus.mockResolvedValue({ available: false, stacks: [] })
    await expect(executeInfraTool('infra_drift', {})).resolves.toMatchObject({ configured: false })
  })
})
