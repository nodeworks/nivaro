// A field-watch notification names the record by its readable id (#776), read
// as EACH subscriber: one who may read the id column gets "CM26-7", one whose
// role cannot read it gets "#7".
import { describe, expect, it, vi } from 'vitest'

type Fn = (ctx: Record<string, unknown>) => Promise<void>
let afterUpdate: Fn | null = null
const inserted: Array<Record<string, unknown>> = []

vi.mock('../../../hooks/registry.js', () => ({
  hooks: {
    after: (_c: string, _a: string, fn: Fn) => {
      afterUpdate = fn
    }
  }
}))
vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const q = {
      where: () => q,
      join: () => q,
      select: async () => {
        if (table === 'nivaro_field_watches')
          return [{ id: 1, name: 'Status', field: 'status', is_active: true, created_by: null }]
        if (table.startsWith('nivaro_field_watch_subscribers'))
          return [
            { id: 'u-reader', role: 'r', status: 'active', email: 'r@x' },
            { id: 'u-masked', role: 'm', status: 'active', email: 'm@x' }
          ]
        return []
      },
      insert: (row: Record<string, unknown>) => {
        inserted.push(row)
        return { returning: async () => [{ id: inserted.length }] }
      }
    }
    return q
  }
  return { db }
})
vi.mock('../../../flows/registry.js', () => ({ emitTrigger: vi.fn() }))
vi.mock('../../../plugins/socketio.js', () => ({ emitNotification: vi.fn() }))
vi.mock('../../../services/chain-columns.js', () => ({ chainFields: async () => ({}) }))
vi.mock('../../../services/unit-of-work.js', () => ({ deferEffect: async () => undefined }))
vi.mock('../../../services/socket-access.js', () => ({ canSeeRecordRoom: async () => true }))
vi.mock('../../../services/permissions.js', () => ({
  isAdminRole: async () => false,
  getAllowedFields: async () => ['*']
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  friendlyIdField: async (c: string) => (c === 'workflows' ? 'workflow_id' : null)
}))
vi.mock('../../../services/items.js', () => ({
  // The masked role's field list drops workflow_id from the row it reads.
  readItems: async (user: { id: string }) => ({
    data: [user.id === 'u-reader' ? { id: 7, workflow_id: 'CM26-7' } : { id: 7 }]
  })
}))

const { registerFieldWatchHooks } = await import('../../../hooks/field-watches.js')

describe('field watch notification subject', () => {
  it('names the record by the friendly id each subscriber may read', async () => {
    registerFieldWatchHooks()
    expect(afterUpdate).toBeTruthy()
    await afterUpdate?.({
      collection: 'workflows',
      action: 'update',
      keys: [7],
      previousData: { status: 'draft' },
      result: { status: 'approved' },
      user: { id: 'u-writer' }
    })
    const subjects = Object.fromEntries(inserted.map((r) => [r.recipient, r.subject]))
    expect(subjects['u-reader']).toBe('Field changed: status on workflows CM26-7')
    expect(subjects['u-masked']).toBe('Field changed: status on workflows #7')
    // The payload keeps the numeric id.
    expect(inserted.every((r) => r.item === '7')).toBe(true)
  })
})
