import { describe, expect, it } from 'vitest'
import type { GlobalFieldRow, RelationRow } from '../inspector/model'
import { buildSampleRecord, samplePickers, seededRandom } from './sample-record'

// #3196 Sample record generator.

const NOW = new Date('2026-10-29T12:00:00Z')

const FIELDS: GlobalFieldRow[] = [
  { field: 'id', type: 'integer' },
  { field: 'title', type: 'string', label: 'Title' },
  { field: 'contact_email', type: 'string' },
  { field: 'notes', type: 'text' },
  { field: 'amount', type: 'decimal' },
  { field: 'quantity', type: 'integer' },
  { field: 'approved', type: 'boolean' },
  { field: 'due_on', type: 'date' },
  {
    field: 'status',
    type: 'string',
    options: {
      choices: [
        { text: 'Open', value: 'open' },
        { text: 'Closed', value: 'closed' }
      ]
    }
  },
  {
    field: 'tags',
    type: 'json',
    interface: 'tags',
    options: JSON.stringify({ choices: ['a', 'b', 'c'] })
  },
  { field: 'vendor', type: 'integer' },
  { field: 'owner', type: 'uuid' },
  { field: 'lines', type: 'alias' },
  { field: 'total', type: 'decimal', computed_type: 'formula' },
  { field: 'date_created', type: 'timestamp' },
  { field: 'photo', type: 'uuid', interface: 'file-image' }
]

const RELATIONS: RelationRow[] = [
  { many_collection: 'orders', many_field: 'vendor', one_collection: 'vendors' },
  { many_collection: 'orders', many_field: 'owner', one_collection: 'nivaro_users' },
  {
    many_collection: 'order_lines',
    many_field: 'order',
    one_collection: 'orders',
    one_field: 'lines'
  }
]

describe('sample record (#3196)', () => {
  it('the same seed gives the same record; another seed varies it', () => {
    const a = buildSampleRecord({ fields: FIELDS, relations: RELATIONS, seed: 7, now: NOW })
    const b = buildSampleRecord({ fields: FIELDS, relations: RELATIONS, seed: 7, now: NOW })
    expect(a).toEqual(b)
    const others = [1, 2, 3, 4, 5].map((s) =>
      JSON.stringify(buildSampleRecord({ fields: FIELDS, relations: RELATIONS, seed: s, now: NOW }))
    )
    expect(new Set(others).size).toBeGreaterThan(1)
  })

  it('values follow the field type, name and choices', () => {
    const r = buildSampleRecord({ fields: FIELDS, relations: RELATIONS, seed: 42, now: NOW })
    expect(typeof r.title).toBe('string')
    expect(String(r.contact_email)).toMatch(/^[a-z]+\.[a-z]+@example\.com$/)
    expect(typeof r.notes).toBe('string')
    expect(typeof r.amount).toBe('number')
    expect(Number.isInteger(r.quantity)).toBe(true)
    expect(typeof r.approved).toBe('boolean')
    expect(String(r.due_on)).toMatch(/^2026-\d{2}-\d{2}$/)
    expect(['open', 'closed']).toContain(r.status)
    expect(Array.isArray(r.tags)).toBe(true)
    for (const t of r.tags as string[]) expect(['a', 'b', 'c']).toContain(t)
  })

  it('leaves out ids, system and computed columns, lists, files and unknown pickers', () => {
    const r = buildSampleRecord({ fields: FIELDS, relations: RELATIONS, seed: 3, now: NOW })
    for (const k of ['id', 'lines', 'total', 'date_created', 'photo', 'vendor', 'owner'])
      expect(r).not.toHaveProperty(k)
  })

  it('a picker gets one of the readable related ids', () => {
    const r = buildSampleRecord({
      fields: FIELDS,
      relations: RELATIONS,
      relatedIds: { vendor: [11, 12, 13] },
      seed: 9,
      now: NOW
    })
    expect([11, 12, 13]).toContain(r.vendor)
  })

  it('pickers to look up skip system collections', () => {
    expect(samplePickers(FIELDS, RELATIONS)).toEqual([{ field: 'vendor', collection: 'vendors' }])
  })

  it('seeded random stays in [0, 1)', () => {
    const r = seededRandom(123)
    for (let i = 0; i < 200; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
