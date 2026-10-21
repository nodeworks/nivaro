import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DockerUnavailableError,
  dockerGet,
  dockerHosts,
  forEachDockerHost,
  maskArgs,
  ownerOf,
  sanitizeDockerValue,
  setDockerFetchForTests
} from './docker-source.js'

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.DOCKER_HOSTS
  delete process.env.DOCKER_API_URL
  delete process.env.CLOUD_META_DB_URL
  delete process.env.DOCKER_API_TOKEN
})
afterEach(() => {
  process.env = { ...saved }
  setDockerFetchForTests(null)
})

describe('dockerHosts', () => {
  it('parses DOCKER_HOSTS, dropping bad entries and duplicates', () => {
    process.env.DOCKER_HOSTS =
      'staging=http://a:2375/, bad, x=ftp://y, staging=http://b, prod=https://c'
    expect(dockerHosts()).toEqual([
      { name: 'staging', url: 'http://a:2375' },
      { name: 'prod', url: 'https://c' }
    ])
  })

  it('falls back to DOCKER_API_URL and is empty in cloud mode', () => {
    process.env.DOCKER_API_URL = 'http://proxy:2375'
    expect(dockerHosts()).toEqual([{ name: 'local', url: 'http://proxy:2375' }])
    process.env.CLOUD_META_DB_URL = 'x'
    expect(dockerHosts()).toEqual([])
  })
})

describe('dockerGet', () => {
  const host = { name: 'h', url: 'http://proxy' }

  it('refuses paths outside the allowlist', async () => {
    await expect(dockerGet(host, '/containers/abc/logs')).rejects.toBeInstanceOf(
      DockerUnavailableError
    )
    await expect(dockerGet(host, '/exec/1/start')).rejects.toBeInstanceOf(DockerUnavailableError)
    await expect(dockerGet(host, '/containers/../exec')).rejects.toBeInstanceOf(
      DockerUnavailableError
    )
  })

  it('GETs, encodes filters, caches and names a proxy refusal', async () => {
    const calls: string[] = []
    setDockerFetchForTests(async (url, init) => {
      calls.push(`${init.method} ${url}`)
      if (url.includes('/secrets')) return new Response('no', { status: 403 })
      return new Response(JSON.stringify([{ Id: '1' }]), { status: 200 })
    })
    const q = { filters: { label: ['a=b'] } }
    expect(await dockerGet(host, '/containers/json', { query: q })).toEqual([{ Id: '1' }])
    await dockerGet(host, '/containers/json', { query: q })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(
      `GET http://proxy/containers/json?filters=${encodeURIComponent('{"label":["a=b"]}')}`
    )
    await expect(dockerGet(host, '/secrets')).rejects.toThrow(/section not enabled/)
  })

  it('reports each host on its own', async () => {
    process.env.DOCKER_HOSTS = 'a=http://a,b=http://b'
    setDockerFetchForTests(async (url) =>
      url.startsWith('http://a') ? new Response('{}') : new Response('x', { status: 500 })
    )
    const out = await forEachDockerHost((h) => dockerGet(h, '/info'))
    expect(out[0]).toEqual({ host: 'a', data: {}, error: null })
    expect(out[1].error).toMatch(/HTTP 500/)
  })
})

it('ownerOf reads stack and compose labels', () => {
  expect(ownerOf({ 'com.docker.stack.namespace': 's', 'com.docker.compose.project': 'p' })).toEqual(
    { stack: 's', service: null, compose_project: 'p', compose_service: null }
  )
})

describe('never-read sections', () => {
  const host = { name: 'h', url: 'http://proxy' }
  it('refuses /swarm (join tokens) and /configs (config contents)', async () => {
    let called = false
    setDockerFetchForTests(async () => {
      called = true
      return new Response('{}')
    })
    for (const p of ['/swarm', '/swarm/unlockkey', '/configs', '/configs/abc'])
      await expect(dockerGet(host, p)).rejects.toThrow(/Path not allowed/)
    expect(called).toBe(false)
  })
})

