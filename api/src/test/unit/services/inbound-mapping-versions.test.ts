import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { diffMappingSnapshots, hashSnapshot, snapshotOf } = await import(
  '../../../services/inbound-mapping-versions.js'
)

const base = {
  id: 9,
  key: 'partner',
  label: 'Partner',
  collection: 'regions',
  mode: 'create',
  upsert_keys: null,
  rules: JSON.stringify([
    { target: 'name', source: 'title', steps: [] },
    { target: 'code', source: 'code', steps: [] }
  ]),
  children: null,
  fixtures: JSON.stringify([
    { id: 'aaaaaaaa-1', name: 'Good', payload: { a: 1 }, expect: 'write' },
    { id: 'bbbbbbbb-2', name: 'Bad', payload: { a: 2 }, expect: 'reject' }
  ]),
  response_template: null,
  response_status: JSON.stringify({ success: 200 }),
  is_active: 1,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-02')
}

describe('snapshotOf / hashSnapshot', () => {
  it('keeps the id and the versioned columns only', () => {
    const s = snapshotOf(base)
    expect(s.id).toBe(9)
    expect(s.is_active).toBe(true)
    expect('created_at' in s).toBe(false)
  })
  it('ignores JSON spelling and timestamps', () => {
    const a = snapshotOf(base)
    const b = snapshotOf({
      ...base,
      response_status: '{ "success": 200 }',
      updated_at: new Date('2027-01-01')
    })
    expect(hashSnapshot(a)).toBe(hashSnapshot(b))
    expect(hashSnapshot(a)).not.toBe(hashSnapshot(snapshotOf({ ...base, label: 'Other' })))
  })
})

describe('diffMappingSnapshots', () => {
  it('names changed rules by target, fixtures by id, and settings', () => {
    const after = snapshotOf({
      ...base,
      label: 'Partner v2',
      rules: JSON.stringify([
        { target: 'name', source: 'heading', steps: [] },
        { target: 'zone', source: 'z', steps: [] }
      ]),
      fixtures: JSON.stringify([
        { id: 'aaaaaaaa-1', name: 'Good', payload: { a: 9 }, expect: 'write' },
        { id: 'cccccccc-3', name: 'New', payload: {}, expect: 'write' }
      ]),
      response_template: '{{ outcome }}',
      response_status: JSON.stringify({ success: 201 })
    })
    const d = diffMappingSnapshots(snapshotOf(base), after)
    expect(d.settings).toEqual([{ field: 'label', from: 'Partner', to: 'Partner v2' }])
    expect(d.rules.added).toEqual(['zone'])
    expect(d.rules.removed).toEqual(['code'])
    expect(d.rules.changed).toEqual([{ key: 'name', fields: ['source'] }])
    expect(d.fixtures.added).toEqual(['New (cccccccc)'])
    expect(d.fixtures.removed).toEqual(['Bad (bbbbbbbb)'])
    expect(d.fixtures.changed).toEqual([{ key: 'Good (aaaaaaaa)', fields: ['payload'] }])
    expect(d.response_template).toEqual({ from: null, to: '{{ outcome }}' })
    expect(d.response_status).toEqual([{ field: 'success', from: 200, to: 201 }])
    expect(d.total).toBe(9)
  })
  it('is empty for identical snapshots', () => {
    expect(diffMappingSnapshots(snapshotOf(base), snapshotOf(base)).total).toBe(0)
  })
})
