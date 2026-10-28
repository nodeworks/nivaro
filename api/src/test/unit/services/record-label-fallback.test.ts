import { describe, expect, it } from 'vitest'
import {
  businessIdOf,
  collectionTitle,
  isPkLabel,
  safeRecordLabel
} from '../../../services/record-label-fallback.js'
import {
  recordLabelsAsViewer,
  type ViewerLabelDeps
} from '../../../services/record-labels-as-viewer.js'
import type { User } from '../../../types.js'

// Search must never show a record's primary key (Rob 2026-10-28: pinned
// "Workflow 370973", recent "Inventory Request #32828").

describe('isPkLabel', () => {
  it('spots the shapes the old fallbacks built', () => {
    expect(isPkLabel('', 1)).toBe(true)
    expect(isPkLabel(null, 1)).toBe(true)
    expect(isPkLabel('32832', 32832)).toBe(true)
    expect(isPkLabel('#985', '985')).toBe(true)
    expect(isPkLabel('Inventory Request 32832', 32832, ['inventory_request'])).toBe(true)
    expect(isPkLabel('Inventory Request #32828', 32828, ['inventory_request'])).toBe(true)
    expect(isPkLabel('Cifa Items #39767', 39767, ['cifa_items'])).toBe(true)
    // Plural key, singular label: "workflows" → "Workflow 370973".
    expect(isPkLabel('Workflow 370973', 370973, ['workflows'])).toBe(true)
  })

  it('keeps real labels, business ids and names that merely end in the number', () => {
    expect(isPkLabel('MM26INV-32440', 32440, ['inventory_request'])).toBe(false)
    expect(isPkLabel('CM26-80394', 80394, ['workflows'])).toBe(false)
    // "Zone 5" is a label unless "Zone" is the collection's name.
    expect(isPkLabel('Zone 5', 5, ['regions'])).toBe(false)
    expect(isPkLabel('Workflow 370973', 1, ['workflows'])).toBe(false)
  })
})

describe('safeRecordLabel', () => {
  it('a pk-only label falls back to a business id, then the collection name', () => {
    const rec = { collection: 'cifa_items', id: 39, display_name: 'Cifa Items' }
    expect(
      safeRecordLabel('39', {
        ...rec,
        row: { id: 39, cifa_number: 'CF-0039' },
        columns: ['cifa_number']
      })
    ).toBe('CF-0039')
    expect(safeRecordLabel('#39', rec)).toBe('Cifa Items')
    expect(safeRecordLabel('', { collection: 'inventory_request', id: 1 })).toBe(
      'Inventory Request'
    )
    expect(safeRecordLabel('MM26INV-1', rec)).toBe('MM26INV-1')
  })

  it('a business id column never yields the pk or a uuid', () => {
    expect(businessIdOf({ id: 5, ref_id: 5 }, ['ref_id'])).toBeNull()
    expect(
      businessIdOf({ id: 5, owner_id: '0f8fad5b-d9cb-469f-a165-70867728950e' }, ['owner_id'])
    ).toBeNull()
    expect(businessIdOf({ id: 5, workflow_id: 'AB26-5' }, ['id', 'workflow_id'])).toBe('AB26-5')
    expect(collectionTitle('cifa_items', '  ')).toBe('Cifa Items')
  })
})

describe('recordLabelsAsViewer', () => {
  const user = { id: 'u-1' } as unknown as User
  const deps = (over: Partial<ViewerLabelDeps> = {}): ViewerLabelDeps => ({
    linkLabels: async () => ({ 'inventory_request:32832': 'MM26INV-32440' }),
    displayNames: async () =>
      new Map([
        ['inventory_request', 'Inventory Request'],
        ['cifa_items', 'Cifa Items']
      ]),
    businessColumns: async (_u, c) => (c === 'cifa_items' ? ['cifa_number'] : []),
    read: async (_u, _c, ids) =>
      ids.filter((i) => i === '39767').map((i) => ({ id: Number(i), cifa_number: 'CF-39767' })),
    ...over
  })

  it('label as the viewer, else a business id, else the collection name — never the pk', async () => {
    const out = await recordLabelsAsViewer(
      user,
      [
        { collection: 'inventory_request', id: '32832' },
        { collection: 'cifa_items', id: '39767' },
        { collection: 'cifa_items', id: '985' },
        { collection: 'workflows', id: '370973' }
      ],
      deps()
    )
    expect(out).toEqual({
      'inventory_request:32832': 'MM26INV-32440',
      'cifa_items:39767': 'CF-39767',
      'cifa_items:985': 'Cifa Items',
      'workflows:370973': 'Workflows'
    })
    for (const [k, v] of Object.entries(out)) expect(isPkLabel(v, k.split(':')[1])).toBe(false)
  })

  it('one read per collection, only for the ones still unlabelled', async () => {
    const reads: Array<{ c: string; ids: string[] }> = []
    await recordLabelsAsViewer(
      user,
      [
        { collection: 'inventory_request', id: '32832' },
        { collection: 'cifa_items', id: '1' },
        { collection: 'cifa_items', id: '2' }
      ],
      deps({
        businessColumns: async () => ['cifa_number'],
        read: async (_u, c, ids) => {
          reads.push({ c, ids })
          return []
        }
      })
    )
    expect(reads).toEqual([{ c: 'cifa_items', ids: ['1', '2'] }])
  })

  it('an unreadable record or a failing read still gets the collection name', async () => {
    const out = await recordLabelsAsViewer(
      user,
      [{ collection: 'cifa_items', id: '39' }],
      deps({
        linkLabels: async () => {
          throw new Error('no')
        },
        read: async () => {
          throw new Error('forbidden')
        }
      })
    )
    expect(out).toEqual({ 'cifa_items:39': 'Cifa Items' })
  })
})
