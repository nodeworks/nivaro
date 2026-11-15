import { describe, expect, it } from 'vitest'
import { assembleTeamBoard, recordOfPath } from '../../../services/team-board.js'

const NOW = Date.UTC(2026, 10, 14, 15, 0, 0)

describe('recordOfPath', () => {
  it('reads admin and portal record pages, not lists, new forms or system tables', () => {
    expect(recordOfPath('/collections/workflows/42')).toEqual({
      collection: 'workflows',
      item: '42'
    })
    expect(recordOfPath('/records/invoices/9?tab=lines')).toEqual({
      collection: 'invoices',
      item: '9'
    })
    expect(recordOfPath('/admin/collections/workflows/7')).toEqual({
      collection: 'workflows',
      item: '7'
    })
    expect(recordOfPath('/collections/workflows')).toBeNull()
    expect(recordOfPath('/collections/workflows/new')).toBeNull()
    expect(recordOfPath('/collections/nivaro_users/1')).toBeNull()
    expect(recordOfPath(null)).toBeNull()
  })
})

describe('assembleTeamBoard', () => {
  const base = {
    viewers: [],
    locks: [],
    managers: new Map<string, { id: string; name: string }>(),
    labels: new Map<string, string>(),
    now: NOW
  }

  it('merges presence, page pings, record rooms and edit locks per person', () => {
    const board = assembleTeamBoard({
      ...base,
      presence: [
        {
          user_id: 'u-beth',
          display_name: 'Beth Ames',
          role_name: 'Approver',
          current_path: '/collections/workflows/42',
          page: 'Workflows › CM26-42',
          state: 'active',
          app: 'admin'
        },
        {
          user_id: 'u-al',
          display_name: 'Al Brown',
          role_name: 'Creator',
          current_path: '/queues/abc',
          page: 'Queues',
          state: 'idle',
          idle_minutes: 14
        }
      ],
      pages: [
        {
          user: { id: 'u-beth', name: 'Beth' },
          path: '/collections/workflows/42',
          since: NOW - 60_000,
          socket: 's1'
        },
        {
          user: { id: 'u-beth', name: 'Beth' },
          path: '/collections/invoices/9',
          since: NOW - 5_000,
          socket: 's2'
        }
      ],
      viewers: [{ collection: 'workflows', item: '42', viewers: [{ id: 'u-beth', name: 'Beth' }] }],
      locks: [
        { collection: 'invoices', item: '9', user: 'U-BETH', locked_at: new Date(NOW - 3_000) }
      ],
      managers: new Map([['U-BETH', { id: 'u-mgr', name: 'Mo Grant' }]]),
      labels: new Map([['workflows:42', 'CM26-42']])
    })
    expect(board.people.map((p) => p.name)).toEqual(['Al Brown', 'Beth Ames'])
    const beth = board.people[1]
    expect(beth.manager).toEqual({ id: 'u-mgr', name: 'Mo Grant' })
    expect(beth.tabs).toBe(2)
    // Editing first, then the most recent.
    expect(beth.records.map((r) => [r.collection, r.item, r.editing])).toEqual([
      ['invoices', '9', true],
      ['workflows', '42', false]
    ])
    expect(beth.records[1]).toMatchObject({ label: 'CM26-42', since: NOW - 60_000, tabs: 1 })
    expect(board.counts).toEqual({ online: 2, on_record: 1, editing: 1, idle: 1, stuck: 0 })
    expect(board.people[0]).toMatchObject({ state: 'idle', idle_minutes: 14, records: [] })
  })

  it('shows a View-as session as the viewed person only, never the administrator', () => {
    const board = assembleTeamBoard({
      ...base,
      presence: [
        {
          user_id: 'u-beth',
          display_name: 'Beth Ames',
          state: 'active',
          masquerade: { admin_id: 'u-admin', admin_name: 'Ada Admin' }
        }
      ],
      pages: [
        {
          user: { id: 'u-beth', name: 'Beth' },
          path: '/collections/workflows/1',
          since: NOW,
          socket: 's'
        }
      ]
    })
    expect(board.people).toHaveLength(1)
    expect(board.people[0].view_as).toBe(true)
    expect(JSON.stringify(board)).not.toContain('Ada Admin')
    expect(JSON.stringify(board)).not.toContain('u-admin')
  })

  it("uses the Online row's page as a record only for someone without page pings", () => {
    const board = assembleTeamBoard({
      ...base,
      presence: [
        { user_id: 'u-a', display_name: 'A', current_path: '/collections/workflows/1' },
        { user_id: 'u-b', display_name: 'B', current_path: '/collections/workflows/2' }
      ],
      pages: [
        { user: { id: 'u-a', name: 'A' }, path: '/collections/invoices/9', since: NOW, socket: 's' }
      ]
    })
    expect(board.people[0].records.map((r) => r.item)).toEqual(['9'])
    expect(board.people[1].records.map((r) => r.item)).toEqual(['2'])
  })

  it('a lock alone does not put someone on the board', () => {
    const board = assembleTeamBoard({
      ...base,
      presence: [],
      pages: [],
      locks: [{ collection: 'workflows', item: '1', user: 'ghost' }]
    })
    expect(board.people).toEqual([])
  })

  it('people only seen in a record room (another process) are listed', () => {
    const board = assembleTeamBoard({
      ...base,
      presence: [],
      pages: [],
      viewers: [{ collection: 'workflows', item: '5', viewers: [{ id: 'u-cy', name: 'Cy' }] }]
    })
    expect(board.people[0]).toMatchObject({ id: 'u-cy', name: 'Cy' })
    expect(board.people[0].records[0]).toMatchObject({
      collection: 'workflows',
      item: '5',
      tabs: 1
    })
  })
})
