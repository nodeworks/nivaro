import { describe, expect, it } from 'vitest'
import {
  CONFIG_TABLES,
  type ConfigSnapshot,
  hashRow,
  type SnapshotRow
} from '../../../services/config-inventory.js'
import {
  CONFIG_PROMOTION_GROUPS,
  groupOfTable,
  promotableTables,
  tablesForGroups
} from '../../../services/config-promote-groups.js'
import { RESTORE_EXCLUDED } from '../../../services/config-restore.js'
import {
  isOutboundOptionKey,
  mergeOutbound,
  outboundPart
} from '../../../services/env-refresh/flow-ops.js'
import { allKeeps, type EnvKeepEntry } from '../../../services/env-refresh/registry.js'
import {
  applyTargetKeeps,
  identityChanges,
  PromoteError,
  parsePromoteRequest,
  parseTables,
  preparedRef,
  stripKeepSecrets,
  switchOff
} from '../../../services/hub-link/config-promote.js'

// Hub config promotion (idea 30), app side: what travels, what the target keeps, and the request
// checks. Pure — the restore engine itself is covered by config-restore.test.ts.

const row = (data: Record<string, unknown>): SnapshotRow => ({ hash: hashRow(data), data })
const snap = (tables: ConfigSnapshot['tables']): ConfigSnapshot => ({
  format: 1,
  generated_at: '2026-11-25T00:00:00.000Z',
  instance: { version: '0.3.215', environment: 'production', database: 'src' },
  classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
  tables,
  errors: {}
})
const OUT = { part: outboundPart, merge: mergeOutbound, isKey: isOutboundOptionKey }

describe('promotion groups', () => {
  it('names only CONFIG tables a restore may write', () => {
    const config = new Set(CONFIG_TABLES)
    for (const g of CONFIG_PROMOTION_GROUPS)
      for (const t of g.tables) {
        expect(config.has(t), `${g.key}: ${t} is not a CONFIG table`).toBe(true)
        expect(RESTORE_EXCLUDED[t], `${g.key}: ${t} is excluded from restores`).toBeUndefined()
      }
    expect(promotableTables().size).toBe(CONFIG_PROMOTION_GROUPS.flatMap((g) => g.tables).length)
  })

  it('never offers the schema registry, people or per-environment tables', () => {
    const all = promotableTables()
    for (const t of [
      'nivaro_collections',
      'nivaro_fields',
      'nivaro_relations',
      'nivaro_users',
      'nivaro_user_scopes',
      'nivaro_sso_providers',
      'nivaro_settings_overrides',
      'nivaro_environments',
      'nivaro_external_apis'
    ])
      expect(all.has(t), t).toBe(false)
  })

  it('resolves groups to tables in order, each once', () => {
    expect(tablesForGroups(['roles', 'roles', 'nope'])).toEqual(['nivaro_roles', 'nivaro_policies'])
    expect(groupOfTable('nivaro_flow_operations')?.key).toBe('flows')
  })
})

describe('request checks', () => {
  it('refuses tables outside the groups', () => {
    expect(() => parseTables(['nivaro_users'])).toThrow(PromoteError)
    expect(() => parseTables([])).toThrow(/1–100/)
    expect(parseTables(['nivaro_roles', 'nivaro_roles'])).toEqual(['nivaro_roles'])
  })

  it('needs a format-1 snapshot and cleans the labels', () => {
    expect(() =>
      parsePromoteRequest({ snapshot: { format: 2 }, tables: ['nivaro_roles'] })
    ).toThrow(/format-1/)
    const r = parsePromoteRequest({
      snapshot: snap({}),
      tables: ['nivaro_roles'],
      deletes: 'yes',
      source_label: 'efp/\nstaging',
      promotion_id: '12',
      actor: 'Rob'
    })
    expect(r.deletes).toBe(false)
    expect(r.source_label).toBe('efp/ staging')
    expect(r.promotion_id).toBe(12)
  })
})

describe('what travels', () => {
  it('strips every column the keep registry calls a secret, on top of the redaction', () => {
    const keeps: EnvKeepEntry[] = [
      {
        source: 'core',
        id: 'core:webhooks',
        label: 'Webhooks',
        reason: 'r',
        table: 'nivaro_webhooks',
        kind: 'columns',
        key: ['name'],
        columns: ['url'],
        secret_columns: ['headers']
      }
    ]
    const out = stripKeepSecrets(
      snap({ nivaro_webhooks: { '1': row({ id: 1, name: 'w', headers: '{"x":"y"}', url: 'u' }) } }),
      keeps
    )
    const r = out.tables.nivaro_webhooks['1']
    expect(r.data).toEqual({ id: 1, name: 'w', url: 'u' })
    expect(r.hash).toBe(hashRow(r.data))
  })

  it('the core registry strips the Teams webhook and storage settings from nivaro_settings', () => {
    const out = stripKeepSecrets(
      snap({
        nivaro_settings: {
          '1': row({ id: 1, smtp_pass: 'p', teams_webhook_url: 'https://x', welcome_message: 'hi' })
        }
      }),
      allKeeps([])
    )
    expect(out.tables.nivaro_settings['1'].data).toEqual({ id: 1, welcome_message: 'hi' })
  })
})

