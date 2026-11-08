import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const meta = vi.hoisted(() => ({ fields: [] as Array<Record<string, unknown>> }))
vi.mock('../../../services/collections.js', () => ({ getFields: async () => meta.fields }))
vi.mock('../../../extensions/validators.js', () => ({
  validatorRegistry: { has: () => false, run: () => null }
}))

import { applyValidationRule, enforceValidationRules } from '../../../services/validation-rules.js'

const END = { type: 'gte_field', field: 'service_start_date' }

describe('gte_field / lte_field', () => {
  it('compares dates as calendar days and passes when either side is empty', () => {
    const rec = (start: unknown) => ({ service_start_date: start })
    expect(applyValidationRule(END, '2020-01-01', 'End', rec('2026-05-01'))).toBe(
      'End must be on or after service start date'
    )
    expect(applyValidationRule(END, '2026-05-01', 'End', rec('2026-05-01T23:00:00Z'))).toBeNull()
    expect(
      applyValidationRule(END, new Date('2026-05-02T00:00:00Z'), 'End', rec('2026-05-01'))
    ).toBeNull()
    expect(applyValidationRule(END, '', 'End', rec('2026-05-01'))).toBeNull()
    expect(applyValidationRule(END, '2020-01-01', 'End', rec(null))).toBeNull()
    expect(applyValidationRule(END, '2020-01-01', 'End', undefined)).toBeNull()
  })

  it('compares numbers numerically, uses the message, and has an lte twin', () => {
    const r = { type: 'gte_field', field: 'min_qty', message: 'Too few' }
    expect(applyValidationRule(r, '9', 'Max', { min_qty: 10 })).toBe('Too few')
    expect(applyValidationRule(r, '10', 'Max', { min_qty: 9 })).toBeNull()
    const lte = { type: 'lte_field', field: 'service_end_date' }
    expect(
      applyValidationRule(lte, '2026-06-01', 'Start', { service_end_date: '2026-05-01' })
    ).toBe('Start must be on or before service end date')
    expect(applyValidationRule(r, 'abc', 'Max', { min_qty: 'xyz' })).toBeNull()
  })

  it('is the same helper as the shared evaluator', () => {
    const cut = (path: string) => {
      const s = readFileSync(new URL(path, import.meta.url), 'utf8')
      return s.slice(
        s.indexOf('function crossFieldOrder'),
        s.indexOf('export function applyValidationRule')
      )
    }
    const api = cut('../../../services/validation-rules.ts')
    const shared = cut('../../../../../packages/shared/src/lib/validation-rules.ts')
    expect(api.length).toBeGreaterThan(200)
    expect(api).toBe(shared.slice(0, api.length))
  })
})

describe('enforceValidationRules with a cross-field rule', () => {
  beforeEach(() => {
    meta.fields = [
      { field: 'service_start_date' },
      { field: 'service_end_date', validation_rules: JSON.stringify([END]) }
    ]
  })
  const stored = { service_start_date: '2026-05-01', service_end_date: '2026-06-01' }

  it('judges an update of one side against the stored other', async () => {
    await expect(
      enforceValidationRules(
        'workflows',
        { service_end_date: '2020-01-01' },
        new Set(['service_end_date']),
        stored
      )
    ).rejects.toMatchObject({ statusCode: 400, field: 'service_end_date', rule: 'gte_field' })
    // Moving only the START past the stored end is refused on the end field.
    await expect(
      enforceValidationRules(
        'workflows',
        { service_start_date: '2026-07-01' },
        new Set(['service_start_date']),
        stored
      )
    ).rejects.toMatchObject({ field: 'service_end_date' })
    await expect(
      enforceValidationRules(
        'workflows',
        { service_start_date: '2026-05-15' },
        new Set(['service_start_date']),
        stored
      )
    ).resolves.toBeUndefined()
  })

  it('never judges a stored field the patch did not touch', async () => {
    meta.fields = [
      { field: 'qty', validation_rules: JSON.stringify([{ type: 'min', value: 5 }]) },
      {
        field: 'reason',
        validation_rules: JSON.stringify([
          { type: 'required_if', field: 'on_hold', op: 'eq', value: true }
        ])
      },
      { field: 'note' },
      { field: 'service_start_date' },
      { field: 'service_end_date', validation_rules: JSON.stringify([END]) }
    ]
    // A legacy row breaking all three rules; the edit touches only `note`.
    const legacy = {
      qty: 1,
      reason: null,
      on_hold: true,
      service_start_date: '2026-05-01',
      service_end_date: '2020-01-01'
    }
    await expect(
      enforceValidationRules('workflows', { note: 'hi' }, new Set(['note']), legacy)
    ).resolves.toBeUndefined()
  })

  it('judges a create on its own payload', async () => {
    await expect(
      enforceValidationRules(
        'workflows',
        { service_start_date: '9999-12-31', service_end_date: '2020-01-01' },
        new Set(['service_start_date', 'service_end_date'])
      )
    ).rejects.toMatchObject({ rule: 'gte_field' })
  })
})

