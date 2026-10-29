import { describe, expect, it, vi } from 'vitest'

/**
 * build_filter (#3211): the checker runs the SERVER's filter gates (filterCheckerFor) clause by
 * clause. Here the gates are a stand-in compiler that refuses the way the real one does, so
 * what is tested is the splitting, the type / choice checks, the fixes and the suggestion.
 */
const FIELDS: Record<string, Array<Record<string, unknown>>> = {
  orders: [
    { field: 'id', type: 'integer' },
    {
      field: 'status',
      type: 'string',
      label: 'Status',
      options: {
        choices: [
          { text: 'Open', value: 'open' },
          { text: 'Closed', value: 'closed' }
        ]
      }
    },
    { field: 'amount', type: 'decimal' },
    { field: 'due_on', type: 'date' },
    { field: 'is_rush', type: 'boolean' },
    { field: 'owner', type: 'uuid' }
  ],
  nivaro_users: [
    { field: 'id', type: 'uuid' },
    { field: 'last_name', type: 'string', label: 'Last name' }
  ]
}
const OPS = new Set([
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_in',
  '_nin',
  '_null',
  '_nnull',
  '_contains',
  '_ncontains',
  '_icontains',
  '_starts_with',
  '_nstarts_with',
  '_ends_with',
  '_nends_with',
  '_empty',
  '_nempty',
  '_between',
  '_nbetween'
])

const refusal = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { statusCode: 400, code, ...extra })

/** A tiny compiler with the real one's refusals: unknown field / operator / path. */
function compile(filter: Record<string, unknown>, collection = 'orders'): void {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') {
      for (const c of value as Array<Record<string, unknown>>) compile(c, collection)
      continue
    }
    const names = FIELDS[collection].map((f) => f.field)
    if (!names.includes(key))
      throw refusal('UNKNOWN_FIELD', `${collection} has no field "${key}"`, { fields: [key] })
    const ops = value as Record<string, unknown>
    if (key === 'owner' && Object.keys(ops).some((k) => !k.startsWith('_'))) {
      compile(ops, 'nivaro_users')
      continue
    }
    for (const op of Object.keys(ops)) {
      if (!op.startsWith('_'))
        throw refusal('FILTER_PATH_UNSUPPORTED', `"${key}" does not link to another record`)
      if (!OPS.has(op))
        throw refusal('FILTER_OPERATOR_UNKNOWN', `"${op}" is not a filter operator`, {
          operator: op
        })
      if ((op === '_in' || op === '_nin') && !Array.isArray(ops[op]))
        throw refusal('FILTER_VALUE_INVALID', `"${op}" takes a list`)
    }
  }
}

vi.mock('../../../services/items.js', () => ({
  FILTER_OPS: OPS,
  filterCheckerFor: vi.fn(async () => async (f: Record<string, unknown>) => compile(f)),
  resolveFilterPath: vi.fn(async (_c: string, segs: string[]) => {
    // Like the real resolver: hops are followed, the last segment is not judged.
    if (segs[0] === 'owner' && segs.length === 2)
      return { collection: 'nivaro_users', field: segs[1], link: false }
    if (segs.length === 1) return { collection: 'orders', field: segs[0], link: false }
    return null
  })
}))
vi.mock('../../../services/collections.js', () => ({
  getFields: vi.fn(async (c: string) => FIELDS[c] ?? [])
}))

const { checkFilter, splitFilter, nearestOperator, nearestField, applyFixes, lintClause } =
  await import('../../../services/filter-check.js')

const user = { id: 'u1' } as never

describe('splitFilter', () => {
  it('cuts a filter into one clause per operator, kept inside its group and relation', () => {
    const clauses = splitFilter({
      status: { _eq: 'open', _neq: 'x' },
      _or: [{ amount: { _gt: 5 } }, { owner: { last_name: { _contains: 'Lee' } } }]
    })
    expect(clauses.map((c) => c.ptr)).toEqual([
      ['status', '_eq'],
      ['status', '_neq'],
      ['_or', 0, 'amount', '_gt'],
      ['_or', 1, 'owner', 'last_name', '_contains']
    ])
    expect(clauses[3].filter).toEqual({ _or: [{ owner: { last_name: { _contains: 'Lee' } } }] })
  })
})

