import knex from 'knex'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: knex({ client: 'mssql' }) }))

import { sheetWindow, summarizeChanges } from './today.js'

/** The Today drill sheets list exactly what the figure counts. */

const DAY = new Date('2026-11-18T05:00:00.000Z')
const NOW = new Date('2026-11-18T15:30:00.000Z')

describe('sheetWindow', () => {
  it('runs from the figure’s day start to its computed_at, never past now', () => {
    const w = sheetWindow(DAY, '2026-11-18T15:00:00.000Z', NOW)
    expect(w.to.toISOString()).toBe('2026-11-18T15:00:00.000Z')
    expect(sheetWindow(DAY, '2026-11-19T00:00:00.000Z', NOW).to).toBe(NOW)
    expect(sheetWindow(DAY, 'soon', NOW).to).toBe(NOW)
    expect(sheetWindow(DAY, '2026-11-17T00:00:00.000Z', NOW).to).toBe(NOW)
  })
})

describe('summarizeChanges', () => {
  const rows = [
    {
      id: 1,
      collection: 'invoices',
      item: '7',
      timestamp: '2026-11-18T06:10:00.000Z',
      user: 'u1',
      action: 'update'
    },
    {
      id: 2,
      collection: 'invoices',
      item: '7',
      timestamp: '2026-11-18T07:10:00.000Z',
      user: 'u2',
      action: 'update'
    },
    {
      id: 3,
      collection: 'invoices',
      item: '8',
      timestamp: '2026-11-18T07:20:00.000Z',
      user: 'u1',
      action: 'create'
    },
    {
      id: 4,
      collection: 'orders',
      item: '1',
      timestamp: '2026-11-18T09:00:00.000Z',
      user: null,
      action: 'delete'
    },
    // Yesterday: outside the window.
    {
      id: 5,
      collection: 'orders',
      item: '2',
      timestamp: '2026-11-17T09:00:00.000Z',
      user: 'u1',
      action: 'update'
    }
  ]
  const w = { from: DAY, to: NOW }

  it('counts distinct records (= the figure) and every change', () => {
    const s = summarizeChanges(rows, w)
    expect(s.records).toBe(3)
    expect(s.changes).toBe(4)
    expect(s.total_rows).toBe(3)
    expect(s.rows[0]).toMatchObject({ collection: 'orders', item: '1', changes: 1, last_id: 4 })
    expect(s.rows.find((r) => r.item === '7')).toMatchObject({ changes: 2, last_user: 'u2' })
  })

  it('breaks down by collection, person and hour from the day start', () => {
    const s = summarizeChanges(rows, w)
    expect(s.by_collection).toEqual([
      { collection: 'invoices', records: 2, changes: 3 },
      { collection: 'orders', records: 1, changes: 1 }
    ])
    expect(s.by_person[0]).toEqual({ user: 'u1', records: 2, changes: 2 })
    expect(s.hourly).toHaveLength(11)
    expect(s.hourly[1]).toBe(1)
    expect(s.hourly[2]).toBe(2)
    expect(s.hourly[4]).toBe(1)
  })

  it('narrows the list (not the header) to a collection or person and pages it', () => {
    const s = summarizeChanges(rows, w, { collection: 'invoices', limit: 1 })
    expect(s.records).toBe(3)
    expect(s.total_rows).toBe(2)
    expect(s.rows).toHaveLength(1)
    expect(summarizeChanges(rows, w, { user: 'u2' }).total_rows).toBe(1)
  })
})
