import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deriveContainers,
  deriveImages,
  deriveProvenance,
  deriveVolumes,
  type EngineContainer,
  type EngineDf,
  type EngineImage,
  type EngineInspect,
  loadContainers,
  matchesAnyGlob,
  releasesBehind,
  revisionUrl
} from './docker-inventory.js'
import { setDockerFetchForTests } from './docker-source.js'

const NOW = Date.parse('2026-10-21T12:00:00Z') / 1000
const DAY = 86_400

const compose = (dir: string, project = 'docker', service = 'x') => ({
  'com.docker.compose.project': project,
  'com.docker.compose.service': service,
  'com.docker.compose.project.working_dir': dir
})

const ctr = (over: Partial<EngineContainer> & { Id: string }): EngineContainer => ({
  Names: [`/${over.Id}`],
  Image: 'nginx:1.27',
  ImageID: 'sha256:aaa',
  State: 'running',
  Status: 'Up 2 hours',
  Created: NOW - 2 * DAY,
  Labels: {},
  Mounts: [],
  NetworkSettings: { Networks: { bridge: {} } },
  ...over
})

describe('deriveContainers (#2830)', () => {
  const list: EngineContainer[] = [
    ctr({ Id: 'nivaro', Labels: compose('/opt/docker', 'docker', 'nivaro') }),
    ctr({ Id: 'redis', Labels: compose('/opt/docker', 'docker', 'redis') }),
    ctr({ Id: 'grafana', Labels: compose('/opt/monitoring', 'docker', 'grafana') }),
    ctr({ Id: 'adhoc', Labels: {} }),
    ctr({
      Id: 'web.1.abc',
      Labels: { 'com.docker.stack.namespace': 'prod', 'com.docker.swarm.service.name': 'prod_web' }
    }),
    ctr({
      Id: 'old',
      State: 'exited',
      Status: 'Exited (0) 12 days ago',
      Labels: compose('/opt/docker', 'docker')
    }),
    ctr({
      Id: 'recent',
      State: 'exited',
      Status: 'Exited (1) 2 hours ago',
      Labels: compose('/opt/docker', 'docker')
    })
  ]
  const inspects: Record<string, EngineInspect | null> = {
    old: {
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      State: { FinishedAt: new Date((NOW - 12 * DAY) * 1000).toISOString() }
    },
    recent: {
      HostConfig: { RestartPolicy: { Name: '' } },
      State: { FinishedAt: new Date((NOW - 7200) * 1000).toISOString() }
    },
    nivaro: { HostConfig: { RestartPolicy: { Name: 'always' } } }
  }
  const rows = deriveContainers(list, inspects, NOW)
  const by = (n: string) => rows.find((r) => r.name === n)!

  it('resolves the owner', () => {
    expect(by('nivaro').owner).toMatchObject({ kind: 'compose', label: 'docker / nivaro' })
    expect(by('web.1.abc').owner).toMatchObject({ kind: 'stack', label: 'prod / prod_web' })
    expect(by('adhoc').owner).toMatchObject({ kind: 'none', label: 'No owner' })
  })

  it('flags an unowned container', () => {
    expect(by('adhoc').flags.map((f) => f.code)).toEqual(['no-owner'])
    expect(by('nivaro').flags).toEqual([])
  })

  it('flags stopped for more than 7 days only', () => {
    expect(by('old').stopped_days).toBe(12)
    expect(by('old').flags.map((f) => f.code)).toEqual(['stopped-long'])
    expect(by('recent').flags).toEqual([])
    expect(by('nivaro').stopped_days).toBeNull()
  })

  it('says plainly that --remove-orphans would remove a foreign-dir container', () => {
    const f = by('grafana').flags.find((x) => x.code === 'compose-foreign-dir')!
    expect(f.text).toContain('--remove-orphans')
    expect(f.text).toContain('/opt/monitoring')
    expect(f.text).toContain('/opt/docker')
    expect(by('redis').flags).toEqual([])
  })

  it('reads the restart policy from inspect; empty means no; missing inspect is null', () => {
    expect(by('nivaro').restart_policy).toBe('always')
    expect(by('recent').restart_policy).toBe('no')
    expect(by('redis').restart_policy).toBeNull()
  })

  it('lists flagged rows first', () => {
    expect(rows[0].flags.length).toBeGreaterThan(0)
    expect(rows.at(-1)!.flags.length).toBe(0)
  })

  it('loadContainers survives one failed inspect', async () => {
    setDockerFetchForTests(async (url) => {
      if (url.includes('/containers/json'))
        return new Response(JSON.stringify([ctr({ Id: 'a' }), ctr({ Id: 'b' })]), { status: 200 })
      if (url.endsWith('/containers/a/json'))
        return new Response(JSON.stringify({ HostConfig: { RestartPolicy: { Name: 'always' } } }), {
          status: 200
        })
      return new Response('x', { status: 500 })
    })
    try {
      const out = await loadContainers({ name: 'h', url: 'http://proxy' })
      expect(out.find((r) => r.name === 'a')!.restart_policy).toBe('always')
      expect(out.find((r) => r.name === 'b')!.restart_policy).toBeNull()
    } finally {
      setDockerFetchForTests(null)
    }
  })
})

