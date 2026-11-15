import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  browserConfig: null as unknown,
  fields: [] as Array<{ field: string }>,
  row: undefined as Record<string, unknown> | undefined,
  reads: [] as Array<{ table: string; where: unknown; col: string }>
}))

vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async () => ({ browser_config: state.browserConfig })),
  getFields: vi.fn(async () => state.fields)
}))
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => ({
    where: (where: unknown) => ({
      first: async (col: string) => {
        state.reads.push({ table, where, col })
        return state.row
      }
    })
  })
}))

import {
  flagIsOn,
  notificationIsUrgent,
  parseUrgentField,
  recordFlaggedUrgent,
  urgentFromRow
} from '../../../services/notification-urgent.js'

beforeEach(() => {
  state.browserConfig = null
  state.fields = []
  state.row = undefined
  state.reads = []
})

describe('urgentFromRow', () => {
  it('never calls an FYI urgent, whatever the caller says', () => {
    expect(urgentFromRow({ lane: 'fyi', urgent: true })).toBe(false)
  })
  it('a critical row is urgent', () => {
    expect(urgentFromRow({ lane: 'critical' })).toBe(true)
  })
  it('an SLA breach waiting on the person is urgent', () => {
    expect(
      urgentFromRow({ lane: 'needs_you', category: 'sla', target: { kind: 'sla', id: '1' } })
    ).toBe(true)
  })
  it('a caller marking it urgent counts on a needs-you row', () => {
    expect(urgentFromRow({ lane: 'needs_you', urgent: true })).toBe(true)
  })
  it('otherwise the record decides', () => {
    expect(urgentFromRow({ lane: 'needs_you', category: 'workflow' })).toBeNull()
  })
})

describe('parseUrgentField / flagIsOn', () => {
  it('reads the field name from JSON text or an object', () => {
    expect(parseUrgentField('{"urgent_field":"is_priority"}')).toBe('is_priority')
    expect(parseUrgentField({ urgent_field: 'hot' })).toBe('hot')
  })
  it('refuses anything that is not a plain column name', () => {
    expect(parseUrgentField({ urgent_field: 'x; drop table' })).toBeNull()
    expect(parseUrgentField('not json')).toBeNull()
    expect(parseUrgentField(null)).toBeNull()
  })
  it('stored flag values', () => {
    expect(flagIsOn(true)).toBe(true)
    expect(flagIsOn(1)).toBe(true)
    expect(flagIsOn('Yes')).toBe(true)
    expect(flagIsOn(0)).toBe(false)
    expect(flagIsOn(null)).toBe(false)
  })
})

describe('recordFlaggedUrgent', () => {
  it('reads nothing when the collection names no urgent flag', async () => {
    expect(await recordFlaggedUrgent('workflows', '7')).toBe(false)
    expect(state.reads).toEqual([])
  })
  it('reads the one flag column of the record when configured', async () => {
    state.browserConfig = { urgent_field: 'is_priority' }
    state.fields = [{ field: 'id' }, { field: 'is_priority' }]
    state.row = { is_priority: 1 }
    expect(await recordFlaggedUrgent('workflows', '7')).toBe(true)
    expect(state.reads).toEqual([{ table: 'workflows', where: { id: '7' }, col: 'is_priority' }])
  })
  it('a flag naming a field the collection lacks is ignored', async () => {
    state.browserConfig = { urgent_field: 'gone' }
    state.fields = [{ field: 'id' }]
    expect(await recordFlaggedUrgent('workflows', '7')).toBe(false)
    expect(state.reads).toEqual([])
  })
  it('system collections never count', async () => {
    state.browserConfig = { urgent_field: 'x' }
    expect(await recordFlaggedUrgent('nivaro_tasks', '1')).toBe(false)
  })
})

describe('notificationIsUrgent', () => {
  it('asks the record only for a needs-you row the row alone does not decide', async () => {
    state.browserConfig = { urgent_field: 'hot' }
    state.fields = [{ field: 'hot' }]
    state.row = { hot: true }
    expect(
      await notificationIsUrgent({
        lane: 'needs_you',
        category: 'workflow',
        target: { kind: 'record', collection: 'jobs', id: 3 }
      })
    ).toBe(true)
    expect(state.reads[0]).toMatchObject({ table: 'jobs', where: { id: 3 } })
    state.reads = []
    expect(await notificationIsUrgent({ lane: 'fyi', collection: 'jobs', item: '3' })).toBe(false)
    expect(state.reads).toEqual([])
  })
})
