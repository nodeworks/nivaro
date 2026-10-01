// api/src/test/unit/services/devops-versions.test.ts — #1048 / #1049 / #1050 / #1053 / #1180
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../version.js', () => ({ NIVARO_VERSION: '0.2.12' }))

import { isConfigWrite, tablesInStatement } from '../../../db/config-epoch.js'
import {
  clientVersionFromHello,
  currentBuilds,
  olderReason,
  parseClientHeader
} from '../../../services/client-version.js'
import { configArea, describeStamp } from '../../../services/config-stamps.js'
import { judgeMixedVersions, judgeOtherInstanceRuns } from '../../../services/deploy-readiness.js'
import { summarizeTabs } from '../../../services/traffic-taps/stale-tabs.js'

const NOW = Date.parse('2026-10-01T12:00:00Z')

describe('client version signal (#1048 / #1180)', () => {
  it('parses the x-nivaro-client header and cleans its fields', () => {
    const v = parseClientHeader(
      `build=abc123; api=0.2.11; tab=k3j2x9; loaded=${NOW - 60_000}; junk; evil=<script>`
    )
    expect(v).toEqual({ build: 'abc123', api: '0.2.11', tab: 'k3j2x9', loaded: NOW - 60_000 })
    expect(parseClientHeader('build=a b<c>; tab=x')?.build).toBe('abc')
    expect(parseClientHeader('')).toBeNull()
    expect(parseClientHeader('api=0.2.11')).toBeNull()
    // a load time in the future or before 2020 is ignored
    expect(parseClientHeader(`build=x; loaded=${Date.now() + 3_600_000}`)?.loaded).toBeNull()
    expect(parseClientHeader('build=x; loaded=12')?.loaded).toBeNull()
  })

  it('reads the same fields off a socket hello', () => {
    expect(
      clientVersionFromHello({ app: 'admin', build: '0.2.12', api: '0.2.12', tab: 't1' })
    ).toEqual({
      build: '0.2.12',
      api: '0.2.12',
      tab: 't1',
      loaded: null
    })
    expect(clientVersionFromHello(null)).toEqual({
      build: null,
      api: null,
      tab: null,
      loaded: null
    })
  })

  it('names the current build of each app by its newest page load', () => {
    const v = (build: string, loaded: number, api = '0.2.12') => ({
      build,
      api,
      tab: build,
      loaded
    })
    const clients = [
      { app: 'efp-new', version: v('old111', NOW - 9_000_000) },
      { app: 'efp-new', version: v('new222', NOW - 60_000) },
      { app: 'efp-new', version: v('old111', NOW - 8_000_000) },
      { app: 'admin', version: v('dev', NOW) }
    ]
    const cur = currentBuilds(clients)
    expect(cur.get('efp-new')).toBe('new222')
    expect(cur.has('admin')).toBe(false)
    expect(olderReason('efp-new', clients[0].version, cur)).toBe('build')
    expect(olderReason('efp-new', clients[1].version, cur)).toBeNull()
    // current build, but it first talked to an older API
    expect(olderReason('efp-new', v('new222', NOW, '0.2.11'), cur)).toBe('api')
    // dev builds and unknown versions are never judged
    expect(olderReason('admin', clients[3].version, cur)).toBeNull()
    expect(olderReason('admin', null, cur)).toBeNull()
  })

  it('folds a window of tabs per app and build', () => {
    const row = (app: string, build: string, loaded: number, caller: string, api = '0.2.12') => ({
      app,
      caller,
      lastSec: 100,
      version: { build, api, tab: `${build}-${caller}`, loaded }
    })
    const s = summarizeTabs([
      row('efp-new', 'new222', NOW - 1000, 'u1'),
      row('efp-new', 'new222', NOW - 2000, 'u2'),
      row('efp-new', 'old111', NOW - 9_000_000, 'u3'),
      row('efp-new', 'old111', NOW - 9_000_100, 'u3'),
      row('admin', '0.2.12', NOW - 500, 'u1'),
      row('admin', '0.2.12', NOW - 600, 'u4', '0.2.11')
    ])
    expect(s?.tabs).toBe(6)
    expect(s?.stale).toBe(3)
    const efp = s?.apps.find((a) => a.app === 'efp-new')
    expect(efp?.current_build).toBe('new222')
    expect(efp?.builds.find((b) => b.build === 'old111')).toMatchObject({
      tabs: 2,
      people: 1,
      older: 'build',
      current: false
    })
    const admin = s?.apps.find((a) => a.app === 'admin')
    expect(admin?.stale).toBe(1)
    expect(admin?.builds.find((b) => b.older === 'api')?.api).toBe('0.2.11')
    expect(summarizeTabs([])).toBeUndefined()
  })
})

