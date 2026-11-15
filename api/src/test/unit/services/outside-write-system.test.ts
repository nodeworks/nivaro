import { describe, expect, it } from 'vitest'
import { fileJunctions, planSystemTables } from '../../../services/change-tracking-plan.js'
import {
  childDetailQuery,
  dependentTables,
  mapChildRows,
  mapSystemRows,
  NOTICE_ID_CAP,
  planEmits,
  probeQuery,
  SYSTEM_TABLES,
  systemDetailQuery
} from '../../../services/outside-write-system.js'

const rels = [
  // addendums.workflow → workflows (many-to-one)
  { many_collection: 'addendums', many_field: 'workflow', one_collection: 'workflows' },
  // addendums_directus_files: addendums ↔ files
  {
    many_collection: 'addendums_directus_files',
    many_field: 'addendums_id',
    one_collection: 'addendums',
    one_field: 'files',
    junction_field: 'directus_files_id'
  },
  {
    many_collection: 'addendums_directus_files',
    many_field: 'directus_files_id',
    one_collection: 'directus_files',
    junction_field: 'addendums_id'
  },
  // line_items.workflow → workflows; line_items.creator → nivaro_users (system: ignored)
  { many_collection: 'line_items', many_field: 'workflow', one_collection: 'workflows' },
  { many_collection: 'line_items', many_field: 'creator', one_collection: 'nivaro_users' }
]

describe('system rows → aspects on the owning record', () => {
  it('pipeline instances and history → $state + $owners; an addendum instance also tells its parent', () => {
    const p = mapSystemRows('nivaro_workflow_instances', [
      { op: 'U', c: 'workflows', i: '42' },
      { op: 'U', c: 'nivaro_addendums', i: 'A-1', pc: 'workflows', pi: '42' },
      { op: 'D', c: null, i: null }
    ])
    expect(p.notices).toEqual([
      { collection: 'workflows', item: '42', aspects: ['$state', '$owners', '$addendums'] },
      { collection: 'nivaro_addendums', item: 'A-1', aspects: ['$state', '$owners'] }
    ])
    expect(
      mapSystemRows('nivaro_workflow_history', [{ op: 'I', c: 'requests', i: '7' }]).notices
    ).toEqual([{ collection: 'requests', item: '7', aspects: ['$state', '$owners'] }])
  })

  it('tasks → $tasks on their record (+ my work); support tickets poke the support desk instead', () => {
    const p = mapSystemRows('nivaro_tasks', [
      { op: 'U', id: '1', c: 'workflows', i: '9', kind: 'task' },
      { op: 'I', id: '2', c: null, i: null, kind: 'support' },
      { op: 'D', id: '3', c: null, i: null, kind: null }
    ])
    expect(p.notices).toEqual([{ collection: 'workflows', item: '9', aspects: ['$tasks'] }])
    expect(p.ops.sort()).toEqual(['my-work', 'support'])
  })

  it('comments (field comments too) → $comments; files → their carriers', () => {
    expect(
      mapSystemRows('nivaro_comments', [
        { op: 'I', c: 'workflows', i: '5' },
        { op: 'U', c: 'workflows', i: '5' }
      ]).notices
    ).toEqual([{ collection: 'workflows', item: '5', aspects: ['$comments'] }])
    expect(
      mapSystemRows('nivaro_files', [
        { op: 'U', id: 'F1' },
        { op: 'D', id: 'F2' },
        { op: 'U', id: 'F1' }
      ]).files
    ).toEqual(['F1', 'F2'])
  })

  it('people: directory changes only, ids only; a new person = anyone + created', () => {
    expect(
      mapSystemRows('nivaro_users', [
        { op: 'U', id: 'u-1', dir: 1 },
        { op: 'U', id: 'u-2', dir: 0 } // last_access only
      ]).people
    ).toEqual({ ids: ['U-1'], created: false })
    expect(mapSystemRows('nivaro_users', [{ op: 'U', id: 'u-2', dir: 0 }]).people).toBeNull()
    expect(mapSystemRows('nivaro_users', [{ op: 'I', id: 'u-3', dir: 1 }]).people).toEqual({
      ids: [],
      created: true
    })
  })

  it('addendums and approvals → $addendums on the parent; an approval also moves the addendum', () => {
    expect(
      mapSystemRows('nivaro_addendums', [{ op: 'U', id: 'A-1', pc: 'workflows', pi: '42' }]).notices
    ).toEqual([
      { collection: 'workflows', item: '42', aspects: ['$addendums'] },
      { collection: 'nivaro_addendums', item: 'A-1', aspects: ['$addendums'] }
    ])
    expect(
      mapSystemRows('nivaro_addendum_approvals', [
        { op: 'I', aid: 'A-1', pc: 'workflows', pi: '42' }
      ]).notices
    ).toEqual([
      { collection: 'workflows', item: '42', aspects: ['$addendums'] },
      { collection: 'nivaro_addendums', item: 'A-1', aspects: ['$addendums', '$state'] }
    ])
    // deleted since: nothing to name
    expect(mapSystemRows('nivaro_addendums', [{ op: 'D', id: 'A-2' }]).notices).toEqual([])
  })

  it('reads every system table with ids and owner columns only', () => {
    for (const t of SYSTEM_TABLES) {
      const sql = systemDetailQuery(t, '10', '20')
      expect(sql).toContain(`CHANGETABLE(CHANGES [dbo].[${t}], 10) AS ct`)
      expect(sql).toContain('ct.SYS_CHANGE_VERSION <= 20')
      expect(sql).not.toMatch(/password|static_token|totp/i)
    }
    expect(systemDetailQuery('nivaro_users', '1', '2')).toContain(
      "CHANGE_TRACKING_IS_COLUMN_IN_MASK(COLUMNPROPERTY(OBJECT_ID(N'dbo.nivaro_users'), N'first_name', 'ColumnId'), ct.SYS_CHANGE_COLUMNS) = 1"
    )
    expect(() => systemDetailQuery('nivaro_tasks', '1 OR 1=1', '2')).toThrow()
  })
})

