import { describe, expect, it } from 'vitest'
import { overwrittenBy } from '../../../services/config-drift/core.js'
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
  baselineAfter,
  exportSnapshot,
  heartbeatFresh,
  orphanSteps,
  PromoteError,
  parsePromoteRequest,
  parseTables,
  renameSuspects,
  STALE_MS,
  staleRows,
  targetDictOf,
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
import { DUPLICATE, mapToTarget, UNUSABLE } from '../../../services/hub-link/config-promote-map.js'
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

describe('outbound keys at every depth, embedded secrets anywhere', () => {
  const nested = {
    request: {
      url: 'https://partner.example/x',
      headers: { Authorization: 'Bearer abc123def456' }
    },
    method: 'POST'
  }

  it('a nested request url + headers never leaves the source — step and trigger alike', () => {
    const step = exportStepOptions(opts(nested))
    expect(parsed(step.options)).toEqual({ request: {}, method: 'POST' })
    expect(step.stripped).toEqual(expect.arrayContaining(['request.url', 'request.headers']))
    expect(parsed(exportTriggerOptions(opts({ ...nested, auth_type: 'none' })))).toEqual({
      request: {},
      method: 'POST'
    })
  })

  it('the target keeps its own nested values at the same path', () => {
    const own = opts({
      request: { url: 'https://prod.example/x', headers: { Authorization: 'Bearer PROD9999' } },
      list: ['https://svc:pw9@prod.example', 'plain']
    })
    const incoming = exportStepOptions(
      opts({
        request: { url: 'https://dev', timeout: 5 },
        list: ['https://u:p@dev.example', 'plain']
      })
    ).options
    expect(parsed(mergeOwn(incoming, own, stepTop))).toEqual({
      request: {
        timeout: 5,
        url: 'https://prod.example/x',
        headers: { Authorization: 'Bearer PROD9999' }
      },
      list: ['https://svc:pw9@prod.example', 'plain']
    })
  })

  it('a userinfo URL deep in an array, or an auth token in any string, is stripped', () => {
    const e = exportStepOptions(
      opts({
        steps: [{ calls: ['https://user:pa55@host.example/a', 'https://host.example/b'] }],
        note: 'call with Basic dXNlcjpwYXNzMTIz please',
        message: 'A token is needed for this'
      })
    )
    expect(parsed(e.options)).toEqual({
      steps: [{ calls: [null, 'https://host.example/b'] }],
      message: 'A token is needed for this'
    })
    expect(e.stripped).toEqual(expect.arrayContaining(['steps.0.calls.0', 'note']))
  })

  it('a step that lost a nested URL the target lacks needs setup (flow lands inactive)', () => {
    const keeps = allKeeps([])
    const live = {
      nivaro_flows: { f: row({ id: 'f', name: 'F', status: 'active', trigger: 'event' }) },
      nivaro_flow_operations: {
        s: row({ id: 's', flow: 'f', key: 'k', name: 'Call', options: opts({ request: {} }) })
      }
    }
    const incoming = {
      nivaro_flows: { f: row({ id: 'f', name: 'F', status: 'active', trigger: 'event' }) },
      nivaro_flow_operations: {
        s: row({ id: 's', flow: 'f', key: 'k', name: 'Call', options: opts({ request: {} }) })
      }
    }
    const p = applyFlowKeeps(
      applyTargetKeeps(incoming, keeps, live),
      live,
      { s: ['request.url'] },
      {
        sessionSecret: 'x'.repeat(40),
        runKey: RUN
      }
    )
    expect(p.tables.nivaro_flows.f.data.status).toBe('inactive')
    expect(p.needs_setup[0].reason).toMatch(/request\.url/)
  })
})

// ── round 4 ─────────────────────────────────────────────────────────────────

