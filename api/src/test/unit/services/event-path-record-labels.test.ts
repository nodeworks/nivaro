import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PathStep } from '../../../services/event-path/types.js'

const rowsFor: Record<string, unknown[]> = {}

function builder(table: string): unknown {
  const target = {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rowsFor[table] ?? []).then(resolve)
  }
  const proxy: unknown = new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then
      return () => proxy
    }
  })
  return proxy
}

vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => builder(String(t).split(' ')[0]))
}))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async (name: string) =>
    name === 'project_sub_types'
      ? { singular: null, display_name: 'Project Sub Types' }
      : name === 'workflow_line_items'
        ? { singular: 'Workflow line item', display_name: null }
        : undefined
  )
}))
vi.mock('../../../services/queues.js', () => ({
  getLabels: vi.fn(async (by: Map<string, Set<string>>) => {
    const out: Record<string, string> = {}
    for (const [c, ids] of by) {
      for (const id of ids) {
        if (c === 'workflows') out[`${c}:${id}`] = 'TP26-80366'
        if (c === 'project_sub_types') out[`${c}:${id}`] = 'Fiber Split'
      }
    }
    return out
  })
}))

import { labelPathRecords } from '../../../services/event-path/record-labels.js'

const step = (key: string, collection: string, item: string, summary = 'created'): PathStep => ({
  key,
  parent: null,
  kind: 'write',
  at: '2026-09-25T10:00:00.000Z',
  record: { collection, item },
  summary
})

beforeEach(() => {
  for (const k of Object.keys(rowsFor)) delete rowsFor[k]
})

describe('labelPathRecords', () => {
  it('names a junction row by what it links and flips the verb', async () => {
    rowsFor.nivaro_relations = [
      { many_field: 'workflows_id', one_collection: 'workflows' },
      { many_field: 'project_sub_types_id', one_collection: 'project_sub_types' }
    ]
    rowsFor.workflows_project_sub_types = [
      { id: 474752, workflows_id: 371490, project_sub_types_id: 28 }
    ]
    const steps = [
      step('a:1', 'workflows_project_sub_types', '474752'),
      step('a:2', 'workflows', '371490'),
      step('a:3', 'workflows_project_sub_types', '474752', 'deleted')
    ]
    await labelPathRecords(steps)
    expect(steps[0].record?.label).toBe('Project Sub Type: Fiber Split · on TP26-80366')
    expect(steps[0].record?.link).toBe(true)
    expect(steps[0].summary).toBe('linked')
    expect(steps[2].summary).toBe('unlinked')
    expect(steps[1].record?.label).toBe('TP26-80366')
  })

  it('names a removed junction row from its revision snapshot', async () => {
    rowsFor.nivaro_relations = [
      { many_field: 'workflows_id', one_collection: 'workflows' },
      { many_field: 'project_sub_types_id', one_collection: 'project_sub_types' }
    ]
    rowsFor.workflows_project_sub_types = []
    rowsFor.nivaro_revisions = [
      { item: '474752', data: '{"id":474752,"workflows_id":371490,"project_sub_types_id":28}' }
    ]
    const steps = [step('a:1', 'workflows_project_sub_types', '474752')]
    await labelPathRecords(steps)
    expect(steps[0].record?.label).toBe(
      'Project Sub Type: Fiber Split · on TP26-80366 (since removed)'
    )
    expect(steps[0].summary).toBe('linked')
  })

  it('names an M2A junction row through the row discriminator (users included)', async () => {
    rowsFor.nivaro_relations = [
      { many_field: 'inventory_request_id', one_collection: 'inventory_request' },
      { many_field: 'item', one_collection: null, one_collection_field: 'collection' }
    ]
    rowsFor.inventory_request_internal_contact = [
      { id: 7, inventory_request_id: 32831, item: 'ABC', collection: 'directus_users' }
    ]
    rowsFor.nivaro_users = [{ id: 'ABC', first_name: 'Beth', last_name: 'Ann', email: 'b@x.io' }]
    const steps = [step('a:1', 'inventory_request_internal_contact', '7')]
    await labelPathRecords(steps)
    expect(steps[0].record?.label).toBe('User: Beth Ann')
    expect(steps[0].summary).toBe('linked')
  })

  it('falls back to the singular collection name for a plain unlabelled record', async () => {
    const steps = [step('a:1', 'workflow_line_items', '465446', 'updated')]
    await labelPathRecords(steps)
    expect(steps[0].record?.label).toBe('Workflow line item 465446')
    expect(steps[0].record?.link).toBeUndefined()
    expect(steps[0].summary).toBe('updated')
  })

  it('derives a word from the table name when the collection is unregistered', async () => {
    const steps = [step('a:1', 'inventory_item_transactions', '9')]
    await labelPathRecords(steps)
    expect(steps[0].record?.label).toBe('Inventory Item Transaction 9')
  })

  it('names a user row by the person', async () => {
    rowsFor.nivaro_users = [
      { id: 'ABC', first_name: 'Robert', last_name: 'Lee', email: 'r@example.com' }
    ]
    const steps = [step('a:1', 'nivaro_users', 'abc', 'updated')]
    await labelPathRecords(steps)
    expect(steps[0].record?.label).toBe('Robert Lee')
  })
})
