import { beforeEach, describe, expect, it, vi } from 'vitest'

// Dotted paths (export preset columns, queue columns, layout fields) reach
// related rows. Army 2026-10-25 (critical): `creator.static_token` exported a
// bearer credential for every readable row. Also: worklist money and date
// columns sorted as text, and dates went out as Date.toString().

vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async () => null),
  getRelations: vi.fn(async () => [
    {
      many_collection: 'workflows',
      many_field: 'creator',
      one_collection: 'nivaro_users',
      one_field: null,
      junction_field: null
    },
    {
      many_collection: 'workflows',
      many_field: 'vendor',
      one_collection: 'vendors',
      one_field: null,
      junction_field: null
    },
    {
      many_collection: 'workflows',
      many_field: 'role_ref',
      one_collection: 'nivaro_roles',
      one_field: null,
      junction_field: null
    }
  ])
}))

import { db } from '../../../db/index.js'
import { can, getAllowedFields } from '../../../services/permissions.js'
import {
  compareCellText,
  pathReadableBy,
  pathText,
  type QueueItem,
  resolvePathValues,
  sortItems
} from '../../../services/queues.js'

const user = { id: 'u-paul', role: 'role-approver' } as never

beforeEach(() => vi.clearAllMocks())

describe('resolvePathValues', () => {
  it('never resolves a credential segment, whoever configured the path', async () => {
    const out = await resolvePathValues('workflows', ['1'], ['creator', 'static_token'], new Map())
    expect(out.size).toBe(0)
    expect(db).not.toHaveBeenCalled()
  })
})

describe('pathReadableBy', () => {
  it('refuses a credential, a hidden field, a system table hop and an unreadable hop', async () => {
    expect((await pathReadableBy(user, 'workflows', ['creator', 'totp_secret'])).readable).toBe(
      false
    )
    expect((await pathReadableBy(user, 'workflows', ['role_ref', 'name'])).readable).toBe(false)
    vi.mocked(getAllowedFields).mockResolvedValueOnce(['id', 'name'])
    expect((await pathReadableBy(user, 'workflows', ['vendor', 'name'])).readable).toBe(false)
    vi.mocked(can).mockResolvedValueOnce(false)
    expect((await pathReadableBy(user, 'workflows', ['vendor', 'name'])).readable).toBe(false)
  })

  it('allows a readable path and names its leading M2O for row visibility', async () => {
    const ok = await pathReadableBy(user, 'workflows', ['vendor', 'name'])
    expect(ok).toEqual({ readable: true, firstHop: { field: 'vendor', collection: 'vendors' } })
    const person = await pathReadableBy(user, 'workflows', ['creator', 'first_name'])
    expect(person.readable).toBe(true)
  })
})

describe('pathText', () => {
  it('sends dates as ISO — a DATE column as its day', () => {
    expect(pathText(new Date('2026-10-19T00:00:00.000Z'))).toBe('2026-10-19')
    expect(pathText(new Date('2026-10-19T19:38:00.000Z'))).toBe('2026-10-19T19:38:00.000Z')
    expect(pathText(null)).toBe('')
    expect(pathText(117518)).toBe('117518')
  })
})

describe('extra.* sort', () => {
  const row = (id: string, v: unknown) =>
    ({ collection: 'workflows', item_id: id, extra: { amt: v } }) as unknown as QueueItem
  it('orders money as numbers and empties last', () => {
    const items = ['117518', '11850', '', '125277.7', '-26', '2013.92'].map((v, i) =>
      row(String(i), v)
    )
    expect(sortItems(items, 'extra.amt').map((r) => r.extra?.amt)).toEqual([
      '-26',
      '2013.92',
      '11850',
      '117518',
      '125277.7',
      ''
    ])
    expect(sortItems(items, '-extra.amt').map((r) => r.extra?.amt)[0]).toBe('125277.7')
  })
  it('orders dates by time, old Date.toString() text included', () => {
    expect(
      compareCellText(
        'Wed Sep 30 2026 10:00:00 GMT+0000 (Coordinated Universal Time)',
        'Fri Apr 25 2025 10:00:00 GMT+0000'
      )
    ).toBeGreaterThan(0)
    expect(compareCellText('2026-01-02', '2025-12-31')).toBeGreaterThan(0)
    expect(compareCellText('apple', 'banana')).toBeLessThan(0)
  })
})