describe('registered child and junction rows → their parents', () => {
  it('an addendum row tells its parent $related + $addendums', () => {
    expect(mapChildRows('addendums', rels, [{ op: 'U', id: 3, workflow: 42 }])).toEqual([
      { collection: 'workflows', item: '42', aspects: ['$related', '$addendums'] }
    ])
  })

  it('an addendum file link tells the addendum $related + $files', () => {
    expect(
      mapChildRows('addendums_directus_files', rels, [
        { op: 'I', id: 8, addendums_id: 3, directus_files_id: 'F1' }
      ])
    ).toEqual([{ collection: 'addendums', item: '3', aspects: ['$related', '$files'] }])
  })

  it('a plain child tells its parent $related; system parents and deleted rows are dropped', () => {
    expect(
      mapChildRows('line_items', rels, [
        { op: 'U', id: 1, workflow: 42, creator: 'u-1' },
        { op: 'D', id: null, workflow: null, creator: null }
      ])
    ).toEqual([{ collection: 'workflows', item: '42', aspects: ['$related'] }])
  })

  it('finds the tracked child / junction tables of what is watched', () => {
    const tracked = new Set(['addendums', 'addendums_directus_files', 'line_items'])
    expect(dependentTables(['workflows'], rels, tracked).sort()).toEqual([
      'addendums',
      'line_items'
    ])
    expect(dependentTables(['addendums'], rels, tracked)).toEqual(['addendums_directus_files'])
    expect(dependentTables(['workflows'], rels, new Set())).toEqual([])
  })

  it('child read joins the current row; probe asks every table in one round trip', () => {
    expect(childDetailQuery('addendums', 'id', '5', '9')).toContain(
      'LEFT JOIN [dbo].[addendums] b ON b.[id] = ct.[id]'
    )
    const probe = probeQuery(['nivaro_tasks', 'addendums'], '5', '9')
    expect(probe.split('UNION ALL')).toHaveLength(2)
    expect(probe).toContain("CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(N'dbo.addendums')) <= 5")
  })
})

describe('emits', () => {
  it('skips what the app already told, splits foreign aspects, goes wide past the cap', () => {
    const recent = new Map([['workflows', { ids: new Map([['5', 1000]]), wholeAt: -Infinity }]])
    const e = planEmits(
      [
        { collection: 'workflows', item: '5', aspects: ['$comments'] },
        { collection: 'workflows', item: '6', aspects: ['$related', '$addendums'] },
        { collection: 'addendums', item: '3', aspects: ['$related', '$files'] }
      ],
      recent,
      2000,
      15_000
    )
    expect(e.deduped).toBe(1)
    expect(e.foreign).toEqual([
      { collection: 'workflows', item: '6', aspect: '$related' },
      { collection: 'addendums', item: '3', aspect: '$related' },
      { collection: 'addendums', item: '3', aspect: '$files' }
    ])
    expect(e.record).toEqual([{ collection: 'workflows', item: '6', aspects: ['$addendums'] }])
    const many = Array.from({ length: NOTICE_ID_CAP + 1 }, (_, i) => ({
      collection: 'workflows',
      item: String(i),
      aspects: ['$state']
    }))
    expect(planEmits(many, new Map(), 0, 1).record).toEqual([
      { collection: 'workflows', item: '*', aspects: ['$state'] }
    ])
  })
})

describe('change-tracking-setup allowlist', () => {
  it('plans only the allowlist plus file junctions; people with changed columns', () => {
    const tables = new Map([
      ['nivaro_users', { pk: true, tracked: false }],
      ['nivaro_tasks', { pk: true, tracked: true }],
      ['workflows_files', { pk: true, tracked: false }]
    ])
    const plan = planSystemTables(['workflows_files'], tables)
    expect(plan.map((p) => p.collection)).toEqual([...SYSTEM_TABLES, 'workflows_files'])
    expect(plan.find((p) => p.collection === 'nivaro_users')).toMatchObject({
      action: 'enable',
      columns: true
    })
    expect(plan.find((p) => p.collection === 'nivaro_tasks')).toMatchObject({
      action: 'skip',
      reason: 'tracked'
    })
    expect(plan.find((p) => p.collection === 'nivaro_comments')).toMatchObject({
      reason: 'not-table'
    })
    expect(fileJunctions(rels)).toEqual(['addendums_directus_files'])
  })
})
