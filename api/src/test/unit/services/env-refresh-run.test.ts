import type { EnvRefreshDecl } from '@nivaro/extension-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshRunRefusal, rollbackUntil } from '../../../routes/env-refresh.js'
import {
  EXIT_REFUSED,
  isTransientAfterRestore,
  loadedConfig,
  main,
  moveClauses,
  parseArgs
} from '../../../scripts/env-refresh.js'
import {
  _resetRefreshDecl,
  assertWritableTarget,
  EnvRefreshRefused,
  refreshDecl,
  registerRefreshDecl,
  resolveDirection,
  validateRefreshDecl
} from '../../../services/env-refresh/directions.js'
import {
  FLOW_OPS_ID,
  isOutboundOptionKey,
  mergeOutbound,
  outboundPart
} from '../../../services/env-refresh/flow-ops.js'
import {
  applyKeepSet,
  captureKeepSet,
  decodeValue,
  encodeValue,
  keyOf,
  matchByKey
} from '../../../services/env-refresh/keep-set.js'
import {
  buildRefreshPlan,
  isSecretColumn,
  judgePreflight,
  type PreflightFacts,
  planLines,
  showValue
} from '../../../services/env-refresh/plan.js'
import { allKeeps, CORE_KEEPS, type EnvKeepEntry } from '../../../services/env-refresh/registry.js'
import {
  decideExternalApis,
  MOCK_REASON,
  runSafetyPass
} from '../../../services/env-refresh/safety.js'
import type { HostRunSummary } from '../../../services/runbook-queue.js'
import { FakeSqlServer } from '../../helpers/fake-sql-server.js'

const DECL: EnvRefreshDecl = {
  runbook: 'env-refresh',
  rollback_runbook: 'env-rollback',
  environments: [
    { key: 'production', label: 'Production', database: 'EFP', production: true },
    { key: 'staging', label: 'Staging', database: 'EFP_staging', instance_key: 'staging' },
    { key: 'development', label: 'Development', database: 'EFP_Development', runbook_queue: true }
  ],
  directions: [
    { from: 'production', to: 'staging' },
    { from: 'production', to: 'development' },
    { from: 'staging', to: 'development' }
  ]
}

afterEach(() => _resetRefreshDecl())

describe('directions — production is never a target', () => {
  it('resolves the three declared directions', () => {
    expect(resolveDirection(DECL, 'production-to-staging').target.database).toBe('EFP_staging')
    expect(resolveDirection(DECL, 'production-to-development').source.database).toBe('EFP')
    expect(resolveDirection(DECL, 'staging-to-development').source.key).toBe('staging')
  })

  it('refuses EFP as a target by name, whatever the declaration says', () => {
    for (const name of ['EFP', 'efp', 'Efp'])
      expect(() => assertWritableTarget(name)).toThrow(EnvRefreshRefused)
    const sneaky: EnvRefreshDecl = {
      ...DECL,
      environments: [
        ...DECL.environments,
        { key: 'mirror', label: 'Mirror', database: 'EFP' } // not flagged production
      ],
      directions: [{ from: 'staging', to: 'mirror' }]
    }
    expect(() => resolveDirection(sneaky, 'staging-to-mirror')).toThrow(/never a refresh target/)
    expect(() => validateRefreshDecl(sneaky)).toThrow(EnvRefreshRefused)
  })

  it('refuses a production-flagged environment, a production-looking name, and system databases', () => {
    const toProd: EnvRefreshDecl = { ...DECL, directions: [{ from: 'staging', to: 'production' }] }
    expect(() => resolveDirection(toProd, 'staging-to-production')).toThrow(/production/)
    expect(() => assertWritableTarget('EFP_Prod')).toThrow(/production/)
    expect(() => assertWritableTarget('master')).toThrow()
    expect(() => assertWritableTarget('EFP_staging', DECL)).not.toThrow()
    expect(() => assertWritableTarget('EFP_Development', DECL)).not.toThrow()
  })

  it('refuses an undeclared direction, a malformed key and source = target', () => {
    expect(() => resolveDirection(DECL, 'staging-to-staging')).toThrow(/not a declared/)
    expect(() => resolveDirection(DECL, 'development-to-staging')).toThrow(/not a declared/)
    expect(() => resolveDirection(DECL, "x'; DROP")).toThrow(/look like/)
    const same: EnvRefreshDecl = {
      ...DECL,
      environments: [...DECL.environments, { key: 'copy', label: 'Copy', database: 'EFP_staging' }],
      directions: [{ from: 'staging', to: 'copy' }]
    }
    expect(() => resolveDirection(same, 'staging-to-copy')).toThrow(/same database/)
  })

  it('one extension declares the refresh', () => {
    registerRefreshDecl('efp-ops', DECL)
    expect(refreshDecl()?.extension).toBe('efp-ops')
    expect(() => registerRefreshDecl('other', DECL)).toThrow(/already declared/)
  })
})