describe('deriveVolumes (#2832)', () => {
  const df: EngineDf = {
    Volumes: [
      {
        Name: 'pgdata',
        Driver: 'local',
        Labels: { 'com.docker.compose.project': 'docker' },
        UsageData: { Size: 5_000_000_000, RefCount: 1 }
      },
      {
        Name: 'redisdata',
        Driver: 'local',
        Labels: { 'nivaro.backup': 'true' },
        UsageData: { Size: 1000, RefCount: 1 }
      },
      { Name: 'uploads', Driver: 'local', Labels: {}, UsageData: { Size: 300, RefCount: 1 } },
      {
        Name: 'old_cache',
        Driver: 'local',
        Labels: {},
        UsageData: { Size: 2_000_000, RefCount: 0 }
      },
      {
        Name: 'big_orphan',
        Driver: 'local',
        Labels: {},
        UsageData: { Size: 9_000_000_000, RefCount: 0 }
      },
      { Name: 'f'.repeat(64), Driver: 'local', Labels: {}, UsageData: { Size: -1, RefCount: 0 } }
    ]
  }
  const containers: EngineContainer[] = [
    ctr({
      Id: 'db',
      Mounts: [{ Type: 'volume', Name: 'pgdata' }],
      Labels: compose('/opt/docker', 'docker', 'db')
    }),
    ctr({ Id: 'redis', Mounts: [{ Type: 'volume', Name: 'redisdata' }] }),
    ctr({
      Id: 'app',
      Mounts: [
        { Type: 'volume', Name: 'uploads' },
        { Type: 'bind', Source: '/srv/config', Destination: '/config' }
      ]
    })
  ]
  const inv = deriveVolumes(df, containers, {
    backedUp: ['pg*', '/srv/config'],
    lastWrite: { pgdata: 1_790_000_000 }
  })
  const by = (n: string) => inv.volumes.find((v) => v.name === n)!

  it('orphans sort first by size desc and total the reclaimable bytes', () => {
    expect(inv.volumes.slice(0, 3).map((v) => v.name)).toEqual([
      'big_orphan',
      'old_cache',
      'f'.repeat(64)
    ])
    expect(inv.orphan_count).toBe(3)
    expect(inv.reclaimable_bytes).toBe(9_002_000_000)
  })

  it('treats size -1 as unknown and marks anonymous volumes', () => {
    expect(by('f'.repeat(64)).size_bytes).toBeNull()
    expect(by('f'.repeat(64)).anonymous).toBe(true)
  })

  it('backup coverage: env glob, label, none; uncovered + in use is flagged', () => {
    expect(by('pgdata').backup).toBe('env')
    expect(by('redisdata').backup).toBe('label')
    expect(by('uploads').backup).toBe('none')
    expect(by('uploads').flags.map((f) => f.code)).toEqual(['unbacked-in-use'])
    expect(by('pgdata').flags).toEqual([])
    expect(by('old_cache').flags.map((f) => f.code)).toEqual(['orphaned'])
  })

  it('names the owner from labels or the using container, and the containers', () => {
    expect(by('pgdata').owner).toBe('docker')
    expect(by('pgdata').containers).toEqual(['db'])
  })

  it('lists bind mounts with backup coverage and carries last write when known', () => {
    const b = by('/srv/config')
    expect(b).toMatchObject({ kind: 'bind', containers: ['app'], backup: 'env', flags: [] })
    expect(by('pgdata').last_write).toBe(1_790_000_000)
    expect(by('uploads').last_write).toBeNull()
    expect(inv.last_write_known).toBe(true)
  })
})

