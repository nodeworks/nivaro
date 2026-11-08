import { describe, expect, it, vi } from 'vitest'

const rules = [
  {
    id: 1,
    collection: 'workflows',
    name: 'Sent back',
    conditions: '[{"field":"is_send_back","op":"eq","value":true}]',
    highlight_color: 'red',
    is_active: true
  },
  {
    id: 2,
    collection: 'workflows',
    name: 'On hold',
    conditions: '[{"field":"is_on_hold","op":"eq","value":true}]',
    highlight_color: 'amber',
    is_active: true
  }
]
const records = [
  { id: 1, is_on_hold: true, is_send_back: true },
  { id: 2, is_on_hold: false, is_send_back: false },
  { id: 3, is_on_hold: true, is_send_back: false }
]
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    if (table === 'nivaro_at_risk_rules') return { where: () => ({ orderBy: async () => rules }) }
    return {
      whereIn: (_c: string, ids: string[]) => ({
        select: async () => records.filter((r) => ids.includes(String(r.id)))
      })
    }
  })
}))

// Loaded up front: the module under test imports it lazily.
await import('../../../routes/at-risk.js')
const { atRiskFlags, atRiskRuleNames } = await import('../../../services/at-risk-flags.js')

describe('atRiskFlags (army 11 a1 F-2 / rev11-api #1)', () => {
  const rows = ['1', '2', '3'].map((item_id) => ({ collection: 'workflows', item_id }))

  it('names every rule each record matches, in rule order', async () => {
    const flags = await atRiskFlags(rows)
    expect(flags.get('workflows:1')?.map((f) => f.name)).toEqual(['Sent back', 'On hold'])
    expect(flags.get('workflows:3')?.map((f) => f.name)).toEqual(['On hold'])
    expect(flags.has('workflows:2')).toBe(false)
  })

  it("the list's own rule is the first match", async () => {
    const names = await atRiskRuleNames(rows)
    expect(names.get('workflows:1')).toBe('Sent back')
    expect(names.get('workflows:3')).toBe('On hold')
  })
})
