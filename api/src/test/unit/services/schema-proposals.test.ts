import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))

const { checkChanges, describeChanges, normalizeChanges, planApply, SchemaProposalError } =
  await import('../../../services/schema-proposals.js')
type Facts = Parameters<typeof checkChanges>[1]

const facts = (): Facts => ({
  collections: new Map([
    ['work_orders', { name: 'work_orders', display: 'Work orders', registered: true }]
  ]),
  fields: new Set(['work_orders.id', 'work_orders.title', 'work_orders.status']),
  meta: new Map([
    ['work_orders.status', { label: 'Status', interface: 'input', options: '{"placeholder":"…"}' }],
    ['work_orders.title', { label: null, interface: null, options: null }]
  ])
})

describe('normalizeChanges', () => {
  it('keeps the known shape and cleans text', () => {
    const [c] = normalizeChanges([
      {
        kind: 'add_field',
        collection: 'work_orders',
        field: 'priority',
        label: '  Priority\u0007 ',
        choices: ['low', { value: 'high', text: 'High' }, 'low'],
        extra: 'dropped'
      }
    ])
    expect(c).toEqual({
      kind: 'add_field',
      collection: 'work_orders',
      field: 'priority',
      type: 'string',
      label: 'Priority',
      choices: [
        { value: 'low', text: 'low' },
        { value: 'high', text: 'High' }
      ]
    })
  })

  it('refuses system collections, bad names, reserved fields and destructive kinds', () => {
    expect(() =>
      normalizeChanges([{ kind: 'add_field', collection: 'nivaro_users', field: 'x' }])
    ).toThrow(/system collections/)
    expect(() =>
      normalizeChanges([{ kind: 'add_field', collection: 'work orders', field: 'x' }])
    ).toThrow(/collection name/)
    expect(() =>
      normalizeChanges([{ kind: 'add_field', collection: 'work_orders', field: 'id' }])
    ).toThrow(/reserved/)
    expect(() =>
      normalizeChanges([{ kind: 'drop_field', collection: 'work_orders', field: 'title' }])
    ).toThrow(/done by a person/)
    try {
      normalizeChanges([
        { kind: 'add_field', collection: 'work_orders', field: 'ok' },
        { kind: 'add_field', collection: 'work_orders', field: 'b', type: 'json' }
      ])
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaProposalError)
      expect((err as InstanceType<typeof SchemaProposalError>).change_index).toBe(1)
    }
  })

  it('needs an update to change something, and choices on a string or integer field', () => {
    expect(() =>
      normalizeChanges([{ kind: 'update_field', collection: 'work_orders', field: 'title' }])
    ).toThrow(/say what changes/)
    expect(() =>
      normalizeChanges([
        { kind: 'add_field', collection: 'work_orders', field: 'f', type: 'date', choices: ['a'] }
      ])
    ).toThrow(/string or integer/)
  })
})

describe('checkChanges', () => {
  it('judges against the database as it is, counting collections the proposal adds', () => {
    const changes = normalizeChanges([
      {
        kind: 'add_collection',
        collection: 'site_visits',
        fields: [{ field: 'visited_on', type: 'date' }]
      },
      { kind: 'add_field', collection: 'site_visits', field: 'notes', type: 'text' },
      { kind: 'update_field', collection: 'work_orders', field: 'status', label: 'Stage' }
    ])
    expect(() => checkChanges(changes, facts())).not.toThrow()
  })

  it('refuses a field that exists, an unknown collection and an unregistered field', () => {
    expect(() =>
      checkChanges(
        normalizeChanges([{ kind: 'add_field', collection: 'work_orders', field: 'title' }]),
        facts()
      )
    ).toThrow(/already has a field title/)
    expect(() =>
      checkChanges(
        normalizeChanges([{ kind: 'add_field', collection: 'invoices', field: 'x' }]),
        facts()
      )
    ).toThrow(/was not found/)
    expect(() =>
      checkChanges(
        normalizeChanges([
          { kind: 'update_field', collection: 'work_orders', field: 'nope', label: 'N' }
        ]),
        facts()
      )
    ).toThrow(/no registered field/)
  })

  it('hides collections the proposer cannot read', () => {
    const changes = normalizeChanges([{ kind: 'add_field', collection: 'work_orders', field: 'x' }])
    expect(() => checkChanges(changes, facts(), () => false)).toThrow(/was not found/)
  })
})

describe('describeChanges + planApply', () => {
  const changes = normalizeChanges([
    {
      kind: 'add_field',
      collection: 'work_orders',
      field: 'priority',
      label: 'Priority',
      choices: ['low', 'high'],
      required: true
    },
    {
      kind: 'update_field',
      collection: 'work_orders',
      field: 'status',
      label: 'Stage',
      choices: ['open', 'closed']
    }
  ])

  it('reads in plain words', () => {
    expect(describeChanges(changes, facts())).toEqual([
      'Add field “Priority” (priority, string, 2 choices, required) to Work orders',
      'Change Work orders.status: label “Status” → “Stage”, 2 choices'
    ])
  })

  it('plans the same Data Model calls a person makes, keeping existing options', () => {
    const steps = planApply(changes, facts())
    expect(steps.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /api/data-model/tables/work_orders/columns',
      'POST /api/data-model/tables/work_orders/fields',
      'PATCH /api/field-config/work_orders/priority',
      'PATCH /api/field-config/work_orders/status'
    ])
    expect(steps[0].body).toEqual({ name: 'priority', type: 'string', nullable: true })
    expect(steps[0].skip_if).toEqual({ table: 'work_orders', field: 'priority' })
    expect(JSON.parse(String(steps[1].body.options))).toEqual({
      choices: [
        { text: 'low', value: 'low' },
        { text: 'high', value: 'high' }
      ]
    })
    expect(steps[3].body.interface).toBe('select-dropdown')
    expect(JSON.parse(String(steps[3].body.options))).toEqual({
      placeholder: '…',
      choices: [
        { text: 'open', value: 'open' },
        { text: 'closed', value: 'closed' }
      ]
    })
  })
})
