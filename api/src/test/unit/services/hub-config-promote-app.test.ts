import { describe, expect, it } from 'vitest'
import {
  CONFIG_TABLES,
  type ConfigSnapshot,
  hashRow,
  redactRow,
  redactSnapshot,
  type SnapshotRow
} from '../../../services/config-inventory.js'
import {
  CONFIG_PROMOTION_GROUPS,
  promotableTables,
  SETTINGS_PROMOTED,
  tablesForGroups
} from '../../../services/config-promote-groups.js'
import { planTable, RESTORE_EXCLUDED } from '../../../services/config-restore.js'
import { allKeeps, type EnvKeepEntry } from '../../../services/env-refresh/registry.js'
import {
  exportSnapshot,
  PromoteError,
  parsePromoteRequest,
  parseTables,
  staleRows,
  type UndoRow,
  undoRowsOf,
  undoTarget
} from '../../../services/hub-link/config-promote.js'
import {
  applyFlowKeeps,
  applyTargetKeeps,
  KEEP_PSEUDO_COLUMNS,
  stripKeepSecrets,
  switchOff
} from '../../../services/hub-link/config-promote-keeps.js'
import { mapToTarget } from '../../../services/hub-link/config-promote-map.js'
import { planProcs, procsRef } from '../../../services/hub-link/config-promote-procs.js'
import {
  deepStrip,
  exportStepOptions,
  exportTriggerOptions,
  mergeOwn,
  stepTop
} from '../../../services/hub-link/config-promote-secrets.js'

// Hub config promotion (idea 30), app side, pure: what leaves the source, how rows are matched
// across environments, what the target keeps, and what an undo puts back.

const row = (data: Record<string, unknown>): SnapshotRow => ({ hash: hashRow(data), data })
const snap = (tables: ConfigSnapshot['tables']): ConfigSnapshot => ({
  format: 1,
  generated_at: '2026-11-25T00:00:00.000Z',
  instance: { version: '0.3.215', environment: 'production', database: 'src' },
  classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
  tables,
  errors: {}
})
const RUN = 'run-key-aaaaaaaaaaaaaaaa'
const opts = (o: Record<string, unknown>) => JSON.stringify(o)
const parsed = (v: unknown) => JSON.parse(String(v))

describe('stored restore points keep flows whole (as on main)', () => {
  it('a snapshot row of a step keeps its URL and headers, and a restore re-inserts them', () => {
    const data = {
      id: 'a',
      flow: 'f',
      key: 'send',
      name: 'Send',
      type: 'webhook',
      options: opts({ url: 'https://partner', headers: { Authorization: 'Bearer x' } })
    }
    const red = redactRow('nivaro_flow_operations', data)
    expect(red.options).toBe(data.options)
    const stored = redactSnapshot(snap({ nivaro_flow_operations: { a: row(red) } }))
    const cols = new Map(
      Object.keys(data).map((c) => [c, { type: 'nvarchar', identity: false, writable: true }])
    )
    const plan = planTable(
      'nivaro_flow_operations',
      stored.tables.nivaro_flow_operations,
      {},
      cols,
      {
        deletes: true
      }
    )
    expect(plan.ops[0]).toMatchObject({ op: 'insert', key: 'a' })
    expect(plan.ops[0].fields).toContain('options')
    expect(parsed(stored.tables.nivaro_flow_operations.a.data.options).url).toBe('https://partner')
  })

  it('trigger options with their webhook secret stay in a stored point', () => {
    const red = redactRow('nivaro_flows', {
      id: 'f',
      trigger_options: opts({ auth_type: 'bearer', secret: 's1' })
    })
    expect(parsed(red.trigger_options).secret).toBe('s1')
  })
})

describe('promotion groups', () => {
  it('names only CONFIG tables a restore may write, and no history table', () => {
    const config = new Set(CONFIG_TABLES)
    for (const t of promotableTables()) {
      expect(config.has(t), t).toBe(true)
      expect(RESTORE_EXCLUDED[t], t).toBeUndefined()
      expect(t, t).not.toMatch(/version|draft/)
    }
  })

  it('offers no layouts or pipelines (ids inside JSON are not mapped yet)', () => {
    expect(CONFIG_PROMOTION_GROUPS.map((g) => g.key)).toEqual([
      'flows',
      'payload_templates',
      'managed_procedures',
      'roles',
      'settings'
    ])
    expect(tablesForGroups(['roles'])).toEqual(['nivaro_roles', 'nivaro_policies'])
  })

  it('settings carry no column that names roles or other rows by id', () => {
    for (const c of ['ad_group_role_map', 'new_user_role', 'nav_role_defaults', 'command_center'])
      expect(SETTINGS_PROMOTED).not.toContain(c)
    expect(SETTINGS_PROMOTED).toContain('welcome_message')
  })
})

