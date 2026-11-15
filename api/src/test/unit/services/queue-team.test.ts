import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
const batch = vi.hoisted(() => ({ chunks: [] as number[], lists: [] as number[] }))
vi.mock('../../../services/db-batch.js', () => ({
  selectInChunks: async <T>(ids: string[], size: number, fn: (c: string[]) => Promise<T[]>) => {
    const out: T[] = []
    for (let i = 0; i < ids.length; i += size) {
      batch.chunks.push(Math.min(size, ids.length - i))
      out.push(...(await fn(ids.slice(i, i + size))))
    }
    return out
  },
  whereInList: (q: { rows: unknown[] }, _col: string, ids: string[]) => {
    batch.lists.push(ids.length)
    return q
  }
}))

import { db } from '../../../db/index.js'
import {
  buildTeam,
  isListablePerson,
  loadTeamUsers,
  QUEUE_TEAM_MAX
} from '../../../services/queue-team.js'

const u = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  first_name: id,
  last_name: 'X',
  email: null,
  status: 'active',
  is_redacted: false,
  account_kind: null,
  is_out_of_office: false,
  ooo_end: null,
  delegate_id: null,
  delegate_expires_at: null,
  ...over
})

describe('queue team strip', () => {
  it('never lists machine accounts, suspended or redacted people', () => {
    expect(isListablePerson({ account_kind: 'service' })).toBe(false)
    expect(isListablePerson({ status: 'suspended' })).toBe(false)
    expect(isListablePerson({ is_redacted: true })).toBe(false)
    expect(isListablePerson({ status: 'active' })).toBe(true)
  })

  it('lists only people the viewer may see in presence', () => {
    const out = buildTeam([u('A'), u('B'), u('C')], new Map(), new Set(['A', 'C']))
    expect(out.members.map((m) => m.id)).toEqual(['A', 'C'])
  })

  it('names who covers only while the delegation is live', () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    const delegates = new Map([['D', 'Dee Cover']])
    const live = u('A', {
      is_out_of_office: true,
      delegate_id: 'D',
      delegate_expires_at: '2026-11-20T00:00:00Z',
      ooo_end: '2026-11-19T00:00:00Z'
    })
    const lapsed = u('B', {
      is_out_of_office: true,
      delegate_id: 'D',
      delegate_expires_at: '2026-11-10T00:00:00Z'
    })
    const away = buildTeam(
      [live, lapsed],
      delegates,
      new Set(['A', 'B']),
      now,
      new Set(['D'])
    ).members
    expect(away.find((m) => m.id === 'A')?.covered_by).toEqual({ id: 'D', name: 'Dee Cover' })
    expect(away.find((m) => m.id === 'A')?.ooo_end).toBe('2026-11-19T00:00:00.000Z')
    expect(away.find((m) => m.id === 'B')?.covered_by).toBeNull()
  })

  it('a delegate the viewer cannot see is not named', () => {
    const o = u('A', { is_out_of_office: true, delegate_id: 'D' })
    const out = buildTeam([o], new Map([['D', 'Dee']]), new Set(['A']), Date.now(), new Set())
    expect(out.members[0].covered_by).toBeNull()
  })

  it('a delegate who cannot act is not offered', () => {
    const o = u('A', { is_out_of_office: true, delegate_id: 'Z' })
    expect(buildTeam([o], new Map(), new Set(['A'])).members[0].covered_by).toBeNull()
  })

  it('caps the list and says how many more', () => {
    const many = Array.from({ length: QUEUE_TEAM_MAX + 5 }, (_, i) =>
      u(`U${String(i).padStart(3, '0')}`)
    )
    const out = buildTeam(many, new Map(), new Set(many.map((m) => m.id)))
    expect(out.members).toHaveLength(QUEUE_TEAM_MAX)
    expect(out.more).toBe(5)
  })
})

describe('loading every seated person (security review 2026-11-15)', () => {
  it('reads in chunks under the parameter cap, one list per chunk', async () => {
    const q: Record<string, unknown> = {}
    q.where = () => q
    q.whereNull = () => q
    q.select = async () => []
    vi.mocked(db).mockReturnValue(q as never)
    batch.chunks = []
    batch.lists = []
    const ids = Array.from({ length: 2500 }, (_, i) => `U${i}`)
    await loadTeamUsers(ids)
    expect(batch.chunks).toEqual([1000, 1000, 500])
    expect(batch.lists).toEqual([1000, 1000, 500])
  })
})
