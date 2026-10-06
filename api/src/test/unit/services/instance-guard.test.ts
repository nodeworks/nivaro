import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  assertInstanceAccess,
  type GuardDeps,
  InstanceAccessError
} from '../../../services/instance-guard.js'
import type { User } from '../../../types.js'

const user = { id: 'u1', role: 'r1' } as unknown as User

function deps(over: Partial<GuardDeps> = {}): GuardDeps {
  return {
    can: vi.fn(async () => true),
    readOne: vi.fn(async () => ({ id: '1' })),
    subject: vi.fn(async (c, i) => ({ collection: c, itemId: i })),
    ...over
  }
}

async function status(p: Promise<void>): Promise<number | 'ok'> {
  try {
    await p
    return 'ok'
  } catch (err) {
    if (err instanceof InstanceAccessError) return err.statusCode
    throw err
  }
}

describe('assertInstanceAccess', () => {
  it('lets admins through without any lookup', async () => {
    const d = deps()
    expect(await status(assertInstanceAccess(null, true, 'workflows', '1', d))).toBe('ok')
    expect(d.can).not.toHaveBeenCalled()
  })

  it('refuses an anonymous caller', async () => {
    expect(await status(assertInstanceAccess(null, false, 'workflows', '1', deps()))).toBe(403)
  })

  it('needs update permission on the collection', async () => {
    const d = deps({ can: vi.fn(async () => false) })
    expect(await status(assertInstanceAccess(user, false, 'workflows', '1', d))).toBe(403)
    expect(d.can).toHaveBeenCalledWith(user, 'update', 'workflows')
    expect(d.readOne).not.toHaveBeenCalled()
  })

  it('treats a record the caller cannot see as missing (404)', async () => {
    const d = deps({ readOne: vi.fn(async () => null) })
    expect(await status(assertInstanceAccess(user, false, 'workflows', '1', d))).toBe(404)
  })

  it('passes a visible record the caller may update', async () => {
    expect(await status(assertInstanceAccess(user, false, 'workflows', '1', deps()))).toBe('ok')
  })

  it('judges an addendum instance on its parent record', async () => {
    const d = deps({
      subject: vi.fn(async () => ({ collection: 'workflows', itemId: '42' }))
    })
    expect(await status(assertInstanceAccess(user, false, 'nivaro_addendums', 'a1', d))).toBe('ok')
    expect(d.readOne).toHaveBeenCalledWith(user, 'workflows', '42')
  })

  it('refuses an addendum with no parent, and other system collections', async () => {
    expect(await status(assertInstanceAccess(user, false, 'nivaro_addendums', 'a1', deps()))).toBe(
      404
    )
    expect(await status(assertInstanceAccess(user, false, 'nivaro_users', 'x', deps()))).toBe(403)
  })

  it('uses read permission for read-only callers', async () => {
    const d = deps()
    await assertInstanceAccess(user, false, 'workflows', '1', d, 'read')
    expect(d.can).toHaveBeenCalledWith(user, 'read', 'workflows')
  })
})
