import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))
vi.mock('./queues.js', () => ({ getLabels: vi.fn() }))
vi.mock('./approval-brief-lines.js', () => ({ briefLinesFor: vi.fn(async () => []) }))

import { isBooleanField, isDerivedField } from './approval-brief.js'

describe('approval brief field kinds (army11 a1 F-4, f3)', () => {
  it('a yes/no field is boolean', () => {
    expect(isBooleanField({ field: 'is_on_hold', label: null, type: 'boolean' })).toBe(true)
    expect(isBooleanField({ field: 'name', label: null, type: 'string' })).toBe(false)
  })
  it('a built title (auto_id) and a write formula are derived, typed text is not', () => {
    expect(
      isDerivedField({
        field: 'name',
        label: null,
        options: JSON.stringify({ auto_id: { pattern: '{project.project_id}' } })
      })
    ).toBe(true)
    expect(isDerivedField({ field: 'amount', label: null, computed_type: 'write' })).toBe(true)
    expect(
      isDerivedField({ field: 'description', label: null, options: '{"max_length":255}' })
    ).toBe(false)
    expect(isDerivedField(undefined)).toBe(false)
  })
})
