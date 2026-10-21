import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDockerFetchForTests } from './docker-source.js'
import { type HostMount, resetHostFactsCacheForTests } from './host-facts.js'
import {
  daysUntilFull,
  judgeLogConfig,
  judgeReboot,
  logsReport,
  rebootReport,
  summarizeReboot
} from './infra-host-checks.js'
import { setStoreFetchForTests } from './telemetry-store.js'

const MOUNTS: HostMount[] = [
  { mountpoint: '/mnt/data', fstype: 'nfs4', nofail: false, docker_waits: false },
  { mountpoint: '/mnt/safe', fstype: 'nfs', nofail: true, docker_waits: true }
]

describe('judgeReboot', () => {
  const base = { name: 'x', serviceCondition: undefined, mounts: [], hostMounts: MOUNTS }

  it('swarm tasks come back unless the service restart condition is none', () => {
    const labels = {
      'com.docker.swarm.service.name': 'app_api',
      'com.docker.stack.namespace': 'app'
    }
    expect(
      judgeReboot({ ...base, labels, restartPolicy: 'no', serviceCondition: 'on-failure' })
    ).toMatchObject({ verdict: 'comes_back', managed_by: 'swarm', stack: 'app' })
    expect(
      judgeReboot({ ...base, labels, restartPolicy: 'no', serviceCondition: null }).verdict
    ).toBe('comes_back')
    expect(
      judgeReboot({ ...base, labels, restartPolicy: 'no', serviceCondition: 'none' }).verdict
    ).toBe('stays_down')
  })

  it('plain and compose containers follow their restart policy', () => {
    const compose = { 'com.docker.compose.project': 'gitlab', 'com.docker.compose.service': 'web' }
    expect(judgeReboot({ ...base, labels: compose, restartPolicy: 'always' })).toMatchObject({
      verdict: 'comes_back',
      managed_by: 'compose',
      stack: 'gitlab',
      service: 'web'
    })
    expect(judgeReboot({ ...base, restartPolicy: 'unless-stopped' }).verdict).toBe('comes_back')
    expect(judgeReboot({ ...base, restartPolicy: 'on-failure' }).verdict).toBe('stays_down')
    expect(judgeReboot({ ...base, restartPolicy: '' })).toMatchObject({
      verdict: 'stays_down',
      restart_policy: 'no',
      managed_by: 'none'
    })
  })

  it('may come back broken on a remote mount Docker does not wait for', () => {
    const r = judgeReboot({
      ...base,
      restartPolicy: 'always',
      mounts: [
        { Source: '/mnt/data/uploads', Destination: '/app/uploads' },
        { Source: '/mnt/safe/x', Destination: '/x' },
        { Source: '/srv/local', Destination: '/l' }
      ]
    })
    expect(r.verdict).toBe('may_break')
    expect(r.reason).toMatch(/\/mnt\/data/)
    expect(r.remote_mounts.map((m) => m.mountpoint)).toEqual(['/mnt/data', '/mnt/safe'])
    // A container that stays down anyway is reported as staying down.
    expect(
      judgeReboot({ ...base, restartPolicy: 'no', mounts: [{ Source: '/mnt/data/a' }] }).verdict
    ).toBe('stays_down')
  })
})

describe('summarizeReboot', () => {
  it('counts verdicts, orders the worst first and notes mounts without nofail', () => {
    const a = judgeReboot({
      name: 'b',
      restartPolicy: 'always',
      mounts: [],
      hostMounts: [],
      serviceCondition: undefined
    })
    const b = judgeReboot({
      name: 'a',
      restartPolicy: 'no',
      mounts: [],
      hostMounts: [],
      serviceCondition: undefined
    })
    const s = summarizeReboot([a, b], 3, {
      host: 'h',
      collected_at: 1,
      mounts: MOUNTS
    } as never)
    expect(s.counts).toEqual({ comes_back: 1, stays_down: 1, may_break: 0 })
    expect(s.containers.map((c) => c.name)).toEqual(['a', 'b'])
    expect(s.stopped).toBe(3)
    expect(s.summary).toBe('1 of 2 running containers come back after a reboot; 1 stays down.')
    expect(s.host_notes).toHaveLength(1)
    expect(s.host_notes[0]).toMatch(/\/mnt\/data .* no nofail/)
  })

  it('says when host facts are missing', () => {
    const s = summarizeReboot([], 0, null)
    expect(s.facts_collected).toBe(false)
    expect(s.summary).toBe('No running containers.')
    expect(s.host_notes[0]).toMatch(/not collected/)
  })
})

describe('log config', () => {
  it('flags json-file without max-size only', () => {
    expect(judgeLogConfig({ Type: 'json-file', Config: {} }).unbounded).toBe(true)
    expect(
      judgeLogConfig({ Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } })
    ).toEqual({ driver: 'json-file', max_size: '10m', max_file: '3', unbounded: false })
    expect(judgeLogConfig({ Type: 'local' }).unbounded).toBe(false)
    expect(judgeLogConfig(undefined)).toEqual({
      driver: null,
      max_size: null,
      max_file: null,
      unbounded: false
    })
  })

  it('projects days until the filesystem is full', () => {
    expect(daysUntilFull(10e9, 1e9)).toBe(10)
    expect(daysUntilFull(10e9, 0)).toBeNull()
    expect(daysUntilFull(null, 1)).toBeNull()
  })
})

// ── Reports against fake Docker + store ────────────────────────────────────────────────────

