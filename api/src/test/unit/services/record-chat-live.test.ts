import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/chat-records.js', () => ({ roomTypes: vi.fn(async () => []) }))
vi.mock('../../../services/record-events.js', () => ({ emitRecordEvent: vi.fn() }))

import {
  announceRecordChat,
  clearRecordChatCache,
  type RecordChatDeps,
  recordsOfEntityRoom
} from '../../../services/record-chat-live.js'

function deps(over: Partial<RecordChatDeps> = {}) {
  const emitted: Array<[string, string]> = []
  const lookup = vi.fn(async (_c: string, _f: string, token: string) =>
    token === 'CR26-1' ? ['101'] : []
  )
  const d: RecordChatDeps = {
    types: async () => [
      { prefix: 'wf', collection: 'workflows', match_field: 'workflow_number' },
      { prefix: 'inv', collection: 'invoices', match_field: 'id' }
    ],
    lookup,
    emit: (c, id) => emitted.push([c, id]),
    now: () => 1_000,
    tenant: () => 't1',
    ...over
  }
  return { d, emitted, lookup }
}

describe('record chat unread goes live (rt5 #9)', () => {
  beforeEach(() => clearRecordChatCache())

  it("a message in a record's room tells that record's open pages — ids only", async () => {
    const { d, emitted } = deps()
    await announceRecordChat('wf:CR26-1', d)
    expect(emitted).toEqual([['workflows', '101']])
  })

  it('a room matched on id needs no lookup', async () => {
    const { d, emitted, lookup } = deps()
    await announceRecordChat('inv:77', d)
    expect(emitted).toEqual([['invoices', '77']])
    expect(lookup).not.toHaveBeenCalled()
  })

  it('DMs, channels, General and unknown prefixes announce nothing', async () => {
    const { d, emitted, lookup } = deps()
    for (const room of ['dm:A:B', 'ch:ops', 'general', 'nope:1', 'wf:missing'])
      await announceRecordChat(room, d)
    expect(emitted).toEqual([])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('caches the room → record lookup per tenant', async () => {
    const { d, lookup } = deps()
    await recordsOfEntityRoom('wf:CR26-1', d)
    await recordsOfEntityRoom('wf:CR26-1', d)
    expect(lookup).toHaveBeenCalledTimes(1)
    await recordsOfEntityRoom('wf:CR26-1', { ...d, tenant: () => 't2' })
    expect(lookup).toHaveBeenCalledTimes(2)
    await recordsOfEntityRoom('wf:CR26-1', { ...d, now: () => 1_000 + 6 * 60_000 })
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  it('a failed lookup never throws out of the send path', async () => {
    const { d, emitted } = deps({
      lookup: async () => {
        throw new Error('boom')
      }
    })
    await expect(announceRecordChat('wf:CR26-1', d)).resolves.toBeUndefined()
    expect(emitted).toEqual([])
  })
})
