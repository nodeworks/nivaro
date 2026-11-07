import { describe, expect, it, vi } from 'vitest'

// Army 6 H1 / L6: a line or forecast edit made from a record page writes an `o2m-*` activity
// row on the parent whose comment is machine JSON (child ids, a row snapshot with user
// uuids). It showed as a "Change reason" note in Notes and the Comments thread, and counted
// in the badge. A person's typed reason on the same record still shows.

const ROWS = vi.hoisted(() => ({
  activity: [
    {
      id: 11,
      user: 'U-PM',
      timestamp: '2026-11-06T16:00:00Z',
      action: 'o2m-update',
      legacy_id: null,
      comment: JSON.stringify({
        child_collection: 'forecasts',
        child_id: '7917874',
        snapshot: { id: 7917874, creator: '087389AF-2013-4A66-8C29-7F0E2E1047E5' }
      })
    },
    {
      id: 12,
      user: 'U-PM',
      timestamp: '2026-11-06T16:01:00Z',
      action: 'update',
      legacy_id: null,
      comment: 'Vendor quote went up'
    },
    {
      id: 13,
      user: 'U-PM',
      timestamp: '2026-11-06T16:02:00Z',
      // an older writer stamped the JSON under a plain action
      action: 'update',
      legacy_id: null,
      comment: '{"child_collection":"workflow_line_items","child_id":"475911","snapshot":{}}'
    }
  ]
}))

vi.mock('../../../db/index.js', async (orig) => {
  const { default: knexFactory } = await import('knex')
  const k = knexFactory({ client: 'mssql' })
  ;(k.client as unknown as { runner: unknown }).runner = (builder: {
    toSQL(): { sql: string } | Array<{ sql: string }>
  }) => ({
    run: async () => {
      const c = builder.toSQL()
      const sql = (Array.isArray(c) ? c[0] : c).sql
      if (/from \[nivaro_activity\]/i.test(sql) && /\[comment\] is not null/i.test(sql))
        return ROWS.activity
      return []
    }
  })
  return { ...(await orig<object>()), db: k, dbRead: k }
})
vi.mock('../../../lib/column-probe.js', async (orig) => ({
  ...(await orig<object>()),
  hasColumn: vi.fn(async () => false)
}))

import { loadRecordNotes } from '../../../services/record-notes.js'

describe('record notes skip o2m pointer rows', () => {
  it('only the typed reason is a note; no JSON, no ids', async () => {
    const notes = await loadRecordNotes('workflows', '372961', 'U-PM')
    const reasons = notes.filter((n) => n.source === 'change_reason')
    expect(reasons.map((n) => n.text)).toEqual(['Vendor quote went up'])
    expect(JSON.stringify(notes)).not.toMatch(/child_collection|7917874|087389AF/)
  })
})
