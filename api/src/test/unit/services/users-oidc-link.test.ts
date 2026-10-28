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
  issuerFamily,
  providerKeyFor,
  resetAccountLinkPolicyCache
} from '../../../auth/account-link-policy.js'
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

describe('email links to an account held elsewhere — review A7 exceptions', () => {
  const TID = '11111111-2222-4333-8444-555555555555'
  const msA = `oidc:https://login.microsoftonline.com/${TID}/v2.0|sub-app-a`
  const msB = `oidc:https://sts.windows.net/${TID}/|sub-app-b`

  beforeEach(() => {
    resetAccountLinkPolicyCache()
    delete process.env.SSO_LINK_BY_EMAIL
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  it('same Microsoft tenant under another provider config links, keeping the stored subject', async () => {
    state.rows.set('nivaro_users', [
      undefined,
      { id: 'T', email: base.email, external_id: msA, status: 'active' }
    ])
    const user = await findOrCreateFromOIDC({ ...base, sub: msB })
    expect(user.id).toBe('T')
    expect(user.external_id).toBe(msA)
    expect(updates()[0]).not.toHaveProperty('external_id')
  })

  it('another tenant is a different identity provider: refused', async () => {
    const other = `oidc:https://login.microsoftonline.com/99999999-2222-4333-8444-555555555555/v2.0|x`
    state.rows.set('nivaro_users', [
      undefined,
      { id: 'T', email: base.email, external_id: msA, status: 'active' }
    ])
    await expect(findOrCreateFromOIDC({ ...base, sub: other })).rejects.toBeInstanceOf(
      AccountLinkRefusedError
    )
  })

  it('the same Entra object id links whatever the provider; a different one never does', async () => {
    state.rows.set('nivaro_users', [
      undefined,
      {
        id: 'E',
        email: base.email,
        external_id: 'saml:victim',
        entra_oid: 'OID-1',
        entra_tid: TID,
        status: 'active'
      },
      undefined, // update
      { entra_oid: 'oid-1', entra_tid: TID } // captureEntraIdentity read
    ])
    const ok = await findOrCreateFromOIDC({ ...base, sub: 'raw', entraOid: 'oid-1', entraTid: TID })
    expect(ok.id).toBe('E')

    state.rows.set('nivaro_users', [
      undefined,
      { id: 'E', email: base.email, external_id: msA, entra_oid: 'OID-1', status: 'active' }
    ])
    // even the same tenant family cannot override a different stored Entra person
    await expect(
      findOrCreateFromOIDC({ ...base, sub: msB, entraOid: 'oid-2', entraTid: TID })
    ).rejects.toBeInstanceOf(AccountLinkRefusedError)
  })

  it('a provider switched on for email linking links; others stay refused', async () => {
    process.env.SSO_LINK_BY_EMAIL = 'saml'
    state.rows.set('nivaro_users', [
      undefined,
      { id: 'S', email: base.email, external_id: 'primary-sub', status: 'active' }
    ])
    const user = await findOrCreateFromOIDC({ ...base, sub: 'saml:victim@example.com' })
    expect(user.id).toBe('S')
    expect(updates()[0]).not.toHaveProperty('external_id')

    resetAccountLinkPolicyCache()
    state.rows.set('nivaro_users', [
      undefined,
      { id: 'S', email: base.email, external_id: 'saml:victim@example.com', status: 'active' }
    ])
    await expect(findOrCreateFromOIDC({ ...base, sub: 'other-primary' })).rejects.toBeInstanceOf(
      AccountLinkRefusedError
    )
  })

  it('reads provider keys and families', () => {
    expect(issuerFamily(`https://login.microsoftonline.com/${TID}/v2.0`)).toBe(`ms:${TID}`)
    expect(issuerFamily('https://login.microsoftonline.com/common/v2.0')).toBeNull()
    expect(issuerFamily('https://idp.example.com/realms/x/')).toBe(
      'https://idp.example.com/realms/x'
    )
    const providers = new Map([['https://idp.example.com', 'okta']])
    expect(providerKeyFor('oidc:https://idp.example.com/|s', providers)).toBe('okta')
    expect(providerKeyFor('saml:n', providers)).toBe('saml')
    expect(providerKeyFor('raw', providers)).toBe('primary')
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
