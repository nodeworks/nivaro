import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

// requirementBlockers imports these lazily; the tests drive them per record.
const conditions = vi.hoisted(() => ({
  fetchRecordForConditions: vi.fn(),
  evaluateTransitionRequirements: vi.fn()
}))
vi.mock('../../../services/workflow-conditions.js', () => ({
  evaluateConditionRules: () => true,
  evalConditionRule: () => true,
  fetchRecordForConditions: conditions.fetchRecordForConditions,
  parseConditionRules: () => []
}))
vi.mock('../../../services/transition-requirements.js', () => ({
  evaluateTransitionRequirements: conditions.evaluateTransitionRequirements
}))

import { db } from '../../../db/index.js'
import {
  assembleReadiness,
  creatorColumnFor,
  daysBetween,
  describeConditionRule,
  fieldBlockers,
  isSendBackEdge,
  onboardingSteps,
  pickUnavailable,
  requirementBlockers,
  splitLineFinding,
  tallyCollection,
  verdictOf,
  weekBuckets
} from '../../../services/dashboard-feed.js'

describe('isSendBackEdge', () => {
  it('is a send-back when the destination sorts before the origin', () => {
    expect(isSendBackEdge(5, 2, 'Approve')).toBe(true)
  })

  it('is not a send-back on a forward or same-sort move with an ordinary label', () => {
    expect(isSendBackEdge(2, 5, 'Approve')).toBe(false)
    expect(isSendBackEdge(3, 3, 'Submit')).toBe(false)
  })

  it('counts a transition whose label says send back / sent back, whatever the sorts', () => {
    expect(isSendBackEdge(2, 5, 'Send Back')).toBe(true)
    expect(isSendBackEdge(2, 5, 'sent back to creator')).toBe(true)
    expect(isSendBackEdge(2, 5, 'SendBack')).toBe(true)
    expect(isSendBackEdge(2, 5, 'Send-back')).toBe(true)
  })

  it('treats missing sorts as unknown, falling back to the label', () => {
    expect(isSendBackEdge(null, null, 'Approve')).toBe(false)
    expect(isSendBackEdge(null, 1, 'Send back')).toBe(true)
  })

  it('an uncancel (leaving the canceled state) is never a send-back', () => {
    expect(isSendBackEdge(9, 2, 'Uncancel', 'canceled')).toBe(false)
    expect(isSendBackEdge(9, 2, 'Send back', 'CANCELED')).toBe(false)
    expect(isSendBackEdge(9, 2, 'Uncancel', 'review')).toBe(true)
  })
})

describe('splitLineFinding', () => {
  it('splits a line-scoped message into the line token and the rest', () => {
    expect(splitLineFinding('Line 3: Category is empty')).toEqual({
      line: '3',
      message: 'Category is empty'
    })
  })

  it('keeps a #-prefixed token as written', () => {
    expect(splitLineFinding('Line #12:   Price is $5.00')).toEqual({
      line: '#12',
      message: 'Price is $5.00'
    })
  })

  it('answers null for a record-level message', () => {
    expect(splitLineFinding('Vendor is required')).toBeNull()
    expect(splitLineFinding('Lines missing: 3')).toBeNull()
  })
})

