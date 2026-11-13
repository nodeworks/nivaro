import { beforeEach, describe, expect, it, vi } from 'vitest'

// ctx.integrations.beginSend / finishSend / holdSend: an extension that calls a partner itself
// (efp-ops: the Fusion requisition, MWF / LinX write-backs) writes the submission row before
// the call (`sending`, answer_by from THAT call's own timeout), finishes it in place with the
// answer, and asks first whether an earlier send of the same push is still unanswered.

const calls = vi.hoisted(() => ({
  begin: [] as Array<Record<string, unknown>>,
  finish: [] as Array<{ id: number; outcome: Record<string, unknown> }>,
  hold: [] as Array<Record<string, unknown>>,
  holdAnswer: null as null | Record<string, unknown>
}))

vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const q: Record<string, unknown> = {}
    let name: unknown = null
    q.where = (w: Record<string, unknown>) => {
      name = w.name ?? w.id
      return q
    }
    q.first = async () =>
      table === 'nivaro_external_apis' && (name === 'Fusion IIP' || name === 7)
        ? { id: 7, name: 'Fusion IIP' }
        : undefined
    return q
  }
}))
vi.mock('../../../services/workflow-actions.js', () => ({
  beginSubmission: vi.fn(async (o: Record<string, unknown>) => {
    calls.begin.push(o)
    return 501
  }),
  finishSubmission: vi.fn(async (id: number, outcome: Record<string, unknown>) => {
    calls.finish.push({ id, outcome })
    return true
  })
}))
vi.mock('../../../services/erp-unanswered.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/erp-unanswered.js')>()),
  unansweredHold: vi.fn(async (o: Record<string, unknown>) => {
    calls.hold.push(o)
    return calls.holdAnswer
  })
}))

import { extensionSendMembers } from '../../../services/extension-sends.js'

const NOW = new Date('2026-11-13T15:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  calls.begin = []
  calls.finish = []
  calls.hold = []
  calls.holdAnswer = null
})

describe('ctx.integrations send members', () => {
  const m = extensionSendMembers()

  it('beginSend writes the row before the call, answer_by from the call’s own timeout', async () => {
    const id = await m.beginSend({
      collection: 'workflows',
      item: 372931,
      api: 'Fusion IIP',
      endpointPath: '/manage-order',
      body: { a: 1 },
      // A big requisition: Fusion validates every line (up to ten minutes).
      timeoutMs: 600_000,
      blocking: true,
      requestedBy: 'U-ROB',
      requestedVia: 'item-action'
    })
    expect(id).toBe(501)
    expect(calls.begin[0]).toMatchObject({
      collection: 'workflows',
      item: '372931',
      externalApi: 7,
      endpointPath: '/manage-order',
      body: { a: 1 },
      blocking: true,
      who: { by: 'U-ROB', via: 'item-action' }
    })
    expect((calls.begin[0].answerBy as Date).toISOString()).toBe(
      new Date(NOW.getTime() + 600_000 + 60_000).toISOString()
    )
  })

  it('an unknown API begins nothing (null: the caller records the old way)', async () => {
    expect(
      await m.beginSend({
        collection: 'workflows',
        item: '1',
        api: 'Nope',
        endpointPath: '/x',
        body: {},
        timeoutMs: 30_000
      })
    ).toBeNull()
    expect(calls.begin).toHaveLength(0)
  })

  it('an unknown requested_via is not stored', async () => {
    await m.beginSend({
      collection: 'workflows',
      item: '1',
      api: 7,
      endpointPath: '/x',
      body: {},
      timeoutMs: 30_000,
      requestedVia: 'whatever'
    })
    expect(calls.begin[0].who).toEqual({ by: null, via: null })
  })

  it('finishSend writes the outcome onto that row, with the partner’s reference', async () => {
    expect(
      await m.finishSend(501, {
        collection: 'workflows',
        item: '372931',
        api: 'Fusion IIP',
        status: 'accepted',
        error: null,
        response: { status: 'SUCCESS' },
        httpStatus: 200,
        externalRef: '101-100560817',
        source: 'Fusion requisition push'
      })
    ).toBe(true)
    expect(calls.finish[0]).toEqual({
      id: 501,
      outcome: expect.objectContaining({
        externalApi: 7,
        status: 'accepted',
        externalRef: '101-100560817',
        responseBody: { status: 'SUCCESS' },
        httpStatus: 200,
        source: 'Fusion requisition push'
      })
    })
  })

  it('holdSend asks the same guard the transitions use, and answers what it says', async () => {
    calls.holdAnswer = {
      reason: 'Fusion IIP may already have this order: …',
      send: { stale: true },
      checkFailed: false
    }
    expect(
      await m.holdSend({
        collection: 'workflows',
        item: 5,
        api: 'Fusion IIP',
        endpointPath: '/manage-order'
      })
    ).toEqual({
      reason: 'Fusion IIP may already have this order: …',
      stale: true,
      checkFailed: false
    })
    expect(calls.hold[0]).toMatchObject({
      collection: 'workflows',
      item: '5',
      apiId: 7,
      endpointPath: '/manage-order'
    })
  })

  it('holdSend: an unknown API cannot be checked', async () => {
    expect(
      await m.holdSend({ collection: 'workflows', item: '5', api: 'Nope', endpointPath: '/x' })
    ).toEqual({
      reason: "Couldn't check earlier sends to Nope. Try again in a minute.",
      stale: null,
      checkFailed: true
    })
  })
})
