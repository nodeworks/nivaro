import { describe, expect, it, vi } from 'vitest'

// An addendum completed by an AUTO transition ("PO Received (auto)") reached
// applyAddendumApproval with no approver, so its line changes were skipped
// while it still read Approved (TP26-79847, 2026-11-11). The last person who
// moved it stands in as the approver.

const calls: Array<Record<string, unknown>> = []
let rows: Array<{ user: string | null; origin: string | null }> = []

vi.mock('../../../db/index.js', () => {
  const chain = () => {
    const q: Record<string, unknown> = {}
    const state: Record<string, unknown> = {}
    q.where = (a: unknown) => {
      calls.push({ where: a })
      Object.assign(state, a as object)
      return q
    }
    let notUser: string | null = null
    q.whereNotNull = () => q
    q.whereNot = (_c: string, v: string) => {
      notUser = v
      return q
    }
    q.modify = (fn: (x: unknown) => void) => {
      fn(q)
      return q
    }
    q.orderBy = () => q
    q.first = async () =>
      [...rows]
        .reverse()
        .find((r) => r.user != null && r.origin !== 'machine' && r.user !== notUser) ?? undefined
    q.select = () => q
    return q
  }
  return { db: Object.assign(vi.fn(chain), { raw: () => '' }) }
})

import { addendumMachineApprover } from '../../../services/addendum-approve.js'

describe('addendumMachineApprover', () => {
  it('names the last person who moved the addendum', async () => {
    rows = [
      { user: 'author', origin: 'person' },
      { user: 'level5', origin: 'person' },
      { user: 'submitter', origin: 'person' },
      { user: null, origin: 'machine' }
    ]
    await expect(addendumMachineApprover('inst-1')).resolves.toBe('submitter')
    expect(calls[0]).toEqual({ where: { instance: 'inst-1' } })
  })

  it('never names the author as approver of their own change', async () => {
    rows = [
      { user: 'level5', origin: 'person' },
      { user: 'author', origin: 'person' },
      { user: null, origin: 'machine' }
    ]
    await expect(addendumMachineApprover('inst-3', 'author')).resolves.toBe('level5')
    rows = [{ user: 'author', origin: 'person' }]
    await expect(addendumMachineApprover('inst-4', 'author')).resolves.toBeNull()
  })

  it('is null when no person ever moved it', async () => {
    rows = [{ user: null, origin: 'machine' }]
    await expect(addendumMachineApprover('inst-2')).resolves.toBeNull()
  })
})
