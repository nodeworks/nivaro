import type { Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import { hashRow, redactRow, type SnapshotRow } from '../../../services/config-inventory.js'
import {
  applyTablePlans,
  type ColumnInfo,
  computeCascade,
  type ForeignKey,
  grantUserIds,
  isLockTimeout,
  isRetryableDbError,
  orderBySelfRef,
  orderTables,
  planHash,
  planTable,
  publicRows,
  RestoreOpError,
  type RunnableOp,
  runOps,
  type TableColumns,
  toDbValue
} from '../../../services/config-restore.js'
import { idsToPrune } from '../../../services/config-snapshots.js'

function rows(data: Record<string, Record<string, unknown>>): Record<string, SnapshotRow> {
  const out: Record<string, SnapshotRow> = {}
  for (const [k, d] of Object.entries(data)) out[k] = { hash: hashRow(d), data: d }
  return out
}

function cols(spec: Record<string, Partial<ColumnInfo>>): TableColumns {
  return new Map(
    Object.entries(spec).map(([c, i]) => [
      c,
      { type: 'nvarchar', identity: false, writable: true, ...i } as ColumnInfo
    ])
  )
}

const layoutCols = cols({
  id: { type: 'int', identity: true },
  name: {},
  col_span: { type: 'int' }
})

describe('planTable', () => {
  it('plans inserts, updates and deletes to make live look like the snapshot', () => {
    const target = rows({
      '1': { id: 1, name: 'Main', col_span: 2 },
      '2': { id: 2, name: 'Side', col_span: 1 },
      '3': { id: 3, name: 'Gone since', col_span: 1 }
    })
    const live = rows({
      '1': { id: 1, name: 'Main', col_span: 2 },
      '2': { id: 2, name: 'Side', col_span: 4 },
      '9': { id: 9, name: 'Added since', col_span: 1 }
    })
    const p = planTable('nivaro_collection_layouts', target, live, layoutCols, { deletes: true })
    expect(p.inserts).toBe(1)
    expect(p.updates).toBe(1)
    expect(p.deletes).toBe(1)
    expect(p.unchanged).toBe(1)
    expect(p.ops.map((o) => `${o.op}:${o.key}`)).toEqual(['delete:9', 'insert:3', 'update:2'])
    // An update writes only what differs.
    expect(p.ops.find((o) => o.op === 'update')?.fields).toEqual(['col_span'])
    // An insert carries the id (ids are preserved).
    expect(p.ops.find((o) => o.op === 'insert')?.fields).toContain('id')
  })

  it('never deletes when deletes are off (uploaded-snapshot apply) and honours a key scope', () => {
    const target = rows({ '1': { id: 1, name: 'A' }, '2': { id: 2, name: 'B' } })
    const live = rows({ '1': { id: 1, name: 'a' }, '5': { id: 5, name: 'E' } })
    const p = planTable('nivaro_collection_layouts', target, live, layoutCols, { deletes: false })
    expect(p.deletes).toBe(0)
    expect(p.inserts + p.updates).toBe(2)
    const scoped = planTable('nivaro_collection_layouts', target, live, layoutCols, {
      deletes: true,
      keys: new Set(['1'])
    })
    expect(scoped.ops.map((o) => `${o.op}:${o.key}`)).toEqual(['update:1'])
  })

  it('skips and reports keyless rows on both sides', () => {
    const target = rows({ '#abc': { a: 1 }, '1': { id: 1, name: 'x' } })
    const live = rows({ '#def': { a: 2 }, '1': { id: 1, name: 'x' } })
    const p = planTable('nivaro_collection_layouts', target, live, layoutCols, { deletes: true })
    expect(p.ops).toEqual([])
    expect(p.skipped_keyless).toBe(2)
  })

  it('treats a row that differs only in columns the snapshot never had as unchanged', () => {
    // The snapshot predates a migration that added `col_span`.
    const target = rows({ '1': { id: 1, name: 'Main' } })
    const live = rows({ '1': { id: 1, name: 'Main', col_span: 3 } })
    const p = planTable('nivaro_collection_layouts', target, live, layoutCols, { deletes: true })
    expect(p.ops).toEqual([])
    expect(p.untracked_only).toBe(1)
    expect(p.unchanged).toBe(1)
  })

  it('never writes redacted or credential columns, even when a file carries them', () => {
    const settingsCols = cols({ id: { type: 'int' }, project_name: {}, smtp_pass: {} })
    const target = rows({ '1': { id: 1, project_name: 'Old', smtp_pass: 'from-a-file' } })
    const live = rows({ '1': { id: 1, project_name: 'New' } })
    const p = planTable('nivaro_settings', target, live, settingsCols, { deletes: true })
    expect(p.ops[0].fields).toEqual(['project_name'])
    const userCols = cols({ id: {}, email: {}, password_hash: {}, static_token: {} })
    const t2 = rows({ u1: { id: 'u1', email: 'a@x', password_hash: 'h', static_token: 't' } })
    const p2 = planTable('nivaro_users', t2, {}, userCols, { deletes: true })
    expect(p2.ops[0].fields.sort()).toEqual(['email', 'id'])
  })

  it('reports snapshot columns the live table no longer has and does not write them', () => {
    const target = rows({ '1': { id: 1, name: 'A', view_mode: 'grid' } })
    const live = rows({ '1': { id: 1, name: 'B' } })
    const p = planTable('nivaro_collection_layouts', target, live, layoutCols, { deletes: true })
    expect(p.dropped_columns).toEqual(['view_mode'])
    expect(p.ops[0].fields).toEqual(['name'])
  })

  it('compares dates by instant: a Date live and its ISO string in the snapshot are equal', () => {
    const c = cols({ id: { type: 'int' }, at: { type: 'datetime' }, name: {} })
    const target = rows({ '1': { id: 1, at: '2026-10-01T08:00:00.000Z', name: 'x' } })
    const liveData = { id: 1, at: new Date('2026-10-01T08:00:00.000Z'), name: 'y' }
    const live = { '1': { hash: hashRow(liveData), data: liveData } }
    const p = planTable('nivaro_collection_layouts', target, live, c, { deletes: true })
    expect(p.ops[0].fields).toEqual(['name'])
  })
})

describe('planHash', () => {
  const target = rows({ '1': { id: 1, name: 'A' } })
  it('is stable for the same plan and moves when the live row it overwrites moves', () => {
    const live1 = rows({ '1': { id: 1, name: 'B' } })
    const live2 = rows({ '1': { id: 1, name: 'C' } })
    const p1 = planTable('t', target, live1, layoutCols, { deletes: true })
    const p1b = planTable('t', target, live1, layoutCols, { deletes: true })
    const p2 = planTable('t', target, live2, layoutCols, { deletes: true })
    expect(planHash('snapshot:1', [p1])).toBe(planHash('snapshot:1', [p1b]))
    expect(planHash('snapshot:1', [p1])).not.toBe(planHash('snapshot:1', [p2]))
    expect(planHash('snapshot:1', [p1])).not.toBe(planHash('snapshot:2', [p1]))
    expect(planHash('snapshot:1', [p1])).toMatch(/^[0-9a-f]{64}$/)
  })
  it('moves when a new row appears live (a new delete)', () => {
    const live1 = rows({ '1': { id: 1, name: 'A' } })
    const live2 = rows({ '1': { id: 1, name: 'A' }, '2': { id: 2, name: 'new' } })
    const h1 = planHash('s', [planTable('t', target, live1, layoutCols, { deletes: true })])
    const h2 = planHash('s', [planTable('t', target, live2, layoutCols, { deletes: true })])
    expect(h1).not.toBe(h2)
  })
})

describe('ordering', () => {
  const fks: ForeignKey[] = [
    { child: 'b', childCol: 'a_id', parent: 'a', parentCol: 'id' },
    { child: 'c', childCol: 'b_id', parent: 'b', parentCol: 'id' },
    { child: 'c', childCol: 'parent_id', parent: 'c', parentCol: 'id' },
    { child: 'x', childCol: 'a_id', parent: 'a', parentCol: 'id' }
  ]
  it('orders tables parent-first, ignoring self-references and tables outside the plan', () => {
    expect(orderTables(['c', 'b', 'a'], fks)).toEqual(['a', 'b', 'c'])
    expect(orderTables(['c', 'a'], fks)).toEqual(['c', 'a'])
  })
  it('keeps every table on a cycle', () => {
    const cyc: ForeignKey[] = [
      { child: 'p', childCol: 'q_id', parent: 'q', parentCol: 'id' },
      { child: 'q', childCol: 'p_id', parent: 'p', parentCol: 'id' }
    ]
    expect(orderTables(['p', 'q', 'r'], cyc).sort()).toEqual(['p', 'q', 'r'])
  })
  it('orders self-referencing rows parent-first', () => {
    const data: Record<string, Record<string, unknown>> = {
      '3': { parent_id: 2 },
      '2': { parent_id: 1 },
      '1': { parent_id: null },
      '7': { parent_id: 99 }
    }
    const out = orderBySelfRef(['3', '2', '1', '7'], (k) => data[k], ['parent_id'])
    expect(out.indexOf('1')).toBeLessThan(out.indexOf('2'))
    expect(out.indexOf('2')).toBeLessThan(out.indexOf('3'))
  })
})

describe('runOps', () => {
  const fk = Object.assign(new Error('FK conflict'), { number: 547 })
  it('retries a constraint failure after the rest of the pass', async () => {
    const done: string[] = []
    let parentIn = false
    const ops: RunnableOp[] = [
      {
        table: 'c',
        key: '1',
        op: 'insert',
        run: async () => {
          if (!parentIn) throw fk
          done.push('child')
        }
      },
      {
        table: 'p',
        key: '1',
        op: 'insert',
        run: async () => {
          parentIn = true
          done.push('parent')
        }
      }
    ]
    await runOps(ops, { retryable: isRetryableDbError, alive: async () => true })
    expect(done).toEqual(['parent', 'child'])
  })
  it('throws (so the transaction rolls back) on a non-retryable error', async () => {
    const ops: RunnableOp[] = [
      {
        table: 't',
        key: '4',
        op: 'update',
        run: async () => {
          throw new Error('conversion failed')
        }
      }
    ]
    await expect(
      runOps(ops, { retryable: isRetryableDbError, alive: async () => true })
    ).rejects.toBeInstanceOf(RestoreOpError)
  })
  it('throws when the transaction is no longer alive, and when a pass makes no progress', async () => {
    const op: RunnableOp = {
      table: 't',
      key: '1',
      op: 'delete',
      run: async () => {
        throw fk
      }
    }
    await expect(
      runOps([op], { retryable: isRetryableDbError, alive: async () => false })
    ).rejects.toThrow(/delete t #1/)
    await expect(
      runOps([op], { retryable: isRetryableDbError, alive: async () => true })
    ).rejects.toBeInstanceOf(RestoreOpError)
  })
})

describe('toDbValue', () => {
  it('turns ISO strings back into dates for date columns only', () => {
    expect(
      toDbValue('2026-10-01T08:00:00.000Z', { type: 'datetime', identity: false, writable: true })
    ).toBeInstanceOf(Date)
    expect(
      toDbValue('2026-10-01T08:00:00.000Z', { type: 'nvarchar', identity: false, writable: true })
    ).toBe('2026-10-01T08:00:00.000Z')
  })
  it('rebuilds buffers and stringifies other objects', () => {
    const b = toDbValue(
      { type: 'Buffer', data: [1, 2] },
      { type: 'varbinary', identity: false, writable: true }
    )
    expect(Buffer.isBuffer(b)).toBe(true)
    expect(toDbValue({ a: 1 }, { type: 'nvarchar', identity: false, writable: true })).toBe(
      '{"a":1}'
    )
    expect(toDbValue(null, undefined)).toBeNull()
  })
})

describe('publicRows', () => {
  it('shows live → snapshot values per changed field and never a field the plan skips', () => {
    const settingsCols = cols({ id: { type: 'int' }, project_name: {}, smtp_pass: {} })
    const target = rows({ '1': { id: 1, project_name: 'Old', smtp_pass: 'x' } })
    const live = rows({ '1': { id: 1, project_name: 'New' } })
    const p = planTable('nivaro_settings', target, live, settingsCols, { deletes: true })
    const out = publicRows(p, target, live)
    expect(out[0].fields).toEqual([{ field: 'project_name', now: 'New', was: 'Old' }])
  })
})

/** A knex-transaction stand-in: parses each raw batch into a short log line. */
function fakeTrx(failOn?: (sql: string) => Error | null) {
  const log: string[] = []
  const batches: string[] = []
  const trx = (() => {
    throw new Error('the engine writes through trx.raw only')
  }) as unknown as Parameters<typeof applyTablePlans>[0]
  ;(trx as unknown as { raw: (sql: string, b?: unknown[]) => Promise<unknown> }).raw = (
    sql: string,
    b: unknown[] = []
  ) => {
    if (/XACT_STATE/.test(sql)) return Promise.resolve([{ s: 1 }])
    batches.push(sql)
    let line = sql
    const del = sql.match(/DELETE FROM \[(\w+)\] WHERE \[id\] = \?/)
    const upd = sql.match(/UPDATE \[(\w+)\] SET (.+) WHERE \[id\] = \?/)
    const ins = sql.match(/INSERT INTO \[(\w+)\]/)
    if (del) line = `delete ${del[1]} ${b[0]}`
    else if (upd)
      line = `update ${upd[1]} ${b[b.length - 1]} ${[...upd[2].matchAll(/\[(\w+)\]/g)].map((m) => m[1]).join(',')}`
    else if (ins)
      line = `${/IDENTITY_INSERT/.test(sql) ? 'identity-insert' : 'insert'} ${ins[1]} ${b[0]}`
    const err = failOn?.(line)
    log.push(line)
    if (err) return Promise.reject(err)
    return Promise.resolve(upd ? [{ n: 1 }] : [])
  }
  return { trx, log, batches }
}

describe('applyTablePlans', () => {
  const columns = new Map<string, TableColumns>([
    ['nivaro_workflow_templates', cols({ id: { type: 'uniqueidentifier' }, name: {} })],
    [
      'nivaro_workflow_states',
      cols({ id: { type: 'int', identity: true }, template_id: {}, key: {} })
    ]
  ])
  const fks: ForeignKey[] = [
    {
      child: 'nivaro_workflow_states',
      childCol: 'template_id',
      parent: 'nivaro_workflow_templates',
      parentCol: 'id'
    }
  ]
  const target = {
    nivaro_workflow_templates: rows({ T1: { id: 'T1', name: 'Approval' } }),
    nivaro_workflow_states: rows({
      '5': { id: 5, template_id: 'T1', key: 'draft' },
      '6': { id: 6, template_id: 'T1', key: 'done' }
    })
  }
  const live = {
    nivaro_workflow_templates: rows({ T9: { id: 'T9', name: 'New one' } }),
    nivaro_workflow_states: rows({
      '6': { id: 6, template_id: 'T1', key: 'finished' },
      '8': { id: 8, template_id: 'T9', key: 'x' }
    })
  }
  const plans = ['nivaro_workflow_templates', 'nivaro_workflow_states'].map((t) =>
    planTable(
      t,
      target[t as keyof typeof target],
      live[t as keyof typeof live],
      columns.get(t) as TableColumns,
      {
        deletes: true
      }
    )
  )

  it('deletes child-first, then inserts and updates parent-first, ids kept via IDENTITY_INSERT', async () => {
    const { trx, log, batches } = fakeTrx()
    const counts = await applyTablePlans(trx, plans, target, live, columns, fks)
    expect(log).toEqual([
      'delete nivaro_workflow_states 8',
      'delete nivaro_workflow_templates T9',
      'insert nivaro_workflow_templates T1',
      'identity-insert nivaro_workflow_states 5',
      'update nivaro_workflow_states 6 key'
    ])
    // Every write batch carries its own lock timeout (a SET never outlives a knex.raw call).
    expect(batches.every((sql) => sql.startsWith('SET LOCK_TIMEOUT 10000;'))).toBe(true)
    expect(counts).toEqual([
      { table: 'nivaro_workflow_templates', inserted: 1, updated: 0, deleted: 1 },
      { table: 'nivaro_workflow_states', inserted: 1, updated: 1, deleted: 1 }
    ])
  })

  it('retries a delete blocked by a reference until the rest of the pass clears it', async () => {
    let blocked = true
    const { trx, log } = fakeTrx((sql) => {
      if (sql === 'delete nivaro_workflow_templates T9' && blocked) {
        blocked = false
        return Object.assign(new Error('REFERENCE constraint'), { number: 547 })
      }
      return null
    })
    await applyTablePlans(trx, plans, target, live, columns, fks)
    expect(log.filter((l) => l === 'delete nivaro_workflow_templates T9')).toHaveLength(2)
  })

  it('throws on a hard failure so the caller rolls the whole restore back', async () => {
    const { trx } = fakeTrx((sql) =>
      sql.startsWith('update') ? new Error('String or binary data would be truncated') : null
    )
    await expect(applyTablePlans(trx, plans, target, live, columns, fks)).rejects.toThrow(
      /update nivaro_workflow_states #6/
    )
  })
})

describe('applyTablePlans — payload templates (migration 501)', () => {
  const T = 'nivaro_payload_templates'
  const V = 'nivaro_payload_template_versions'
  const D = 'nivaro_payload_template_drafts'
  type Tables = Record<string, Record<string, SnapshotRow>>
  const columns = new Map<string, TableColumns>([
    [T, cols({ id: { type: 'int', identity: true }, key: {}, published_body: {} })],
    [V, cols({ id: { type: 'int', identity: true }, template_id: { type: 'int' }, version: {} })],
    [
      D,
      cols({ id: { type: 'int', identity: true }, template_id: { type: 'int' }, body: {}, rev: {} })
    ]
  ])
  // The real FKs (NO ACTION) — loadForeignKeys reads them from sys.foreign_keys on apply.
  const fks: ForeignKey[] = [
    { child: V, childCol: 'template_id', parent: T, parentCol: 'id', onDelete: 'NO_ACTION' },
    { child: D, childCol: 'template_id', parent: T, parentCol: 'id', onDelete: 'NO_ACTION' }
  ]

  it('a restore that deletes a template deletes its draft row (and versions) first', async () => {
    // The snapshot predates template 3; the live instance has it with a version and a draft.
    const target: Tables = {
      [T]: rows({ '1': { id: 1, key: 'kept', published_body: '{}' } }),
      [V]: rows({ '10': { id: 10, template_id: 1, version: 1 } }),
      [D]: rows({ '20': { id: 20, template_id: 1, body: '{}', rev: 1 } })
    }
    const live: Tables = {
      [T]: rows({
        '1': { id: 1, key: 'kept', published_body: '{}' },
        '3': { id: 3, key: 'gone', published_body: '{}' }
      }),
      [V]: rows({
        '10': { id: 10, template_id: 1, version: 1 },
        '11': { id: 11, template_id: 3, version: 1 }
      }),
      [D]: rows({
        '20': { id: 20, template_id: 1, body: '{}', rev: 1 },
        '21': { id: 21, template_id: 3, body: '{}', rev: 4 }
      })
    }
    const plans = [T, V, D].map((t) =>
      planTable(t, target[t], live[t], columns.get(t) as TableColumns, { deletes: true })
    )
    // Drafts carry an identity id now: matched by it, never skipped as keyless.
    expect(plans.find((p) => p.table === D)?.skipped_keyless).toBe(0)
    const { trx, log } = fakeTrx()
    await applyTablePlans(trx, plans, target, live, columns, fks)
    expect(log.indexOf(`delete ${D} 21`)).toBeGreaterThanOrEqual(0)
    expect(log.indexOf(`delete ${D} 21`)).toBeLessThan(log.indexOf(`delete ${T} 3`))
    expect(log.indexOf(`delete ${V} 11`)).toBeLessThan(log.indexOf(`delete ${T} 3`))
    expect(log).toHaveLength(3)
  })

  it('a restore that brings a template back inserts it before its draft, ids kept', async () => {
    const target: Tables = {
      [T]: rows({ '3': { id: 3, key: 'back', published_body: '{}' } }),
      [D]: rows({ '21': { id: 21, template_id: 3, body: '{}', rev: 2 } })
    }
    const live: Tables = { [T]: rows({}), [D]: rows({}) }
    const plans = [D, T].map((t) =>
      planTable(t, target[t], live[t], columns.get(t) as TableColumns, { deletes: true })
    )
    const { trx, log } = fakeTrx()
    await applyTablePlans(trx, plans, target, live, columns, fks)
    expect(log).toEqual([`identity-insert ${T} 3`, `identity-insert ${D} 21`])
  })
})

describe('applyTablePlans — external API instance_overrides (redacted by value)', () => {
  const apiCols = new Map<string, TableColumns>([
    [
      'nivaro_external_apis',
      cols({ id: { type: 'int', identity: true }, name: {}, instance_overrides: {} })
    ]
  ])
  const liveRaw = {
    id: 4,
    name: 'MWF',
    instance_overrides: JSON.stringify({
      production: {
        base_url: 'https://prod-NEW.example',
        auth_config: { body_secrets: { token: 'PROD-TOKEN' } }
      }
    })
  }
  const snapRaw = {
    id: 4,
    name: 'MWF',
    instance_overrides: JSON.stringify({
      production: {
        base_url: 'https://prod-OLD.example',
        auth_config: { body_secrets: { token: 'OLD-TOKEN' } }
      }
    })
  }

  function redacted(raw: Record<string, unknown>): Record<string, SnapshotRow> {
    const data = redactRow('nivaro_external_apis', raw)
    return { '4': { hash: hashRow(data), data } }
  }

  it('the update keeps the live credentials and takes only the plain parts from the snapshot', async () => {
    const target = { nivaro_external_apis: redacted(snapRaw) }
    const live = { nivaro_external_apis: redacted(liveRaw) }
    expect(JSON.stringify(target)).not.toContain('OLD-TOKEN')
    const plan = planTable(
      'nivaro_external_apis',
      target.nivaro_external_apis,
      live.nivaro_external_apis,
      apiCols.get('nivaro_external_apis') as TableColumns,
      { deletes: false }
    )
    expect(plan.ops).toEqual([
      expect.objectContaining({ op: 'update', fields: ['instance_overrides'] })
    ])
    const writes: Array<{ sql: string; b: unknown[] }> = []
    const trx = (() => {
      throw new Error('raw only')
    }) as unknown as Parameters<typeof applyTablePlans>[0]
    ;(trx as unknown as { raw: (sql: string, b?: unknown[]) => Promise<unknown> }).raw = async (
      sql: string,
      b: unknown[] = []
    ) => {
      if (/XACT_STATE/.test(sql)) return [{ s: 1 }]
      writes.push({ sql, b })
      if (/SELECT \[instance_overrides\] FROM \[nivaro_external_apis\] WITH \(UPDLOCK/.test(sql))
        return [{ instance_overrides: liveRaw.instance_overrides }]
      return /UPDATE/.test(sql) ? [{ n: 1 }] : []
    }
    await applyTablePlans(trx, [plan], target, live, apiCols, [])
    const upd = writes.find((w) => /UPDATE \[nivaro_external_apis\]/.test(w.sql))
    expect(upd).toBeDefined()
    const written = JSON.parse(String(upd?.b[0]))
    expect(written).toEqual({
      production: {
        base_url: 'https://prod-OLD.example',
        auth_config: { body_secrets: { token: 'PROD-TOKEN' } }
      }
    })
    expect(JSON.stringify(writes)).not.toContain('OLD-TOKEN')
  })
})

describe('idsToPrune', () => {
  it('keeps the newest N per trigger kind — nightly rows never push out deploy points', () => {
    const list: Array<{ id: number; trigger: string }> = []
    let id = 1
    list.push({ id: id++, trigger: 'pre-deploy' })
    for (let i = 0; i < 40; i++) list.push({ id: id++, trigger: 'cron' })
    for (let i = 0; i < 12; i++) list.push({ id: id++, trigger: 'pre-restore' })
    const drop = new Set(idsToPrune(list))
    expect(drop.has(1)).toBe(false) // the old deploy point survives 40 nights
    expect(list.filter((r) => r.trigger === 'cron' && !drop.has(r.id))).toHaveLength(30)
    expect(list.filter((r) => r.trigger === 'pre-restore' && !drop.has(r.id))).toHaveLength(10)
    // The oldest go first.
    expect(drop.has(2)).toBe(true)
    expect(drop.has(41)).toBe(false)
  })
})

describe('grants only for people active now', () => {
  const U1 = 'AAAAAAAA-1111-4111-8111-111111111111'
  const U2 = 'BBBBBBBB-2222-4222-8222-222222222222'
  const scopeCols = cols({ id: { type: 'int', identity: true }, user: {}, dimension: {} })
  const target = rows({
    '1': { id: 1, user: U1, dimension: 'division' },
    '2': { id: 2, user: U2, dimension: 'division' },
    '3': { id: 3, user: U2, dimension: 'zone' }
  })
  const live = rows({ '3': { id: 3, user: U2, dimension: 'project' } })

  it('skips inserts and updates granting to someone not active, and counts them', () => {
    const p = planTable('nivaro_user_scopes', target, live, scopeCols, {
      deletes: true,
      isActiveUser: (u) => u.toUpperCase() === U1
    })
    expect(p.ops.map((o) => `${o.op}:${o.key}`)).toEqual(['insert:1'])
    expect(p.skipped_inactive_user).toBe(2)
    expect(p.inactive_keys).toEqual(['2', '3'])
  })

  it('folds the skipped grants into the plan hash', () => {
    const some = planTable('nivaro_user_scopes', target, live, scopeCols, {
      deletes: true,
      isActiveUser: (u) => u.toUpperCase() === U1
    })
    const all = planTable('nivaro_user_scopes', target, live, scopeCols, {
      deletes: true,
      isActiveUser: () => true
    })
    expect(planHash('s', [some])).not.toBe(planHash('s', [all]))
  })

  it('collects the people grant rows name (GUIDs only)', () => {
    expect(
      grantUserIds(
        { nivaro_user_scopes: rows({ a: { id: 'a', user: U1 }, b: { id: 'b', user: 'x' } }) },
        ['nivaro_user_scopes']
      )
    ).toEqual([U1])
  })

  it('leaves non-grant tables alone', () => {
    const p = planTable(
      'nivaro_collection_layouts',
      rows({ '1': { id: 1, name: 'A' } }),
      {},
      layoutCols,
      {
        deletes: true,
        isActiveUser: () => false
      }
    )
    expect(p.inserts).toBe(1)
  })
})

describe('cascade effects of planned deletes', () => {
  const fks: ForeignKey[] = [
    {
      child: 'nivaro_queue_sources',
      childCol: 'queue',
      parent: 'nivaro_queues',
      parentCol: 'id',
      onDelete: 'CASCADE'
    },
    {
      child: 'nivaro_queue_items',
      childCol: 'queue',
      parent: 'nivaro_queues',
      parentCol: 'id',
      onDelete: 'CASCADE'
    },
    {
      child: 'nivaro_widgets',
      childCol: 'queue',
      parent: 'nivaro_queues',
      parentCol: 'id',
      onDelete: 'NO_ACTION'
    }
  ]
  const queueCols = cols({ id: { type: 'int' }, name: {} })
  const srcCols = cols({ id: { type: 'int' }, queue: { type: 'int' } })
  // Live: queue 9 (added since) with two sources (one also deleted by the plan) and 40 queue items.
  const fake = {
    raw: async (sql: string) => {
      if (sql.includes('[nivaro_queue_sources]')) return [{ id: '90' }, { id: '91' }]
      if (sql.includes('[nivaro_queue_items]'))
        return Array.from({ length: 40 }, (_, i) => ({ id: String(i) }))
      throw new Error(`unexpected ${sql}`)
    }
  } as unknown as Knex

  it('counts rows a delete takes with it beyond what the plan deletes, and hashes them', async () => {
    const queues = planTable(
      'nivaro_queues',
      {},
      rows({ '9': { id: 9, name: 'New' } }),
      queueCols,
      { deletes: true }
    )
    const sources = planTable(
      'nivaro_queue_sources',
      {},
      rows({ '90': { id: 90, queue: 9 } }),
      srcCols,
      {
        deletes: true
      }
    )
    const effects = await computeCascade(fake, [queues, sources], fks)
    expect(effects).toEqual([
      {
        table: 'nivaro_queues',
        child: 'nivaro_queue_items',
        column: 'queue',
        action: 'CASCADE',
        rows: 40
      },
      {
        table: 'nivaro_queues',
        child: 'nivaro_queue_sources',
        column: 'queue',
        action: 'CASCADE',
        rows: 1
      }
    ])
    const withOut = planHash('s', [queues, sources], { cascade: effects })
    expect(withOut).not.toBe(planHash('s', [queues, sources]))
    // Opting in is part of what was previewed.
    expect(planHash('s', [queues, sources], { cascade: effects, allowCascade: true })).not.toBe(
      withOut
    )
  })

  it('reports nothing when no delete is planned', async () => {
    const queues = planTable(
      'nivaro_queues',
      rows({ '9': { id: 9, name: 'A' } }),
      rows({ '9': { id: 9, name: 'B' } }),
      queueCols,
      {
        deletes: true
      }
    )
    expect(await computeCascade(fake, [queues], fks)).toEqual([])
  })
})

describe('secrets in previews', () => {
  it('masks a secret-named column a stored snapshot still carries, both sides', () => {
    // A row deleted since, from a live table that (wrongly) still exposes the column.
    const c = cols({ id: { type: 'int' }, name: {}, api_token: {}, git_token: {} })
    const live = {
      '7': { hash: 'h', data: { id: 7, name: 'Prod', api_token: 'live-secret', git_token: 'g' } }
    }
    const p = planTable('nivaro_environment_components', {}, live, c, { deletes: true })
    const out = publicRows(p, {}, live)
    const fields = Object.fromEntries(out[0].fields.map((f) => [f.field, f.now]))
    expect(fields.api_token).toBe('••••••')
    expect(fields.git_token).toBe('••••••')
    expect(fields.name).toBe('Prod')
  })

  it('never plans a write of a secret column even when a file carries it', () => {
    const c = cols({
      id: { type: 'int' },
      name: {},
      client_secret: {},
      ai_gateway_client_secret: {}
    })
    const target = rows({
      '1': { id: 1, name: 'x', client_secret: 's', ai_gateway_client_secret: 's2' }
    })
    const p = planTable('nivaro_settings', target, {}, c, { deletes: false })
    expect(p.ops[0].fields.sort()).toEqual(['id', 'name'])
  })
})

describe('isLockTimeout', () => {
  it('reads SQL Server 1222 by number or by text', () => {
    expect(isLockTimeout(Object.assign(new Error('x'), { number: 1222 }))).toBe(true)
    expect(isLockTimeout(new Error('Lock request time out period exceeded.'))).toBe(true)
    expect(isLockTimeout(new Error('deadlock'))).toBe(false)
  })
})
