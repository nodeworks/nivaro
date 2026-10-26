// Ask AI's waiting_on_me answers the asker's own My Work "Waiting on you" set:
// the owned_by_me resolver for THEIR id, narrowed to what they may read,
// labelled as them — and says "nothing" instead of substituting another list.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { CHAT_SYSTEM_PROMPT, CHAT_TOOLS } from '../../../services/ai-chat.js'
import type { SourceResult } from '../../../services/queues.js'
import { ownedWithSla, type WaitingDeps, waitingOnMe } from '../../../services/waiting-on-me.js'
import type { User } from '../../../types.js'

const JORDAN = { id: 'JORDAN', role: 'approver' } as unknown as User

const item = (collection: string, id: string, state = 'level_1') => ({
  collection,
  item_id: id,
  label: `raw ${id}`,
  state,
  state_color: null,
  owners: [],
  sla_status: null,
  at_risk: false,
  aging_hours: null,
  claimed_by: null,
  url: `/collections/${collection}/${id}`
})

function deps(over: Partial<WaitingDeps> = {}): WaitingDeps & { ownedFor: string[] } {
  const ownedFor: string[] = []
  return {
    ownedFor,
    owned: async (userId) => {
      ownedFor.push(userId)
      return {
        items: [item('workflows', '8181'), item('workflows', '8182'), item('workflows', '9999')],
        matchedCount: 3,
        truncated: false
      } as SourceResult
    },
    sla: async () => ({
      '8182': { status: 'breached', elapsed_hours: 50, remaining_hours: -26 } as never,
      '8181': { status: 'ok', elapsed_hours: 2, remaining_hours: 22 } as never
    }),
    approvals: async () => [
      { id: 1, collection: 'invoices', item: '77', chain_name: 'Invoice sign-off', current_step: 2 }
    ],
    // 9999 is owned but unreadable for Jordan (a User Scope hides it).
    visible: async () => new Set(['workflows:8181', 'workflows:8182', 'invoices:77']),
    labels: async () => ({ 'workflows:8181': 'Fiber build', 'workflows:8182': 'Node split' }),
    friendlyIds: async (c, ids) =>
      new Map(ids.map((id) => [id, c === 'workflows' ? `HQ25-${id}` : `INV-${id}`])),
    ...over
  }
}

describe('waitingOnMe', () => {
  it("answers only the asker's owned records, breached first, readable only", async () => {
    const d = deps()
    const out = await waitingOnMe(JORDAN, {}, d)
    expect(d.ownedFor).toEqual(['JORDAN'])
    expect(out.total).toBe(2)
    expect(out.breached).toBe(1)
    expect(out.records.map((r) => r.record)).toEqual(['HQ25-8182', 'HQ25-8181'])
    expect(out.records[0]).toMatchObject({ sla: 'breached', hours_over: 26, label: 'Node split' })
    expect(JSON.stringify(out)).not.toContain('9999')
    expect(out.approvals).toEqual([
      { record: 'INV-77', collection: 'invoices', id: '77', chain: 'Invoice sign-off', step: 2 }
    ])
    expect(out.note).toBeUndefined()
  })

  it('never uses the resolver label (labels are read as the asker)', async () => {
    const out = await waitingOnMe(JORDAN, {}, deps({ labels: async () => ({}) }))
    expect(out.records.every((r) => r.label === null)).toBe(true)
  })

  it('says nothing is waiting instead of an empty list the model could fill', async () => {
    const out = await waitingOnMe(
      JORDAN,
      {},
      deps({
        owned: async () => ({ items: [], matchedCount: 0, truncated: false }),
        approvals: async () => []
      })
    )
    expect(out.total).toBe(0)
    expect(out.note).toMatch(/do not list other people/)
  })

  it('a failing resolver is an empty set, never a throw', async () => {
    const out = await ownedWithSla(
      'JORDAN',
      deps({
        owned: async () => {
          throw new Error('db down')
        }
      })
    )
    expect(out.owned).toEqual([])
  })

  it('caps the list and reports truncation', async () => {
    const out = await waitingOnMe(JORDAN, { limit: 1 }, deps())
    expect(out.records).toHaveLength(1)
    expect(out.total).toBe(2)
    expect(out.truncated).toBe(true)
  })
})

describe('Ask AI wiring', () => {
  it('offers waiting_on_me with no person parameter', () => {
    const tool = CHAT_TOOLS.find((t) => t.name === 'waiting_on_me')
    expect(tool).toBeTruthy()
    expect(Object.keys((tool!.input_schema as { properties: object }).properties)).toEqual([
      'limit'
    ])
  })
  it('the prompt routes "waiting on me" to it and forbids substitutes', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/what's waiting on me[^\n]*call waiting_on_me/)
    expect(CHAT_SYSTEM_PROMPT).toMatch(/never answer with other people's records/)
  })
})
