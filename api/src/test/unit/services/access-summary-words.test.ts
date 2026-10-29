import { describe, expect, it } from 'vitest'
import {
  type AccessSummaryInput,
  buildAccessSummary,
  conditionWords,
  pluralLabel,
  roleSubject,
  rowFilterWords,
  type SummaryCollectionFacts
} from '../../../services/access-summary-words.js'

// #12 — the pure phrasing of a role's / person's access.

const P = { subj: 'They', they: 'they', their: 'their', them: 'them', have: 'have' }

function facts(over: Partial<SummaryCollectionFacts> = {}): SummaryCollectionFacts {
  return {
    collection: 'po',
    label: 'POs',
    rank: 0,
    read: true,
    create: true,
    update: true,
    delete: true,
    read_fields: null,
    update_fields: null,
    all_fields: ['id', 'number', 'cost'],
    field_labels: { cost: 'Cost' },
    row_filter: { read: null, update: null, delete: null },
    scopes: [],
    strict: null,
    tree_rules: false,
    ...over
  }
}

function input(over: Partial<AccessSummaryInput> = {}): AccessSummaryInput {
  return {
    voice: 'role',
    name: 'Buyer',
    role_name: 'Buyer',
    admin: false,
    app_access: true,
    collections: [],
    closed_count: 0,
    ui_disabled: [],
    ...over
  }
}

describe('words', () => {
  it('plural labels and role subjects', () => {
    expect(pluralLabel('Zone')).toBe('Zones')
    expect(pluralLabel('Entity')).toBe('Entities')
    expect(pluralLabel('Business Unit')).toBe('Business Units')
    expect(roleSubject('Buyer')).toBe('Buyers')
    expect(roleSubject('Approvers')).toBe('Approvers')
    expect(roleSubject('Finance')).toBe('People with the Finance role')
  })

  it('row rules in plain words', () => {
    expect(conditionWords({ field: 'status', op: 'eq', value: 'Approved' }, {})).toBe(
      'Status is Approved'
    )
    expect(conditionWords({ field: 'amount', op: 'lte', value: 5000 }, {})).toBe(
      'Amount is at most 5000'
    )
    expect(conditionWords({ field: 'kind', op: 'in', value: 'a,b,c' }, {})).toBe(
      'Kind is a, b or c'
    )
    expect(conditionWords({ field: 'owner', op: 'eq', value: '$CURRENT_USER' }, {})).toBe(
      'Owner is them'
    )
    expect(conditionWords({ field: 'closed_at', op: 'null' }, { closed_at: 'Closed' })).toBe(
      'Closed is empty'
    )
    expect(
      rowFilterWords([{ field: 'user_created', op: 'eq', value: '$CURRENT_USER' }], {}, P)
    ).toBe('only ones they created')
  })
})

describe('buildAccessSummary', () => {
  it("Rob's example: scopes + no delete + hidden cost field", () => {
    const s = buildAccessSummary(
      input({
        collections: [
          facts({
            delete: false,
            create: false,
            read_fields: ['id', 'number'],
            scopes: [{ label: 'Zone', members: 3, of: 3 }]
          })
        ]
      })
    )
    expect(s.lines[0].sentence).toBe(
      "Buyers can see and edit POs in their own Zones, can't add or delete, can't see the Cost field."
    )
  })

  it('full access collections share one line, in rank order', () => {
    const s = buildAccessSummary(
      input({
        collections: [
          facts({ collection: 'b', label: 'notes', rank: 2 }),
          facts({ collection: 'a', label: 'tasks', rank: 1 }),
          facts({ collection: 'c', label: 'POs', rank: 0, delete: false })
        ]
      })
    )
    expect(s.lines.map((l) => l.kind)).toEqual(['limited', 'full'])
    expect(s.lines[1].sentence).toBe(
      'Buyers have full access to tasks and notes: see, add, edit and delete.'
    )
  })

  it('a different edit rule is named; a row rule on a hidden field is not (own access)', () => {
    const f = facts({
      read_fields: ['id', 'number'],
      row_filter: {
        read: [{ field: 'cost', op: 'gt', value: 0 }],
        update: [{ field: 'number', op: 'nnull' }],
        delete: [{ field: 'cost', op: 'gt', value: 0 }]
      }
    })
    const self = buildAccessSummary(
      input({ voice: 'self', collections: [f], conceal_hidden_fields: true })
    )
    expect(self.lines[0].sentence).toBe(
      'You can see, add, edit and delete POs, only ones a rule on your role allows, edits only where Number is filled in, some fields are hidden from you.'
    )
    expect(self.sentences.join(' ')).not.toMatch(/cost/i)
    const admin = buildAccessSummary(input({ voice: 'third', name: 'Beth', collections: [f] }))
    expect(admin.lines[0].sentence).toContain('only where Cost is over 0')
  })

  it('strict scope hides a collection; write without read', () => {
    const s = buildAccessSummary(
      input({
        collections: [
          facts({ strict: 'Zone' }),
          facts({
            collection: 'x',
            label: 'forms',
            rank: 1,
            read: false,
            update: false,
            delete: false
          })
        ]
      })
    )
    expect(s.lines[0].sentence).toBe(
      "Buyers can't see any POs: the Zone filter is strict and these records have no Zone link."
    )
    expect(s.lines[1].sentence).toBe("Buyers can add forms but can't see them.")
  })

  it('admin, no role, pages and app access', () => {
    expect(buildAccessSummary(input({ admin: true })).headline).toMatch(/administrator role/)
    expect(
      buildAccessSummary(input({ voice: 'third', name: 'Beth', no_role: true })).headline
    ).toBe("Beth has no role, so they can't see any records.")
    const s = buildAccessSummary(
      input({
        collections: [facts()],
        ui_disabled: ['/flows', '/jobs/timeline'],
        app_access: false,
        closed_count: 3
      })
    )
    expect(s.sentences).toContain('Pages turned off: Flows and Jobs timeline.')
    expect(s.sentences).toContain("Buyers can't open the other 3 collections.")
    expect(s.sentences).toContain(
      "Everyone with this role can't sign in to the app (the role has no app access)."
    )
  })
})