describe('mixed API versions (#1049)', () => {
  const e = (version: string, startedMinAgo: number, role: string | null = 'web', host = 'h1') => ({
    id: `${version}-${startedMinAgo}`,
    host,
    version,
    role,
    started_at: new Date(NOW - startedMinAgo * 60_000).toISOString()
  })
  it('skips without a roster and passes on one version with role counts', () => {
    expect(judgeMixedVersions([], NOW).status).toBe('skip')
    const r = judgeMixedVersions([e('0.2.12', 60), e('0.2.12', 59), e('0.2.12', 58, 'worker')], NOW)
    expect(r.status).toBe('pass')
    expect(r.detail).toContain('2 web, 1 worker')
  })
  it('passes while a rolling deploy is young and warns once it outlives the limit', () => {
    const young = judgeMixedVersions([e('0.2.11', 300), e('0.2.12', 4)], NOW, 15)
    expect(young.status).toBe('pass')
    expect(young.detail).toContain('4 min')
    const stalled = judgeMixedVersions([e('0.2.11', 300), e('0.2.12', 40, 'worker', 'h2')], NOW, 15)
    expect(stalled.status).toBe('warn')
    expect(stalled.detail).toContain('40 min')
    expect(stalled.blockers?.join('\n')).toContain('0.2.12: 1 process (1 worker) on h2')
  })
})

describe('scheduled runs from another instance (#1050)', () => {
  const row = (instance: string | null, runs: number) => ({
    instance,
    runs,
    last: new Date(NOW),
    sample: 'digest-daily'
  })
  it('on a ticking instance, warns about any other instance', () => {
    expect(judgeOtherInstanceRuns([row('staging', 40)], 'staging', true).status).toBe('pass')
    expect(judgeOtherInstanceRuns([], 'staging', true).status).toBe('pass')
    const r = judgeOtherInstanceRuns([row('staging', 40), row('development', 12)], 'staging', true)
    expect(r.status).toBe('warn')
    expect(r.blockers).toHaveLength(1)
    expect(r.blockers?.[0]).toContain('development ran 12 scheduled jobs')
    expect(r.blockers?.[0]).toContain('CRON_TICKS=off')
  })
  it('on a ticks-off process, warns only when two instances both ran scheduled jobs', () => {
    expect(judgeOtherInstanceRuns([row('staging', 40)], 'development', false).status).toBe('pass')
    expect(
      judgeOtherInstanceRuns([row('staging', 40), row('development', 3)], 'development', false)
        .status
    ).toBe('warn')
  })
})

describe('config changes on the incident timeline (#1053)', () => {
  it('names the configuration tables a statement touched (DDL names its own table)', () => {
    expect(tablesInStatement('update [nivaro_layout_field_assignments] set [sort] = @p0')).toEqual([
      'nivaro_layout_field_assignments'
    ])
    expect(tablesInStatement('ALTER TABLE [dbo].[orders] ADD [note] nvarchar(50)')).toEqual([
      'orders'
    ])
    expect(tablesInStatement('select 1')).toEqual([])
  })
  it('counts flow edits as configuration, not flow runs', () => {
    expect(isConfigWrite('update [nivaro_flows] set [status] = @p0 where [id] = @p1')).toBe(true)
    expect(isConfigWrite('insert into [nivaro_flow_runs] ([flow]) values (@p0)')).toBe(false)
  })
  it('sorts tables into areas and writes one sentence per change', () => {
    expect(configArea('nivaro_layout_field_assignments')).toBe('layout')
    expect(configArea('nivaro_workflow_transitions')).toBe('pipeline')
    expect(configArea('nivaro_flow_operations')).toBe('flow')
    expect(configArea('nivaro_fields')).toBe('schema')
    expect(configArea('orders')).toBe('schema')
    const text = describeStamp(
      {
        epoch: 4321,
        tables: [
          { table: 'nivaro_layout_field_assignments', writes: 3 },
          { table: 'nivaro_collection_layouts', writes: 1 }
        ],
        ddl: 0,
        statements: 4,
        users: ['U1'],
        paths: [],
        from: new Date(NOW).toISOString(),
        to: new Date(NOW).toISOString(),
        manual: false
      },
      'Robert Lee',
      [{ id: 12345, action: 'update', collection: 'nivaro_collection_layouts', item: '2' }],
      'staging'
    )
    expect(text).toBe(
      'Configuration changed: layout (nivaro_layout_field_assignments ×3, nivaro_collection_layouts) by Robert Lee on staging — caused by update on nivaro_collection_layouts #2 (activity #12345) · config epoch 4321'
    )
    const script = describeStamp(
      {
        epoch: null,
        tables: [{ table: 'orders', writes: 1 }],
        ddl: 1,
        statements: 1,
        users: [],
        paths: [],
        from: '',
        to: '',
        manual: false
      },
      null,
      [],
      'development'
    )
    expect(script).toContain('with no signed-in request (a script, migration or job)')
    expect(script).toContain('1 schema statement')
  })
})