describe('weekBuckets', () => {
  // Wednesday; this week began Monday 2026-09-28 (UTC).
  const now = new Date('2026-09-30T12:00:00Z')
  const row = (at: string, extra: Partial<Parameters<typeof weekBuckets>[0][number]> = {}) => ({
    at,
    send_back: false,
    completion: false,
    tta_hours: null,
    ...extra
  })

  it('counts this week apart and takes the median of the prior weeks (zero weeks included)', () => {
    const rows = [
      // this week
      row('2026-09-28T01:00:00Z', { send_back: true, tta_hours: 2 }),
      row('2026-09-30T09:00:00Z', { completion: true, tta_hours: 4 }),
      // 1 week ago: 3
      row('2026-09-21T10:00:00Z', { tta_hours: 10 }),
      row('2026-09-22T10:00:00Z', { send_back: true, tta_hours: 20 }),
      row('2026-09-27T23:59:00Z', { completion: true }),
      // 2 weeks ago: 1
      row('2026-09-15T10:00:00Z', { tta_hours: 30 }),
      // 3 weeks ago: 0
      // 4 weeks ago: 5
      row('2026-08-31T10:00:00Z'),
      row('2026-09-01T10:00:00Z'),
      row('2026-09-02T10:00:00Z', { completion: true }),
      row('2026-09-03T10:00:00Z'),
      row('2026-09-06T10:00:00Z'),
      // 5 weeks ago — outside a 4-week window
      row('2026-08-25T10:00:00Z', { send_back: true, tta_hours: 999 })
    ]
    const out = weekBuckets(rows, 4, now)
    expect(out.this_week).toEqual({ transitions: 2, send_backs: 1, completions: 1 })
    // weekly counts [3, 1, 0, 5] → transitions median (1 + 3) / 2
    expect(out.median.transitions).toBe(2)
    // send-backs [1, 0, 0, 0] → 0; completions [1, 0, 0, 1] → 0.5
    expect(out.median.send_backs).toBe(0)
    expect(out.median.completions).toBe(0.5)
    expect(out.time_to_action_hours).toEqual({ this_week: 3, median: 20 })
    // 2 send-backs over 11 transitions inside the window
    expect(out.send_back_ratio).toBeCloseTo(2 / 11)
  })

  it('answers nulls when there is nothing to measure', () => {
    const out = weekBuckets([], 4, now)
    expect(out.this_week).toEqual({ transitions: 0, send_backs: 0, completions: 0 })
    expect(out.median).toEqual({ transitions: 0, send_backs: 0, completions: 0 })
    expect(out.time_to_action_hours).toEqual({ this_week: null, median: null })
    expect(out.send_back_ratio).toBeNull()
  })

  it("buckets by the viewer's own Monday", () => {
    // 2026-09-28T02:00Z is still Sunday evening in New York → last week there.
    const rows = [row('2026-09-28T02:00:00Z')]
    expect(weekBuckets(rows, 4, now, 'UTC').this_week.transitions).toBe(1)
    expect(weekBuckets(rows, 4, now, 'America/New_York').this_week.transitions).toBe(0)
  })
})

describe('verdictOf', () => {
  it('is idle when nothing was sent', () => {
    expect(verdictOf([])).toEqual({ verdict: 'idle', failed_24h: 0, last_failure_at: null })
  })

  it('is failing when the newest attempt failed', () => {
    const out = verdictOf([
      { status: 'failed', at: '2026-09-28T10:00:00Z' },
      { status: 'accepted', at: '2026-09-28T09:00:00Z' },
      { status: 'failed', at: '2026-09-28T08:00:00Z' }
    ])
    expect(out).toEqual({
      verdict: 'failing',
      failed_24h: 2,
      last_failure_at: '2026-09-28T10:00:00.000Z'
    })
  })

  it('is healthy when a success landed after the last failure (order-independent)', () => {
    const out = verdictOf([
      { status: 'failed', at: '2026-09-28T08:00:00Z' },
      { status: 'pending', at: '2026-09-28T11:00:00Z' }
    ])
    expect(out.verdict).toBe('healthy')
    expect(out.failed_24h).toBe(1)
    expect(out.last_failure_at).toBe('2026-09-28T08:00:00.000Z')
  })
})