describe('N4: ids in options and permissions are remapped or refused, never carried', () => {
  const U1 = '11111111-1111-4111-8111-111111111111'
  const U2 = '22222222-2222-4222-8222-222222222222'
  const U3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const flowWith = (options: Record<string, unknown>) => ({
    nivaro_flows: { f: row({ id: 'f', name: 'F' }) },
    nivaro_flow_operations: {
      o: row({ id: 'o', flow: 'f', key: 'notify', options: opts(options) })
    }
  })
  const step = (m: ReturnType<typeof mapToTarget>) =>
    parsed(
      m.tables.nivaro_flow_operations[m.ids.nivaro_flow_operations.get('o') as string].data.options
    )

  it('recipient / exclude / assignee people are remapped by email, lists included', () => {
    const m = mapToTarget({
      source: flowWith({ recipients: `${U1},${U2}`, exclude: [U2], assignee: U1, timeout: '30' }),
      target: {},
      sourceDict: { user: { [U1]: 'ann@x.test', [U2]: 'bob@x.test' } },
      targetDict: { user: { 'ann@x.test': T1, 'bob@x.test': T2 } },
      runKey: RUN
    })
    expect(m.refusals).toEqual([])
    const o = step(m)
    expect(o.recipients).toBe(`${T1},${T2}`)
    expect(o.exclude).toEqual([T2])
    expect(o.assignee).toBe(T1)
    expect(o.timeout).toBe('30')
  })

  it('a person missing, duplicated or unusable on the target refuses REF_UNMAPPED', () => {
    const m = mapToTarget({
      source: flowWith({ recipient: U1, run_as: U2, owner: U3 }),
      target: {},
      sourceDict: { user: { [U1]: 'ann@x.test', [U2]: 'bot@x.test', [U3]: 'dup@x.test' } },
      targetDict: { user: { 'ann@x.test': UNUSABLE, 'dup@x.test': DUPLICATE } },
      runKey: RUN
    })
    const reasons = m.refusals.filter((r) => r.code === 'REF_UNMAPPED').map((r) => r.reason)
    expect(reasons.some((r) => /suspended, redacted or a machine/.test(r))).toBe(true)
    expect(reasons.some((r) => /more than one/.test(r))).toBe(true)
    expect(reasons.some((r) => /bot@x.test/.test(r))).toBe(true)
  })

  it('a uuid or bare id under any other key refuses unless the key is a known number', () => {
    const m = mapToTarget({
      source: flowWith({ target_record: U1, parent: '4812', limit: '50', note: 'call 555' }),
      target: {},
      sourceDict: {},
      targetDict: {},
      runKey: RUN
    })
    const where = m.refusals.map((r) => r.reason).join(' | ')
    expect(m.refusals.filter((r) => r.code === 'REF_UNMAPPED')).toHaveLength(2)
    expect(where).toMatch(/target_record/)
    expect(where).toMatch(/parent/)
    expect(where).not.toMatch(/limit/)
  })

  it('permission JSON: a role id is remapped; any other uuid refuses', () => {
    const m = mapToTarget({
      source: {
        nivaro_roles: { [U2]: row({ id: U2, name: 'Editor' }) },
        nivaro_policies: {
          '7': row({
            id: 7,
            role: U2,
            collection: 'units',
            action: 'read',
            permissions: JSON.stringify({ _or: [{ role: { _eq: U2 } }, { owner: { _eq: U1 } }] })
          })
        }
      },
      target: { nivaro_roles: { [T2]: row({ id: T2, name: 'editor' }) } },
      sourceDict: {},
      targetDict: {},
      runKey: RUN
    })
    const pol = Object.values(m.tables.nivaro_policies)[0]
    expect(String(pol.data.permissions)).toContain(`"${T2}"`)
    expect(String(pol.data.permissions)).not.toContain(U2)
    expect(
      m.refusals.some((r) => r.code === 'REF_UNMAPPED' && /Permission rule/.test(r.reason))
    ).toBe(true)
  })

  it('the target dictionary marks duplicate names and unusable people', () => {
    const d = targetDictOf('user', [
      { id: 'a', name: 'Ann@x.test', status: 'active', account_kind: null, is_redacted: 0 },
      { id: 'b', name: 'off@x.test', status: 'suspended' },
      { id: 'c', name: 'gone@x.test', status: 'active', is_redacted: 1 },
      { id: 'd', name: 'bot@x.test', status: 'active', account_kind: 'service' },
      { id: 'e', name: 'two@x.test', status: 'active' },
      { id: 'f', name: 'TWO@x.test', status: 'active' }
    ])
    expect(d['ann@x.test']).toBe('a')
    expect(d['off@x.test']).toBe(UNUSABLE)
    expect(d['gone@x.test']).toBe(UNUSABLE)
    expect(d['bot@x.test']).toBe(UNUSABLE)
    expect(d['two@x.test']).toBe(DUPLICATE)
    expect(targetDictOf('role', [{ id: 'r', name: 'Editor' }]).editor).toBe('r')
  })

  it('settings never carry brand_logo or sla_zone_map (they name rows of this environment)', () => {
    expect(SETTINGS_PROMOTED).not.toContain('brand_logo')
    expect(SETTINGS_PROMOTED).not.toContain('sla_zone_map')
  })
})

