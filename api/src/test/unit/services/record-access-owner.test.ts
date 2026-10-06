import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { ownerOnlyAllows, ownsStep } from '../../../services/record-access.js'

const OWNER = '6D0C0E3A-1111-4A2B-9C3D-000000000001'
const DELEGATE = '6D0C0E3A-1111-4A2B-9C3D-000000000002'
const STRANGER = '6D0C0E3A-1111-4A2B-9C3D-000000000003'

describe('ownsStep (#794)', () => {
  it('finds the owner whatever case the ids come back in', () => {
    expect(ownsStep([{ id: OWNER }], OWNER.toLowerCase())).toBe(true)
    expect(ownsStep([{ id: OWNER.toLowerCase() }], OWNER)).toBe(true)
  })

  it('a non-owner is not an owner', () => {
    expect(ownsStep([{ id: OWNER }], STRANGER)).toBe(false)
    expect(ownsStep([], OWNER)).toBe(false)
    expect(ownsStep([{ id: null }], OWNER)).toBe(false)
  })

  it('judges the owner list AFTER delegation: the delegate passes, the absent owner does not', () => {
    // resolveStateOwnersBatch substitutes a working delegate for an
    // out-of-office owner — the list it hands back names the delegate.
    const resolved = [{ id: DELEGATE }]
    expect(ownsStep(resolved, DELEGATE)).toBe(true)
    expect(ownsStep(resolved, OWNER)).toBe(false)
  })
})

describe('ownerOnlyAllows (#794)', () => {
  it('admins always pass', () => {
    expect(ownerOnlyAllows(true, { is_owner: false })).toBe(true)
    expect(ownerOnlyAllows(true, { is_owner: null })).toBe(true)
  })

  it('anyone else passes only as an owner of the current step', () => {
    expect(ownerOnlyAllows(false, { is_owner: true })).toBe(true)
    expect(ownerOnlyAllows(false, { is_owner: false })).toBe(false)
    // No open step to own — nobody but an admin.
    expect(ownerOnlyAllows(false, { is_owner: null })).toBe(false)
  })
})
