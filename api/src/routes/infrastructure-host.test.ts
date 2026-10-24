import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDockerFetchForTests } from '../services/docker-source.js'
import { resetHostFactsCacheForTests } from '../services/host-facts.js'
import { listReadinessChecks } from '../services/readiness.js'
import { setStoreFetchForTests } from '../services/telemetry-store.js'
import {
  hostHungIoCheck,
  hostsReport,
  infrastructureHostRoutes,
  rebootSurvivabilityCheck
} from './infrastructure-host.js'

const saved = { ...process.env }

function store(samples: Array<{ metric: Record<string, string>; value: number }>) {
  setStoreFetchForTests(async (_url, init) => {
    const q = new URLSearchParams(String(init.body)).get('query') ?? ''
    const result = q.startsWith('last_over_time({__name__')
      ? samples.map((s) => ({ metric: s.metric, value: [0, String(s.value)] }))
      : []
    return new Response(JSON.stringify({ data: { result } }), { status: 200 })
  })
}

function docker(containers: unknown[], inspect: Record<string, unknown>) {
  setDockerFetchForTests(async (url) => {
    const path = new URL(url).pathname
    const body = path === '/containers/json' ? containers : inspect[path.split('/')[2]]
    return body
      ? new Response(JSON.stringify(body), { status: 200 })
      : new Response('', { status: 404 })
  })
}

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.DOCKER_HOSTS
  delete process.env.DOCKER_API_URL
  delete process.env.TELEMETRY_STORE_URL
  resetHostFactsCacheForTests()
})
afterEach(() => {
  process.env = { ...saved }
  setDockerFetchForTests(null)
  setStoreFetchForTests(null)
  resetHostFactsCacheForTests()
})

describe('infrastructure host routes', () => {
  it('registers the routes and both readiness checks', async () => {
    const app = Fastify()
    await app.register(infrastructureHostRoutes)
    const r = await app.inject({ method: 'GET', url: '/hosts' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual({ store: false, error: null, hosts: [] })
    const ids = listReadinessChecks().map((c) => c.id)
    expect(ids).toContain('reboot-survivability')
    expect(ids).toContain('host-hung-io')
    await app.close()
  })

  it('lists docker hosts with no facts as not collected', async () => {
    process.env.DOCKER_HOSTS = 'staging=http://proxy:2375'
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    store([])
    const r = await hostsReport()
    expect(r.hosts).toEqual([
      expect.objectContaining({
        host: 'staging',
        docker: true,
        collected_at: null,
        stale: true,
        patch: expect.objectContaining({ level: 'unknown' }),
        hung: expect.objectContaining({ level: 'unknown' })
      })
    ])
  })
})

describe('readiness checks', () => {
  it('reboot-survivability skips without Docker and warns on a container that stays down', async () => {
    expect((await rebootSurvivabilityCheck.run()).status).toBe('skip')
    process.env.DOCKER_HOSTS = 'staging=http://proxy:2375'
    docker(
      [
        { Id: 'a', Names: ['/cron'], State: 'running', Labels: {}, Mounts: [] },
        { Id: 'b', Names: ['/web'], State: 'running', Labels: {}, Mounts: [] }
      ],
      {
        a: { Id: 'a', HostConfig: { RestartPolicy: { Name: 'no' } } },
        b: { Id: 'b', HostConfig: { RestartPolicy: { Name: 'always' } } }
      }
    )
    const r = await rebootSurvivabilityCheck.run()
    expect(r.status).toBe('warn')
    expect(r.detail).toBe('1 of 2 running container(s) would stay down after a reboot.')
    expect(r.blockers?.[0]).toMatch(/^staging \/ cron: No restart policy/)
  })

  it('reboot-survivability does not judge CI job and --rm containers (a deploy-time build)', async () => {
    process.env.DOCKER_HOSTS = 'staging=http://proxy:2375'
    docker(
      [
        { Id: 'b', Names: ['/web'], State: 'running', Labels: {}, Mounts: [] },
        {
          Id: 'r',
          Names: ['/runner-abc-project-12-concurrent-0-build'],
          State: 'running',
          Labels: {
            'com.gitlab.gitlab-runner.job.id': '991',
            'com.gitlab.gitlab-runner.type': 'build'
          },
          Mounts: []
        },
        { Id: 'n', Names: ['/build-efp-ops'], State: 'running', Labels: {}, Mounts: [] }
      ],
      {
        b: { Id: 'b', HostConfig: { RestartPolicy: { Name: 'always' } } },
        r: { Id: 'r', HostConfig: { RestartPolicy: { Name: 'no' } } },
        n: { Id: 'n', HostConfig: { AutoRemove: true, RestartPolicy: { Name: 'no' } } }
      }
    )
    expect(await rebootSurvivabilityCheck.run()).toEqual({
      status: 'pass',
      detail:
        'All 1 running container(s) come back after a reboot; 2 temporary container(s) not judged.'
    })
  })

  it('reboot-survivability passes when everything comes back', async () => {
    process.env.DOCKER_HOSTS = 'staging=http://proxy:2375'
    docker([{ Id: 'b', Names: ['/web'], State: 'running', Labels: {}, Mounts: [] }], {
      b: { Id: 'b', HostConfig: { RestartPolicy: { Name: 'unless-stopped' } } }
    })
    expect(await rebootSurvivabilityCheck.run()).toMatchObject({ status: 'pass' })
  })

  it('host-hung-io skips without facts and warns on a hung host', async () => {
    expect((await hostHungIoCheck.run()).status).toBe('skip')
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    store([])
    resetHostFactsCacheForTests()
    expect((await hostHungIoCheck.run()).status).toBe('skip')
    store([
      {
        metric: { __name__: 'nivaro_host_nfs_not_responding', host: 'prod', server: 'nas01' },
        value: 1
      },
      {
        metric: { __name__: 'nivaro_host_facts_last_run_seconds', host: 'prod' },
        value: Date.now() / 1000
      }
    ])
    resetHostFactsCacheForTests()
    const r = await hostHungIoCheck.run()
    expect(r.status).toBe('warn')
    expect(r.blockers).toEqual(['prod: NFS server nas01 is not responding.'])
  })
})
