import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { activityLabelsFor, type LabelDeps } from '../../../services/activity-readable.js'
import { valueText } from '../../../services/activity-sentence.js'
import { numberKindOf } from '../../../services/number-kind.js'
import type { User } from '../../../types.js'

const API_TWIN = fileURLToPath(new URL('../../../services/number-kind.ts', import.meta.url))
const SHARED_TWIN = fileURLToPath(
  new URL('../../../../../packages/shared/src/lib/number-kind.ts', import.meta.url)
)

describe('number-kind twin', () => {
  it('is byte-identical to the packages/shared twin', () => {
    expect(readFileSync(API_TWIN, 'utf8')).toBe(readFileSync(SHARED_TWIN, 'utf8'))
  })
  it('keeps references plain and groups counts', () => {
    expect(numberKindOf({ field: 'po_number', type: 'integer' })).toBe('plain')
    expect(numberKindOf({ field: 'year', type: 'integer' })).toBe('plain')
    expect(numberKindOf({ field: 'quantity', type: 'integer' })).toBe('count')
    expect(
      numberKindOf({ field: 'amount', type: 'decimal', options: { format: 'currency' } })
    ).toBe('money')
  })
})

describe('activity labels: number formats', () => {
  const reader = { id: 'AAAAAAAA-0000-0000-0000-000000000001' } as unknown as User
  const deps: LabelDeps = {
    canRead: vi.fn(async () => true),
    visibleIds: vi.fn(async (_u: User, _c: string, ids: string[]) => new Set(ids)),
    recordLabels: vi.fn(async () => ({ 'invoices:1': 'INV-1' })),
    people: vi.fn(async () => []),
    collections: vi.fn(async () => [
      { collection: 'invoices', display_name: 'Invoices', singular: 'Invoice' }
    ]),
    fields: vi.fn(async () => [
      {
        collection: 'invoices',
        field: 'amount',
        label: 'Amount',
        options: JSON.stringify({ format: 'currency' }),
        type: 'decimal',
        interface: 'input'
      },
      {
        collection: 'invoices',
        field: 'quantity',
        label: 'Quantity',
        options: null,
        type: 'integer'
      },
      { collection: 'invoices', field: 'po_number', label: 'PO', options: null, type: 'integer' }
    ]),
    links: vi.fn(async () => [])
  }

  it('sends money / count formats and leaves references out', async () => {
    const labels = await activityLabelsFor(
      reader,
      {
        refs: [{ collection: 'invoices', id: '1' }],
        users: [],
        fields: [
          { collection: 'invoices', field: 'amount' },
          { collection: 'invoices', field: 'quantity' },
          { collection: 'invoices', field: 'po_number' }
        ],
        collections: ['invoices']
      },
      {},
      deps
    )
    expect(labels.numbers?.['invoices.amount']).toEqual({ kind: 'money', currency: 'USD' })
    expect(labels.numbers?.['invoices.quantity']).toEqual({ kind: 'count' })
    expect(labels.numbers?.['invoices.po_number']).toBeUndefined()

    expect(valueText('invoices', 'amount', '12345.67', labels)).toBe('$12,345.67')
    expect(valueText('invoices', 'amount', 15000, labels)).toBe('$15,000.00')
    expect(valueText('invoices', 'quantity', 12345, labels)).toBe('12,345')
    expect(valueText('invoices', 'po_number', 4500123, labels)).toBe('4500123')
  })
})