describe('request checks', () => {
  it('refuses tables outside the groups and a missing run key', () => {
    expect(() => parseTables(['nivaro_users'])).toThrow(PromoteError)
    expect(() => parsePromoteRequest({ snapshot: snap({}), tables: ['nivaro_roles'] })).toThrow(
      /run_key/
    )
    const r = parsePromoteRequest({
      snapshot: snap({}),
      tables: ['nivaro_roles'],
      run_key: RUN,
      refs: { external_api: { '3': 'MDSi' }, bogus: { x: 'y' } }
    })
    expect(r.refs).toEqual({ external_api: { '3': 'MDSi' } })
  })
})

describe('export filter (the promotion path only)', () => {
  it('a step loses its top-level outbound part and every nested secret, at any depth', () => {
    const e = exportStepOptions(
      opts({
        url: 'https://p',
        method: 'POST',
        body: '{"id":"{{id}}"}',
        request: {
          query: { api_key: 'Q' },
          nested: [{ deep: { Authorization: 'A', password: 'P', keep: 1, zz_token: 'T' } }]
        },
        mystery: { client_secret: 'C', unknownThing: { sessionId: 'S', fine: 'ok' } }
      })
    )
    expect(parsed(e.options)).toEqual({
      method: 'POST',
      body: '{"id":"{{id}}"}',
      request: { nested: [{ deep: { keep: 1 } }] },
      mystery: { unknownThing: { fine: 'ok' } }
    })
    expect(e.stripped).toContain('url')
  })

  it('a trigger loses the whole inbound-auth group', () => {
    expect(
      parsed(
        exportTriggerOptions(
          opts({ auth_type: 'none', secret: 's', require_timestamp: true, method: 'POST' })
        )
      )
    ).toEqual({ method: 'POST' })
  })

  it('audit, deploy and history columns never travel; unlisted columns are dropped', () => {
    const out = exportSnapshot(
      snap({
        nivaro_managed_procedures: {
          '1': row({
            id: 1,
            name: 'usp_x',
            body: 'CREATE PROCEDURE usp_x AS SELECT 1',
            deployed_hash: 'h',
            deployed_at: 'x',
            version: 4,
            owner: 'u',
            brand_new_column: 'secret?'
          })
        },
        nivaro_settings: {
          '1': row({ id: 1, welcome_message: 'hi', new_user_role: 'uuid', smtp_host: 'm' })
        }
      })
    )
    expect(out.snapshot.tables.nivaro_managed_procedures['1'].data).toEqual({
      id: 1,
      name: 'usp_x',
      body: 'CREATE PROCEDURE usp_x AS SELECT 1'
    })
    expect(out.snapshot.tables.nivaro_settings['1'].data).toEqual({ id: 1, welcome_message: 'hi' })
  })

  it('deepStrip leaves plain config alone', () => {
    expect(deepStrip({ a: [1, { b: 'c' }], tokens: 5 })).toEqual({ a: [1, { b: 'c' }], tokens: 5 })
  })
})

describe('keep pseudo-columns', () => {
  it('the outbound pseudo-column strips a step’s outbound options', () => {
    const out = stripKeepSecrets(
      snap({
        nivaro_flow_operations: {
          '1': row({ id: 1, options: opts({ url: 'https://hook', token: 't0k', body: 'b' }) })
        }
      }),
      allKeeps([])
    )
    expect(parsed(out.tables.nivaro_flow_operations['1'].data.options)).toEqual({ body: 'b' })
    expect(Object.keys(KEEP_PSEUDO_COLUMNS.nivaro_flow_operations)).toEqual(['outbound', 'fields'])
  })

  it('on the source, a secret name it cannot apply throws instead of doing nothing', () => {
    const odd: EnvKeepEntry = {
      source: 'x',
      id: 'x:odd',
      label: 'Odd',
      reason: 'r',
      table: 'nivaro_roles',
      kind: 'columns',
      key: ['id'],
      columns: [],
      secret_columns: ['endpoint_blob']
    }
    const s = snap({ nivaro_roles: { '1': row({ id: 1, name: 'A' }) } })
    expect(() => stripKeepSecrets(s, [odd], { strict: true })).toThrow(/neither a column/)
    expect(() => stripKeepSecrets(s, [odd])).not.toThrow()
  })
})

