import { describe, expect, it, vi } from 'vitest'

// PUT /support/assign-rules refuses rules that name people, types, teams, collections or
// fields that do not exist — in plain words, per rule.

const A = 'AAAAAAAA-0000-0000-0000-000000000001'
const GONE = 'EEEEEEEE-0000-0000-0000-00000000000E'

vi.mock('../../../middleware/authenticate.js', () => ({ requireAdmin: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/support-assign.js', () => ({
  decideAssignment: vi.fn(),
  loadRuleSet: vi.fn(),
  saveRuleSet: vi.fn()
}))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async (c: string) => (c === 'workflows' ? { collection: c } : undefined)),
  getFields: vi.fn(async () => [{ field: 'zone' }])
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb(async (q) => {
      if (/from \[nivaro_users\]/.test(q.sql)) return q.bindings.includes(A) ? [{ id: A }] : []
      if (/from \[nivaro_task_categories\]/.test(q.sql)) return [{ id: 3 }]
      return []
    })
  }
})

import { checkReferences } from '../../../routes/support-assign-rules.js'
import { DEFAULT_HOURS } from '../../../services/support-assign-rules.js'

const base = {
  id: 'r',
  name: 'R',
  active: true,
  match: 'all' as const,
  fallback: { kind: 'desk' as const },
  on_type_change: false,
  note: null
}

describe('checkReferences', () => {
  it('passes a rule whose references exist', async () => {
    const errs = await checkReferences({
      hours: DEFAULT_HOURS,
      rules: [
        {
          ...base,
          conditions: [
            { kind: 'type', op: 'in', values: [3] },
            { kind: 'field', collection: 'workflows', field: 'zone', op: 'is', values: ['x'] }
          ],
          action: { kind: 'person', user: A }
        }
      ]
    })
    expect(errs).toEqual([])
  })

  it('names a missing person, type, team, collection and field', async () => {
    const errs = await checkReferences({
      hours: DEFAULT_HOURS,
      rules: [
        {
          ...base,
          conditions: [{ kind: 'type', op: 'in', values: [99] }],
          action: { kind: 'person', user: GONE }
        },
        {
          ...base,
          conditions: [
            { kind: 'about', op: 'record_in', collections: ['nope'] },
            { kind: 'field', collection: 'workflows', field: 'colour', op: 'is', values: ['x'] }
          ],
          action: { kind: 'team', team: 5 }
        }
      ]
    })
    expect(errs).toEqual(
      expect.arrayContaining([
        { rule: 0, message: 'A person on this rule no longer exists' },
        { rule: 0, message: 'A request type on this rule no longer exists' },
        { rule: 1, message: 'A team on this rule no longer exists' },
        { rule: 1, message: 'A kind of record on this rule is not a collection' },
        { rule: 1, message: 'Colour is not a field of that record' }
      ])
    )
  })
})
