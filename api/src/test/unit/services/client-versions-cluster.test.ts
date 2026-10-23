import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_DATA_KEY,
  type ClientData,
  groupClientVersions,
  listClusterClients,
  makeBuildJudge,
  olderClientIds,
  SETTLE_MS,
  staleBuildsByUser
} from '../../../services/client-versions-cluster.js'

vi.mock('../../../version.js', () => ({ NIVARO_VERSION: '0.3.9' }))

function client(
  id: string,
  user: string,
  app: string,
  build: string,
  loaded: number,
  api = '0.3.9'
): { id: string } & ClientData {
  return {
    id,
    app,
    user: { id: user, name: user },
    node: null,
    version: { build, api, tab: id, loaded }
  }
}

// Loads well before "now", so nothing is inside the settle window unless a test says so.
const T0 = 1_700_000_000_000
const NOW = T0 + 24 * 3600_000
const judge = (list: Parameters<typeof makeBuildJudge>[0], roster: string[] = []) =>
  makeBuildJudge(list, { roster, now: NOW, self: '0.3.9' })

describe('groupClientVersions', () => {
  it('judges current from the newest load and lists who is on each build', () => {
    const list = [
      client('s1', 'ana', 'efp-new', 'b1', T0),
      client('s2', 'bob', 'efp-new', 'b2', T0 + 1000),
      client('s3', 'cat', 'efp-new', 'b1', T0 + 10)
    ]
    const groups = groupClientVersions(list, judge(list))
    const old = groups.find((g) => g.build === 'b1')!
    const cur = groups.find((g) => g.build === 'b2')!
    expect(cur).toMatchObject({ current: true, older: null, sockets: 1, users: 1 })
    expect(old).toMatchObject({ current: false, older: 'build', sockets: 2, users: 2 })
    expect(old.people.map((p) => p.name)).toEqual(['ana', 'cat'])
  })

  it('a tab on the current build but loaded against an older API is older', () => {
    const list = [client('s1', 'ana', 'admin', 'b2', T0, '0.3.8')]
    const groups = groupClientVersions(list, judge(list))
    expect(groups[0]).toMatchObject({ older: 'api', current: false })
  })

  it('dev builds are never judged', () => {
    const list = [
      client('s1', 'ana', 'admin', 'dev', T0),
      client('s2', 'bob', 'admin', 'b2', T0 + 5)
    ]
    const groups = groupClientVersions(list, judge(list))
    expect(groups.find((g) => g.build === 'dev')?.older).toBeNull()
  })
})

describe('staleBuildsByUser / olderClientIds', () => {
  const list = [
    client('s1', 'ana', 'efp-new', 'b1', T0),
    client('s2', 'ana', 'efp-new', 'b1', T0 + 1),
    client('s3', 'ana', 'admin', 'a2', T0 + 1),
    client('s4', 'bob', 'efp-new', 'b2', T0 + 1000)
  ]

  it('only people with an old tab appear, one entry per app + build', () => {
    const stale = staleBuildsByUser(list, judge(list))
    expect([...stale.keys()]).toEqual(['ANA'])
    expect(stale.get('ANA')).toEqual([
      { app: 'efp-new', build: 'b1', current_build: 'b2', reason: 'build', tabs: 2 }
    ])
  })

  it('names the sockets an "Old versions" refresh reaches', () => {
    expect([...olderClientIds(list, judge(list))].sort()).toEqual(['s1', 's2'])
  })
})