describe('natural keys and references (never by id)', () => {
  const srcFlows = {
    s1: row({ id: 's1', name: 'Order submitted', status: 'active' }),
    s2: row({ id: 's2', name: 'Brand new', status: 'active' })
  }
  const tgtFlows = {
    t9: row({ id: 't9', name: 'order submitted', status: 'active' })
  }

  it('matches by name, keeps the target id, gives a new row a fresh id (never the source’s)', () => {
    const m = mapToTarget({
      source: { nivaro_flows: srcFlows },
      target: { nivaro_flows: tgtFlows },
      sourceDict: {},
      targetDict: {},
      runKey: RUN
    })
    expect(m.refusals).toEqual([])
    expect(m.ids.nivaro_flows.get('s1')).toBe('t9')
    const fresh = m.ids.nivaro_flows.get('s2') as string
    expect(fresh).not.toBe('s2')
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/)
    expect(m.tables.nivaro_flows.t9.data.id).toBe('t9')
  })

  it('a step whose flow changed is a NEW step (it never keeps another step’s URL)', () => {
    // dev step 12 belongs to flow A; prod step 12 (same id!) belongs to flow B with partner B's URL.
    const m = mapToTarget({
      source: {
        nivaro_flows: { a: row({ id: 'a', name: 'A' }) },
        nivaro_flow_operations: { '12': row({ id: '12', flow: 'a', key: 'post', name: 'Post' }) }
      },
      target: {
        nivaro_flows: { a2: row({ id: 'a2', name: 'A' }), b: row({ id: 'b', name: 'B' }) },
        nivaro_flow_operations: {
          '12': row({
            id: '12',
            flow: 'b',
            key: 'post',
            options: opts({ url: 'https://partner-b' })
          })
        }
      },
      sourceDict: {},
      targetDict: {},
      runKey: RUN
    })
    const id = m.ids.nivaro_flow_operations.get('12') as string
    expect(id).not.toBe('12')
    expect(m.inserted.nivaro_flow_operations.has(id)).toBe(true)
    expect(m.tables.nivaro_flow_operations[id].data.flow).toBe('a2')
  })

  it('remaps references by name and refuses what the target does not have', () => {
    const m = mapToTarget({
      source: {
        nivaro_flows: { f: row({ id: 'f', name: 'F' }) },
        nivaro_flow_operations: {
          o1: row({ id: 'o1', flow: 'f', key: 'call', options: opts({ api_id: 3, body: 'x' }) }),
          o2: row({ id: 'o2', flow: 'f', key: 'call2', options: opts({ api_id: 4 }) }),
          o3: row({ id: 'o3', flow: 'f', key: 'upd', options: opts({ id: 77, item: '{{key}}' }) })
        },
        nivaro_payload_templates: { '5': row({ id: 5, key: 'order', external_api: 3 }) }
      },
      target: { nivaro_payload_templates: { '9': row({ id: 9, key: 'order', external_api: 1 }) } },
      sourceDict: { external_api: { '3': 'MDSi', '4': 'Gone' } },
      targetDict: { external_api: { mdsi: '21' } },
      runKey: RUN
    })
    const codes = m.refusals.map((r) => `${r.code}:${r.reason.slice(0, 40)}`)
    expect(codes.filter((c) => c.startsWith('REF_UNMAPPED'))).toHaveLength(2)
    expect(m.refusals.some((r) => /“Gone”/.test(r.reason))).toBe(true)
    expect(m.refusals.some((r) => /literal id/.test(r.reason))).toBe(true)
    const o1 = m.tables.nivaro_flow_operations[m.ids.nivaro_flow_operations.get('o1') as string]
    expect(parsed(o1.data.options).api_id).toBe(21)
    expect(m.tables.nivaro_payload_templates['9'].data.external_api).toBe(21)
  })

  it('two rows sharing a name are ROW_UNMATCHED', () => {
    const m = mapToTarget({
      source: { nivaro_flows: { x: row({ id: 'x', name: 'Dup' }) } },
      target: {
        nivaro_flows: { a: row({ id: 'a', name: 'dup' }), b: row({ id: 'b', name: 'DUP' }) }
      },
      sourceDict: {},
      targetDict: {},
      runKey: RUN
    })
    expect(m.refusals[0]).toMatchObject({ code: 'ROW_UNMATCHED', table: 'nivaro_flows' })
  })

  it('policies follow their role by name; settings map to the target’s one row', () => {
    const m = mapToTarget({
      source: {
        nivaro_roles: { r1: row({ id: 'r1', name: 'Editor' }) },
        nivaro_policies: { '7': row({ id: 7, role: 'r1', collection: 'units', action: 'read' }) },
        nivaro_settings: { '1': row({ id: 1, welcome_message: 'hi' }) }
      },
      target: {
        nivaro_roles: { R9: row({ id: 'R9', name: 'editor' }) },
        nivaro_policies: { '40': row({ id: 40, role: 'R9', collection: 'units', action: 'read' }) },
        nivaro_settings: { '3': row({ id: 3 }) }
      },
      sourceDict: {},
      targetDict: {},
      runKey: RUN
    })
    expect(m.refusals).toEqual([])
    expect(m.tables.nivaro_policies['40'].data.role).toBe('R9')
    expect(m.tables.nivaro_settings['3'].data.id).toBe(3)
  })
})

