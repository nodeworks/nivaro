import { describe, expect, it } from 'vitest'
import { type WatchRowData, withCompleted, withPrefDefaults } from './watch-list'

const row = (key: string): WatchRowData => ({
  key,
  collection: 'po',
  collection_label: 'PO',
  id: key.split(':')[1],
  pinned_at: '2026-11-01T00:00:00Z',
  available: true,
  title: key,
  state: null,
  owners: [],
  figures: [],
  sla: null,
  timing: null,
  change: null,
  updated_at: null
})

describe('completed records on the watch list', () => {
  it('marks rows whose record the list saw completed', () => {
    const rows = withCompleted(
      [row('po:1'), row('po:2')],
      [
        { key: 'po:1', done_at: '2026-11-15T10:00:00Z' },
        { key: 'po:2', done_at: null }
      ]
    )
    expect(rows[0].completed_at).toBe('2026-11-15T10:00:00Z')
    expect(rows[1].completed_at).toBeUndefined()
  })

  it('an older answer reads as nothing removed and the switch off', () => {
    const p = withPrefDefaults({ pins: [], max: 50 } as never)
    expect(p.removed).toEqual([])
    expect(p.settings.remove_completed).toBe(false)
  })
})