describe('spelling', () => {
  it('maps the operators people reach for onto the API spelling', () => {
    expect(nearestOperator('eq')).toBe('_eq')
    expect(nearestOperator('_like')).toBe('_contains')
    expect(nearestOperator('_not_in')).toBe('_nin')
    expect(nearestOperator('_contians')).toBe('_contains')
    expect(nearestOperator('_whatever_this_is')).toBeNull()
  })

  it('finds the field by name, label or close spelling, and refuses to guess between two', () => {
    const fields = [
      { field: 'status', label: 'Status' },
      { field: 'due_on', label: 'Due date' },
      { field: 'stat_a' },
      { field: 'stat_b' }
    ]
    expect(nearestField('stauts', fields)).toBe('status')
    expect(nearestField('Due date', fields)).toBe('due_on')
    expect(nearestField('stat_c', fields)).toBeNull()
  })

  it('applies renames in place, keeping key order', () => {
    const out = applyFixes({ a: 1, stauts: { _like: 'x' }, z: 2 }, [
      { ptr: ['stauts', '_like'], rename: '_contains' },
      { ptr: ['stauts'], rename: 'status' }
    ])
    expect(Object.keys(out)).toEqual(['a', 'status', 'z'])
    expect(out.status).toEqual({ _contains: 'x' })
  })
})

describe('lintClause', () => {
  const field = (type: string, options: Record<string, unknown> | null = null) => ({
    field: 'f',
    type,
    options
  })
  it('names a text operator on a number and a range on a yes/no field', () => {
    expect(lintClause('amount', '_contains', '5', field('decimal'))[0].problem.code).toBe(
      'FILTER_OPERATOR_TYPE'
    )
    expect(lintClause('is_rush', '_gt', 1, field('boolean'))[0].problem.code).toBe(
      'FILTER_OPERATOR_TYPE'
    )
  })
  it('names values that can never match the type', () => {
    expect(lintClause('amount', '_eq', 'lots', field('decimal'))[0].problem.code).toBe(
      'FILTER_VALUE_TYPE'
    )
    expect(lintClause('owner', '_eq', 'Rob', field('uuid'))[0].problem.code).toBe(
      'FILTER_VALUE_TYPE'
    )
    expect(lintClause('due_on', '_gte', '$NOW(-7 days)', field('date'))).toEqual([])
    expect(lintClause('due_on', '_gte', 'last week', field('date'))[0].severity).toBe('error')
  })
})

describe('checkFilter', () => {
  it('passes a good filter', async () => {
    const r = await checkFilter(user, 'orders', {
      status: { _in: ['open', 'closed'] },
      amount: { _gte: 10 }
    })
    expect(r).toMatchObject({ ok: true, errors: [], warnings: [], suggestion: null, clauses: 2 })
  })

  it('names every problem, not just the first, and suggests a fixed filter', async () => {
    const r = await checkFilter(user, 'orders', {
      stauts: { _eq: 'open' },
      amount: { _like: '5' },
      owner: { last_nmae: { _contains: 'Lee' } }
    })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => [e.path, e.code])).toEqual([
      ['stauts', 'UNKNOWN_FIELD'],
      ['amount', 'FILTER_OPERATOR_UNKNOWN'],
      ['owner.last_nmae', 'UNKNOWN_FIELD']
    ])
    expect(r.errors[0].fix).toBe('did you mean "status"?')
    // _like → _contains compiles, but a number never "contains": the next round of checks
    // turns it into _eq, and only the clean result is offered.
    expect(r.suggestion).toEqual({
      status: { _eq: 'open' },
      amount: { _eq: '5' },
      owner: { last_name: { _contains: 'Lee' } }
    })
  })

  it('turns a choice label into the stored value', async () => {
    const r = await checkFilter(user, 'orders', { status: { _eq: 'Open' } })
    expect(r.errors).toEqual([
      expect.objectContaining({ path: 'status', code: 'FILTER_VALUE_IS_LABEL' })
    ])
    expect(r.suggestion).toEqual({ status: { _eq: 'open' } })
  })

  it('a value outside the choices has no fix, so no suggestion', async () => {
    const r = await checkFilter(user, 'orders', { status: { _eq: 'pending' } })
    expect(r.errors[0]).toMatchObject({ code: 'FILTER_VALUE_NOT_A_CHOICE' })
    expect(r.errors[0].message).toContain('open (Open)')
    expect(r.suggestion).toBeNull()
  })

  it('wraps a single _in value in a list and fixes a missing underscore', async () => {
    const r = await checkFilter(user, 'orders', {
      status: { _in: 'open,closed' },
      amount: { gt: 3 }
    })
    expect(r.errors.map((e) => e.code)).toEqual(['FILTER_VALUE_INVALID', 'FILTER_PATH_UNSUPPORTED'])
    expect(r.suggestion).toEqual({ status: { _in: ['open', 'closed'] }, amount: { _gt: 3 } })
  })

  it('a filter that is not an object is one plain error', async () => {
    const r = await checkFilter(user, 'orders', ['status'])
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'FILTER_NOT_AN_OBJECT' }] })
  })
})
