import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { slugFellThrough } from '../../../routes/collection-layouts.js'

describe('slugFellThrough (army11 f3: ?layout=does-not-exist opened the Unit form silently)', () => {
  it('a named form that opened (or its phone / tablet version) is no fallback', () => {
    expect(slugFellThrough('inv-non-unit', { kind: 'slug' })).toBe(false)
    expect(slugFellThrough('inv-non-unit', { kind: 'phone', desktop_kind: 'slug' })).toBe(false)
  })
  it('a name that matched nothing the person may open is said', () => {
    expect(slugFellThrough('does-not-exist', { kind: 'default' })).toBe(true)
    expect(slugFellThrough('does-not-exist', { kind: 'phone', desktop_kind: 'default' })).toBe(true)
  })
  it('no name asked for: nothing to say', () => {
    expect(slugFellThrough(undefined, { kind: 'default' })).toBe(false)
  })
})
