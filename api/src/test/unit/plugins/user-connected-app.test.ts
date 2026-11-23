import { describe, expect, it } from 'vitest'
import { userConnectedLocally } from '../../../plugins/socketio.js'

// Hub phase 6 final review (rest) Minor 4: on a Hub shared deployment copied apps share user ids,
// so "has this person a socket?" (the edit-lock presence probe) must look at the asking app's
// sockets only — a lock in app B stayed "live" while the same id was connected in app A.

const meta = (id: string | null) => ({ user: id ? { id, name: 'x' } : null })
const sockets: Array<[string, { user: { id: string; name: string } | null }]> = [
  ['s1', meta('ABC')],
  ['s2', meta('def')],
  ['s3', meta(null)]
]
const tenantOf = (sid: string) => ({ s1: 'appa-e1', s2: 'appb-e2', s3: 'appa-e1' })[sid] ?? null

describe('userConnectedLocally', () => {
  it('any socket counts when not scoped (self-hosted, cloud)', () => {
    expect(userConnectedLocally(sockets, 'abc', null, tenantOf)).toBe(true)
    expect(userConnectedLocally(sockets, 'DEF', null, tenantOf)).toBe(true)
    expect(userConnectedLocally(sockets, 'zzz', null, tenantOf)).toBe(false)
  })

  it('scoped to an app: only that app’s sockets count', () => {
    expect(userConnectedLocally(sockets, 'abc', 'appa-e1', tenantOf)).toBe(true)
    expect(userConnectedLocally(sockets, 'abc', 'appb-e2', tenantOf)).toBe(false)
    expect(userConnectedLocally(sockets, 'def', 'appb-e2', tenantOf)).toBe(true)
    expect(userConnectedLocally(sockets, 'def', 'appa-e1', tenantOf)).toBe(false)
  })
})