describe('sanitizeDockerValue', () => {
  const host = { name: 'h', url: 'http://proxy' }
  const serve = (body: unknown) =>
    setDockerFetchForTests(async () => new Response(JSON.stringify(body), { status: 200 }))

  it('strips Env and masks secret labels and arguments in a container inspect', async () => {
    serve({
      Id: 'c1',
      Path: 'docker-entrypoint.sh',
      Args: ['redis-server', '--requirepass', 'hunter2', '--port', '6379'],
      State: { Status: 'running' },
      Config: {
        Image: 'redis:7',
        Env: ['REDIS_PASSWORD=hunter2', 'PATH=/usr/bin'],
        Cmd: ['redis-server', '--requirepass=hunter2'],
        Entrypoint: ['env', 'API_TOKEN=abc123', 'run'],
        Labels: {
          'com.docker.compose.project': 'cache',
          'app.db_password': 'hunter2',
          'traefik.http.middlewares.a.basicauth.users': 'admin:$apr1$hash'
        }
      },
      Mounts: [{ Source: '/srv/redis', Destination: '/data' }]
    })
    const v = await dockerGet<any>(host, '/containers/c1/json')
    const json = JSON.stringify(v)
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('abc123')
    expect(json).not.toContain('$apr1$')
    expect(v.Config.Env).toBeUndefined()
    expect(v.Args).toEqual(['redis-server', '--requirepass', '***', '--port', '6379'])
    expect(v.Config.Cmd).toEqual(['redis-server', '--requirepass=***'])
    expect(v.Config.Entrypoint).toEqual(['env', 'API_TOKEN=***', 'run'])
    expect(v.Config.Labels).toEqual({
      'com.docker.compose.project': 'cache',
      'app.db_password': '***',
      'traefik.http.middlewares.a.basicauth.users': '***'
    })
    expect(v.Mounts[0].Source).toBe('/srv/redis')
  })

  it('strips Env from service specs and tasks, and Spec.Data anywhere', async () => {
    serve([
      {
        ID: 's1',
        Spec: {
          Name: 'app',
          Labels: { 'com.docker.stack.namespace': 'nivaro' },
          TaskTemplate: {
            ContainerSpec: {
              Image: 'app:1',
              Env: ['DB_PASS=x1'],
              Args: ['--secret', 'x2', '--verbose'],
              Command: ['node']
            }
          }
        }
      },
      {
        ID: 't1',
        ServiceID: 's1',
        Spec: { ContainerSpec: { Image: 'app:1', Env: ['SESSION_SECRET=x3'] } },
        Status: { State: 'running' }
      },
      { ID: 'cfg', Spec: { Name: 'traefik_yml', Data: 'cGFzc3dvcmQ=' } }
    ])
    const v = await dockerGet<any[]>(host, '/services')
    const json = JSON.stringify(v)
    for (const s of ['x1', 'x2', 'x3', 'cGFzc3dvcmQ=']) expect(json).not.toContain(s)
    expect(v[0].Spec.TaskTemplate.ContainerSpec.Args).toEqual(['--secret', '***', '--verbose'])
    expect(v[0].Spec.Labels['com.docker.stack.namespace']).toBe('nivaro')
    expect(v[2].Spec.Name).toBe('traefik_yml')
  })

  it('keeps /info Swarm.Cluster settings and drops any token fields', async () => {
    serve({
      Name: 'mgr',
      Swarm: {
        LocalNodeState: 'active',
        ControlAvailable: true,
        Cluster: {
          ID: 'c',
          Spec: {
            Orchestration: { TaskHistoryRetentionLimit: 5 },
            CAConfig: { NodeCertExpiry: 7776000000000000 },
            EncryptionConfig: { AutoLockManagers: false }
          },
          TLSInfo: { TrustRoot: '-----BEGIN CERTIFICATE-----' },
          RootRotationInProgress: false,
          JoinTokens: { Worker: 'SWMTKN-1-w', Manager: 'SWMTKN-1-m' }
        }
      },
      UnlockKey: 'SWMKEY-1-x'
    })
    const v = await dockerGet<any>(host, '/info')
    expect(v.Swarm.Cluster.Spec.Orchestration.TaskHistoryRetentionLimit).toBe(5)
    expect(v.Swarm.Cluster.TLSInfo.TrustRoot).toContain('CERTIFICATE')
    expect(JSON.stringify(v)).not.toMatch(/SWMTKN|SWMKEY/)
  })

  it('masks secret flags in a one-line container summary Command', () => {
    expect(sanitizeDockerValue({ Command: 'postgres -c ssl=on --password secret1' })).toEqual({
      Command: 'postgres -c ssl=on --password ***'
    })
    expect(maskArgs(['--port', '80', '--token=abc'])).toEqual(['--port', '80', '--token=***'])
  })
})