describe('what the target keeps', () => {
  const keeps = allKeeps([])

  it('H2: dev auth none onto prod bearer → prod keeps bearer and its secret', () => {
    const live = {
      nivaro_flows: {
        f: row({
          id: 'f',
          name: 'Partner callback',
          trigger: 'webhook',
          status: 'active',
          trigger_options: opts({ auth_type: 'bearer', secret: 'PROD', method: 'POST' })
        })
      }
    }
    const incoming = exportSnapshot(
      snap({
        nivaro_flows: {
          f: row({
            id: 'f',
            name: 'Partner callback',
            trigger: 'webhook',
            status: 'active',
            trigger_options: opts({ auth_type: 'none', method: 'PUT' })
          })
        }
      })
    ).snapshot.tables
    const p = applyFlowKeeps(
      applyTargetKeeps(incoming, keeps, live),
      live,
      {},
      {
        sessionSecret: 'x'.repeat(40),
        runKey: RUN
      }
    )
    expect(parsed(p.tables.nivaro_flows.f.data.trigger_options)).toEqual({
      method: 'PUT',
      auth_type: 'bearer',
      secret: 'PROD'
    })
  })

  it('a webhook flow new here arrives inactive with bearer auth and a fresh secret', () => {
    const p = applyFlowKeeps(
      applyTargetKeeps(
        {
          nivaro_flows: {
            n: row({
              id: 'n',
              name: 'New hook',
              trigger: 'webhook',
              status: 'active',
              trigger_options: opts({ method: 'POST' })
            })
          }
        },
        keeps,
        {}
      ),
      {},
      {},
      { sessionSecret: 'x'.repeat(40), runKey: RUN }
    )
    const t = parsed(p.tables.nivaro_flows.n.data.trigger_options)
    expect(t.auth_type).toBe('bearer')
    expect(t.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(p.tables.nivaro_flows.n.data.status).toBe('inactive')
  })

  it('M1: an existing active flow that gains a step needing this environment’s URL lands inactive', () => {
    const live = {
      nivaro_flows: {
        f: row({ id: 'f', name: 'Order submitted', status: 'active', trigger: 'event' })
      },
      nivaro_flow_operations: {}
    }
    const incoming = {
      nivaro_flows: {
        f: row({ id: 'f', name: 'Order submitted', status: 'active', trigger: 'event' })
      },
      nivaro_flow_operations: {
        s: row({
          id: 's',
          flow: 'f',
          key: 'notify',
          name: 'Notify partner',
          options: opts({ body: 'x' })
        })
      }
    }
    const p = applyFlowKeeps(
      applyTargetKeeps(incoming, keeps, live),
      live,
      { s: ['url', 'headers'] },
      {
        sessionSecret: 'x'.repeat(40),
        runKey: RUN
      }
    )
    expect(p.tables.nivaro_flows.f.data.status).toBe('inactive')
    expect(p.needs_setup[0]).toMatchObject({ flow: 'Order submitted', step: 'Notify partner' })
    expect(p.needs_setup[0].reason).toMatch(/url, headers/)
  })

  it('a matched step gets the target’s own outbound part and nested secrets back', () => {
    const own = opts({ url: 'https://prod', request: { query: { api_key: 'PK' } }, body: 'old' })
    expect(parsed(mergeOwn(opts({ body: 'new', request: {} }), own, stepTop))).toEqual({
      body: 'new',
      request: { query: { api_key: 'PK' } },
      url: 'https://prod'
    })
  })

  it('switchOff knows the switches', () => {
    expect(switchOff('nivaro_sync_jobs', 'is_active')).toEqual({ value: false })
    expect(switchOff('nivaro_flows', 'status')).toEqual({ value: 'inactive' })
  })
})

describe('undo puts back exactly the rows the run wrote', () => {
  const rows: UndoRow[] = [
    {
      table: 'nivaro_roles',
      key: 'a',
      op: 'update',
      before: { id: 'a', name: 'Old' },
      after_hash: 'h1'
    },
    { table: 'nivaro_roles', key: 'b', op: 'insert', before: null, after_hash: 'h2' },
    {
      table: 'nivaro_roles',
      key: 'c',
      op: 'delete',
      before: { id: 'c', name: 'Gone' },
      after_hash: null
    }
  ]

  it('scoped to those rows: updates back, inserts removed, deletes re-inserted', () => {
    const t = undoTarget(rows)
    expect(t.keys.nivaro_roles).toEqual(['a', 'b', 'c'])
    expect(Object.keys(t.tables.nivaro_roles).sort()).toEqual(['a', 'c'])
    const cols = new Map(
      ['id', 'name'].map((c) => [c, { type: 'nvarchar', identity: false, writable: true }])
    )
    const live = {
      a: { hash: 'h1', data: { id: 'a', name: 'New' } },
      b: { hash: 'h2', data: { id: 'b', name: 'Added' } },
      later: { hash: 'zz', data: { id: 'later', name: 'Made after' } }
    }
    const plan = planTable('nivaro_roles', t.tables.nivaro_roles, live, cols, {
      deletes: true,
      keys: new Set(t.keys.nivaro_roles)
    })
    expect(plan.ops.map((o) => `${o.op}:${o.key}`).sort()).toEqual([
      'delete:b',
      'insert:c',
      'update:a'
    ])
  })

  it('STALE when any of them changed since (rows made after are never touched)', () => {
    expect(
      staleRows(rows, {
        nivaro_roles: { a: { hash: 'h1', data: {} }, b: { hash: 'h2', data: {} } }
      })
    ).toEqual([])
    expect(
      staleRows(rows, {
        nivaro_roles: { a: { hash: 'EDITED', data: {} }, b: { hash: 'h2', data: {} } }
      }).map((r) => r.key)
    ).toEqual(['a'])
    expect(
      staleRows(rows, {
        nivaro_roles: {
          a: { hash: 'h1', data: {} },
          b: { hash: 'h2', data: {} },
          c: { hash: 'x', data: {} }
        }
      }).map((r) => r.key)
    ).toEqual(['c'])
  })

  it('undoRowsOf records before values and after hashes', () => {
    const out = undoRowsOf({
      plans: [
        {
          table: 'nivaro_roles',
          ops: [
            { op: 'update', key: 'a', live_hash: 'x', target_hash: 'y', fields: ['name'] },
            { op: 'insert', key: 'b', live_hash: null, target_hash: 'z', fields: ['name'] }
          ]
        } as never
      ],
      before: { nivaro_roles: { a: { hash: 'x', data: { id: 'a', name: 'Old' } } } },
      after: {
        nivaro_roles: {
          a: { hash: 'A1', data: {} },
          b: { hash: 'B1', data: {} }
        }
      }
    })
    expect(out).toEqual([
      {
        table: 'nivaro_roles',
        key: 'a',
        op: 'update',
        before: { id: 'a', name: 'Old' },
        after_hash: 'A1'
      },
      { table: 'nivaro_roles', key: 'b', op: 'insert', before: null, after_hash: 'B1' }
    ])
  })
})

describe('managed procedures through their own writer', () => {
  const cur = [
    {
      name: 'usp_a',
      body: 'CREATE PROCEDURE usp_a AS SELECT 1',
      body_hash: 'h',
      version: 3,
      description: null,
      dropped: false
    },
    { name: 'usp_old', body: 'x', body_hash: 'o', version: 1, description: null, dropped: false }
  ]
  it('adds, changes and (with removals) drops; refuses an import-owned name', () => {
    const p = planProcs(
      {
        '1': row({ name: 'usp_a', body: 'CREATE PROCEDURE usp_a AS SELECT 2' }),
        '2': row({ name: 'usp_new', body: 'CREATE PROCEDURE usp_new AS SELECT 1' }),
        '3': row({ name: 'usp_imp', body: 'CREATE PROCEDURE usp_imp AS SELECT 1' })
      },
      cur,
      new Set(['usp_imp']),
      true
    )
    expect(p.items.map((i) => `${i.op}:${i.name}`)).toEqual([
      'change:usp_a',
      'add:usp_new',
      'drop:usp_old'
    ])
    expect(p.refusals[0]).toMatchObject({ code: 'PROC_IMPORT_OWNED' })
    expect(procsRef(p.items)).toMatch(/^[0-9a-f]{64}$/)
  })
})