describe('matchesAnyGlob', () => {
  it('matches names and globs without regex injection', () => {
    expect(matchesAnyGlob('pgdata', ['pg*'])).toBe(true)
    expect(matchesAnyGlob('pgdata', ['pgdata'])).toBe(true)
    expect(matchesAnyGlob('pgdata', ['pg.ata'])).toBe(false)
    expect(matchesAnyGlob('x', [])).toBe(false)
  })
})

describe('deriveImages (#2833)', () => {
  const img = (over: Partial<EngineImage> & { Id: string }): EngineImage => ({
    RepoTags: ['x:1'],
    Created: NOW - DAY,
    Size: 1000,
    SharedSize: 200,
    Containers: 0,
    ...over
  })
  const df: EngineDf = {
    LayersSize: 5000,
    Images: [
      img({ Id: 'sha256:aaa', RepoTags: ['nginx:1.27'], Containers: 1 }),
      img({ Id: 'sha256:bbb', RepoTags: ['redis:7'], Size: 3000, SharedSize: 0 }),
      img({ Id: 'sha256:ccc', RepoTags: ['<none>:<none>'], Size: 700, SharedSize: 100 }),
      img({ Id: 'sha256:ddd', RepoTags: null, Size: 500, SharedSize: -1 })
    ],
    BuildCache: [
      { ID: '1', InUse: false, Size: 4000 },
      { ID: '2', InUse: true, Size: 1000 }
    ]
  }
  const containers = [
    ctr({ Id: 'web', ImageID: 'sha256:aaa' }),
    ctr({ Id: 'job-1', State: 'exited', Status: 'Exited (0) 3 days ago', ImageID: 'sha256:aaa' })
  ]
  const networks = [
    { Id: '1', Name: 'bridge', Driver: 'bridge', Scope: 'local', Containers: {} },
    { Id: '2', Name: 'docker_default', Driver: 'bridge', Scope: 'local', Containers: {} },
    { Id: '3', Name: 'stale_net', Driver: 'bridge', Scope: 'local', Containers: {} },
    { Id: '4', Name: 'overlay1', Driver: 'overlay', Scope: 'swarm', Containers: {} }
  ]
  const withNet = [
    ...containers.slice(0, 1),
    { ...containers[1], NetworkSettings: { Networks: { docker_default: {} } } }
  ]
  const inv = deriveImages(df, withNet, networks)

  it('classifies in use / unused / dangling by unique size', () => {
    expect(inv.totals.in_use).toEqual({ count: 1, bytes: 800 })
    expect(inv.totals.unused).toEqual({ count: 1, bytes: 3000 })
    expect(inv.totals.dangling).toEqual({ count: 2, bytes: 600 + 500 })
    expect(inv.totals.layers_bytes).toBe(5000)
    expect(inv.images[0].id).toBe('sha256:bbb')
  })

  it('build cache total and reclaimable (not in use)', () => {
    expect(inv.build_cache).toEqual({ total_bytes: 5000, reclaimable_bytes: 4000, entries: 2 })
  })

  it('prune preview names the stopped containers a prune would delete', () => {
    expect(inv.prune.stopped_containers.map((c) => c.name)).toEqual(['job-1'])
  })

  it('prune preview: dangling images, unused networks (not builtin/swarm/attached), cache', () => {
    expect(inv.prune.dangling_images).toHaveLength(2)
    expect(inv.prune.unused_networks.map((n) => n.name)).toEqual(['stale_net'])
    expect(inv.prune.build_cache).toEqual({ bytes: 4000, entries: 1 })
  })

  it('-a adds unused images and their bytes', () => {
    expect(inv.prune.unused_images.map((i) => i.name)).toEqual(['redis:7'])
    expect(inv.prune.plain_bytes).toBe(1100 + 4000)
    expect(inv.prune.all_bytes).toBe(1100 + 4000 + 3000)
  })
})

