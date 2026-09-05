import { describe, expect, it } from 'vitest'
import type { db } from '../../../db/index.js'
import {
  fetchPipelineRecord,
  resolvePipelineSubject,
  resolvePipelineSubjectsBatch
} from '../../../services/pipeline-subject.js'

/** Minimal knex stand-in: whereIn().select() for the batch, where().first() for the record. */
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const database = ((table: string) => ({
    whereIn: (col: string, ids: unknown[]) => ({
      select: async () =>
        (tables[table] ?? []).filter((r) =>
          ids.some((id) => String(id).toUpperCase() === String(r[col]).toUpperCase())
        )
    }),
    where: (cond: Record<string, unknown>) => ({
      first: async () =>
        (tables[table] ?? []).find((r) =>
          Object.entries(cond).every(([k, v]) => String(r[k]).toUpperCase() === String(v).toUpperCase())
        )
    })
  })) as unknown as typeof db
  return database
}

const ADD_ID = '1DDCFA21-79F9-4EAF-B105-BD9D4DF9B55B'
const tables = {
  nivaro_addendums: [
    { id: ADD_ID, parent_collection: 'workflows', parent_id: '370880' },
    { id: 'ORPHAN-0000', parent_collection: null, parent_id: null }
  ],
  workflows: [{ id: '370880', workflow_id: 'HQ26-80302', requisition_amount: 3400.05 }]
}

describe('pipeline subject', () => {
  it('leaves business collections untouched', async () => {
    const database = fakeDb(tables)
    expect(await resolvePipelineSubject('workflows', '370880', database)).toEqual({
      collection: 'workflows',
      itemId: '370880'
    })
    const batch = await resolvePipelineSubjectsBatch('workflows', ['1', '2'], database)
    expect([...batch.values()]).toEqual([
      { collection: 'workflows', itemId: '1' },
      { collection: 'workflows', itemId: '2' }
    ])
  })

  it('maps an addendum to its parent record, keyed by the caller spelling', async () => {
    const database = fakeDb(tables)
    const lower = ADD_ID.toLowerCase()
    const batch = await resolvePipelineSubjectsBatch('nivaro_addendums', [lower], database)
    expect(batch.get(lower)).toEqual({ collection: 'workflows', itemId: '370880' })
    expect(await resolvePipelineSubject('nivaro_addendums', ADD_ID, database)).toEqual({
      collection: 'workflows',
      itemId: '370880'
    })
  })

  it('keeps an orphan addendum as its own subject', async () => {
    const database = fakeDb(tables)
    expect(await resolvePipelineSubject('nivaro_addendums', 'ORPHAN-0000', database)).toEqual({
      collection: 'nivaro_addendums',
      itemId: 'ORPHAN-0000'
    })
  })

  it('fetches the PARENT row for an addendum, {} when unreadable', async () => {
    const database = fakeDb(tables)
    const rec = await fetchPipelineRecord('nivaro_addendums', ADD_ID, database)
    expect(rec.workflow_id).toBe('HQ26-80302')
    expect(rec.requisition_amount).toBe(3400.05)
    const boom = (() => {
      throw new Error('db down')
    }) as unknown as typeof db
    expect(await fetchPipelineRecord('nivaro_addendums', ADD_ID, boom)).toEqual({})
  })
})