describe('onboardingSteps', () => {
  it('reads each step from its own source', () => {
    expect(
      onboardingSteps(
        { notification_prefs: { matrix: { workflow: { inapp: true } } }, timezone: 'UTC' },
        2,
        1,
        { delegate_id: 'X' }
      )
    ).toEqual({
      scope_defaults: true,
      notification_rules: true,
      timezone: true,
      watching: true,
      delegate: true
    })
  })

  it('is all false for a brand-new account', () => {
    expect(onboardingSteps(null, 0, 0, { delegate_id: null })).toEqual({
      scope_defaults: false,
      notification_rules: false,
      timezone: false,
      watching: false,
      delegate: false
    })
    expect(
      onboardingSteps({ notification_prefs: { matrix: {} }, timezone: '  ' }, 0, 0, {})
        .notification_rules
    ).toBe(false)
  })
})

describe('daysBetween', () => {
  it('counts whole days, flooring partial ones', () => {
    expect(daysBetween('2026-09-01T00:00:00Z', '2026-09-04T12:00:00Z')).toBe(3)
  })

  it('is never negative and reads Date objects too', () => {
    expect(daysBetween(new Date('2026-09-04T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))).toBe(0)
  })

  it('answers 0 for an unreadable date', () => {
    expect(daysBetween('not a date', '2026-09-04T00:00:00Z')).toBe(0)
  })
})

describe('creatorColumnFor', () => {
  it('prefers a field flagged user-created (JSON array special) that physically exists', () => {
    const fields = [
      { field: 'owner_person', special: '["user-created"]' },
      { field: 'user_created', special: null }
    ]
    expect(creatorColumnFor(fields, ['id', 'owner_person', 'user_created'])).toBe('owner_person')
  })

  it('reads a bare or comma-list special', () => {
    expect(creatorColumnFor([{ field: 'made_by', special: 'm2o,user-created' }], ['made_by'])).toBe(
      'made_by'
    )
  })

  it('ignores a flagged field that has no physical column', () => {
    expect(creatorColumnFor([{ field: 'ghost', special: 'user-created' }], ['id', 'creator'])).toBe(
      'creator'
    )
  })

  it('falls back to user_created, then creator, then created_by (case-insensitive)', () => {
    expect(creatorColumnFor([], ['id', 'created_by', 'creator'])).toBe('creator')
    expect(creatorColumnFor([], ['id', 'CREATED_BY'])).toBe('CREATED_BY')
    expect(creatorColumnFor([], ['id', 'user_created', 'creator'])).toBe('user_created')
  })

  it('answers null when nothing names a creator', () => {
    expect(creatorColumnFor([], ['id', 'name'])).toBeNull()
  })
})

describe('pickUnavailable', () => {
  const base = {
    first_name: 'Pat',
    last_name: 'Lee',
    email: 'pat@example.com',
    status: 'active',
    is_redacted: false,
    is_out_of_office: false,
    delegate_id: null,
    delegate_expires_at: null
  }

  it('lists a suspended owner', () => {
    const out = pickUnavailable([{ id: 'A' }], [{ ...base, id: 'A', status: 'suspended' }])
    expect(out).toEqual([{ id: 'A', name: 'Pat Lee', reason: 'suspended', delegate: null }])
  })

  it('lists a redacted owner as redacted', () => {
    const out = pickUnavailable([{ id: 'A' }], [{ ...base, id: 'A', is_redacted: 1 }])
    expect(out[0]?.reason).toBe('redacted')
  })

  it('an out-of-office owner whose delegation expired is out with no delegate', () => {
    const out = pickUnavailable(
      [{ id: 'A' }],
      [
        {
          ...base,
          id: 'A',
          is_out_of_office: true,
          delegate_id: 'X',
          delegate_expires_at: new Date('2020-01-01T00:00:00Z')
        },
        { ...base, id: 'X', first_name: 'Kim' }
      ]
    )
    expect(out).toEqual([{ id: 'A', name: 'Pat Lee', reason: 'out', delegate: null }])
  })

  it('an out-of-office owner with a working delegate names the delegate', () => {
    const out = pickUnavailable(
      [{ id: 'a' }],
      [
        { ...base, id: 'A', is_out_of_office: 1, delegate_id: 'x', delegate_expires_at: null },
        { ...base, id: 'X', first_name: 'Kim', last_name: 'Diaz' }
      ]
    )
    expect(out).toEqual([
      {
        id: 'a',
        name: 'Pat Lee',
        reason: 'out',
        delegate: { id: 'X', name: 'Kim Diaz', expires_at: null }
      }
    ])
  })

  it('an active owner is not listed', () => {
    expect(pickUnavailable([{ id: 'A' }], [{ ...base, id: 'A' }])).toEqual([])
  })
})

describe('describeConditionRule', () => {
  it('words the common operators', () => {
    expect(describeConditionRule({ field: 'vendor', op: 'nnull', value: null })).toBe(
      'Vendor must be set'
    )
    expect(describeConditionRule({ field: 'workflow_type', op: 'eq', value: 2 })).toBe(
      'Workflow Type must be 2'
    )
    expect(describeConditionRule({ field: 'status', op: 'in', value: 'a, b' })).toBe(
      'Status must be one of a, b'
    )
  })

  it('names the child collection for a related-rows rule', () => {
    expect(
      describeConditionRule({
        field: 'workflow_line_items:workflow',
        op: 'related_some',
        value: null
      })
    ).toBe('Needs at least one Workflow Line Items row')
  })

  it('walks a dotted field', () => {
    expect(
      describeConditionRule({ field: 'unit.schedule_date', op: 'within_days', value: 45 })
    ).toBe('Unit › Schedule Date must be within 45 days')
  })
})

describe('assembleReadiness', () => {
  const vendor = {
    kind: 'field' as const,
    field: 'vendor',
    label: 'Vendor',
    message: 'Vendor is required'
  }
  const gate = { kind: 'requirement' as const, label: 'Submit', message: 'Enter REQ ids' }

  it('marks an id ready only when both lookups answered and neither blocks it', () => {
    const out = assembleReadiness(['1', '2'], new Map([['1', [vendor]]]), new Map([['1', [gate]]]))
    expect(out['1']).toEqual({ ready: false, blockers: [vendor, gate] })
    expect(out['2']).toEqual({ ready: true, blockers: [] })
  })

  it('matches ids case-insensitively', () => {
    const out = assembleReadiness(['ab-1'], new Map([['AB-1', [vendor]]]), new Map())
    expect(out['ab-1']).toEqual({ ready: false, blockers: [vendor] })
  })

  it('omits every id when a lookup failed — a failure is never "ready"', () => {
    expect(assembleReadiness(['1', '2'], null, new Map())).toEqual({})
    expect(assembleReadiness(['1'], new Map([['1', [vendor]]]), null)).toEqual({})
    expect(assembleReadiness(['1'], null, null)).toEqual({})
  })

  it('omits only an id whose own lookup could not be answered', () => {
    const out = assembleReadiness(
      ['1', '2', '3'],
      new Map([['1', [vendor]]]),
      new Map<string, (typeof gate)[] | null>([['2', null]])
    )
    expect(out['1']).toEqual({ ready: false, blockers: [vendor] })
    expect(out['2']).toBeUndefined()
    expect(out['3']).toEqual({ ready: true, blockers: [] })
  })
})

/** A knex-shaped fake: every builder call chains, and awaiting it answers the
 *  table's rows (or rejects when the table is listed in `fail`). */
function fakeDb(rows: Record<string, unknown[]>, fail: string[] = []) {
  vi.mocked(db).mockImplementation(((table: string) => {
    const chain: Record<string, unknown> = {}
    const settle = () =>
      fail.includes(table)
        ? Promise.reject(new Error(`read failed: ${table}`))
        : Promise.resolve(rows[table] ?? [])
    for (const m of [
      'where',
      'orWhere',
      'whereIn',
      'whereNull',
      'whereNotNull',
      'orderBy',
      'select',
      'groupBy',
      'count'
    ]) {
      chain[m] = () => chain
    }
    chain.first = () => settle().then((r) => (r as unknown[])[0])
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      settle().then(res, rej)
    chain.catch = (rej: (e: unknown) => unknown) => settle().catch(rej)
    return chain
  }) as never)
}

describe('requirementBlockers', () => {
  const instances = ['1', '2', '3'].map((item) => ({
    id: `i${item}`,
    item,
    template: 'T',
    current_state: 'S1'
  }))
  const states = [
    { id: 'S1', key: 'started', sort: 1 },
    { id: 'S2', key: 'review', sort: 2 }
  ]
  const transitions = [
    {
      id: 'x',
      template: 'T',
      from_state: 'S1',
      to_state: 'S2',
      label: 'Submit',
      sort: 1,
      auto_trigger: false,
      condition_rules: '[{"field":"vendor","op":"nnull","value":null}]',
      required_roles: null,
      requirements: '[{"type":"record_fields","fields":["vendor"]}]'
    }
  ]

  it('marks only the record whose own read failed as unknown; the others still answer', async () => {
    fakeDb({
      nivaro_workflow_instances: instances,
      nivaro_workflow_states: states,
      nivaro_workflow_transitions: transitions
    })
    conditions.fetchRecordForConditions.mockImplementation(async (_c: string, item: string) => {
      if (item === '2') throw new Error('record read failed')
      return {}
    })
    conditions.evaluateTransitionRequirements.mockImplementation(
      async (_db: unknown, _r: unknown, item: string) => {
        if (item === '3') throw new Error('requirements read failed')
        return []
      }
    )
    const reqs = await requirementBlockers('workflows', ['1', '2', '3'])
    expect(reqs.get('2')).toBeNull()
    expect(reqs.get('3')).toBeNull()
    const out = assembleReadiness(['1', '2', '3'], new Map(), reqs)
    expect(Object.keys(out)).toEqual(['1'])
    expect(out['1']).toEqual({ ready: true, blockers: [] })
  })

  it('fails the whole lookup when a read covering every record fails', async () => {
    fakeDb(
      {
        nivaro_workflow_instances: instances,
        nivaro_workflow_states: states,
        nivaro_workflow_transitions: transitions
      },
      ['nivaro_workflow_transitions']
    )
    conditions.fetchRecordForConditions.mockResolvedValue({})
    conditions.evaluateTransitionRequirements.mockResolvedValue([])
    await expect(requirementBlockers('workflows', ['1', '2', '3'])).rejects.toThrow('read failed')
  })
})

describe('fieldBlockers', () => {
  const required = [{ field: 'vendor', label: 'Vendor', required: true }]

  it('answers when every read succeeds', async () => {
    fakeDb({
      nivaro_fields: required,
      nivaro_collection_layouts: [],
      'information_schema.columns': [{ column_name: 'id' }, { column_name: 'vendor' }],
      nivaro_relations: [],
      workflows: [
        { id: 1, vendor: null },
        { id: 2, vendor: 5 }
      ]
    })
    const out = await fieldBlockers('workflows', ['1', '2'])
    expect(out.get('1')?.[0]?.field).toBe('vendor')
    expect(out.get('2')).toBeUndefined()
  })

  // Two grouped layouts a record can open: the active default and a slugged
  // variant (the CAR / PUB case) that has no vendor at all.
  const twoLayouts = [
    { id: 1, name: 'Default', is_active: true, slug: null, create_hidden: false },
    { id: 2, name: 'PUB', is_active: false, slug: 'pub', create_hidden: false }
  ]
  const base = {
    nivaro_fields: required,
    nivaro_collection_layouts: twoLayouts,
    'information_schema.columns': [{ column_name: 'id' }, { column_name: 'vendor' }],
    nivaro_relations: [],
    workflows: [{ id: 1, vendor: null }]
  }

  it('a field required on one layout but absent from another is not a blocker', async () => {
    fakeDb({
      ...base,
      nivaro_layout_field_assignments: [
        { layout_id: 1, field: 'vendor', label_override: null, overrides: null, is_visible: true }
      ]
    })
    const out = await fieldBlockers('workflows', ['1'])
    expect(out.get('1')).toBeUndefined()
  })

  it('a field required on every reachable layout is a blocker', async () => {
    fakeDb({
      ...base,
      nivaro_layout_field_assignments: [
        { layout_id: 1, field: 'vendor', label_override: null, overrides: null, is_visible: true },
        {
          layout_id: 2,
          field: 'vendor',
          label_override: null,
          overrides: '{"label":"Supplier"}',
          is_visible: true
        }
      ]
    })
    const out = await fieldBlockers('workflows', ['1'])
    expect(out.get('1')?.map((b) => b.message)).toEqual(['Vendor is required'])
  })

  it('a layout that makes the field optional unbinds it', async () => {
    fakeDb({
      ...base,
      nivaro_layout_field_assignments: [
        { layout_id: 1, field: 'vendor', label_override: null, overrides: null, is_visible: true },
        {
          layout_id: 2,
          field: 'vendor',
          label_override: null,
          overrides: '{"required":false}',
          is_visible: true
        }
      ]
    })
    const out = await fieldBlockers('workflows', ['1'])
    expect(out.get('1')).toBeUndefined()
  })

  it('an unreachable layout (inactive, no slug) does not gate the check', async () => {
    fakeDb({
      ...base,
      nivaro_collection_layouts: [
        twoLayouts[0],
        { id: 3, name: 'Old', is_active: false, slug: null, create_hidden: false }
      ],
      nivaro_layout_field_assignments: [
        { layout_id: 1, field: 'vendor', label_override: null, overrides: null, is_visible: true }
      ]
    })
    const out = await fieldBlockers('workflows', ['1'])
    expect(out.get('1')?.[0]?.field).toBe('vendor')
  })

  it.each([
    'nivaro_fields',
    'nivaro_collection_layouts',
    'information_schema.columns',
    'nivaro_relations',
    'workflows'
  ])('rejects instead of answering "no blockers" when %s cannot be read', async (table) => {
    fakeDb(
      {
        nivaro_fields: required,
        nivaro_collection_layouts: [],
        'information_schema.columns': [{ column_name: 'id' }, { column_name: 'vendor' }],
        nivaro_relations: [],
        workflows: [{ id: 1, vendor: null }]
      },
      [table]
    )
    await expect(fieldBlockers('workflows', ['1'])).rejects.toThrow('read failed')
  })
})

describe('tallyCollection', () => {
  it('counts breaches with the SLA reader it is handed, never its own import', async () => {
    const instances = [
      { id: 'I1', item: '1', current_state: 'S', template: 'T', started_at: new Date() },
      { id: 'I2', item: '2', current_state: 'S', template: 'T', started_at: new Date() }
    ]
    vi.mocked(db).mockImplementation(((table: string) => {
      const rows = table.startsWith('nivaro_workflow_instances') ? instances : []
      const chain: Record<string, unknown> = {}
      for (const m of ['where', 'whereNull', 'whereNotNull', 'orderBy', 'limit', 'select'])
        chain[m] = () => chain
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej)
      return chain
    }) as never)
    const scopes = {
      applyScopeEnforcement: () => {},
      resolveRecordDimensionIds: async (_c: string, ids: string[]) =>
        new Map(ids.map((id) => [id, ['z1']]))
    } as never
    const computeStatusBatch = vi.fn(async () => ({
      '1': { status: 'breached' },
      '2': { status: 'ok' }
    })) as never
    const tally = await tallyCollection(
      scopes,
      'tally_probe',
      [],
      `tally-probe|${Math.random()}`,
      { filters: [], deny: false },
      computeStatusBatch
    )
    expect(computeStatusBatch).toHaveBeenCalledTimes(1)
    expect(tally.open.get('Z1')).toBe(2)
    expect(tally.breached.get('Z1')).toBe(1)
  })
})
