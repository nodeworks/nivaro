import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import {
  can,
  getAllowedFields,
  parseRowFilter,
  type RowCondition,
} from '../../../services/permissions.js'
import { makeAdminUser, makeRegularUser } from '../../helpers.js'

// Helper to set up a mock db('table').where(...).first() chain
function mockDbFirst(result: unknown) {
  const chain = {
    where: vi.fn().mockReturnThis(),
    orWhere: vi.fn().mockReturnThis(),
    orderByRaw: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(result),
  }
  vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(chain as unknown as ReturnType<typeof db>)
  return chain
}

// Sequence of returns for successive db() calls
function mockDbSequence(results: unknown[]) {
  let callCount = 0
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation(() => {
    const result = results[callCount++] ?? null
    return {
      where: vi.fn().mockReturnThis(),
      orWhere: vi.fn().mockReturnThis(),
      orderByRaw: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(result),
    } as unknown as ReturnType<typeof db>
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

// ─── parseRowFilter (pure, no DB) ────────────────────────────────────────────

describe('parseRowFilter', () => {
  it('returns null for null input', () => {
    expect(parseRowFilter(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseRowFilter(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseRowFilter('')).toBeNull()
  })

  it('returns null for invalid JSON string', () => {
    expect(parseRowFilter('{invalid}')).toBeNull()
  })

  it('returns null for empty array', () => {
    expect(parseRowFilter('[]')).toBeNull()
  })

  it('parses a valid filter array from a JSON string', () => {
    const raw = JSON.stringify([{ field: 'status', op: 'eq', value: 'active' }])
    const result = parseRowFilter(raw)
    expect(result).toEqual([{ field: 'status', op: 'eq', value: 'active' }])
  })

  it('accepts an already-parsed array', () => {
    const conditions: RowCondition[] = [{ field: 'user', op: 'eq', value: '$CURRENT_USER' }]
    expect(parseRowFilter(conditions)).toEqual(conditions)
  })

  it('returns null when a condition has an invalid op', () => {
    const raw = JSON.stringify([{ field: 'status', op: 'INVALID_OP', value: 'x' }])
    expect(parseRowFilter(raw)).toBeNull()
  })

  it('returns null when a condition is missing the field key', () => {
    const raw = JSON.stringify([{ op: 'eq', value: 'x' }])
    expect(parseRowFilter(raw)).toBeNull()
  })
})

// ─── can() ────────────────────────────────────────────────────────────────────

describe('can()', () => {
  it('returns false when user has no role', async () => {
    const user = makeRegularUser({ role: null })
    const result = await can(user, 'read', 'articles')
    expect(result).toBe(false)
  })

  it('returns false when role is not found in DB', async () => {
    mockDbFirst(null) // role lookup returns null
    const user = makeRegularUser()
    const result = await can(user, 'read', 'articles')
    expect(result).toBe(false)
  })

  it('returns true for an admin role regardless of policies', async () => {
    mockDbFirst({ id: 'admin-role-id', admin_access: true, app_access: true })
    const user = makeAdminUser()
    const result = await can(user, 'read', 'articles')
    expect(result).toBe(true)
  })

  it('returns true when a matching policy exists', async () => {
    mockDbSequence([
      { id: 'regular-role-id', admin_access: false, app_access: true }, // role
      { id: 1, role: 'regular-role-id', collection: 'articles', action: 'read' }, // policy
    ])
    const user = makeRegularUser()
    const result = await can(user, 'read', 'articles')
    expect(result).toBe(true)
  })

  it('returns false when no matching policy exists', async () => {
    mockDbSequence([
      { id: 'regular-role-id', admin_access: false, app_access: true }, // role
      null, // no policy
    ])
    const user = makeRegularUser()
    const result = await can(user, 'delete', 'articles')
    expect(result).toBe(false)
  })
})

// ─── getAllowedFields() ───────────────────────────────────────────────────────

describe('getAllowedFields()', () => {
  it('returns empty array when user has no role', async () => {
    const user = makeRegularUser({ role: null })
    const result = await getAllowedFields(user, 'read', 'articles')
    expect(result).toEqual([])
  })

  it('returns null (all fields) for an admin role', async () => {
    mockDbFirst({ id: 'admin-role-id', admin_access: true })
    const user = makeAdminUser()
    const result = await getAllowedFields(user, 'read', 'articles')
    expect(result).toBeNull()
  })

  it('returns null (all fields) when policy has no fields restriction', async () => {
    mockDbSequence([
      { id: 'regular-role-id', admin_access: false }, // role
      { id: 1, role: 'regular-role-id', collection: 'articles', action: 'read', fields: null }, // policy
    ])
    const user = makeRegularUser()
    const result = await getAllowedFields(user, 'read', 'articles')
    expect(result).toBeNull()
  })

  it('returns specific field list when policy restricts fields (JSON string)', async () => {
    mockDbSequence([
      { id: 'regular-role-id', admin_access: false },
      { id: 1, fields: JSON.stringify(['title', 'status']) },
    ])
    const user = makeRegularUser()
    const result = await getAllowedFields(user, 'read', 'articles')
    expect(result).toEqual(['title', 'status'])
  })

  it('returns specific field list when policy restricts fields (already array)', async () => {
    mockDbSequence([
      { id: 'regular-role-id', admin_access: false },
      { id: 1, fields: ['title', 'status'] },
    ])
    const user = makeRegularUser()
    const result = await getAllowedFields(user, 'read', 'articles')
    expect(result).toEqual(['title', 'status'])
  })

  it('returns empty array when no policy matches', async () => {
    mockDbSequence([
      { id: 'regular-role-id', admin_access: false },
      null,
    ])
    const user = makeRegularUser()
    const result = await getAllowedFields(user, 'read', 'articles')
    expect(result).toEqual([])
  })
})
