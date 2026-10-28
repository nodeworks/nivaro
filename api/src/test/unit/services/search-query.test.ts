import { describe, expect, it } from 'vitest'
import {
  type FieldMeta,
  normalizeScopes,
  PEOPLE_SCOPE,
  parseDateAt,
  parseMoney,
  parseSearchQuery,
  planFilters,
  resolveQueryFilters,
  tokenize
} from '../../../services/search-query.js'

// Search program 2026-10-28: the search box's query language (scopes, field
// filters, amounts, dates). Pure parsing + resolution against readable fields.

const SCOPES = { '@': PEOPLE_SCOPE, wf: 'workflows', ir: 'inventory_request' }
const NOW = new Date('2026-10-28T15:00:00Z') // a Wednesday

const WF: FieldMeta[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'status', label: 'Status', type: 'string' },
  { field: 'vendor_name', label: 'Vendor name', type: 'string' },
  { field: 'total_amount', label: 'Total', type: 'decimal' },
  { field: 'quantity', label: 'Qty', type: 'integer' },
  { field: 'date_created', label: 'Created', type: 'datetime' },
  { field: 'due_date', label: 'Due', type: 'date' },
  { field: 'is_priority', label: 'Priority', type: 'boolean' }
]

describe('tokenize', () => {
  it('splits on spaces and keeps quoted phrases whole', () => {
    expect(tokenize('wf: status:"on hold"  canton')).toEqual(['wf:', 'status:on hold', 'canton'])
  })
})

describe('normalizeScopes', () => {
  it('cleans keys and refuses non-identifier targets', () => {
    expect(
      normalizeScopes({ 'WF:': 'workflows', po: 'purchase orders', '@': PEOPLE_SCOPE, '': 'x' })
    ).toEqual({ wf: 'workflows', '@': PEOPLE_SCOPE })
    expect(normalizeScopes('{"ir":"inventory_request"}')).toEqual({ ir: 'inventory_request' })
    expect(normalizeScopes('not json')).toEqual({})
  })
})

describe('parseSearchQuery — scopes', () => {
  it('reads a prefix scope with or without a space', () => {
    expect(parseSearchQuery('wf: canton', SCOPES)).toMatchObject({
      scopeKey: 'wf',
      scope: 'workflows',
      text: 'canton'
    })
    expect(parseSearchQuery('wf:canton grounding', SCOPES)).toMatchObject({
      scope: 'workflows',
      text: 'canton grounding'
    })
  })

  it('@ as the first token means people', () => {
    expect(parseSearchQuery('@jane doe', SCOPES)).toMatchObject({
      scopeKey: '@',
      scope: PEOPLE_SCOPE,
      text: 'jane doe'
    })
  })

  it('an unknown prefix is a field token, not a scope; one scope at most', () => {
    const p = parseSearchQuery('zz:thing', SCOPES)
    expect(p.scope).toBeNull()
    expect(p.fields).toEqual([{ raw: 'zz:thing', key: 'zz', cmp: '', value: 'thing' }])
    const two = parseSearchQuery('wf: ir:x', SCOPES)
    expect(two.scope).toBe('workflows')
    expect(two.fields[0].key).toBe('ir')
  })

  it('leaves a URL alone', () => {
    expect(parseSearchQuery('http://x.test/a', SCOPES).text).toBe('http://x.test/a')
  })
})

describe('parseSearchQuery — filters, amounts, dates', () => {
  it('reads comparisons on field tokens', () => {
    const p = parseSearchQuery('quantity:>=5 total:<10k', SCOPES)
    expect(p.fields.map((f) => [f.key, f.cmp, f.value])).toEqual([
      ['quantity', '>=', '5'],
      ['total', '<', '10k']
    ])
  })

  it('money needs $ or k/m — a bare number stays text (it is an id)', () => {
    expect(parseMoney('$12,500')).toMatchObject({ min: 12500, max: 12500 })
    expect(parseMoney('12.5k')).toMatchObject({ min: 11875, max: 13125 })
    expect(parseMoney('>$10k')).toMatchObject({ cmp: '>=', min: 10000 })
    expect(parseMoney('$1.2m')).toMatchObject({ min: 1_140_000, max: 1_260_000 })
    expect(parseMoney('12500')).toBeNull()
    const p = parseSearchQuery('368808 $12,500', SCOPES)
    expect(p.text).toBe('368808')
    expect(p.money).toHaveLength(1)
  })

  it('dates: month names, ISO months and days, relative ranges', () => {
    const at = (s: string) => parseDateAt(s.split(' '), 0, NOW)
    expect(at('Oct 2026')).toEqual({ start: '2026-10-01', end: '2026-11-01', used: 2 })
    expect(at('september 2026')).toMatchObject({ start: '2026-09-01', end: '2026-10-01' })
    expect(at('2026-10')).toEqual({ start: '2026-10-01', end: '2026-11-01', used: 1 })
    expect(at('2026-02-30')).toBeNull()
    expect(at('last week')).toEqual({ start: '2026-10-19', end: '2026-10-26', used: 2 })
    expect(at('this week')).toMatchObject({ start: '2026-10-26', end: '2026-11-02' })
    expect(at('last month')).toMatchObject({ start: '2026-09-01', end: '2026-10-01' })
    expect(at('today')).toMatchObject({ start: '2026-10-28', end: '2026-10-29' })
    expect(at('marble 2026')).toBeNull()
    const p = parseSearchQuery('wf: canton Oct 2026', SCOPES, NOW)
    expect(p.text).toBe('canton')
    expect(p.dates).toEqual([{ raw: 'Oct 2026', start: '2026-10-01', end: '2026-11-01' }])
  })
})

