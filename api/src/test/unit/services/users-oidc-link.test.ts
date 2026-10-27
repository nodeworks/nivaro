import { beforeEach, describe, expect, it, vi } from 'vitest'

// Security audit H7: email links ONLY an account no sign-in identity has claimed; an account
// bound to another subject is never taken over by an email claim. Additional providers'
// subjects are stored per issuer; accounts they linked before still match (raw sub + email).

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown[]]>,
  rows: new Map<string, unknown[]>()
}))

function chain(table: string): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          const rows = (state.rows.get(table) ?? []).shift()
          return (res: (v: unknown) => void) => res(rows)
        }
        return (...args: unknown[]) => {
          state.calls.push([table, prop, args])
          return proxy
        }
      }
    }
  )
  return proxy
}

vi.mock('../../../db/index.js', () => ({ db: (t: string) => chain(t) }))
vi.mock('../../../services/microsoft.js', () => ({ resolveRoleFromAdGroups: async () => null }))
vi.mock('../../../services/office-geocode.js', () => ({ queueOfficeGeocode: () => undefined }))

import {
  AccountLinkRefusedError,
  findOrCreateFromOIDC,
  getUser,
  getUserWithCredentials,
  namespacedSub,
  updateUser
} from '../../../services/users.js'

const base = { email: 'victim@example.com', given_name: 'V', family_name: 'Ictim' }
const updates = () => state.calls.filter(([, m]) => m === 'update').map(([, , a]) => a[0])

beforeEach(() => {
  state.calls = []
  state.rows = new Map()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('findOrCreateFromOIDC account linking', () => {
  it('refuses an email that names an account linked to another subject', async () => {
    state.rows.set('nivaro_users', [
      undefined, // no row for this sub
      { id: 'V', email: base.email, external_id: 'victim-real-sub', status: 'active' }
    ])
    await expect(findOrCreateFromOIDC({ ...base, sub: 'attacker-sub' })).rejects.toBeInstanceOf(
      AccountLinkRefusedError
    )
    expect(updates()).toHaveLength(0)
  })

  it('links a pre-provisioned account (no subject yet) on first sign-in', async () => {
    state.rows.set('nivaro_users', [
      undefined,
      { id: 'P', email: base.email, external_id: null, status: 'active' }
    ])
    const user = await findOrCreateFromOIDC({ ...base, sub: 'first-sub' })
    expect(user.id).toBe('P')
    expect(updates()[0]).toMatchObject({ external_id: 'first-sub' })
  })

  it('an existing subject still matches as before (primary provider, raw sub)', async () => {
    state.rows.set('nivaro_users', [
      { id: 'M', email: 'other@example.com', external_id: 'ms-sub', status: 'active' }
    ])
    const user = await findOrCreateFromOIDC({ ...base, sub: 'ms-sub' })
    expect(user.id).toBe('M')
    // Matched by subject: no email lookup at all.
    expect(state.calls.filter(([, m, a]) => m === 'where' && 'email' in (a[0] as object))).toEqual(
      []
    )
  })

  it('an additional provider re-stamps an account it linked before namespacing', async () => {
    const sub = namespacedSub('https://idp.example.com/', 'raw-1')
    expect(sub).toBe('oidc:https://idp.example.com|raw-1')
    state.rows.set('nivaro_users', [
      undefined, // nothing under the namespaced subject yet
      { id: 'L', email: 'Victim@Example.com', external_id: 'raw-1', status: 'active' }
    ])
    const user = await findOrCreateFromOIDC({ ...base, sub, legacySub: 'raw-1' })
    expect(user.id).toBe('L')
    expect(updates()[0]).toMatchObject({ external_id: sub })
  })

  it('a legacy raw subject with a different email does not match', async () => {
    const sub = namespacedSub('https://idp.example.com', 'raw-1')
    state.rows.set('nivaro_users', [
      undefined,
      { id: 'L', email: 'someone-else@example.com', external_id: 'raw-1', status: 'active' },
      { id: 'V', email: base.email, external_id: 'victim-real-sub', status: 'active' }
    ])
    await expect(findOrCreateFromOIDC({ ...base, sub, legacySub: 'raw-1' })).rejects.toBeInstanceOf(
      AccountLinkRefusedError
    )
  })
})

describe('getUser / updateUser never hand out credentials (H6)', () => {
  const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
  const raw = () => ({
    id: ID,
    email: 'a@x.test',
    static_token: 'tok',
    password_hash: 'h',
    totp_secret: 's',
    external_id: 'sub',
    preferences: '{"a":1}'
  })

  it('getUser strips them and says whether a token exists', async () => {
    state.rows.set('nivaro_users', [raw()])
    const u = (await getUser(ID)) as unknown as Record<string, unknown>
    for (const f of ['static_token', 'password_hash', 'totp_secret', 'external_id'])
      expect(u).not.toHaveProperty(f)
    expect(u.has_static_token).toBe(true)
    expect(u.preferences).toEqual({ a: 1 })
  })

  it('updateUser returns the stripped row; the internal getter keeps them', async () => {
    state.rows.set('nivaro_users', [1, raw(), raw()])
    const u = (await updateUser(ID, { first_name: 'A' })) as unknown as Record<string, unknown>
    expect(u).not.toHaveProperty('static_token')
    expect((await getUserWithCredentials(ID))?.static_token).toBe('tok')
  })
})
