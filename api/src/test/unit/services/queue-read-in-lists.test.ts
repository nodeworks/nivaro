import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// Queue item reads bind their id lists through whereInList: from JSON_LIST_MIN
// ids one OPENJSON parameter (one cached plan for every length) instead of an
// N-parameter IN list, which SQL Server compiles afresh per length (0.5–1.5 s
// each at ~2,000 ids on EFP production, 2026-11-08). Short lists keep the plain
// IN; an empty list still issues nothing.
const h = vi.hoisted(() => ({
  seen: [] as FakeQuery[],
  answer: (_q: FakeQuery): unknown => []
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      h.seen.push(q)
      return h.answer(q)
    })
  }
})
vi.mock('../../../services/collections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/collections.js')>()),
  getCollection: vi.fn(async () => undefined),
  getRelations: vi.fn(async () => []),
  getPhysicalColumns: vi.fn(async () => null)
}))

import { db } from '../../../db/index.js'
import {
  activeAddendumInstances,
  addendumSummaryBatch
} from '../../../services/addendum-summary.js'
import { JSON_LIST_MIN } from '../../../services/db-batch.js'
import { fulfilmentBatch } from '../../../services/fulfilment.js'
import {
  activeOwnersOnly,
  buildDelegationSubstitutions,
  resolveStateOwnersBatch
} from '../../../services/pipeline-engine.js'
import {
  fillBlankLabels,
  newPathReadBatch,
  renderTemplateLabels,
  resolveAggregateValues,
  resolvePathValues
} from '../../../services/queues.js'
import { unseenChangesFor } from '../../../services/record-unseen.js'
import { sendBackBatch } from '../../../services/send-backs.js'
import type { CMSRelation } from '../../../types.js'

