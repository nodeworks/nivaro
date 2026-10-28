import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SQL Server review (2026-10-27, section D): bound-parameter chunking, UTC
 * windows, narrowed record reads and the cached search catalog.
 */

const calls: Array<{ table: string; whereIn: unknown[][] }> = []

function chain(table: string, rows: (whereIn: unknown[][]) => unknown[]) {
  const entry = { table, whereIn: [] as unknown[][] }
  calls.push(entry)
  const q: Record<string, unknown> = {}
  const self = () => q
  for (const m of ['where', 'whereNull', 'whereNotNull', 'orWhereNull', 'join', 'leftJoin']) {
    q[m] = (...args: unknown[]) => {
      const fn = args.find((a) => typeof a === 'function') as ((b: unknown) => void) | undefined
      if (fn) fn(q)
      return self()
    }
  }
  q.whereIn = (_col: string, vals: unknown[]) => {
    entry.whereIn.push(vals)
    return self()
  }
  q.select = () => self()
  // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(rows(entry.whereIn)).then(res, rej)
  return q
}

let rowsFor: (table: string, whereIn: unknown[][]) => unknown[] = () => []

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => chain(table, (w) => rowsFor(table, w))
  return { db, isMssql: () => true }
})

vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => 'tenant-a' }))

let ownerIds: string[] = []
vi.mock('../../../services/owner-explain.js', () => ({
  explainRecordOwners: async () => ({
    state: { label: 'Review' },
    owners: ownerIds.map((id) => ({ id, name: id, sources: [], unavailable: null }))
  })
}))
vi.mock('../../../routes/presence.js', () => ({
  visibleToViewer: async () => new Set<string>()
}))

import {
  clearSearchableTextColumnsCache,
  searchableTextColumns
} from '../../../services/global-search.js'
import { matchColumns } from '../../../services/pipeline-engine.js'
import { whoCanActNow } from '../../../services/who-can-act.js'

beforeEach(() => {
  calls.length = 0
  rowsFor = () => []
})

describe('matchColumns (pipeline-engine)', () => {
  it('reads id, plain filter fields, dotted prefixes and extras that exist', () => {
    const physical = new Set(['id', 'division', 'project', 'workflow_id', 'status'])
    expect(
      matchColumns(['division', 'project.project_type', 'regions.name'], ['workflow_id'], physical)
    ).toEqual(['id', 'division', 'project', 'workflow_id'])
  })

  it('falls back to the whole row when the columns cannot be read', () => {
    expect(matchColumns(['division'], [], null)).toBeNull()
    expect(matchColumns(['division'], [], new Set(['division']))).toBeNull()
  })
})

describe('searchableTextColumns (global-search)', () => {
  it('keeps physical text columns only, reads the catalog for those tables only, and caches', async () => {
    clearSearchableTextColumnsCache()
    rowsFor = (table) => {
      if (table === 'nivaro_fields')
        return [
          { collection: 'workflows', field: 'workflow_id' },
          { collection: 'workflows', field: 'regions' },
          { collection: 'vendors', field: 'name' }
        ]
      if (table === 'information_schema.columns')
        return [
          { t: 'workflows', c: 'workflow_id' },
          { t: 'vendors', c: 'name' }
        ]
      return []
    }
    const first = await searchableTextColumns()
    expect(Object.fromEntries(first)).toEqual({ workflows: ['workflow_id'], vendors: ['name'] })
    const catalog = calls.find((c) => c.table === 'information_schema.columns')
    expect(catalog?.whereIn[0]?.sort()).toEqual(['vendors', 'workflows'])

    const before = calls.length
    await searchableTextColumns()
    expect(calls.length).toBe(before)
  })
})

describe('who-can-act online lookup', () => {
  it('chunks a wide owner list under the bound-parameter cap', async () => {
    ownerIds = Array.from({ length: 2500 }, (_, i) => `U${i}`)
    rowsFor = (table, w) =>
      table === 'user_presence' ? (w.at(-1) ?? []).slice(0, 1).map((u) => ({ user_id: u })) : []
    const out = await whoCanActNow({ id: 'viewer' } as never, true, 'workflows', '1')
    expect(out?.people).toHaveLength(2500)
    const presence = calls.filter((c) => c.table === 'user_presence')
    expect(presence).toHaveLength(3)
    for (const c of presence) expect((c.whereIn[0] ?? []).length).toBeLessThanOrEqual(1000)
  })
})

describe('UTC windows', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const services = join(here, '..', '..', '..', 'services')
  it.each([
    'dashboard-widgets.ts',
    'scheduled-reports.ts'
  ])('%s compares UTC timestamps against GETUTCDATE, never local GETDATE', (file) => {
    const src = readFileSync(join(services, file), 'utf8')
    expect(src).not.toMatch(/GETDATE\(\)/)
  })
})
