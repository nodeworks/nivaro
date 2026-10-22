import { afterEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ user: null as Record<string, unknown> | null, admin: false }))
vi.mock('../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = auth.user ?? undefined
    req.isAdmin = auth.admin
  }
}))

import { requireChaosOperator } from './operator.js'
import { _setChaosSettingsForTests, normalizeChaosSettings } from './settings.js'

const OPS_ROLE = 'a0000000-0000-0000-0000-00000000000a'
const OTHER_ROLE = 'b0000000-0000-0000-0000-00000000000b'

async function gate() {
  const req = {} as Parameters<typeof requireChaosOperator>[0]
  const reply = { sent: false } as unknown as Parameters<typeof requireChaosOperator>[1]
  return requireChaosOperator(req, reply).then(
    () => 'ok',
    (e: { statusCode: number; code: string }) => `${e.statusCode} ${e.code}`
  )
}

afterEach(() => {
  _setChaosSettingsForTests(null)
  auth.user = null
  auth.admin = false
})

describe('requireChaosOperator (#2862)', () => {
  it('lets administrators through with no settings at all', async () => {
    _setChaosSettingsForTests(normalizeChaosSettings({}))
    auth.user = { id: 'u1', role: OTHER_ROLE }
    auth.admin = true
    expect(await gate()).toBe('ok')
  })

  it('lets members of an operator role through, refuses everyone else', async () => {
    _setChaosSettingsForTests(normalizeChaosSettings({ operator_roles: [OPS_ROLE] }))
    auth.user = { id: 'u2', role: OPS_ROLE.toUpperCase() }
    expect(await gate()).toBe('ok')
    auth.user = { id: 'u3', role: OTHER_ROLE }
    expect(await gate()).toBe('403 CHAOS_OPERATOR')
    auth.user = { id: 'u4', role: null }
    expect(await gate()).toBe('403 CHAOS_OPERATOR')
  })

  it("keeps collection-scoped API keys out, even an administrator's", async () => {
    _setChaosSettingsForTests(normalizeChaosSettings({ operator_roles: [OPS_ROLE] }))
    auth.user = { id: 'u5', role: OPS_ROLE, api_key_scopes: ['items'] }
    auth.admin = true
    expect(await gate()).toBe('403 API_KEY_SCOPE_MISSING')
  })

  it('refuses when nobody signed in', async () => {
    expect(await gate()).toBe('401 UNAUTHENTICATED')
  })
})
