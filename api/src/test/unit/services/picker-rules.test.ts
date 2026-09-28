import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), {}) }))

const { enforcePickerRules, clearPickerRuleCache } = await import(
  '../../../services/picker-rules.js'
)

describe('enforcePickerRules', () => {
  it('never throws when the rules cannot be read', async () => {
    clearPickerRuleCache()
    // The mocked db is not a query builder: reading the rules throws, and a
    // failure to READ the rules must never stop a write.
    await expect(
      enforcePickerRules({
        collection: 'workflows',
        row: { project: 1 },
        callerFields: new Set(['project'])
      })
    ).resolves.toBeUndefined()
  })
})