describe('N5: steps a promoted flow no longer has are removed with it', () => {
  const live = {
    nivaro_flows: { F: row({ id: 'F', name: 'Order' }), G: row({ id: 'G', name: 'Other' }) },
    nivaro_flow_operations: {
      keep: row({ id: 'keep', flow: 'F', key: 'post', name: 'Post' }),
      old: row({ id: 'old', flow: 'F', key: 'legacy', name: 'Legacy step' }),
      g1: row({ id: 'g1', flow: 'G', key: 'x' })
    }
  }
  const mapped = {
    nivaro_flows: { F: row({ id: 'F', name: 'Order' }) },
    nivaro_flow_operations: { keep: row({ id: 'keep', flow: 'F', key: 'post' }) }
  }

  it('lists them whatever the removal setting; other flows are left alone', () => {
    expect(orphanSteps(mapped, live)).toEqual([{ key: 'old', flow: 'F', label: 'Legacy step' }])
    // Steps not promoted at all: nothing is an orphan.
    expect(orphanSteps({ nivaro_flows: mapped.nivaro_flows }, live)).toEqual([])
  })

  it('the restore plan deletes exactly them with removals off; undo rows keep them', () => {
    const cols = new Map(
      ['id', 'flow', 'key', 'name'].map((c) => [
        c,
        { type: 'nvarchar', identity: false, writable: true }
      ])
    )
    const plan = planTable(
      'nivaro_flow_operations',
      mapped.nivaro_flow_operations,
      live.nivaro_flow_operations,
      cols,
      { deletes: false, alsoDelete: new Set(['old']) }
    )
    expect(plan.ops.filter((o) => o.op === 'delete').map((o) => o.key)).toEqual(['old'])
    const rows = undoRowsOf({
      plans: [plan],
      before: { nivaro_flow_operations: live.nivaro_flow_operations },
      after: { nivaro_flow_operations: {} }
    })
    const del = rows.find((r) => r.key === 'old')
    expect(del?.op).toBe('delete')
    expect(del?.before?.name).toBe('Legacy step')
  })
})

describe('a likely rename is flagged before removals', () => {
  it('a new flow with exactly the steps of a target flow the source did not send', () => {
    const live = {
      nivaro_flows: { T: row({ id: 'T', name: 'Order submitted' }) },
      nivaro_flow_operations: {
        a: row({ id: 'a', flow: 'T', key: 'post' }),
        b: row({ id: 'b', flow: 'T', key: 'mail' })
      }
    }
    const mapped = {
      nivaro_flows: { N: row({ id: 'N', name: 'Order sent' }) },
      nivaro_flow_operations: {
        x: row({ id: 'x', flow: 'N', key: 'mail' }),
        y: row({ id: 'y', flow: 'N', key: 'post' })
      }
    }
    const flags = renameSuspects(mapped, live, new Set(['N']))
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ code: 'RENAME_SUSPECTED', key: 'N', label: 'Order sent' })
    expect(flags[0].reason).toMatch(/Order submitted/)
    expect(renameSuspects(mapped, live, new Set())).toEqual([])
  })
})

describe('N2/N3: the Changed-here baseline moves for the written rows only', () => {
  it('replaces written rows, drops deleted ones, keeps every other row as it was', () => {
    const old = {
      nivaro_roles: {
        a: row({ id: 'a', name: 'A0' }),
        b: row({ id: 'b', name: 'B0 changed here' }),
        c: row({ id: 'c', name: 'C0' })
      },
      nivaro_flows: { f: row({ id: 'f', name: 'F' }) }
    }
    const after = {
      nivaro_roles: { a: row({ id: 'a', name: 'A1' }), n: row({ id: 'n', name: 'N' }) }
    }
    const out = baselineAfter(old, {
      plans: [
        {
          table: 'nivaro_roles',
          ops: [
            { key: 'a', op: 'update' },
            { key: 'n', op: 'insert' },
            { key: 'c', op: 'delete' }
          ]
        }
      ] as never,
      before: {},
      after
    })
    expect(out.nivaro_roles.a.data.name).toBe('A1')
    expect(out.nivaro_roles.n.data.name).toBe('N')
    expect(out.nivaro_roles.c).toBeUndefined()
    // Not written by the promotion: still the old baseline (it stays a "changed here" row).
    expect(out.nivaro_roles.b.data.name).toBe('B0 changed here')
    expect(out.nivaro_flows).toBe(old.nivaro_flows)
  })
})

