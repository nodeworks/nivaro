import { describe, expect, it, vi } from 'vitest'

// Precedence: the first matching rule, then the type's default, then the desk; on a type
// change someone who has the request keeps it unless the rule says otherwise.

const A = 'AAAAAAAA-0000-0000-0000-000000000001'
const B = 'BBBBBBBB-0000-0000-0000-000000000002'
const DEF = 'DDDDDDDD-0000-0000-0000-00000000000D'

const users: Record<string, Record<string, unknown>> = {
  [A]: { id: A, first_name: 'Ann', last_name: 'A', status: 'active' },
  [B]: { id: B, first_name: 'Ben', last_name: 'B', status: 'active' },
  [DEF]: { id: DEF, first_name: 'Dee', last_name: 'Fault', status: 'active' }
}

vi.mock('../../../services/collections.js', () => ({ getFields: vi.fn(async () => []) }))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwners: vi.fn(async () => [])
}))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => 't' }))
vi.mock('../../../services/support-tickets.js', () => ({
  teamIdsOf: vi.fn(async () => []),
  userName: (u?: { first_name?: string; last_name?: string }) =>
    u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : null
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb(async (q) => {
      if (/from \[nivaro_users\]/.test(q.sql)) {
        const ids = q.bindings.map(String)
        const rows = Object.values(users).filter((u) => ids.includes(String(u.id)))
        return q.method === 'first' ? rows[0] : rows
      }
      if (/from \[nivaro_user_groups\]/.test(q.sql)) return { id: 9, name: 'Finance' }
      return q.method === 'first' ? undefined : []
    })
  }
})

import { decideAssignment } from '../../../services/support-assign.js'
import type { AssignRule, AssignRuleSet } from '../../../services/support-assign-rules.js'
import { DEFAULT_HOURS } from '../../../services/support-assign-rules.js'

const rule = (over: Partial<AssignRule>): AssignRule => ({
  id: 'r',
  name: 'Rule',
  active: true,
  match: 'all',
  conditions: [],
  action: { kind: 'person', user: A },
  fallback: { kind: 'desk' },
  on_type_change: false,
  note: null,
  ...over
})
const set = (...rules: AssignRule[]): AssignRuleSet => ({ rules, hours: DEFAULT_HOURS })
const draft = {
  category_id: 3,
  collection: null,
  item: null,
  requester: B,
  priority: 'normal',
  title: 'Vendor change',
  description: null,
  at: new Date('2026-11-16T15:00:00Z')
}
const create = {
  trigger: 'create' as const,
  hasAssignee: false,
  typeDefault: DEF,
  redis: undefined
}

describe('decideAssignment precedence', () => {
  it('the first matching rule wins over the type default; later rules are not reached', async () => {
    const d = await decideAssignment(
      set(
        rule({
          id: 'no',
          name: 'Urgent only',
          conditions: [{ kind: 'priority', op: 'in', values: ['urgent'] }]
        }),
        rule({ id: 'yes', name: 'Vendor', action: { kind: 'person', user: A } }),
        rule({ id: 'later', name: 'Later', action: { kind: 'person', user: B } })
      ),
      draft,
      create
    )
    expect(d.outcome).toMatchObject({ kind: 'person', user: { id: A, name: 'Ann A' }, via: 'rule' })
    expect(d.trace.map((t) => t.result)).toEqual(['no_match', 'matched', 'not_reached'])
    expect(d.trace[0].reasons).toEqual(['the priority does not match'])
  })

  it('no rule matches: the type default, then the desk', async () => {
    const off = set(rule({ active: false }))
    const d = await decideAssignment(off, draft, create)
    expect(d.outcome).toMatchObject({ kind: 'person', user: { id: DEF }, via: 'type_default' })
    const desk = await decideAssignment(off, draft, { ...create, typeDefault: null })
    expect(desk.outcome).toMatchObject({ kind: 'desk', via: 'no_rule' })
  })

  it('nobody on the rule can take it: the fallback, not the type default', async () => {
    users[A].status = 'suspended'
    const toDesk = await decideAssignment(set(rule({})), draft, create)
    expect(toDesk.outcome).toMatchObject({ kind: 'desk', via: 'rule_fallback', rule: { id: 'r' } })
    const toPerson = await decideAssignment(
      set(rule({ fallback: { kind: 'person', user: B } })),
      draft,
      create
    )
    expect(toPerson.outcome).toMatchObject({
      kind: 'person',
      user: { id: B },
      via: 'rule_fallback'
    })
    users[A].status = 'active'
  })

  it('send to a team leaves it unassigned with that team', async () => {
    const d = await decideAssignment(
      set(rule({ action: { kind: 'team', team: 9 } })),
      draft,
      create
    )
    expect(d.outcome).toMatchObject({ kind: 'team', team: { id: 9, name: 'Finance' } })
  })

  it('type change: someone who has it keeps it unless the rule runs on type changes', async () => {
    const change = {
      trigger: 'type_change' as const,
      hasAssignee: true,
      typeDefault: DEF,
      redis: undefined
    }
    const kept = await decideAssignment(set(rule({})), draft, change)
    expect(kept.trace[0].result).toBe('held')
    expect(kept.outcome).toMatchObject({ kind: 'desk', via: 'keep' })
    const moved = await decideAssignment(set(rule({ on_type_change: true })), draft, change)
    expect(moved.outcome).toMatchObject({ kind: 'person', user: { id: A }, via: 'rule' })
  })

  it('share among people ranks them and says who was skipped', async () => {
    users[B].status = 'suspended'
    const d = await decideAssignment(
      set(
        rule({
          action: {
            kind: 'share',
            people: [
              { id: B, cap: null, when: 'always' },
              { id: A, cap: null, when: 'always' }
            ],
            strategy: 'fewest_open',
            give_to_cover: false
          }
        })
      ),
      draft,
      create
    )
    expect(d.outcome).toMatchObject({ kind: 'person', user: { id: A } })
    expect(d.pick?.skipped).toEqual([{ id: B, name: 'Ben B', reason: 'account is not active' }])
    expect(d.pick?.ranking).toEqual([{ id: A, name: 'Ann A', measure: '0 open' }])
    users[B].status = 'active'
  })
})
