import { beforeEach, describe, expect, it, vi } from 'vitest'

const emit = vi.fn()
const to = vi.fn(() => ({ emit }))
vi.mock('./io-holder.js', () => ({ getIo: () => ({ to }) }))
const signedIn = vi.fn()
vi.mock('./record-events.js', () => ({ emitToSignedIn: (...a: unknown[]) => signedIn(...a) }))
vi.mock('./tenant-rooms.js', () => ({ currentTenantKey: () => 'tenant-1' }))

import { announceMineChanged, announcePinsChanged } from './user-sync.js'

beforeEach(() => {
  emit.mockClear()
  to.mockClear()
  signedIn.mockClear()
})

describe('announceMineChanged (rt4 #20)', () => {
  it("tells the person's own room which list moved, never a value", () => {
    announceMineChanged('u1', 'saved-views')
    expect(to).toHaveBeenCalledWith('user:u1')
    expect(emit).toHaveBeenCalledWith('mine:changed', { kind: 'saved-views' })
  })
  it('does nothing without a person', () => {
    announceMineChanged(null, 'overview')
    expect(to).not.toHaveBeenCalled()
  })
})

describe('announcePinsChanged', () => {
  it('goes to every signed-in socket of the tenant, with no payload', () => {
    announcePinsChanged()
    expect(signedIn).toHaveBeenCalledWith('tenant-1', 'pins:changed', {})
  })
})