describe('enforceValidationRules and soft (warning-only) rules — army4 a01-5', () => {
  it('a soft rule never refuses the write; a hard rule beside it still does', async () => {
    meta.fields = [
      {
        field: 'qty',
        validation_rules: JSON.stringify([
          { type: 'min', value: 5, soft: true, message: 'Low — check it' },
          { type: 'max', value: 100 }
        ])
      }
    ]
    await expect(
      enforceValidationRules('workflows', { qty: 2 }, new Set(['qty']))
    ).resolves.toBeUndefined()
    await expect(
      enforceValidationRules('workflows', { qty: 200 }, new Set(['qty']))
    ).rejects.toMatchObject({ field: 'qty', rule: 'max' })
  })
})

// Army 9 b02: a BOM upload sent quantity 2.5 to the integer column; SQL Server
// stored 2 while the write-computed total kept 2.5 × price.
describe('whole-number fields refuse a fraction (army 9 b02)', () => {
  it('refuses a fractional value the caller sent, never truncates', async () => {
    meta.fields = [
      { field: 'quantity', type: 'integer' },
      { field: 'price', type: 'decimal' },
      { field: 'total', type: 'integer' }
    ]
    await expect(
      enforceValidationRules(
        'inventory_request_materials',
        { quantity: 2.5 },
        new Set(['quantity'])
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      field: 'quantity',
      rule: 'integer',
      message: 'Quantity must be a whole number (2.5 was sent)'
    })
    await expect(
      enforceValidationRules(
        'inventory_request_materials',
        { quantity: '1.5' },
        new Set(['quantity'])
      )
    ).rejects.toMatchObject({ field: 'quantity' })
    // bigint and biginteger are both whole-number types (review L7).
    for (const type of ['bigint', 'biginteger']) {
      meta.fields = [{ field: 'units', type }]
      await expect(
        enforceValidationRules('stock', { units: 7.25 }, new Set(['units']))
      ).rejects.toMatchObject({ field: 'units', rule: 'integer' })
    }
  })

  it('lets whole numbers, decimals on decimal fields, blanks and derived values through', async () => {
    meta.fields = [
      { field: 'quantity', type: 'integer', label: 'Qty' },
      { field: 'price', type: 'decimal' },
      { field: 'total', type: 'integer' }
    ]
    for (const quantity of [2, '3', '4.0', null, '']) {
      await expect(
        enforceValidationRules(
          'inventory_request_materials',
          { quantity, price: 0.07 },
          new Set(['quantity', 'price'])
        )
      ).resolves.toBeUndefined()
    }
    // Float noise from arithmetic is a whole number, stored rounded.
    const noisy: Record<string, unknown> = { quantity: 0.1 * 3 * 10 }
    await expect(
      enforceValidationRules('inventory_request_materials', noisy, new Set(['quantity']))
    ).resolves.toBeUndefined()
    expect(noisy.quantity).toBe(3)
    // A field the caller did not send (a write-computed one) is not judged here.
    await expect(
      enforceValidationRules(
        'inventory_request_materials',
        { quantity: 2, total: 0.14 },
        new Set(['quantity'])
      )
    ).resolves.toBeUndefined()
  })
})