describe('run heartbeats', () => {
  it('fresh within STALE_MS, stale after it or when never set', () => {
    const t = Date.parse('2026-11-25T12:00:00Z')
    expect(heartbeatFresh(new Date(t - 5_000).toISOString(), t)).toBe(true)
    expect(heartbeatFresh(new Date(t - STALE_MS - 1).toISOString(), t)).toBe(false)
    expect(heartbeatFresh(null, t)).toBe(false)
  })
})

describe('nested arrays are merged back by identity, not position', () => {
  it('a list reordered on the source keeps each element’s own secret (outbound keys stay whole)', () => {
    const own = opts({
      fields: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'Bearer prod-secret-token-123456' }
      ]
    })
    const incoming = opts({ fields: [{ key: 'b' }, { key: 'a', label: 'A' }] })
    const out = parsed(mergeOwn(incoming, own, () => false))
    expect(out.fields[0]).toEqual({ key: 'b', label: 'Bearer prod-secret-token-123456' })
    expect(out.fields[1]).toEqual({ key: 'a', label: 'A' })
  })
})

describe('policy JSON: every literal id leaf refuses, operators included (security review)', () => {
  const R = '22222222-2222-4222-8222-222222222222'
  const T = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const withRule = (permissions: unknown) =>
    mapToTarget({
      source: {
        nivaro_roles: { [R]: row({ id: R, name: 'Editor' }) },
        nivaro_policies: {
          '7': row({
            id: 7,
            role: R,
            collection: 'units',
            action: 'read',
            permissions: JSON.stringify(permissions)
          })
        }
      },
      target: { nivaro_roles: { [T]: row({ id: T, name: 'editor' }) } },
      sourceDict: {},
      targetDict: {},
      runKey: RUN
    }).refusals.filter((r) => r.code === 'REF_UNMAPPED')

  it('`_eq` holding an id refuses, naming the field', () => {
    const r = withRule({ owner: { _eq: 42 } })
    expect(r).toHaveLength(1)
    expect(r[0].reason).toMatch(/permissions\.owner\._eq \(field owner\).*literal id \(42\)/)
    expect(withRule({ owner: { _eq: '42' } })).toHaveLength(1)
  })

  it('an `_in` list of ids refuses each one', () => {
    const r = withRule({ zone: { _in: [3, 4, '5'] } })
    expect(r).toHaveLength(3)
    expect(r.every((x) => /\(field zone\)/.test(x.reason))).toBe(true)
  })

  it('nested `_and` / `_or` are walked; a role id inside maps, a uuid that is not a role refuses', () => {
    const r = withRule({
      _and: [
        { _or: [{ region: { _eq: 9 } }, { role: { _eq: R } }] },
        { created_by: { _neq: '11111111-1111-4111-8111-111111111111' } }
      ]
    })
    expect(r).toHaveLength(2)
    expect(r.some((x) => /\(field region\)/.test(x.reason))).toBe(true)
    expect(r.some((x) => /\(field created_by\)/.test(x.reason))).toBe(true)
  })

  it('known-number fields, text, booleans, decimals and variables pass', () => {
    expect(
      withRule({
        _and: [
          { priority: { _gte: 2 } },
          { status: { _eq: 'open' } },
          { archived: { _eq: false } },
          { ratio: { _lt: 0.5 } },
          { owner: { _eq: '$CURRENT_USER' } }
        ]
      })
    ).toEqual([])
  })
})

describe('Changed here judges forced deletions (security review)', () => {
  const item = (key: string) => ({
    id: `nivaro_flow_operations:${key}`,
    table: 'nivaro_flow_operations',
    key,
    label: 'Legacy step',
    kind: 'changed' as const,
    intended: false,
    at: null,
    who: null
  })
  it('a production-only change on an orphan step counts even with removals off', () => {
    const live = { nivaro_flow_operations: { old: row({ id: 'old', name: 'Legacy step' }) } }
    const items = [item('old'), item('other')] as never
    const opts = { tables: ['nivaro_flow_operations'], deletes: false }
    expect(overwrittenBy(items, { nivaro_flow_operations: {} }, live, opts)).toEqual([])
    const hit = overwrittenBy(items, { nivaro_flow_operations: {} }, live, {
      ...opts,
      alsoDelete: { nivaro_flow_operations: ['old'] }
    })
    expect(hit.map((h) => h.key)).toEqual(['old'])
  })
})