describe('makeBuildJudge — rolling deploys', () => {
  it('admin: the one version every API replica serves is current, whatever loaded last', () => {
    // A late load from an old replica must not make the old build current.
    const list = [
      client('s1', 'ana', 'admin', '0.3.9', T0),
      client('s2', 'bob', 'admin', '0.3.8', T0 + 5000, '0.3.8')
    ]
    const j = judge(list, ['0.3.9'])
    expect(j.current.get('admin')).toBe('0.3.9')
    expect([...olderClientIds(list, j)]).toEqual(['s2'])
  })

  it('admin: while replicas serve two versions nothing is judged, the API reason included', () => {
    const list = [
      client('s1', 'ana', 'admin', '0.3.9', T0),
      client('s2', 'bob', 'admin', '0.3.8', T0 + 5000, '0.3.8'),
      client('s3', 'cat', 'efp-new', 'b2', T0, '0.3.8')
    ]
    const j = judge(list, ['0.3.8', '0.3.9'])
    expect(j.settling.has('admin')).toBe(true)
    expect(j.api).toBeNull()
    expect(olderClientIds(list, j).size).toBe(0)
    expect(staleBuildsByUser(list, j).size).toBe(0)
  })

  it('another app is settling while two of its builds loaded inside the window', () => {
    const list = [
      client('s1', 'ana', 'efp-new', 'new', NOW - 60_000),
      client('s2', 'bob', 'efp-new', 'old', NOW - 30_000),
      client('s3', 'cat', 'efp-new', 'old', T0)
    ]
    const j = judge(list)
    expect(j.settling.get('efp-new')).toMatch(/both loaded/)
    expect(olderClientIds(list, j).size).toBe(0)
    const groups = groupClientVersions(list, j)
    expect(groups.every((g) => g.settling && !g.older && !g.current)).toBe(true)
  })

  it('…and judged again once only one build has loaded for the window', () => {
    const list = [
      client('s1', 'ana', 'efp-new', 'new', NOW - 60_000),
      client('s2', 'bob', 'efp-new', 'old', NOW - SETTLE_MS - 1000)
    ]
    const j = judge(list)
    expect(j.settling.size).toBe(0)
    expect(j.current.get('efp-new')).toBe('new')
    expect([...olderClientIds(list, j)]).toEqual(['s2'])
  })
})

function socket(id: string, data: ClientData | null, tenant?: string) {
  return {
    id,
    data: { ...(data ? { [CLIENT_DATA_KEY]: data } : {}), nvrTenantKey: tenant },
    emit: vi.fn()
  }
}

describe('listClusterClients', () => {
  const d = (user: string, node: string): ClientData => ({
    app: 'admin',
    user: { id: user, name: user },
    node,
    version: null
  })

  it('reads every replica through fetchSockets and counts nodes', async () => {
    const remote = [socket('r1', d('ana', 'n1')), socket('r2', d('bob', 'n2')), socket('r3', null)]
    const io = {
      fetchSockets: vi.fn().mockResolvedValue(remote),
      in: vi.fn(),
      sockets: { sockets: new Map() }
    }
    const out = await listClusterClients(io as never, null, 2500, async () => ['0.3.9'])
    expect(out.roster).toEqual(['0.3.9'])
    expect(out.partial).toBe(false)
    expect(out.nodes).toBe(2)
    expect(out.clients.map((c) => c.id)).toEqual(['r1', 'r2'])
    out.clients[0].emit('client:force-refresh', { seconds: 5 })
    expect(remote[0].emit).toHaveBeenCalledWith('client:force-refresh', { seconds: 5 })
  })

  it('cloud: asks only the tenant room and keeps only that tenant', async () => {
    const fetchSockets = vi
      .fn()
      .mockResolvedValue([socket('a', d('ana', 'n1'), 'T1'), socket('b', d('bob', 'n1'), 'T2')])
    const io = { in: vi.fn(() => ({ fetchSockets })), sockets: { sockets: new Map() } }
    const out = await listClusterClients(io as never, 'T1', 2500, async () => [])
    expect(io.in).toHaveBeenCalledWith('t:T1:all')
    expect(out.clients.map((c) => c.id)).toEqual(['a'])
  })

  it('falls back to this process and says partial when a replica does not answer', async () => {
    const local = new Map([['l1', socket('l1', d('ana', 'me'))]])
    const io = {
      fetchSockets: vi.fn(() => new Promise(() => {})),
      sockets: { sockets: local }
    }
    const out = await listClusterClients(io as never, null, 20, async () => [])
    expect(out.partial).toBe(true)
    expect(out.clients.map((c) => c.id)).toEqual(['l1'])
  })
})