const CONTAINERS = [
  {
    Id: 'c1',
    Names: ['/web'],
    Image: 'nginx',
    State: 'running',
    Labels: {},
    Mounts: [{ Type: 'bind', Source: '/mnt/data/www', Destination: '/usr/share/nginx' }]
  },
  {
    Id: 'c2',
    Names: ['/app_api.1.xyz'],
    Image: 'api',
    State: 'running',
    Labels: { 'com.docker.swarm.service.name': 'app_api', 'com.docker.stack.namespace': 'app' },
    Mounts: []
  },
  { Id: 'c3', Names: ['/job'], Image: 'job', State: 'running', Labels: {}, Mounts: [] },
  { Id: 'c4', Names: ['/old'], Image: 'old', State: 'exited', Labels: {}, Mounts: [] }
]

const INSPECT: Record<string, unknown> = {
  c1: {
    Id: 'c1',
    HostConfig: { RestartPolicy: { Name: 'always' }, LogConfig: { Type: 'json-file', Config: {} } }
  },
  c2: {
    Id: 'c2',
    HostConfig: {
      RestartPolicy: { Name: '' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '50m', 'max-file': '3' } }
    }
  },
  c3: { Id: 'c3', HostConfig: { RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'local' } } },
  c4: { Id: 'c4', HostConfig: { RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file' } } }
}

function fakeDocker() {
  setDockerFetchForTests(async (url) => {
    const path = new URL(url).pathname
    const body =
      path === '/containers/json'
        ? CONTAINERS
        : path === '/services'
          ? [
              {
                ID: 's1',
                Spec: { Name: 'app_api', TaskTemplate: { RestartPolicy: { Condition: 'any' } } }
              }
            ]
          : path === '/info'
            ? { DockerRootDir: '/var/lib/docker' }
            : INSPECT[path.split('/')[2]]
    return body
      ? new Response(JSON.stringify(body), { status: 200 })
      : new Response('', { status: 404 })
  })
}

function fakeStore() {
  const sample = (labels: Record<string, string>, v: number) => ({
    metric: labels,
    value: [0, String(v)]
  })
  setStoreFetchForTests(async (_url, init) => {
    const q = new URLSearchParams(String(init.body)).get('query') ?? ''
    let result: unknown[] = []
    if (q.startsWith('last_over_time({__name__'))
      result = [
        sample(
          {
            __name__: 'nivaro_host_mount_nofail',
            host: 'staging',
            mountpoint: '/mnt/data',
            fstype: 'nfs4'
          },
          0
        ),
        sample(
          {
            __name__: 'nivaro_host_docker_waits_for_mounts',
            host: 'staging',
            mountpoint: '/mnt/data'
          },
          0
        ),
        sample(
          { __name__: 'nivaro_host_container_log_bytes', host: 'staging', container: 'web' },
          5e9
        ),
        sample(
          { __name__: 'nivaro_host_container_log_bytes', host: 'staging', container: 'job' },
          1e6
        ),
        sample(
          { __name__: 'nivaro_host_facts_last_run_seconds', host: 'staging' },
          Date.now() / 1000
        )
      ]
    else if (q.includes('increase(nivaro_host_container_log_bytes'))
      result = [sample({ host: 'staging', container: 'web' }, 2e9)]
    else if (q.includes('node_filesystem_avail_bytes'))
      result = [
        sample({ host: 'staging', mountpoint: '/' }, 50e9),
        sample({ host: 'staging', mountpoint: '/var' }, 20e9)
      ]
    return new Response(JSON.stringify({ data: { result } }), { status: 200 })
  })
}

describe('reports', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.CLOUD_META_DB_URL
    process.env.DOCKER_HOSTS = 'staging=http://proxy:2375'
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    resetHostFactsCacheForTests()
    fakeDocker()
    fakeStore()
  })
  afterEach(() => {
    process.env = { ...saved }
    setDockerFetchForTests(null)
    setStoreFetchForTests(null)
    resetHostFactsCacheForTests()
  })

  it('rebootReport judges every running container per host', async () => {
    const { hosts } = await rebootReport()
    expect(hosts).toHaveLength(1)
    const h = hosts[0].data
    expect(hosts[0].error).toBeNull()
    expect(h?.facts_collected).toBe(true)
    expect(h?.stopped).toBe(1)
    const v = Object.fromEntries((h?.containers ?? []).map((c) => [c.name, c.verdict]))
    expect(v).toEqual({ web: 'may_break', 'app_api.1.xyz': 'comes_back', job: 'stays_down' })
    expect(h?.summary).toBe(
      '1 of 3 running containers come back after a reboot; 1 stays down, 1 may come back broken.'
    )
  })

  it('logsReport joins Docker log config with sizes, growth and free space', async () => {
    const { hosts } = await logsReport()
    const h = hosts[0].data
    expect(h?.filesystem?.mountpoint).toBe('/var')
    expect(h?.growth_per_day).toBe(2e9)
    expect(h?.days_until_full).toBe(10)
    expect(h?.unbounded).toBe(2)
    expect(h?.containers[0]).toMatchObject({
      name: 'web',
      unbounded: true,
      bytes: 5e9,
      growth_per_day: 2e9
    })
    expect(h?.containers.find((c) => c.name === 'job')).toMatchObject({
      driver: 'local',
      unbounded: false,
      bytes: 1e6
    })
  })

  it('a host that does not answer reports its error', async () => {
    setDockerFetchForTests(async () => new Response('', { status: 403 }))
    const { hosts } = await rebootReport()
    expect(hosts[0].data).toBeNull()
    expect(hosts[0].error).toMatch(/refused/)
  })
})
