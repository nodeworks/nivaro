import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 2026-10-25: POST /field-rules/evaluate {trigger_field, trigger_value} read the
// trigger's related record raw, so any chosen id disclosed the rule's source field. With a
// non-admin caller the record (and set_lookup rows) are read as them: hidden = no value.

const state = vi.hoisted(() => ({ visible: true, raw: [] as string[] }))

vi.mock('../../../services/items.js', () => ({
  getActualColumns: vi.fn(async () => new Set(['id', 'org_code'])),
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) =>
    state.visible ? { id, org_code: 'CALLER' } : null
  ),
  readItems: vi.fn(async () => ({ data: state.visible ? [{ code: 'CALLER' }] : [] }))
}))

function rawDb() {
  const db: any = (table: string) => {
    state.raw.push(table)
    const b: any = {}
    for (const m of ['where', 'whereNull', 'whereIn', 'select', 'limit']) b[m] = () => b
    b.first = async () =>
      table === 'nivaro_relations' ? { one_collection: 'vendors' } : { id: 7, org_code: 'RAW' }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    b.then = (res: (v: unknown) => unknown) => Promise.resolve([{ code: 'RAW' }]).then(res)
    return b
  }
  return db
}

import { evaluateRuleRows, type FieldRuleRow } from '../../../services/field-rules.js'

const fromTrigger = {
  id: 1,
  collection: 'workflows',
  trigger_field: 'vendor',
  trigger_op: 'nnull',
  trigger_value: null,
  target_field: 'org_code',
  target_type: 'set_from_trigger',
  target_value: null,
  only_when_empty: false,
  dynamic_config: JSON.stringify({ field: 'org_code' })
} as unknown as FieldRuleRow
const lookup = {
  ...fromTrigger,
  id: 2,
  target_field: 'code',
  target_type: 'set_lookup',
  dynamic_config: JSON.stringify({
    collection: 'vendor_codes',
    filter_field: 'vendor',
    filter_op: 'eq',
    select: 'code'
  })
} as unknown as FieldRuleRow

const run = (rule: FieldRuleRow, caller?: { user: never; isAdmin?: boolean }) =>
  evaluateRuleRows(
    rawDb(),
    'workflows_unknown',
    'vendor',
    7,
    {},
    [rule],
    { warn: () => {} },
    caller
  )

beforeEach(() => {
  state.visible = true
  state.raw = []
})

describe('trigger rules as the caller', () => {
  const user = { id: 'PAUL', role: 'R' } as never

  it('a related record the caller cannot open yields no value', async () => {
    state.visible = false
    expect(await run(fromTrigger, { user })).toEqual({})
    expect(await run(lookup, { user })).toEqual({ code: [] })
    expect(state.raw).not.toContain('vendors')
    expect(state.raw).not.toContain('vendor_codes')
  })

  it('a record the caller can open fills from their view of it', async () => {
    expect(await run(fromTrigger, { user })).toEqual({ org_code: 'CALLER' })
    expect(await run(lookup, { user })).toEqual({ code: ['CALLER'] })
  })

  it('an admin (or an internal write) reads as before', async () => {
    expect(await run(fromTrigger, { user, isAdmin: true })).toEqual({ org_code: 'RAW' })
    expect(await run(fromTrigger)).toEqual({ org_code: 'RAW' })
  })
})
