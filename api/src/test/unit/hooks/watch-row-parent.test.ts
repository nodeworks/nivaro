// A watch on a CHILD row (a workflow line) opens its parent record at that
// row; a watch on a pipeline-bound record (a workflow) stays on that record —
// its M2Os (project, vendor) are links, not the record it belongs to
// (2026-10-26: a workflow watch was filed and opened under its project).
import { describe, expect, it, vi } from 'vitest'

const BOUND = new Set(['workflows'])
const ROWS: Record<string, Record<string, unknown>> = {
  'workflows:371367': { project: 8181, vendor: 12 },
  'workflow_line_items:55': { workflow: 371367 }
}

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const where: Record<string, unknown> = {}
    const q = {
      where(k: string | Record<string, unknown>, v?: unknown) {
        if (typeof k === 'string') where[k] = v
        else Object.assign(where, k)
        return q
      },
      async first() {
        if (table === 'nivaro_workflow_bindings')
          return BOUND.has(String(where.collection)) ? { collection: where.collection } : undefined
        return ROWS[`${table}:${String(where.id)}`]
      }
    }
    return q
  }
  return { db, dbRead: db }
})
vi.mock('../../../services/collections.js', () => ({
  getRelations: async (collection: string) =>
    collection === 'workflows'
      ? [
          { many_collection: 'workflows', many_field: 'project', one_collection: 'projects' },
          { many_collection: 'workflows', many_field: 'vendor', one_collection: 'vendors' }
        ]
      : collection === 'workflow_line_items'
        ? [
            {
              many_collection: 'workflow_line_items',
              many_field: 'workflow',
              one_collection: 'workflows'
            }
          ]
        : []
}))

import { parentOfRow } from '../../../hooks/notification-subscriptions.js'

describe('parentOfRow — where a record watch lands', () => {
  it('a watched workflow stays on the workflow, never its project', async () => {
    expect(await parentOfRow('workflows', '371367', { id: 371367 })).toBeNull()
    expect(await parentOfRow('workflows', '371367', { project: 8181 })).toBeNull()
  })
  it('a watched line opens the workflow it belongs to', async () => {
    expect(await parentOfRow('workflow_line_items', '55', { id: 55 })).toEqual({
      collection: 'workflows',
      id: '371367'
    })
  })
})
