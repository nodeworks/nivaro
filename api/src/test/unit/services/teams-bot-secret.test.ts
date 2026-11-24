import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Teams bot secret saved in Settings is sealed (enc:v1). Reading the bot config opens it; a
// secret saved in clear before sealing is sealed in place once (the update matches the clear
// value); a sealed value this server cannot open reads as no secret.

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  updates: [] as Array<{ where: Record<string, unknown>; set: Record<string, unknown> }>
}))
vi.mock('../../../config.js', () => ({
  config: { OIDC_ISSUER: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '' }
}))
vi.mock('../../../db/index.js', () => ({
  db: () => ({
    select: () => ({ first: async () => ({ ...state.row }) }),
    where: (where: Record<string, unknown>) => ({
      update: async (set: Record<string, unknown>) => {
        state.updates.push({ where, set })
        return 1
      }
    })
  })
}))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))

import { decryptValue, encryptValue } from '../../../services/encryption.js'
import { bustTeamsBotConfig, getTeamsBotConfig } from '../../../services/teams-bot/config.js'

const KEY = 'd'.repeat(64)
const savedKey = process.env.ENCRYPTION_KEY
const row = (secret: string | null) => ({
  id: 7,
  teams_bot_enabled: true,
  teams_bot_app_id: 'bot-id',
  teams_bot_app_secret: secret,
  teams_bot_tenant_id: 'tenant-1'
})

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY
  state.updates.length = 0
  bustTeamsBotConfig()
})
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = savedKey
})

describe('Teams bot secret at rest', () => {
  it('opens a sealed secret; nothing is rewritten', async () => {
    state.row = row(encryptValue('the-secret'))
    const c = await getTeamsBotConfig()
    expect(c).toMatchObject({ enabled: true, appSecret: 'the-secret', source: 'settings' })
    expect(state.updates).toHaveLength(0)
  })

  it('seals a clear secret in place, matching the clear value', async () => {
    state.row = row('old-clear')
    const c = await getTeamsBotConfig()
    expect(c.appSecret).toBe('old-clear')
    expect(state.updates).toHaveLength(1)
    const [u] = state.updates
    expect(u.where).toEqual({ id: 7, teams_bot_app_secret: 'old-clear' })
    expect(String(u.set.teams_bot_app_secret)).toMatch(/^enc:v1:/)
    expect(decryptValue(String(u.set.teams_bot_app_secret))).toBe('old-clear')
  })

  it('no key: a clear secret still works and stays as it was', async () => {
    delete process.env.ENCRYPTION_KEY
    state.row = row('old-clear')
    const c = await getTeamsBotConfig()
    expect(c.appSecret).toBe('old-clear')
    expect(state.updates).toHaveLength(0)
  })

  it('a sealed secret this server cannot open reads as no secret', async () => {
    state.row = row(encryptValue('the-secret'))
    process.env.ENCRYPTION_KEY = 'e'.repeat(64)
    const c = await getTeamsBotConfig()
    expect(c.enabled).toBe(false)
    expect(c.reason).toBe('not_configured')
    expect(c.appSecret).toBe('')
  })
})
