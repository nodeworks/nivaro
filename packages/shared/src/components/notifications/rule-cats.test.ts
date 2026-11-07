import { describe, expect, it } from 'vitest'
import { ruleCatsFor } from './NotificationRulesEditor'

// Army 8 b16: a Workflow Approver's rules listed "Chaos drills" and
// "Audit log patterns" — notices only administrators ever get.
describe('ruleCatsFor', () => {
  const keys = (subject: 'person' | 'role', admin: boolean) =>
    ruleCatsFor(subject, admin).map((c) => c.key)
  it('leaves admin-only categories out of a business user’s rules', () => {
    expect(keys('person', false)).not.toContain('chaos')
    expect(keys('person', false)).not.toContain('audit')
    expect(keys('person', false)).toContain('workflow')
    expect(keys('person', false)).toContain('anomaly')
  })
  it('lists every category for administrators and role defaults', () => {
    expect(keys('person', true)).toContain('chaos')
    expect(keys('role', false)).toContain('audit')
  })
})