describe('provenance (#2840)', () => {
  it('releasesBehind compares against this API version', () => {
    expect(releasesBehind('0.2.76', '0.2.79')).toEqual({
      behind: { kind: 'patch', n: 3 },
      ahead: false
    })
    expect(releasesBehind('0.1.9', '0.2.79').behind).toEqual({ kind: 'minor', n: 1 })
    expect(releasesBehind('0.2.79', '0.2.79')).toEqual({ behind: null, ahead: false })
    expect(releasesBehind('0.2.80', '0.2.79').ahead).toBe(true)
    expect(releasesBehind('latest', '0.2.79')).toEqual({ behind: null, ahead: false })
  })

  it('revisionUrl builds a commit link only from an http(s) source', () => {
    expect(revisionUrl('https://github.com/a/b.git', 'abc123')).toBe(
      'https://github.com/a/b/commit/abc123'
    )
    expect(revisionUrl('git@github.com:a/b.git', 'abc')).toBeNull()
    expect(revisionUrl(undefined, 'abc')).toBeNull()
  })

  const images: EngineImage[] = [
    {
      Id: 'sha256:n1',
      RepoTags: ['nodeworks/nivaro:0.2.76'],
      RepoDigests: ['nodeworks/nivaro@sha256:dead'],
      Created: NOW - 5 * DAY,
      Labels: {
        'org.opencontainers.image.revision': 'abc1234',
        'org.opencontainers.image.version': '0.2.76',
        'org.opencontainers.image.created': new Date((NOW - 5 * DAY) * 1000).toISOString(),
        'org.opencontainers.image.source': 'https://github.com/nodeworks/nivaro'
      }
    },
    { Id: 'sha256:n2', RepoTags: ['nodeworks/nivaro:latest'], Labels: {} },
    { Id: 'sha256:r1', RepoTags: ['redis:7'], Labels: {} },
    { Id: 'sha256:o1', RepoTags: ['registry.example/efp-ops:2.1'], Labels: {} },
    { Id: 'sha256:o2', RepoTags: null, Labels: {} }
  ]
  const containers = [
    ctr({ Id: 'nivaro', Image: 'nodeworks/nivaro:0.2.76', ImageID: 'sha256:n1' }),
    ctr({ Id: 'nivaro2', Image: 'nodeworks/nivaro:latest', ImageID: 'sha256:n2' }),
    ctr({ Id: 'redis', Image: 'redis:7', ImageID: 'sha256:r1' }),
    ctr({ Id: 'efp', Image: 'registry.example/efp-ops:2.1', ImageID: 'sha256:o1' }),
    ctr({ Id: 'ghost', Image: 'sha256:o2deadbeef0000', ImageID: 'sha256:o2' }),
    ctr({ Id: 'stopped', State: 'exited', Image: 'nodeworks/nivaro:0.2.76', ImageID: 'sha256:n1' })
  ]
  const rows = deriveProvenance(containers, images, {
    ownImages: ['nodeworks/nivaro', 'registry.example/efp'],
    ownVersion: '0.2.79',
    nowS: NOW
  })
  const by = (n: string) => rows.find((r) => r.container === n)!

  it('lists running containers with OCI labels or an own-image prefix only', () => {
    expect(rows.map((r) => r.container).sort()).toEqual(['efp', 'nivaro', 'nivaro2'])
  })

  it('a labelled Nivaro image: tag, digest, revision link, build age, 3 behind', () => {
    expect(by('nivaro')).toMatchObject({
      tag: '0.2.76',
      digest: 'sha256:dead',
      revision: 'abc1234',
      revision_url: 'https://github.com/nodeworks/nivaro/commit/abc1234',
      version: '0.2.76',
      age_s: 5 * DAY,
      releases_behind: { kind: 'patch', n: 3 },
      flags: []
    })
  })

  it('flags :latest and no revision label on own images', () => {
    expect(
      by('nivaro2')
        .flags.map((f) => f.code)
        .sort()
    ).toEqual(['latest-tag', 'no-revision'])
    expect(by('efp').flags.map((f) => f.code)).toEqual(['no-revision'])
    expect(by('nivaro2').flags.find((f) => f.code === 'no-revision')!.text).toContain(
      'not built by the release pipeline'
    )
  })

  it('flags an untagged image when the image prefix is configured', () => {
    const r = deriveProvenance(
      [ctr({ Id: 'ghost', Image: 'registry.example/efp@sha256:abc', ImageID: 'sha256:o2' })],
      images,
      { ownImages: ['registry.example/efp'], ownVersion: '0.2.79', nowS: NOW }
    )
    expect(r[0].flags.map((f) => f.code)).toContain('untagged')
  })
})

beforeEach(() => {
  delete process.env.INFRA_BACKED_UP_VOLUMES
})
afterEach(() => setDockerFetchForTests(null))