describe('resolveQueryFilters', () => {
  it('a text field contains, by key or by label slug', () => {
    const p = parseSearchQuery('status:open vendor-name:acme', SCOPES)
    const r = resolveQueryFilters(p, WF, { bare: false })
    expect(r.chips).toEqual([
      { field: 'status', label: 'Status', op: 'contains', value: 'open' },
      { field: 'vendor_name', label: 'Vendor name', op: 'contains', value: 'acme' }
    ])
    expect(r.clauses).toEqual([
      { status: { _contains: 'open' } },
      { vendor_name: { _contains: 'acme' } }
    ])
    expect(r.unresolved).toEqual([])
  })

  it('numbers, booleans and dates take their own operators', () => {
    const p = parseSearchQuery('qty:>5 priority:yes due:2026-10', SCOPES, NOW)
    const r = resolveQueryFilters(p, WF, { bare: false, now: NOW })
    expect(r.clauses).toEqual([
      { quantity: { _gt: 5 } },
      { is_priority: { _eq: true } },
      { due_date: { _gte: '2026-10-01' } },
      { due_date: { _lt: '2026-11-01' } }
    ])
    expect(r.chips.at(-1)).toEqual({
      field: 'due_date',
      label: 'Due',
      op: 'lte',
      value: '2026-10-31'
    })
  })

  it('an unknown field, or a value that does not fit, stays text', () => {
    const p = parseSearchQuery('colour:red qty:lots', SCOPES)
    const r = resolveQueryFilters(p, WF, { bare: false })
    expect(r.clauses).toEqual([])
    expect(r.unresolved).toEqual(['colour:red', 'qty:lots'])
  })

  it('never resolves against a field missing from the readable list', () => {
    const readable = WF.filter((f) => f.field !== 'status')
    const r = resolveQueryFilters(parseSearchQuery('status:open', SCOPES), readable, {
      bare: false
    })
    expect(r.unresolved).toEqual(['status:open'])
  })

  it('bare amounts and dates go to the money / created-date field only when scoped', () => {
    const p = parseSearchQuery('$12,500 last week', SCOPES, NOW)
    const scoped = resolveQueryFilters(p, WF, { bare: true, now: NOW })
    expect(scoped.clauses).toEqual([
      { total_amount: { _eq: 12500 } },
      { date_created: { _gte: '2026-10-19' } },
      { date_created: { _lt: '2026-10-26' } }
    ])
    const unscoped = resolveQueryFilters(p, WF, { bare: false, now: NOW })
    expect(unscoped.clauses).toEqual([])
    expect(unscoped.unresolved).toEqual(['$12,500', 'last week'])
  })

  it('skips an amount when the money field is ambiguous', () => {
    const fields: FieldMeta[] = [
      { field: 'unit_price', type: 'decimal' },
      { field: 'shipping_cost', type: 'decimal' }
    ]
    const r = resolveQueryFilters(parseSearchQuery('$50', SCOPES), fields, { bare: true })
    expect(r.unresolved).toEqual(['$50'])
  })
})

describe('planFilters', () => {
  const metas = new Map<string, FieldMeta[]>([
    ['workflows', WF],
    ['vendors', [{ field: 'name', type: 'string' }]]
  ])

  it('no tokens → no filtering', () => {
    expect(planFilters(parseSearchQuery('canton', SCOPES), metas, { scope: null })).toEqual({
      text: 'canton',
      chips: [],
      targets: null
    })
  })

  it('unscoped: only collections that have the field are searched', () => {
    const plan = planFilters(parseSearchQuery('canton status:open', SCOPES), metas, { scope: null })
    expect(plan.text).toBe('canton')
    expect([...(plan.targets?.keys() ?? [])]).toEqual(['workflows'])
    expect(plan.chips).toHaveLength(1)
  })

  it('unscoped: a token no collection knows is text again, as are bare amounts', () => {
    const plan = planFilters(parseSearchQuery('canton colour:red $5', SCOPES), metas, {
      scope: null
    })
    expect(plan.targets).toBeNull()
    expect(plan.text).toBe('canton colour:red $5')
  })

  it('scoped: everything resolves against the scope', () => {
    const plan = planFilters(parseSearchQuery('wf: $12,500', SCOPES), metas, { scope: 'workflows' })
    expect(plan.text).toBe('')
    expect(plan.targets?.get('workflows')).toEqual([{ total_amount: { _eq: 12500 } }])
  })
})