describe('keep set — save and put back by natural key', () => {
  function server() {
    return new FakeSqlServer()
      .table('EFP_staging', 'nivaro_external_apis', {
        cols: ['id', 'name', 'base_url', 'auth_config', 'mock_config', 'enabled'],
        identity: 'id',
        rows: [
          {
            id: 1,
            name: 'Fusion',
            base_url: 'https://fusion-test',
            auth_config: '{"token":"stg"}',
            mock_config: null,
            enabled: 1
          },
          {
            id: 2,
            name: 'MWF',
            base_url: 'https://mwf-test',
            auth_config: '{"token":"stg2"}',
            mock_config: null,
            enabled: 0
          },
          {
            id: 3,
            name: 'Gone',
            base_url: 'https://gone',
            auth_config: null,
            mock_config: null,
            enabled: 1
          }
        ]
      })
      .table('EFP_staging', 'nivaro_settings_overrides', {
        cols: ['id', 'instance_key', 'data'],
        identity: 'id',
        rows: [{ id: 7, instance_key: 'staging', data: '{"cache":{}}' }]
      })
      .table('EFP_staging', 'nivaro_users', {
        cols: ['id', 'email', 'account_kind', 'static_token'],
        rows: [
          {
            id: 'u-deploy',
            email: 'deploy@efp-staging.internal',
            account_kind: 'service',
            static_token: 'stg-token'
          },
          {
            id: 'u-mcp',
            email: 'claude@nivaro.local',
            account_kind: 'service',
            static_token: 'mcp-stg'
          }
        ]
      })
      .table('EFP_staging', 'nivaro_migrations', {
        cols: ['name'],
        rows: [{ name: '001.ts' }, { name: '531.ts' }]
      })
  }
  const entries = (s: FakeSqlServer) => {
    // the fake has no SQL engine: map the rows predicate to a JS filter
    s.get('EFP_staging', 'nivaro_users')!.where = {}
    return CORE_KEEPS.filter((e) =>
      ['core:external-apis', 'core:settings-overrides', 'core:accounts'].includes(e.id)
    ).map((e) =>
      e.kind === 'rows' ? { ...e, where: '[account_kind] IS NOT NULL' } : e
    ) as EnvKeepEntry[]
  }

  it('captures only kept columns, whole tables and matching rows — SELECTs only', async () => {
    const s = server()
    s.get('EFP_staging', 'nivaro_users')!.cols.push('x')
    const saved = await captureKeepSet(s, {
      entries: entries(s).map((e) =>
        e.kind === 'rows' ? { ...e, where: "[account_kind] = 'service'" } : e
      ),
      direction: 'production-to-staging',
      sourceDb: 'EFP',
      targetDb: 'EFP_staging'
    })
    expect(s.writes).toEqual([])
    const apis = saved.entries.find((e) => e.id === 'core:external-apis')!
    expect(apis.columns).toEqual(['base_url', 'auth_config', 'enabled', 'mock_config'])
    expect(apis.rows[0]).toEqual({
      name: 'Fusion',
      base_url: 'https://fusion-test',
      auth_config: '{"token":"stg"}',
      enabled: 1,
      mock_config: null
    })
    expect(saved.entries.find((e) => e.id === 'core:settings-overrides')!.rows).toHaveLength(1)
    expect(saved.entries.find((e) => e.id === 'core:accounts')!.rows).toHaveLength(2)
    expect(saved.target_ledger).toEqual(['001.ts', '531.ts'])
  })

  it('puts kept values back onto the source rows matched by name (case-insensitively) and reports the rest', async () => {
    const s = server()
    const saved = await captureKeepSet(s, {
      entries: entries(s).map((e) =>
        e.kind === 'rows' ? { ...e, where: "[account_kind] = 'service'" } : e
      ),
      direction: 'production-to-staging',
      sourceDb: 'EFP',
      targetDb: 'EFP_staging'
    })
    // The restore: staging now holds production's rows.
    s.table('EFP_staging', 'nivaro_external_apis', {
      cols: ['id', 'name', 'base_url', 'auth_config', 'mock_config', 'enabled', 'added_later'],
      identity: 'id',
      rows: [
        {
          id: 10,
          name: 'fusion ',
          base_url: 'https://fusion-PROD',
          auth_config: '{"token":"PROD"}',
          mock_config: null,
          enabled: 1
        },
        {
          id: 11,
          name: 'MWF',
          base_url: 'https://mwf-PROD',
          auth_config: '{"token":"PROD2"}',
          mock_config: null,
          enabled: 1
        },
        {
          id: 12,
          name: 'NewPartner',
          base_url: 'https://new-PROD',
          auth_config: '{"token":"P3"}',
          mock_config: null,
          enabled: 1
        }
      ]
    })
    s.table('EFP_staging', 'nivaro_settings_overrides', {
      cols: ['id', 'instance_key', 'data'],
      identity: 'id',
      rows: [{ id: 1, instance_key: 'production', data: '{"prod":true}' }]
    })
    s.table('EFP_staging', 'nivaro_users', {
      cols: ['id', 'email', 'account_kind', 'static_token'],
      rows: [
        {
          id: 'u-mcp',
          email: 'claude@nivaro.local',
          account_kind: 'service',
          static_token: 'mcp-PROD'
        }
      ]
    })
    const res = await applyKeepSet(s, saved)
    const apis = s.get('EFP_staging', 'nivaro_external_apis')!.rows
    expect(apis.find((r) => r.id === 10)).toMatchObject({
      base_url: 'https://fusion-test',
      auth_config: '{"token":"stg"}'
    })
    expect(apis.find((r) => r.id === 11)).toMatchObject({
      base_url: 'https://mwf-test',
      enabled: 0
    })
    // New from the source: untouched here (the safety pass mocks it), and named.
    expect(apis.find((r) => r.id === 12)).toMatchObject({ base_url: 'https://new-PROD' })
    const ar = res.find((r) => r.id === 'core:external-apis')!
    expect(ar).toMatchObject({ written: 2, skipped: 1, new_from_source: ['NewPartner'] })
    // Whole table: production's per-instance row is gone, staging's is back with its id.
    expect(s.get('EFP_staging', 'nivaro_settings_overrides')!.rows).toEqual([
      { id: 7, instance_key: 'staging', data: '{"cache":{}}' }
    ])
    expect(
      s.writes.some((w) =>
        /IDENTITY_INSERT \[EFP_staging\]\.dbo\.\[nivaro_settings_overrides\] ON/.test(w)
      )
    ).toBe(true)
    // Rows: the MCP account keeps staging's token, the deploy account (staging-only) is inserted.
    const users = s.get('EFP_staging', 'nivaro_users')!.rows
    expect(users.find((u) => u.id === 'u-mcp')!.static_token).toBe('mcp-stg')
    expect(users.find((u) => u.id === 'u-deploy')!.static_token).toBe('stg-token')
    expect(res.find((r) => r.id === 'core:accounts')).toMatchObject({ written: 2, inserted: 1 })
  })

  it('a row that cannot be inserted (a link the source lacks) does not lose the others', async () => {
    const s = new FakeSqlServer().table('T', 'nivaro_push_subscriptions', {
      cols: ['id', 'user'],
      rows: [],
      reject: (r) => r.user === 'missing'
    })
    const saved = {
      format: 1 as const,
      captured_at: '',
      direction: 'production-to-staging',
      source_database: 'S',
      target_database: 'T',
      target_ledger: [],
      entries: [
        {
          id: 'core:push-subscriptions',
          label: 'Push',
          table: 'nivaro_push_subscriptions',
          kind: 'table' as const,
          key: [],
          columns: [],
          identity: null,
          total: 3,
          rows: [
            { id: 'a', user: 'u1' },
            { id: 'b', user: 'missing' },
            { id: 'c', user: 'u2' }
          ]
        }
      ]
    }
    const [r] = await applyKeepSet(s, saved)
    expect(r).toMatchObject({ written: 2, skipped: 1 })
    expect(r.errors[0]).toMatch(/FK conflict/)
    expect(s.get('T', 'nivaro_push_subscriptions')!.rows.map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('never applies a sampled (plan) capture', async () => {
    const saved = {
      format: 1 as const,
      captured_at: '',
      direction: 'x',
      source_database: 'S',
      target_database: 'T',
      target_ledger: [],
      entries: [
        {
          id: 'q',
          label: 'Q',
          table: 't',
          kind: 'table' as const,
          key: [],
          columns: [],
          identity: null,
          total: 9000,
          rows: [{ id: 1 }]
        }
      ]
    }
    await expect(applyKeepSet(new FakeSqlServer(), saved)).rejects.toThrow(/sampled/)
  })

  it('matching is by trimmed, case-insensitive key; duplicate keys are never written', () => {
    expect(keyOf({ name: ' Fusion ' }, ['name'])).toBe(keyOf({ name: 'fusion' }, ['name']))
    const m = matchByKey(
      [{ name: 'A' }, { name: 'B' }, { name: 'dup' }],
      [{ name: 'a' }, { name: 'C' }, { name: 'DUP' }, { name: 'dup' }],
      ['name']
    )
    expect(m.matched.map((r) => r.name)).toEqual(['A'])
    expect(m.onlyTarget.map((r) => r.name)).toEqual(['B'])
    expect(m.onlySource.map((r) => r.name)).toEqual(['C'])
    expect(m.ambiguous).toHaveLength(1)
  })

  it('dates and binary survive the JSON file', () => {
    const d = new Date('2026-11-16T12:00:00.000Z')
    const back = JSON.parse(JSON.stringify(encodeValue(d)))
    expect(decodeValue(back)).toEqual(d)
    const buf = Buffer.from([1, 2, 3])
    expect(decodeValue(JSON.parse(JSON.stringify(encodeValue(buf))))).toEqual(buf)
  })
})

describe('safety pass', () => {
  function landed() {
    return new FakeSqlServer()
      .table('T', 'nivaro_settings', {
        cols: ['id', 'mail_test_mode', 'sms_test_mode', 'push_test_mode'],
        rows: [{ id: 1, mail_test_mode: 0, sms_test_mode: 1, push_test_mode: null }]
      })
      .table('T', 'nivaro_external_apis', {
        cols: ['id', 'name', 'mock_config', 'enabled'],
        rows: [
          { id: 1, name: 'Fusion', mock_config: null, enabled: 1 },
          { id: 2, name: 'NewPartner', mock_config: '{"production":{"enabled":false}}', enabled: 1 }
        ]
      })
      .table('T', 'nivaro_webhooks', {
        cols: ['id', 'name', 'enabled'],
        rows: [
          { id: 1, name: 'Ours', enabled: 1 },
          { id: 2, name: 'Theirs', enabled: 1 }
        ]
      })
      .table('T', 'nivaro_erp_submissions', {
        cols: ['id', 'next_retry_at'],
        rows: [
          { id: 1, next_retry_at: new Date() },
          { id: 2, next_retry_at: null }
        ]
      })
      .table('T', 'nivaro_outbox', {
        cols: ['id', 'status', 'last_error'],
        rows: [
          { id: 1, status: 'pending' },
          { id: 2, status: 'delivered' }
        ]
      })
      .table('T', 'nivaro_push_subscriptions', {
        cols: ['id', 'user'],
        rows: [
          { id: 'mine', user: 'u' },
          { id: 'prod-phone', user: 'u' }
        ]
      })
  }
  const saved = {
    format: 1 as const,
    captured_at: '',
    direction: 'production-to-staging',
    source_database: 'S',
    target_database: 'T',
    target_ledger: [],
    entries: [
      {
        id: 'core:external-apis',
        label: '',
        table: 'nivaro_external_apis',
        kind: 'columns' as const,
        key: ['name'],
        columns: [],
        identity: null,
        total: 1,
        rows: [{ name: 'fusion' }]
      },
      {
        id: 'core:webhooks',
        label: '',
        table: 'nivaro_webhooks',
        kind: 'columns' as const,
        key: ['name'],
        columns: [],
        identity: null,
        total: 1,
        rows: [{ name: 'Ours' }]
      },
      {
        id: 'core:push-subscriptions',
        label: '',
        table: 'nivaro_push_subscriptions',
        kind: 'table' as const,
        key: [],
        columns: [],
        identity: null,
        total: 1,
        rows: [{ id: 'MINE' }]
      }
    ]
  }

  it('switches off what the target never had, holds re-sends, drops foreign devices, test modes on', async () => {
    const s = landed()
    const actions = await runSafetyPass(s, {
      readDb: 'S',
      writeDb: 'T',
      instanceKey: 'staging',
      saved,
      dry: false
    })
    const by = (id: string) => actions.find((a) => a.id === id)!
    expect(actions.every((a) => !a.error)).toBe(true)
    expect(s.get('T', 'nivaro_settings')!.rows[0]).toMatchObject({
      mail_test_mode: 1,
      sms_test_mode: 1,
      push_test_mode: 1
    })
    const apis = s.get('T', 'nivaro_external_apis')!.rows
    expect(apis[0].mock_config).toBeNull()
    const mock = JSON.parse(String(apis[1].mock_config))
    expect(mock.staging).toMatchObject({
      enabled: true,
      fallback: { status: 200, body: { reason: MOCK_REASON } }
    })
    expect(mock.production).toEqual({ enabled: false })
    expect(by('external-apis')).toMatchObject({ count: 1, names: ['NewPartner'] })
    expect(s.get('T', 'nivaro_webhooks')!.rows.map((r) => r.enabled)).toEqual([1, 0])
    expect(s.get('T', 'nivaro_erp_submissions')!.rows.every((r) => r.next_retry_at == null)).toBe(
      true
    )
    expect(s.get('T', 'nivaro_outbox')!.rows.map((r) => r.status)).toEqual(['dead', 'delivered'])
    expect(s.get('T', 'nivaro_push_subscriptions')!.rows.map((r) => r.id)).toEqual(['mine'])
    // Tables this database does not have are simply nothing to do.
    expect(by('sync-jobs')).toMatchObject({ count: 0 })
    expect(by('sync-jobs').error).toBeUndefined()
  })

  it('a dry run reads the source and writes nothing', async () => {
    const s = new FakeSqlServer()
    for (const [name, t] of landed().dbs.get('T')!) s.table('S', name, t)
    const actions = await runSafetyPass(s, {
      readDb: 'S',
      writeDb: 'T',
      instanceKey: 'staging',
      saved,
      dry: true
    })
    expect(s.writes).toEqual([])
    expect(actions.find((a) => a.id === 'push-subscriptions')!.count).toBe(1)
    expect(actions.find((a) => a.id === 'webhooks')).toMatchObject({ count: 1, names: ['Theirs'] })
  })

  it('without an instance key, new external APIs are switched off instead of mocked', () => {
    const d = decideExternalApis(
      [
        { id: 1, name: 'Known', enabled: 1 },
        { id: 2, name: 'New', enabled: 1 },
        { id: 3, name: 'AlreadyOff', enabled: 0 }
      ],
      new Set(['known']),
      null
    )
    expect(d).toEqual([{ id: 2, name: 'New', enabled: false }])
  })
})

describe('dry-run plan', () => {
  const facts: PreflightFacts = {
    sourceOnline: true,
    targetOnline: true,
    sourceLedger: ['001.ts', '530.ts'],
    targetLedger: ['001.ts', '530.ts', '531.ts'],
    sourceUsedMb: 46000,
    targetUsedMb: 40000,
    sourceAllocatedMb: 62000,
    targetAllocatedMb: 54700,
    backupFreeMb: 63000,
    dataFreeMb: 224000,
    lastSourceBackupMb: 12000,
    busy: null
  }

  it('passes when the target knows every source migration and the disks have room', () => {
    const checks = judgePreflight(facts)
    expect(checks.every((c) => c.state === 'ok')).toBe(true)
    expect(checks.find((c) => c.id === 'version')!.detail).toMatch(/1 newer migration/)
  })

  it('fails when the target app is older than the source database, or the backup disk is full', () => {
    const old = judgePreflight({ ...facts, targetLedger: ['001.ts'] })
    expect(old.find((c) => c.id === 'version')).toMatchObject({ state: 'fail' })
    expect(old.find((c) => c.id === 'version')!.detail).toMatch(/530\.ts/)
    const full = judgePreflight({ ...facts, backupFreeMb: 5000 })
    expect(full.find((c) => c.id === 'backup-space')!.state).toBe('fail')
    expect(
      judgePreflight({ ...facts, backupFreeMb: null }).find((c) => c.id === 'backup-space')!.state
    ).toBe('warn')
    expect(
      judgePreflight({ ...facts, busy: 'a staging rebuild is running' }).find(
        (c) => c.id === 'busy'
      )!.state
    ).toBe('fail')
  })

  it('lists copied / kept / switched off in plain words and never prints a credential', () => {
    const entries = allKeeps().filter((e) => ['core:settings', 'core:external-apis'].includes(e.id))
    const plan = buildRefreshPlan({
      direction: 'production-to-staging',
      source: DECL.environments[0],
      target: DECL.environments[1],
      entries,
      captured: {
        format: 1,
        captured_at: '',
        direction: 'production-to-staging',
        source_database: 'EFP',
        target_database: 'EFP_staging',
        target_ledger: [],
        entries: [
          {
            id: 'core:settings',
            label: 'Settings',
            table: 'nivaro_settings',
            kind: 'columns',
            key: ['id'],
            columns: ['smtp_host', 'smtp_pass', 'mail_test_mode'],
            identity: 'id',
            total: 1,
            rows: [{ id: 1, smtp_host: 'smtp.staging', smtp_pass: 'hunter2', mail_test_mode: true }]
          },
          {
            id: 'core:external-apis',
            label: 'APIs',
            table: 'nivaro_external_apis',
            kind: 'columns',
            key: ['name'],
            columns: ['base_url', 'auth_config'],
            identity: 'id',
            total: 1,
            rows: [
              { name: 'Fusion', base_url: 'https://fusion-test', auth_config: '{"token":"s3cret"}' }
            ]
          }
        ]
      },
      safety: [
        { id: 'webhooks', label: 'Webhooks the target never had: off', count: 2, names: ['A', 'B'] }
      ],
      preflight: judgePreflight(facts),
      sourceTables: { tables: 900, rows: 12_345_678, used_mb: 46000 },
      filesFallback: '/var/efp/uploads-prod',
      rollbackHours: 24
    })
    expect(plan.ready).toBe(true)
    const text = planLines(plan).join('\n')
    expect(text).toMatch(/Refresh Staging \(EFP_staging\) from Production \(EFP\)/)
    expect(text).toMatch(/12,345,678 rows/)
    expect(text).toMatch(/smtp_host=smtp\.staging/)
    expect(text).toMatch(/smtp_pass=set/)
    expect(text).toMatch(/auth_config=set/)
    expect(text).toMatch(/Webhooks the target never had: off: 2 — A, B/)
    expect(text).toMatch(/read-only/)
    expect(text).not.toMatch(/hunter2|s3cret/)
    expect(showValue('', true)).toBe('empty')
  })
})

describe('the runner', () => {
  it('only loads a config module inside an extension folder', () => {
    expect(() => parseArgs(['--config', '../../etc/passwd.ts'])).toThrow()
    expect(() => parseArgs(['--config', 'extensions/efp-ops/../x.ts'])).toThrow()
    expect(
      parseArgs(['--config', 'extensions/efp-ops/env-refresh-config.ts', '--dry'], {
        TARGET: 'production-to-staging'
      })
    ).toMatchObject({
      direction: 'production-to-staging',
      dry: true,
      rollbackTarget: null
    })
    expect(
      parseArgs(['--config', 'extensions/efp-ops/env-refresh-config.ts', '--rollback'], {
        TARGET: 'staging'
      }).rollbackTarget
    ).toBe('staging')
  })

  it('validates the module like registration does', () => {
    expect(() => loadedConfig({}, 'x')).toThrow(/no envRefresh/)
    const { entries } = loadedConfig(
      {
        envRefresh: DECL,
        envKeeps: [
          {
            id: 'x:videos',
            label: 'Videos',
            reason: 'r',
            table: 'nivaro_help_videos',
            kind: 'delegate'
          }
        ]
      },
      'x'
    )
    expect(entries.find((e) => e.id === 'x:videos')?.source).toBe('x')
  })

  it('refuses a production direction before it opens any connection', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => {
      lines.push(String(s))
      return true
    })
    try {
      // The module path does not exist: refusal happens at load, never at a database.
      expect(
        await main(['--config', 'extensions/nope/none.ts', '--direction', 'staging-to-production'])
      ).toBe(EXIT_REFUSED)
    } finally {
      spy.mockRestore()
    }
    expect(lines.join('\n')).toMatch(/### REFUSED/)
  })

  it('maps the backup onto the target files by type and order, keeping logical names', () => {
    expect(
      moveClauses(
        [
          { LogicalName: 'EFP_1', Type: 'D' },
          { LogicalName: 'EFP_2', Type: 'D' },
          { LogicalName: 'EFP_log', Type: 'L' }
        ],
        [
          { physical_name: 'D:\\SQLData\\EFP_stagingNew_1.mdf', type_desc: 'ROWS' },
          { physical_name: 'D:\\SQLData\\EFP_stagingNew_2.ndf', type_desc: 'ROWS' },
          { physical_name: 'E:\\SQLLog\\EFP_stagingNew_log.ldf', type_desc: 'LOG' }
        ]
      )
    ).toEqual([
      "MOVE N'EFP_1' TO N'D:\\SQLData\\EFP_stagingNew_1.mdf'",
      "MOVE N'EFP_2' TO N'D:\\SQLData\\EFP_stagingNew_2.ndf'",
      "MOVE N'EFP_log' TO N'E:\\SQLLog\\EFP_stagingNew_log.ldf'"
    ])
    expect(() =>
      moveClauses(
        [
          { LogicalName: 'a', Type: 'D' },
          { LogicalName: 'b', Type: 'D' }
        ],
        [{ physical_name: 'x', type_desc: 'ROWS' }]
      )
    ).toThrow(/file layout/)
  })
})

describe('routes — queue gates', () => {
  const run = (o: Partial<HostRunSummary>): HostRunSummary =>
    ({
      id: 'r',
      source: 'host',
      extension: 'efp-ops',
      runbook: 'env-refresh',
      mode: 'dry',
      target: 'production-to-staging',
      from_step: null,
      state: 'done',
      host: 'h',
      requested_at: '',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      cancel_requested: false,
      started_by: null,
      ...o
    }) as HostRunSummary

  it('a real refresh needs a fresh dry run of the same direction and the typed target database', () => {
    const base = {
      database: 'EFP_Staging',
      extension: 'efp-ops',
      runbook: 'env-refresh',
      target: 'production-to-staging'
    }
    expect(refreshRunRefusal({ ...base, mode: 'go', confirm: 'EFP_Staging', runs: [] })).toMatch(
      /dry run/
    )
    expect(
      refreshRunRefusal({
        ...base,
        mode: 'go',
        confirm: 'EFP_Staging',
        runs: [run({ target: 'staging-to-development' })]
      })
    ).toMatch(/dry run/)
    expect(refreshRunRefusal({ ...base, mode: 'go', confirm: 'staging', runs: [run({})] })).toMatch(
      /type EFP_Staging/
    )
    expect(
      refreshRunRefusal({ ...base, mode: 'go', confirm: 'EFP_Staging', runs: [run({})] })
    ).toBeNull()
    expect(refreshRunRefusal({ ...base, mode: 'dry', runs: [], confirm: undefined })).toBeNull()
    expect(
      refreshRunRefusal({
        ...base,
        mode: 'dry',
        confirm: undefined,
        runs: [run({ state: 'running' })]
      })
    ).toMatch(/already running/)
    expect(refreshRunRefusal({ ...base, mode: 'drop', confirm: undefined, runs: [] })).toMatch(
      /dry or go/
    )
  })

  it('roll back is offered for the hours after a refresh that replaced the target', () => {
    const now = Date.parse('2026-11-16T12:00:00Z')
    const at = (h: number) => new Date(now - h * 3600_000).toISOString()
    expect(rollbackUntil([run({ mode: 'go', started_at: at(2) })], 'staging', 24, now)).toBe(
      new Date(now + 22 * 3600_000).toISOString()
    )
    expect(rollbackUntil([run({ mode: 'go', started_at: at(30) })], 'staging', 24, now)).toBeNull()
    expect(rollbackUntil([run({ mode: 'dry', started_at: at(2) })], 'staging', 24, now)).toBeNull()
    // Failed before the restore: the target was never replaced.
    expect(
      rollbackUntil(
        [run({ mode: 'go', state: 'failed', failed_step: 'backup', started_at: at(1) })],
        'staging',
        24,
        now
      )
    ).toBeNull()
    expect(
      rollbackUntil(
        [run({ mode: 'go', state: 'failed', failed_step: 'keep', started_at: at(1) })],
        'staging',
        24,
        now
      )
    ).not.toBeNull()
    expect(
      rollbackUntil([run({ mode: 'go', started_at: at(1) })], 'development', 24, now)
    ).toBeNull()
  })
})

describe('safety pass — agents, flows and copied credentials', () => {
  function landed() {
    return new FakeSqlServer()
      .table('T', 'nivaro_agent_triggers', {
        cols: ['id', 'name', 'enabled', 'url'],
        rows: [
          { id: 1, name: 'Ours', enabled: 1, url: 'https://agent.staging' },
          { id: 2, name: 'Prod agent', enabled: 1, url: 'https://agent.prod' }
        ]
      })
      .table('T', 'nivaro_agent_trigger_deliveries', {
        cols: ['id', 'status', 'last_error', 'next_attempt_at'],
        rows: [
          { id: 1, status: 'retrying', next_attempt_at: new Date() },
          { id: 2, status: 'sending' },
          { id: 3, status: 'delivered' }
        ]
      })
      .table('T', 'nivaro_flows', {
        cols: ['id', 'name', 'status'],
        rows: [
          { id: 'f1', name: 'Kept flow', status: 'active' },
          { id: 'f2', name: 'Prod webhook flow', status: 'active' },
          { id: 'f3', name: 'Prod mail flow', status: 'active' }
        ]
      })
      .table('T', 'nivaro_flow_operations', {
        cols: ['id', 'flow', 'type'],
        rows: [
          { id: 'o1', flow: 'f1', type: 'webhook' },
          { id: 'o2', flow: 'f2', type: 'webhook' },
          { id: 'o3', flow: 'f3', type: 'mail' }
        ]
      })
      .table('T', 'nivaro_users', {
        cols: ['id', 'email', 'static_token', 'totp_secret', 'password_hash'],
        rows: [
          { id: 'U-KEPT', email: 'deploy@x.internal', static_token: 'staging-token' },
          {
            id: 'u-person',
            email: 'a@corp.com',
            static_token: 'prod-token',
            totp_secret: 'T',
            password_hash: 'P'
          },
          { id: 'u-none', email: 'b@corp.com', static_token: null }
        ]
      })
      .table('T', 'nivaro_api_keys', {
        cols: ['id', 'name', 'is_active'],
        rows: [
          { id: 46, name: 'Staging MCP', is_active: 1 },
          { id: 77, name: 'A person’s production key', is_active: 1 }
        ]
      })
      .table('T', 'nivaro_sessions', {
        cols: ['id', 'user_id'],
        rows: [{ id: 's1', user_id: 'u-person' }]
      })
  }
  const saved = {
    format: 1 as const,
    captured_at: '',
    direction: 'production-to-staging',
    source_database: 'S',
    target_database: 'T',
    target_ledger: [],
    entries: [
      {
        id: 'core:agent-triggers',
        label: '',
        table: 'nivaro_agent_triggers',
        kind: 'columns' as const,
        key: ['name'],
        columns: [],
        identity: null,
        total: 1,
        rows: [{ name: 'Ours' }]
      },
      {
        id: 'core:flows',
        label: '',
        table: 'nivaro_flows',
        kind: 'columns' as const,
        key: ['name'],
        columns: [],
        identity: null,
        total: 1,
        rows: [{ name: 'Kept flow' }]
      },
      {
        id: 'core:accounts',
        label: '',
        table: 'nivaro_users',
        kind: 'rows' as const,
        key: ['id'],
        columns: [],
        identity: null,
        total: 1,
        rows: [{ id: 'u-kept' }]
      },
      {
        id: 'core:api-keys',
        label: '',
        table: 'nivaro_api_keys',
        kind: 'rows' as const,
        key: ['id'],
        columns: [],
        identity: 'id',
        total: 1,
        rows: [{ id: 46 }]
      }
    ]
  }

  it('switches off what calls out, holds deliveries and strips copied credentials — sign-in secrets stay', async () => {
    const s = landed()
    const actions = await runSafetyPass(s, {
      readDb: 'S',
      writeDb: 'T',
      instanceKey: 'staging',
      saved,
      dry: false
    })
    const by = (id: string) => actions.find((a) => a.id === id)!
    expect(actions.filter((a) => a.error)).toEqual([])
    expect(s.get('T', 'nivaro_agent_triggers')!.rows.map((r) => r.enabled)).toEqual([1, 0])
    expect(by('agent-triggers')).toMatchObject({ count: 1, names: ['Prod agent'] })
    expect(s.get('T', 'nivaro_agent_trigger_deliveries')!.rows.map((r) => r.status)).toEqual([
      'dead',
      'dead',
      'delivered'
    ])
    expect(s.get('T', 'nivaro_flows')!.rows.map((r) => r.status)).toEqual([
      'active',
      'inactive',
      'active'
    ])
    expect(by('flows')).toMatchObject({ count: 1, names: ['Prod webhook flow'] })
    const users = s.get('T', 'nivaro_users')!.rows
    expect(users.find((u) => u.id === 'U-KEPT')!.static_token).toBe('staging-token')
    expect(users.find((u) => u.id === 'u-person')).toMatchObject({
      static_token: null,
      totp_secret: 'T',
      password_hash: 'P'
    })
    expect(by('static-tokens').count).toBe(1)
    expect(s.get('T', 'nivaro_api_keys')!.rows.map((r) => r.is_active)).toEqual([1, 0])
    expect(by('api-keys')).toMatchObject({ count: 1 })
    expect(s.get('T', 'nivaro_sessions')!.rows).toEqual([])
    expect(by('sessions').count).toBe(1)
  })

  it('the dry run counts the same things and writes nothing', async () => {
    const s = new FakeSqlServer()
    for (const [name, t] of landed().dbs.get('T')!) s.table('S', name, t)
    const actions = await runSafetyPass(s, {
      readDb: 'S',
      writeDb: 'T',
      instanceKey: 'staging',
      saved,
      dry: true
    })
    expect(s.writes).toEqual([])
    const counts = Object.fromEntries(actions.map((a) => [a.id, a.count]))
    expect(counts).toMatchObject({
      'agent-triggers': 1,
      'agent-trigger-deliveries': 2,
      flows: 1,
      'static-tokens': 1,
      'api-keys': 1,
      sessions: 1
    })
  })
})

describe('plan masking', () => {
  it('masks declared secrets, the snapshot rule and secret-looking names', () => {
    expect(isSecretColumn('nivaro_settings', 'teams_webhook_url', ['teams_webhook_url'])).toBe(true)
    expect(isSecretColumn('nivaro_environment_components', 'api_token')).toBe(true)
    expect(isSecretColumn('nivaro_x', 'partner_refresh_token')).toBe(true)
    expect(isSecretColumn('nivaro_settings', 'ai_gateway_token_url')).toBe(true)
    expect(isSecretColumn('nivaro_settings', 'smtp_host')).toBe(false)
  })

  it('a credential the entry forgot to declare is still shown only as set', () => {
    const plan = buildRefreshPlan({
      direction: 'production-to-staging',
      source: DECL.environments[0],
      target: DECL.environments[1],
      entries: [
        {
          source: 'x',
          id: 'x:t',
          label: 'T',
          reason: 'r',
          table: 'partner_settings',
          kind: 'table'
        }
      ],
      captured: {
        format: 1,
        captured_at: '',
        direction: 'production-to-staging',
        source_database: 'EFP',
        target_database: 'EFP_staging',
        target_ledger: [],
        entries: [
          {
            id: 'x:t',
            label: 'T',
            table: 'partner_settings',
            kind: 'table',
            key: [],
            columns: [],
            identity: null,
            total: 1,
            rows: [
              { id: 1, client_secret: 'hunter2', webhook_secret: 'abc', endpoint: 'https://p' }
            ]
          }
        ]
      },
      safety: [],
      preflight: [],
      sourceTables: { tables: 1, rows: 1, used_mb: 1 },
      filesFallback: null,
      rollbackHours: 24
    })
    const vals = plan.kept[0].sample[0].values
    expect(vals.client_secret).toBe('set')
    expect(vals.webhook_secret).toBe('set')
    expect(JSON.stringify(plan)).not.toMatch(/hunter2|"abc"/)
  })
})

describe('flow steps keep each environment’s own outbound settings', () => {
  const flows = (db: string, s: FakeSqlServer, ops: Array<Record<string, unknown>>) =>
    s
      .table(db, 'nivaro_flows', {
        cols: ['id', 'name', 'status'],
        rows: [
          { id: 'f1', name: 'Notify partner', status: 'active' },
          { id: 'f2', name: 'Only on the source', status: 'active' }
        ]
      })
      .table(db, 'nivaro_flow_operations', {
        cols: ['id', 'flow', 'name', 'key', 'type', 'options'],
        rows: ops
      })

  it('picks URLs, headers, secrets and path overrides out of a step — nothing else', () => {
    for (const k of [
      'url',
      'headers',
      'path_override',
      'callback_url',
      'signing_secret',
      'api_key',
      'partner_endpoint'
    ])
      expect(isOutboundOptionKey(k), k).toBe(true)
    for (const k of ['body', 'method', 'collection', 'filter', 'to', 'subject', 'api_id'])
      expect(isOutboundOptionKey(k), k).toBe(false)
    expect(outboundPart('{"url":"u","body":"b","headers":{"X":"1"}}')).toEqual({
      url: 'u',
      headers: { X: '1' }
    })
    expect(outboundPart('{"body":"b"}')).toBeNull()
    expect(outboundPart('not json')).toBeNull()
    // A secret the source brought that the target never had does not survive.
    expect(
      JSON.parse(mergeOutbound('{"url":"prod","body":"new","token":"PROD"}', { url: 'stg' }))
    ).toEqual({
      body: 'new',
      url: 'stg'
    })
  })

  it('saves the target’s step options and writes them onto the copy by flow name + step key', async () => {
    const s = flows('T', new FakeSqlServer(), [
      {
        id: 1,
        flow: 'f1',
        name: 'Post',
        key: 'post',
        type: 'webhook',
        options: JSON.stringify({
          url: 'https://hook.staging',
          headers: { Authorization: 'stg' },
          body: 'old'
        })
      },
      {
        id: 2,
        flow: 'f1',
        name: 'Mail',
        key: 'mail',
        type: 'mail',
        options: JSON.stringify({ to: 'x', subject: 'y' })
      }
    ])
    const entry = CORE_KEEPS.find((e) => e.id === FLOW_OPS_ID)!
    const saved = await captureKeepSet(s, {
      entries: [entry],
      direction: 'production-to-staging',
      sourceDb: 'S',
      targetDb: 'T'
    })
    expect(s.writes).toEqual([])
    const e = saved.entries[0]
    expect(e.rows).toEqual([
      {
        flow_name: 'Notify partner',
        key: 'post',
        fields: 'url, headers',
        outbound: JSON.stringify({ url: 'https://hook.staging', headers: { Authorization: 'stg' } })
      }
    ])
    // The restore: the target now holds the source's steps (new body, the source's address and secret).
    flows('T', s, [
      {
        id: 10,
        flow: 'f1',
        name: 'Post',
        key: 'POST ',
        type: 'webhook',
        options: JSON.stringify({
          url: 'https://hook.prod',
          headers: { Authorization: 'PROD' },
          token: 'PRODSECRET',
          body: 'new'
        })
      },
      {
        id: 11,
        flow: 'f2',
        name: 'Call',
        key: 'call',
        type: 'webhook',
        options: JSON.stringify({ url: 'https://only.prod' })
      }
    ])
    const [r] = await applyKeepSet(s, saved)
    const ops = s.get('T', 'nivaro_flow_operations')!.rows
    expect(JSON.parse(String(ops[0].options))).toEqual({
      body: 'new',
      url: 'https://hook.staging',
      headers: { Authorization: 'stg' }
    })
    expect(JSON.parse(String(ops[1].options))).toEqual({ url: 'https://only.prod' })
    expect(r).toMatchObject({
      id: FLOW_OPS_ID,
      written: 1,
      skipped: 0,
      new_from_source: ['Only on the source / call'],
      errors: []
    })
  })

  it('the plan counts the kept steps and masks their values', () => {
    const plan = buildRefreshPlan({
      direction: 'production-to-staging',
      source: DECL.environments[0],
      target: DECL.environments[1],
      entries: CORE_KEEPS.filter((e) => e.id === FLOW_OPS_ID),
      captured: {
        format: 1,
        captured_at: '',
        direction: 'production-to-staging',
        source_database: 'EFP',
        target_database: 'EFP_staging',
        target_ledger: [],
        entries: [
          {
            id: FLOW_OPS_ID,
            label: 'Flow steps',
            table: 'nivaro_flow_operations',
            kind: 'columns',
            key: ['flow_name', 'key'],
            columns: ['fields', 'outbound'],
            identity: null,
            total: 1,
            rows: [
              {
                flow_name: 'Notify partner',
                key: 'post',
                fields: 'url, headers',
                outbound: '{"url":"https://hook.staging"}'
              }
            ]
          }
        ]
      },
      safety: [],
      preflight: [],
      sourceTables: { tables: 1, rows: 1, used_mb: 1 },
      filesFallback: null,
      rollbackHours: 24
    })
    expect(plan.kept[0]).toMatchObject({ rows: 1 })
    expect(plan.kept[0].sample[0]).toEqual({
      key: 'Notify partner / post',
      values: { fields: 'url, headers', outbound: 'set' }
    })
    expect(planLines(plan).join('\n')).not.toMatch(/hook\.staging/)
  })
})

describe('isTransientAfterRestore', () => {
  it('waits on a login refused right after a restore', () => {
    expect(
      isTransientAfterRestore({ code: 'ELOGIN', message: "Login failed for user 'EFP_DB_RW'." })
    ).toBe(true)
    expect(isTransientAfterRestore({ errors: [{ number: 4060 }] })).toBe(true)
    expect(isTransientAfterRestore({ message: 'Database is being recovered' })).toBe(true)
  })
  it('does not wait on a real error', () => {
    expect(
      isTransientAfterRestore({ errors: [{ number: 208 }], message: "Invalid object name 'x'." })
    ).toBe(false)
  })
})
