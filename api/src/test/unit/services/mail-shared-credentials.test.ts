import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap `watch`, review M3: on a Hub shared deployment an app with a saved relay signs in only
// with its own saved credentials — the deployment's SMTP_USER / SMTP_PASSWORD are never sent to
// the app's relay (not even when its sealed password does not open). Self-hosted is unchanged.

vi.hoisted(() => {
  process.env.SMTP_HOST = 'deploy-relay.example'
  process.env.SMTP_PORT = '2525'
  process.env.SMTP_USER = 'deploy-user'
  process.env.SMTP_PASSWORD = 'deploy-secret'
  for (const k of ['NIVARO_SETTINGS_OVERRIDES', 'MAIL_TEST_MODE', 'MAIL_TEST_RECIPIENT'])
    process.env[k] = ''
})
const row = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn((table: string) => {
      if (table !== 'nivaro_settings') throw new Error('no db in test')
      const q = { select: () => q, orderBy: () => q, first: async () => row.value }
      return q
    }),
    { raw: vi.fn() }
  )
}))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))
vi.mock('../../../services/encryption.js', () => ({
  isEncrypted: (v: unknown) => typeof v === 'string' && v.startsWith('enc:v1:'),
  decryptValue: (v: string) => {
    if (v === 'enc:v1:bad') throw new Error('does not open')
    return v.slice(7)
  }
}))

const { getSmtpConfig } = await import('../../../services/mail.js')

beforeEach(() => {
  row.value = {}
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('SMTP credentials on a shared deployment', () => {
  it('a saved relay takes only its own saved sign-in there', async () => {
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
    row.value = { smtp_host: 'app-relay.corp.example' }
    expect(await getSmtpConfig()).toMatchObject({
      host: 'app-relay.corp.example',
      port: 587,
      user: null,
      pass: null,
      secure: false
    })
    row.value = { smtp_host: 'app-relay.corp.example', smtp_user: 'app', smtp_pass: 'enc:v1:bad' }
    expect(await getSmtpConfig()).toMatchObject({ user: 'app', pass: null })
    row.value = { smtp_host: 'app-relay.corp.example', smtp_user: 'app', smtp_pass: 'enc:v1:ok' }
    expect(await getSmtpConfig()).toMatchObject({ user: 'app', pass: 'ok' })
  })

  it('an app with nothing saved still falls back to the deployment relay', async () => {
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
    expect(await getSmtpConfig()).toMatchObject({
      host: 'deploy-relay.example',
      user: 'deploy-user',
      pass: 'deploy-secret'
    })
  })

  it('self-hosted mixing is unchanged', async () => {
    row.value = { smtp_host: 'app-relay.corp.example' }
    expect(await getSmtpConfig()).toMatchObject({
      host: 'app-relay.corp.example',
      port: 2525,
      user: 'deploy-user',
      pass: 'deploy-secret'
    })
  })
})