describe('what the target keeps', () => {
  const keeps = allKeeps([])

  it('settings: kept columns never travel; the rest does', () => {
    const p = applyTargetKeeps(
      snap({
        nivaro_settings: {
          '1': row({ id: 1, smtp_host: 'dev-mail', project_name: 'Dev', welcome_message: 'hi' })
        }
      }),
      keeps,
      { nivaro_settings: { '1': row({ id: 1, smtp_host: 'prod-mail', project_name: 'Prod' }) } },
      OUT
    )
    expect(p.snapshot.tables.nivaro_settings['1'].data).toEqual({ id: 1, welcome_message: 'hi' })
    expect(p.kept.find((k) => k.table === 'nivaro_settings')?.columns).toContain('smtp_host')
  })

  it('a table this environment keeps whole is refused with the reason', () => {
    const p = applyTargetKeeps(
      snap({ nivaro_settings_overrides: { a: row({ id: 'a', data: '{}' }) } }),
      keeps,
      {},
      OUT
    )
    expect(p.snapshot.tables.nivaro_settings_overrides).toBeUndefined()
    expect(p.refused[0]).toMatchObject({ table: 'nivaro_settings_overrides' })
    expect(p.refused[0].reason).toMatch(/keeps its own/)
  })

  it('a new flow arrives switched off; an existing one keeps its own status', () => {
    const p = applyTargetKeeps(
      snap({
        nivaro_flows: {
          '1': row({ id: 1, name: 'old', status: 'active', description: 'v2' }),
          '2': row({ id: 2, name: 'new', status: 'active' })
        }
      }),
      keeps,
      { nivaro_flows: { '1': row({ id: 1, name: 'old', status: 'inactive', description: 'v1' }) } },
      OUT
    )
    expect(p.snapshot.tables.nivaro_flows['1'].data).toEqual({
      id: 1,
      name: 'old',
      description: 'v2'
    })
    expect(p.snapshot.tables.nivaro_flows['2'].data.status).toBe('inactive')
    expect(p.switched_off).toEqual([{ table: 'nivaro_flows', key: '2', label: 'new' }])
  })

  it('flow steps keep this environment’s outbound options; a new step has none', () => {
    const p = applyTargetKeeps(
      snap({
        nivaro_flow_operations: {
          '5': row({ id: 5, key: 'send', options: '{"url":"https://dev","body":"v2"}' }),
          '6': row({ id: 6, key: 'new', options: '{"url":"https://dev2","body":"x"}' })
        }
      }),
      keeps,
      {
        nivaro_flow_operations: {
          '5': row({ id: 5, key: 'send', options: '{"url":"https://prod","body":"v1"}' })
        }
      },
      OUT
    )
    expect(JSON.parse(String(p.snapshot.tables.nivaro_flow_operations['5'].data.options))).toEqual({
      body: 'v2',
      url: 'https://prod'
    })
    expect(JSON.parse(String(p.snapshot.tables.nivaro_flow_operations['6'].data.options))).toEqual({
      body: 'x'
    })
  })

  it('a row new here with a kept non-switch column is held back, never inserted half-set', () => {
    const extra: EnvKeepEntry = {
      source: 'core',
      id: 'x:scheduled',
      label: 'Scheduled reports',
      reason: 'r',
      table: 'nivaro_scheduled_reports',
      kind: 'columns',
      key: ['name'],
      columns: ['recipients', 'is_active']
    }
    const p = applyTargetKeeps(
      snap({
        nivaro_scheduled_reports: {
          '1': row({ id: 1, name: 'weekly', recipients: 'dev@x', is_active: true })
        }
      }),
      [extra],
      { nivaro_scheduled_reports: {} },
      OUT
    )
    expect(p.snapshot.tables.nivaro_scheduled_reports).toEqual({})
    expect(p.held[0]).toMatchObject({
      table: 'nivaro_scheduled_reports',
      key: '1',
      label: 'weekly'
    })
    expect(p.held[0].reason).toMatch(/recipients/)
  })

  it('switchOff knows the switches', () => {
    expect(switchOff('nivaro_sync_jobs', 'is_active')).toEqual({ value: false })
    expect(switchOff('nivaro_flows', 'status')).toEqual({ value: 'inactive' })
    expect(switchOff('nivaro_webhooks', 'url')).toBeNull()
  })
})

describe('plan reference', () => {
  it('changes when any row or the delete choice changes', () => {
    const a = snap({ nivaro_roles: { '1': row({ id: 1, name: 'A' }) } })
    const b = snap({ nivaro_roles: { '1': row({ id: 1, name: 'B' }) } })
    expect(preparedRef(a, false)).toBe(preparedRef(a, false))
    expect(preparedRef(a, false)).not.toBe(preparedRef(b, false))
    expect(preparedRef(a, false)).not.toBe(preparedRef(a, true))
  })
})

describe('identity warning', () => {
  it('counts updates that rename a row (ids may not match between environments)', () => {
    const t = (fields: string[], op: 'update' | 'insert' = 'update') => ({
      key: '1',
      op,
      label: null,
      fields: fields.map((field) => ({ field, now: 'a', was: 'b' }))
    })
    const preview = {
      tables: [
        { rows: [t(['name']), t(['description']), t(['key'], 'insert'), t(['collection', 'x'])] }
      ]
    } as unknown as Parameters<typeof identityChanges>[0]
    expect(identityChanges(preview)).toBe(2)
  })
})
