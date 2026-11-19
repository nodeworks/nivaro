import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { announceRecordAspect } from '../../../services/record-events.js'
import { restoreTrashRow } from '../../../services/trash.js'
import type { User } from '../../../types.js'

// rt-fix C / M3: a trash restore (Trash page, activity undo, Ask AI plan undo, MCP rollback,
// merge undo all call restoreTrashRow) tells the parent records, like a create does.
const items = vi.hoisted(() => ({ cameBack: [] as unknown[][] }))
vi.mock('../../../services/items.js', () => ({
  announceRowCameBack: async (...args: unknown[]) => {
    items.cameBack.push(args)
  }
}))
vi.mock('../../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))
vi.mock('../../../services/realtime.js', () => ({ broadcastCollectionUpdate: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({ can: async () => true }))
vi.mock('../../../services/activity.js', () => ({ logActivity: async () => 1 }))
vi.mock('../../../hooks/activity.js', () => ({ auditLevelOf: async () => 'none' }))
vi.mock('../../../hooks/record-integrity.js', () => ({ noteRawWrite: () => {} }))
vi.mock('../../../services/queue-materialization.js', () => ({
  syncMaterializedQueueItem: async () => {}
}))
vi.mock('../../../services/rollups.js', () => ({ recalcAffectedRollups: async () => {} }))
const tasks = vi.hoisted(() => ({ reopened: 0 }))
vi.mock('../../../services/tasks.js', () => ({ onRecordRestored: async () => tasks.reopened }))

const trashRow = {
  id: 5,
  collection: 'workflow_lines',
  item_id: '901',
  data: JSON.stringify({ id: 901, workflow: 77, amount: 10 }),
  deleted_by: null,
  deleted_at: new Date('2026-11-18T10:00:00Z')
}

function fakeDb() {
  const mocked = vi.mocked(db as unknown as (t: string) => unknown)
  let lineReads = 0
  mocked.mockImplementation(((table: string) => {
    const chain: Record<string, any> = {}
    for (const m of ['where', 'whereIn']) chain[m] = () => chain
    chain.first = async () => {
      if (table === 'nivaro_trash') return trashRow
      // first read = "is the id occupied?" (no); later = the fresh row after the insert
      lineReads++
      return lineReads === 1 ? undefined : { id: 901, workflow: 77, amount: 10 }
    }
    chain.insert = async () => [1]
    chain.del = async () => 1
    return chain
  }) as never)
  const raw = (db as unknown as { raw: ReturnType<typeof vi.fn> }).raw
  raw.mockImplementation(async (sql: string) =>
    /is_identity/.test(sql)
      ? [{ is_identity: false }]
      : [{ name: 'id' }, { name: 'workflow' }, { name: 'amount' }]
  )
}

const user = { id: 'U-1' } as User

afterEach(() => {
  items.cameBack.length = 0
  tasks.reopened = 0
  vi.clearAllMocks()
})

describe('restoreTrashRow tells the parents', () => {
  it('announces the restored row to the records it points at', async () => {
    fakeDb()
    await restoreTrashRow(user, 5)
    expect(items.cameBack).toHaveLength(1)
    expect(items.cameBack[0][0]).toBe('workflow_lines')
    expect(items.cameBack[0][1]).toBe('901')
    expect(items.cameBack[0][2]).toMatchObject({ workflow: 77 })
    expect(announceRecordAspect).not.toHaveBeenCalled()
  })

  it('announces $tasks when the restore reopened tasks', async () => {
    fakeDb()
    tasks.reopened = 2
    await restoreTrashRow(user, 5)
    expect(announceRecordAspect).toHaveBeenCalledWith('workflow_lines', '901', '$tasks')
  })
})
