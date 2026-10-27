import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  who: { user: { id: 'u1', role: 'r', preferences: null }, link: null } as any,
  maintenance: false,
  instance: { collection: 'orders', item: '7' } as any,
  inRowMenu: 1 as unknown,
  access: 'ok' as 'ok' | 'denied',
  decide: vi.fn(async (_o: unknown) => ({ ok: true }) as any),
  transition: vi.fn(async (_o: unknown) => ({ status: 200, body: {} }) as any),
  ack: vi.fn(async (..._a: unknown[]) => ({ status: 200, body: {} }) as any)
}))

vi.mock('../../../db/index.js', () => ({
  db: (table: string) => ({
    where: () => ({
      first: async () =>
        table === 'nivaro_workflow_transitions' ? { in_row_menu: h.inRowMenu } : h.instance
    })
  })
}))
vi.mock('../../../routes/approvals.js', () => ({ applyApprovalDecision: h.decide }))
vi.mock('../../../services/app-links.js', () => ({
  recordLink: async (c: string, i: string) => `https://n.test/${c}/${i}`
}))
vi.mock('../../../services/ai-plan-steps.js', () => ({ isAdminUser: async () => false }))
vi.mock('../../../services/instance-guard.js', () => {
  class InstanceAccessError extends Error {
    statusCode = 404
  }
  return {
    InstanceAccessError,
    assertInstanceAccess: async () => {
      if (h.access === 'denied') throw new InstanceAccessError('nope')
    },
    instanceAccessAllowed: async () => h.access !== 'denied'
  }
})
vi.mock('../../../services/notification-ack.js', () => ({ acknowledgeNotification: h.ack }))
vi.mock('../../../services/record-transition.js', () => ({ runRecordTransition: h.transition }))
vi.mock('../../../services/security.js', () => ({
  maintenanceState: async () => ({ on: h.maintenance })
}))
vi.mock('../../../services/user-time.js', () => ({ userTimeZone: async () => 'America/New_York' }))
vi.mock('../../../services/teams-bot/links.js', () => ({
  resolveTeamsUser: async () => h.who,
  signConnectToken: () => 'tok'
}))
vi.mock('../../../config.js', () => ({ config: { PUBLIC_URL: 'https://n.test' } }))

import { handleInvoke } from '../../../services/teams-bot/actions.js'

let n = 0
const app = { log: { error: vi.fn() } } as unknown as FastifyInstance
const press = (data: Record<string, unknown>) =>
  ({
    type: 'invoke',
    name: 'adaptiveCard/action',
    from: { aadObjectId: 'o1' },
    channelData: { tenant: { id: 't1' } },
    value: { action: { data: { nonce: `n${++n}`, ...data } } }
  }) as any
const text = (c: any) => JSON.stringify(c)

beforeEach(() => {
  h.who = { user: { id: 'u1', role: 'r', preferences: null }, link: null }
  h.maintenance = false
  h.instance = { collection: 'orders', item: '7' }
  h.access = 'ok'
  h.inRowMenu = 1
  h.decide.mockReset().mockResolvedValue({ ok: true })
  h.transition.mockReset().mockResolvedValue({ status: 200, body: {} })
  h.ack.mockReset().mockResolvedValue({ status: 200, body: {} })
})

