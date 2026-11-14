import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  offeredToActor,
  ownerOnlyAllows,
  ownerOnlyMessage,
  ownsStep
} from '../../../services/record-access.js'

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

describe('allow_creator (army 2026-10-24)', () => {
  it('the record creator passes only on a move that allows the creator', () => {
    const creator = { is_owner: false, is_creator: true }
    expect(ownerOnlyAllows(false, creator, true)).toBe(true)
    expect(ownerOnlyAllows(false, creator, false)).toBe(false)
    expect(ownerOnlyAllows(false, { is_owner: false, is_creator: false }, true)).toBe(false)
  })

  it('offeredToActor keeps open moves, owner moves for owners, creator moves for creators', () => {
    const moves = [
      { id: 'submit', require_owner: false },
      { id: 'approve', require_owner: true },
      { id: 'cancel', require_owner: 1, allow_creator: 1 }
    ]
    const ids = (a: { is_owner: boolean; is_creator: boolean }) =>
      offeredToActor(moves, a).map((m) => m.id)
    expect(ids({ is_owner: true, is_creator: false })).toEqual(['submit', 'approve', 'cancel'])
    expect(ids({ is_owner: false, is_creator: true })).toEqual(['submit', 'cancel'])
    expect(ids({ is_owner: false, is_creator: false })).toEqual(['submit'])
  })
})

describe('ownerOnlyMessage (blocked moves, Rob 2026-11-13)', () => {
  it('says nobody owns the step yet, and who can still make the move', () => {
    expect(ownerOnlyMessage({ step: 'Warehouse Submission', ownerNames: [] })).toBe(
      'Only the owner of Warehouse Submission can make this move. No one owns Warehouse Submission on this record yet — an administrator can make it, or ask to be made the owner.'
    )
  })

  it('names the assigned owners', () => {
    expect(ownerOnlyMessage({ step: 'Level 1', ownerNames: ['Kim Lee'] })).toBe(
      "Only the owner of Level 1 can make this move. You don't own Level 1 on this record — Kim Lee does."
    )
    expect(
      ownerOnlyMessage({ step: 'Level 1', allowCreator: true, ownerNames: ['Kim Lee', 'Ana Ruiz'] })
    ).toBe(
      "Only the owner of Level 1 or the person who created this record can make this move. You don't own Level 1 on this record — Kim Lee and Ana Ruiz do."
    )
  })

  it('keeps the plain sentence when the owners are unknown or there is no step', () => {
    expect(ownerOnlyMessage({ step: 'Level 1', ownerNames: null })).toBe(
      'Only the owner of Level 1 can make this move.'
    )
    expect(ownerOnlyMessage({ step: null, ownerNames: [] })).toBe(
      'Only the owner of the current step can make this move.'
    )
  })
})
