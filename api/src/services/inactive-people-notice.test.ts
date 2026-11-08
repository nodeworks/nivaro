import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.fn(async (..._args: unknown[]) => ({ id: 1 }))
let admins: Array<{ id: string }> = []
let totals = new Map<string, number>()

vi.mock('../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  const q = () => chain
  for (const m of ['join', 'where', 'limit', 'whereIn']) chain[m] = q
  chain.select = async () => admins
  const db = (table: string) => {
    if (table === 'nivaro_users') {
      const c: Record<string, unknown> = {}
      c.whereIn = () => c
      c.select = async () => [{ id: 'A1', first_name: 'Ann', last_name: 'Lee', email: 'a@x' }]
      return c
    }
    return chain
  }
  return { db }
})
vi.mock('./notification-channels.js', () => ({
  notifyUser: (...a: unknown[]) => notify(...a)
}))
vi.mock('./inactive-people-offload.js', () => ({ offloadTotalsByUser: async () => totals }))
vi.mock('./inactive-user-links.js', () => ({ bustInactiveLinkCache: () => {} }))
vi.mock('./ai-tenant-state.js', () => ({
  tenantState: <T>(init: () => T) => {
    let v: T | undefined
    return () => {
      if (v === undefined) v = init()
      return v
    }
  }
}))

import {
  buildDeactivationNotice,
  COALESCE_MS,
  flushAllDeactivationBatches,
  noteUsersDeactivated,
  noticePersonName,
  setInactivePeopleNoticeApp
} from './inactive-people-notice.js'

describe('buildDeactivationNotice', () => {
  it('says how many were suspended, by what, and how many still own work', () => {
    const n = buildDeactivationNotice({
      count: 40,
      reason: 'directory_sync',
      verb: 'suspended',
      withWork: [{ id: 'A1', total: 7 }],
      names: new Map([['A1', 'Ann Lee']])
    })
    expect(n.subject).toBe('40 accounts were suspended by directory sync — 1 still owns open work')
    expect(n.message).toContain('Ann Lee (7)')
  })
  it('stays short when nobody holds work', () => {
    const n = buildDeactivationNotice({
      count: 1,
      reason: 'admin',
      verb: 'redacted',
      withWork: [],
      names: new Map()
    })
    expect(n.subject).toBe('1 account was redacted by an administrator')
    expect(n.message).toMatch(/no open work/)
  })
  it('never says "none of them hold no open work" (double negative)', () => {
    const n = buildDeactivationNotice({
      count: 3,
      reason: 'directory_sync',
      verb: 'suspended',
      withWork: [],
      names: new Map()
    })
    expect(n.message).toBe('None of them hold open work that needs handing on.')
  })
})

describe('noticePersonName', () => {
  it('adds the mailbox so two people with one name are told apart', () => {
    expect(
      noticePersonName({ first_name: 'Robert', last_name: 'Lee', email: 'Robert_Lee2@X.com' })
    ).toBe('Robert Lee · robert_lee2@x.com')
  })
  it('a redacted or legacy-anonymised account reads "Former user", never its stand-in email', () => {
    expect(
      noticePersonName({
        first_name: 'Redacted',
        last_name: 'Redacted',
        email: 'Redacted_AB@redact.x'
      })
    ).toBe('Former user')
    expect(
      noticePersonName({ first_name: 'A', last_name: 'B', email: 'a@b', is_redacted: 1 })
    ).toBe('Former user')
  })
})

describe('noteUsersDeactivated coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    notify.mockClear()
    admins = [{ id: 'ADMIN1' }, { id: 'ADMIN2' }]
    totals = new Map([['A1', 3]])
    setInactivePeopleNoticeApp({} as never)
  })
  afterEach(() => vi.useRealTimers())

  it('sends ONE notice per admin for a whole batch of people', async () => {
    for (let i = 0; i < 40; i++) noteUsersDeactivated([`U${i}`, 'A1'], { reason: 'directory_sync' })
    expect(notify).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 10)
    expect(notify).toHaveBeenCalledTimes(2)
    const opts = notify.mock.calls[0][2] as Record<string, unknown>
    expect(opts.subject).toContain('41 accounts were suspended by directory sync')
    expect(opts.category).toBe('system')
  })

  it('keeps different reasons apart and does not repeat a flushed batch', async () => {
    noteUsersDeactivated(['U1'], { reason: 'directory_sync' })
    noteUsersDeactivated(['U2'], { reason: 'retention', verb: 'redacted' })
    await flushAllDeactivationBatches()
    expect(notify).toHaveBeenCalledTimes(4)
    await flushAllDeactivationBatches()
    expect(notify).toHaveBeenCalledTimes(4)
  })

  it('does not tell the administrator who made the change', async () => {
    noteUsersDeactivated(['U1'], { reason: 'admin', actor: 'admin1' })
    await flushAllDeactivationBatches()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toBe('ADMIN2')
  })
})