describe('handleInvoke', () => {
  it('approves as the linked user', async () => {
    const card = await handleInvoke(app, press({ kind: 'approval', ref: '5', action: 'approved' }))
    expect(h.decide).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 5, decision: 'approved', user: h.who.user })
    )
    expect(text(card)).toMatch(/Approved by you · \d{1,2}:\d{2} [AP]M ET/)
  })

  it('second invoke with the same nonce returns the refreshed card and decides nothing', async () => {
    const a = press({ kind: 'approval', ref: '5', action: 'approved', nonce: 'dup' })
    const first = await handleInvoke(app, a)
    const second = await handleInvoke(app, a)
    expect(h.decide).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it("a user who can't read the record gets not-found text and nothing runs", async () => {
    h.access = 'denied'
    const card = await handleInvoke(app, press({ kind: 'approval', ref: '5', action: 'approved' }))
    expect(text(card)).toContain("You can't open this record any more.")
    expect(h.decide).not.toHaveBeenCalled()
  })

  it('reject without comment when required asks for one', async () => {
    const card: any = await handleInvoke(
      app,
      press({ kind: 'approval', ref: '5', action: 'rejected', nonce: 'rj' })
    )
    expect(text(card)).toContain('reason is required')
    expect(h.decide).not.toHaveBeenCalled()
    // the nonce was not spent: sending a reason decides
    await handleInvoke(
      app,
      press({ kind: 'approval', ref: '5', action: 'rejected', nonce: 'rj', comment: 'no' })
    )
    expect(h.decide).toHaveBeenCalledWith(expect.objectContaining({ comment: 'no' }))
  })

  it('transition refusal shows its message', async () => {
    h.transition.mockResolvedValue({ status: 403, body: { error: 'You do not have permission' } })
    const card = await handleInvoke(
      app,
      press({ kind: 'transition', ref: 'orders/7', action: 't1' })
    )
    expect(text(card)).toContain('You do not have permission')
    expect(text(card)).toContain('https://n.test/orders/7')
  })

  it('a duplicate transition names who moved it', async () => {
    h.transition.mockResolvedValue({
      status: 409,
      body: { code: 'TRANSITION_DUPLICATE', first: { user_name: 'Sam' } }
    })
    const card = await handleInvoke(
      app,
      press({ kind: 'transition', ref: 'orders/7', action: 't1' })
    )
    expect(text(card)).toContain('Already moved by Sam.')
  })

  it('a transition that needs the form answers Open in Nivaro', async () => {
    h.transition.mockResolvedValue({
      status: 422,
      body: { error: 'TRANSITION_REQUIREMENTS', requirements: [] }
    })
    const card = await handleInvoke(
      app,
      press({ kind: 'transition', ref: 'orders/7', action: 't1' })
    )
    expect(text(card)).toContain('This needs the form. Open in Nivaro')
    expect(text(card)).toContain('Action.OpenUrl')
  })

  it('acknowledges', async () => {
    const card = await handleInvoke(app, press({ kind: 'ack', ref: '9', action: 'ack' }))
    expect(h.ack).toHaveBeenCalledWith(app, h.who.user, 9)
    expect(text(card)).toContain('Acknowledged by you')
  })

  it('unlinked sender gets the Connect card', async () => {
    h.who = { user: null, reason: 'not_found' }
    const card = await handleInvoke(app, press({ kind: 'approval', ref: '5', action: 'approved' }))
    expect(text(card)).toContain('Connect to Nivaro')
    expect(h.decide).not.toHaveBeenCalled()
  })

  it('refuses while maintenance is on', async () => {
    h.maintenance = true
    const card = await handleInvoke(app, press({ kind: 'approval', ref: '5', action: 'approved' }))
    expect(text(card)).toContain('Nivaro is in maintenance')
    expect(h.decide).not.toHaveBeenCalled()
  })

  it('a non-approver pressing Approve is refused', async () => {
    h.decide.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You are not an approver for the current step'
    })
    const card = await handleInvoke(app, press({ kind: 'approval', ref: '5', action: 'approved' }))
    expect(text(card)).toContain('not an approver')
    expect(text(card)).not.toContain('Approved by you')
  })

  it('a thrown action releases the nonce', async () => {
    h.decide.mockRejectedValueOnce(new Error('db down'))
    const a = press({ kind: 'approval', ref: '5', action: 'approved', nonce: 'boom' })
    const first = await handleInvoke(app, a)
    expect(text(first)).toContain('Something went wrong')
    const second = await handleInvoke(app, a)
    expect(h.decide).toHaveBeenCalledTimes(2)
    expect(text(second)).toContain('Approved by you')
  })

  it('claims the nonce in Redis with SET NX before acting', async () => {
    const calls: unknown[][] = []
    const redis = {
      set: vi.fn(async (...a: unknown[]) => {
        calls.push(a)
        return 'OK'
      }),
      get: vi.fn(),
      del: vi.fn()
    }
    await handleInvoke(
      { ...app, redis } as unknown as FastifyInstance,
      press({ kind: 'ack', ref: '9', action: 'ack', nonce: 'rx' })
    )
    expect(calls[0]).toEqual(['nvr:teams:nonce:rx', '__pending__', 'EX', 60, 'NX'])
  })

  it('a form-only transition (in_row_menu false) answers Open in Nivaro and nothing runs', async () => {
    h.inRowMenu = 0
    const card = await handleInvoke(
      app,
      press({ kind: 'transition', ref: 'orders/7', action: 't1' })
    )
    expect(text(card)).toContain('This needs the form. Open in Nivaro')
    expect(text(card)).toContain('https://n.test/orders/7')
    expect(h.transition).not.toHaveBeenCalled()
  })

  it('a retry while the first press is pending returns the stored card once it lands', async () => {
    let release!: () => void
    h.decide.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ ok: true })
        }) as never
    )
    const a = press({ kind: 'approval', ref: '5', action: 'approved', nonce: 'slow' })
    const first = handleInvoke(app, a)
    await new Promise((r) => setTimeout(r, 5))
    const retry = handleInvoke(app, a)
    await new Promise((r) => setTimeout(r, 300))
    release()
    const [c1, c2] = await Promise.all([first, retry])
    expect(h.decide).toHaveBeenCalledTimes(1)
    expect(text(c2)).toContain('Approved by you')
    expect(c2).toEqual(c1)
  })

  it('a pending marker that never resolves answers Working on it with Open', async () => {
    vi.useFakeTimers()
    try {
      h.decide.mockImplementationOnce(() => new Promise(() => undefined) as never)
      const a = press({ kind: 'approval', ref: '5', action: 'approved', nonce: 'stuck' })
      void handleInvoke(app, a)
      await vi.advanceTimersByTimeAsync(10)
      const retry = handleInvoke(app, a)
      await vi.advanceTimersByTimeAsync(9000)
      const card = await retry
      expect(text(card)).toContain('Working on it')
      expect(text(card)).toContain('https://n.test/orders/7')
    } finally {
      vi.useRealTimers()
    }
  })

  it("pending answer for a record the presser can't read has no link", async () => {
    vi.useFakeTimers()
    try {
      h.decide.mockImplementationOnce(() => new Promise(() => undefined) as never)
      const a = press({ kind: 'approval', ref: '5', action: 'approved', nonce: 'stuck-hidden' })
      void handleInvoke(app, a)
      await vi.advanceTimersByTimeAsync(10)
      // The retry's presser cannot read the record behind the in-flight nonce.
      h.access = 'denied'
      const retry = handleInvoke(app, a)
      await vi.advanceTimersByTimeAsync(9000)
      const card = await retry
      expect(text(card)).toContain('Working on it')
      expect(text(card)).not.toContain('https://n.test/orders/7')
      expect(text(card)).not.toContain('Action.OpenUrl')
    } finally {
      vi.useRealTimers()
    }
  })
})
