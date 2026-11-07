import { describe, expect, it, vi } from 'vitest'

// army6 L45: approving with every zone unticked granted unrestricted access.
// L46: the stored vendor name was the client's free text.

const rows = vi.hoisted(() => ({ vendors: [] as Array<{ id: number; name: unknown }> }))
vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    let id: unknown
    const qb: any = {
      where: (_c: string, v: unknown) => {
        id = v
        return qb
      },
      first: async () =>
        table === 'vendors' ? rows.vendors.find((r) => String(r.id) === String(id)) : undefined
    }
    return qb
  }
  return { db: Object.assign(db, { schema: { hasTable: async () => true } }) }
})

const { planAuthorization, vendorOf } = await import('../../../services/portal-access-request.js')

describe('planAuthorization', () => {
  it('refuses an approval with no zones unless every zone is asked for', () => {
    expect(planAuthorization({ role: 'R1', zones: [] })).toMatchObject({
      ok: false,
      code: 'ZONES_REQUIRED'
    })
    expect(planAuthorization({ role: 'R1' })).toMatchObject({ ok: false, code: 'ZONES_REQUIRED' })
    expect(planAuthorization({ role: 'R1', all_zones: true })).toEqual({
      ok: true,
      role: 'R1',
      zones: 'all'
    })
  })

  it('takes the zones given (deduped) and needs a role', () => {
    expect(planAuthorization({ role: 'R1', zones: [3, 3, '7', ''] })).toEqual({
      ok: true,
      role: 'R1',
      zones: [3, '7']
    })
    expect(planAuthorization({ zones: [1] })).toMatchObject({ ok: false, code: 'ROLE_REQUIRED' })
  })
})

describe('vendorOf', () => {
  it('reads the name by id; a vendor with no name keeps its id and no name', async () => {
    rows.vendors = [
      { id: 753, name: ' Acme Fiber ' },
      { id: 1941, name: null }
    ]
    expect(await vendorOf(753)).toEqual({ id: 753, name: 'Acme Fiber' })
    expect(await vendorOf('1941')).toEqual({ id: 1941, name: null })
    expect(await vendorOf(42)).toBeNull()
    expect(await vendorOf(null)).toBeNull()
  })
})
