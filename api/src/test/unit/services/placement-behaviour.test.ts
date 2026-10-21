import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Placement behaviour (#2703–#2712): the twin rule module, the display
// formula rows the field-config formatter emits, and "Repeat last value"
// reading only the caller's own revisions.

const state = vi.hoisted(() => ({
  activity: [] as Array<Record<string, unknown>>,
  revisions: [] as Array<Record<string, unknown>>,
  activityWhere: null as Record<string, unknown> | null,
  excluded: null as unknown,
  can: true,
  allowed: null as string[] | null,
  encrypted: [] as string[]
}))

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const b: Record<string, unknown> = {
      where: (w: Record<string, unknown>) => {
        if (table === 'nivaro_activity') state.activityWhere = w
        return b
      },
      whereIn: () => b,
      whereNot: (_c: string, v: unknown) => {
        state.excluded = v
        return b
      },
      orderBy: () => b,
      limit: () => b,
      select: () => b,
      // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        let rows: unknown[] = []
        if (table === 'nivaro_fields')
          rows = [
            {
              field: 'budget',
              type: 'decimal',
              label: 'Budget',
              interface: 'input',
              options: null,
              hidden: 0,
              readonly: 0,
              required: 0,
              sort: 1
            }
          ]
        if (table === 'nivaro_activity')
          rows = state.activity.filter((a) => a.item !== state.excluded)
        if (table === 'nivaro_revisions') rows = state.revisions
        return Promise.resolve(rows).then(resolve, reject)
      }
    }
    return b
  }
  return { db }
})
vi.mock('../../../services/permissions.js', () => ({
  can: async () => state.can,
  getAllowedFields: async () => state.allowed
}))
vi.mock('../../../services/encryption.js', () => ({
  getEncryptedFields: async () => state.encrypted
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/rollups.js', () => ({ bustRollupContributorCache: vi.fn() }))

import { formatLayoutFieldRows, normalizeLayoutAssignment } from '../../../routes/field-config.js'
import { checkLastValueAccess, myLastValue, valueSetBy } from '../../../services/my-last-value.js'
import { resolvePlacementText } from '../../../services/placement-behaviour.js'

const SHARED_TWIN = new URL(
  '../../../../../packages/shared/src/lib/placement-behaviour.ts',
  import.meta.url
)
const API_TWIN = new URL('../../../services/placement-behaviour.ts', import.meta.url)

beforeEach(() => {
  state.activity = []
  state.revisions = []
  state.activityWhere = null
  state.excluded = null
  state.can = true
  state.allowed = null
  state.encrypted = []
})

describe('placement behaviour twin', () => {
  it('is byte-identical to the packages/shared twin', () => {
    expect(readFileSync(API_TWIN, 'utf8')).toBe(readFileSync(SHARED_TWIN, 'utf8'))
  })

  it('resolves label rules on the server side (PDF)', () => {
    const ov = JSON.stringify({
      text_rules: [{ type: 'pipeline_state', state_keys: ['done'], label: 'Delivered date' }]
    })
    expect(resolvePlacementText(ov, { stateKey: 'done', roleId: null }).label).toBe(
      'Delivered date'
    )
    expect(resolvePlacementText(ov, { stateKey: 'open', roleId: null }).label).toBeUndefined()
  })
})

describe('display formula rows (#2712)', () => {
  it('emits a read-only display-formula row, never a virtual O2M', async () => {
    const assignments = [
      normalizeLayoutAssignment({
        field: '__calc_1__',
        group_key: 'main',
        sort: 2,
        col_span: 6,
        overrides: JSON.stringify({
          label: 'Remaining',
          display_formula: { expr: '{{budget}} - {{committed}}', format: 'currency' }
        })
      })
    ]
    const { data } = await formatLayoutFieldRows('orders', assignments)
    const row = (data as Array<Record<string, unknown>>).find((r) => r.field === '__calc_1__')
    expect(row).toMatchObject({
      label: 'Remaining',
      interface: 'display-formula',
      readonly: true,
      required: false,
      group_key: 'main',
      layout_assigned: true,
      options: {
        col_span: 6,
        display_formula: { expr: '{{budget}} - {{committed}}', format: 'currency', currency: null }
      }
    })
  })
})

describe('repeat last value (#2706)', () => {
  it('reads what this save set: an update its delta, a create its row', () => {
    expect(valueSetBy('update', { delta: '{"vendor":7}', data: '{"vendor":9}' }, 'vendor')).toBe(7)
    expect(valueSetBy('update', { delta: '{"other":1}' }, 'vendor')).toBeUndefined()
    expect(valueSetBy('update', { delta: '{"vendor":""}' }, 'vendor')).toBeUndefined()
    expect(valueSetBy('create', { data: { vendor: 'Acme' }, delta: null }, 'vendor')).toBe('Acme')
  })

  it("returns the caller's newest value from their own activity, skipping this record", async () => {
    state.activity = [
      { id: 30, item: 'r3', action: 'update', timestamp: '2026-10-20T10:00:00Z' },
      { id: 20, item: 'r2', action: 'update', timestamp: '2026-10-19T10:00:00Z' },
      { id: 10, item: 'r1', action: 'create', timestamp: '2026-10-18T10:00:00Z' }
    ]
    state.revisions = [
      { activity: 30, data: '{}', delta: '{"vendor":3}' },
      { activity: 20, data: '{}', delta: '{"title":"x"}' },
      { activity: 10, data: '{"vendor":1}', delta: null }
    ]
    const hit = await myLastValue('u1', 'orders', 'vendor', 'r3')
    expect(state.activityWhere).toEqual({ user: 'u1', collection: 'orders' })
    expect(hit).toEqual({ value: 1, item: 'r1', at: '2026-10-18T10:00:00.000Z' })
    state.excluded = null
    expect(await myLastValue('u1', 'orders', 'vendor')).toMatchObject({ value: 3, item: 'r3' })
  })

  it('answers null when the caller never set the field', async () => {
    state.activity = [{ id: 1, item: 'a', action: 'update', timestamp: null }]
    state.revisions = [{ activity: 1, data: null, delta: '{"title":"x"}' }]
    expect(await myLastValue('u1', 'orders', 'vendor')).toBeNull()
  })

  it('refuses system collections, unreadable and encrypted fields', async () => {
    const user = { id: 'u1', role: 'R' } as never
    expect(await checkLastValueAccess(user, 'orders', 'vendor')).toBeNull()
    expect((await checkLastValueAccess(user, 'nivaro_users', 'email'))?.status).toBe(400)
    expect((await checkLastValueAccess(user, 'orders', 'bad field'))?.status).toBe(400)
    state.allowed = ['title']
    expect((await checkLastValueAccess(user, 'orders', 'vendor'))?.status).toBe(403)
    state.allowed = ['*']
    state.encrypted = ['vendor']
    expect((await checkLastValueAccess(user, 'orders', 'vendor'))?.status).toBe(400)
    state.can = false
    expect((await checkLastValueAccess(user, 'orders', 'title'))?.status).toBe(403)
  })
})