const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1))
const uuids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`)

/** The statements that read `table`, by their FROM. */
const readsOf = (table: string) => h.seen.filter((q) => q.sql.includes(`from [${table}]`))

function expectOpenJson(q: FakeQuery | undefined, column: string, values: string[]) {
  expect(q, `no read of ${column}`).toBeDefined()
  expect(q!.sql).toContain(`${column} IN (SELECT [value] FROM OPENJSON(@p`)
  expect(q!.sql).not.toMatch(/ in \(@p\d+(, @p\d+){49,}\)/)
  const json = q!.bindings.find((b) => typeof b === 'string' && b.startsWith('['))
  expect(JSON.parse(String(json))).toEqual(values)
}

const RELATIONS = [
  { many_collection: 'workflows', many_field: 'vendor', one_collection: 'vendors' },
  {
    many_collection: 'lines',
    many_field: 'workflow',
    one_collection: 'workflows',
    one_field: 'lines'
  },
  {
    many_collection: 'workflows_regions',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'regions',
    junction_field: 'regions_id'
  },
  {
    many_collection: 'workflows_regions',
    many_field: 'regions_id',
    one_collection: 'regions',
    junction_field: 'workflows_id'
  }
].map((r, i) => ({ id: i + 1, one_field: null, junction_field: null, ...r })) as CMSRelation[]
const relCache = () => new Map<string, CMSRelation[]>([['workflows', RELATIONS]])

beforeEach(() => {
  h.seen.length = 0
  h.answer = () => []
})

describe('queue item reads bind long id lists as one OPENJSON array', () => {
  const many = ids(JSON_LIST_MIN + 10)

  it('send-backs, fulfilment and addendum summaries', async () => {
    const inst = uuids(JSON_LIST_MIN)
    await sendBackBatch(inst)
    expectOpenJson(readsOf('nivaro_workflow_history')[0], '[h].[instance]', inst)

    await fulfilmentBatch('inventory_request', many, {
      shipped_field: 'shipped',
      requested_field: 'requested'
    } as never)
    expectOpenJson(readsOf('inventory_request')[0], '[id]', many)

    await addendumSummaryBatch('workflows', many, db)
    expectOpenJson(readsOf('nivaro_addendums')[0], '[parent_id]', many)

    h.seen.length = 0
    await activeAddendumInstances('workflows', many, db)
    expectOpenJson(readsOf('nivaro_addendums')[0], '[a].[parent_id]', many)
  })

  it('changed-since-you-looked marks: edits, moves and comments', async () => {
    await unseenChangesFor('u1', 'workflows', many)
    expectOpenJson(readsOf('nivaro_activity')[0], '[a].[item]', many)
    expectOpenJson(readsOf('nivaro_workflow_history')[0], '[i].[item]', many)
    expectOpenJson(readsOf('nivaro_comments')[0], '[c].[item]', many)
  })

  it('owner people reads: delegation, active owners, instance owners', async () => {
    const people = uuids(JSON_LIST_MIN + 1)
    await buildDelegationSubstitutions(people, db)
    expectOpenJson(readsOf('nivaro_users')[0], '[id]', people)

    h.seen.length = 0
    await activeOwnersOnly(
      people.map((id) => ({ id })),
      db
    )
    expectOpenJson(readsOf('nivaro_users')[0], '[id]', people)

    h.seen.length = 0
    const inst = uuids(JSON_LIST_MIN)
    await resolveStateOwnersBatch(
      inst.map((instanceId, i) => ({
        key: `k${i}`,
        stateId: 'S1',
        instanceId,
        collection: 'workflows',
        itemId: String(i + 1)
      })),
      db
    ).catch(() => undefined)
    expectOpenJson(readsOf('nivaro_pipeline_instance_owners')[0], '[io].[instance]', inst)
  })

  it('labels and template labels', async () => {
    await renderTemplateLabels('workflows', many, '{{name}}')
    expectOpenJson(readsOf('workflows')[0], '[id]', many)

    h.seen.length = 0
    h.answer = (q) =>
      q.sql.includes('[nivaro_fields]') ? [{ field: 'id' }, { field: 'name' }] : []
    await fillBlankLabels({}, 'workflows', many)
    expectOpenJson(readsOf('workflows')[0], '[id]', many)
  })

  it('extra-column paths: plain, m2o, o2m, m2m and their aggregates', async () => {
    const batch = newPathReadBatch()
    await batch.rows('lines', many, ['sku'], 'workflow')
    expectOpenJson(readsOf('lines')[0], '[workflow]', many)

    h.seen.length = 0
    h.answer = (q) =>
      q.sql.startsWith('select [id], [vendor] from [workflows]')
        ? many.map((id) => ({ id, vendor: id }))
        : []
    await resolvePathValues('workflows', many, ['vendor'], relCache())
    expectOpenJson(readsOf('workflows')[0], '[id]', many)
    expectOpenJson(readsOf('vendors')[0], '[id]', many)

    h.answer = () => []
    h.seen.length = 0
    await resolvePathValues('workflows', many, ['lines'], relCache())
    expectOpenJson(readsOf('lines')[0], '[workflow]', many)

    h.seen.length = 0
    await resolvePathValues('workflows', many, ['regions'], relCache())
    expectOpenJson(readsOf('workflows_regions')[0], '[_j].[workflows_id]', many)

    h.seen.length = 0
    await resolveAggregateValues('workflows', many, ['lines', 'id'], 'count', relCache())
    expectOpenJson(readsOf('lines')[0], '[workflow]', many)

    h.seen.length = 0
    await resolveAggregateValues('workflows', many, ['regions', 'id'], 'count', relCache())
    expectOpenJson(readsOf('workflows_regions')[0], '[_j].[workflows_id]', many)
  })

  it('short lists keep the plain IN; empty lists read nothing', async () => {
    const few = ids(3)
    await fulfilmentBatch('inventory_request', few, {
      shipped_field: 'shipped',
      requested_field: 'requested'
    } as never)
    const q = readsOf('inventory_request')[0]
    expect(q.sql).toMatch(/\[id\] in \(@p\d+, @p\d+, @p\d+\)/)
    expect(q.sql).not.toContain('OPENJSON')

    h.seen.length = 0
    await sendBackBatch([])
    await fulfilmentBatch('inventory_request', [], {
      shipped_field: 'shipped',
      requested_field: 'requested'
    } as never)
    await addendumSummaryBatch('workflows', [], db)
    await unseenChangesFor('u1', 'workflows', [])
    await buildDelegationSubstitutions([], db)
    await renderTemplateLabels('workflows', [], '{{name}}')
    await resolvePathValues('workflows', [], ['vendor'], relCache())
    expect(h.seen).toEqual([])
  })
})
