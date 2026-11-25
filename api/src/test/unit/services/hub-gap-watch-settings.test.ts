import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap `watch` (0.3.215): per-app huddle media servers on a Hub shared deployment (secrets
// sealed with the app key, the API's own calls guarded), the instance-row fallback a moved app
// needs, and the env mail settings an app saves for a move to shared.

const st = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  updates: [] as Array<Record<string, unknown>>,
  smtp: {
    host: 'relay.corp.example',
    port: 587,
    secure: false,
    user: 'mailer',
    pass: 'pw',
    from: 'app@corp.example'
  },
  activity: [] as unknown[]
}))

vi.mock('../../../db/index.js', () => {
  const db = () => {
    const c: Record<string, unknown> = {}
    for (const m of ['orderBy', 'select', 'limit']) c[m] = () => c
    c.first = async () => st.row
    c.where = () => ({
      update: async (u: Record<string, unknown>) => {
        st.updates.push(u)
        return 1
      }
    })
    return c
  }
  db.schema = { hasColumn: async () => true }
  return { db }
})
vi.mock('../../../services/encryption.js', () => ({
  isEncrypted: (v: unknown) => typeof v === 'string' && v.startsWith('enc:v1:'),
  encryptValue: (v: string) => `enc:v1:${v}`,
  decryptValue: (v: string) => {
    if (v === 'enc:v1:bad') throw new Error('does not open')
    return v.startsWith('enc:v1:') ? v.slice(7) : v
  }
}))
vi.mock('../../../services/mail.js', () => ({ getSmtpConfig: async () => st.smtp }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (a: unknown) => {
    st.activity.push(a)
    return 1
  }
}))

const { pickInstanceValue } = await import('../../../services/instance-row.js')
const { openHuddleSecrets, sealHuddleSecrets, normalizeHuddleSettings, HUDDLE_DEFAULTS } =
  await import('../../../services/huddle-settings.js')
const d = await import('../../../services/huddle-destinations.js')
const { keepEnvMailSettings, mailColumnsToKeep } = await import(
  '../../../services/mail-env-keep.js'
)

const SHARED = { HUB_SHARED_DEPLOYMENT: 'pool-a' }
const CLOUD = { CLOUD_META_DB_URL: 'mssql://meta' }

beforeEach(() => {
  st.row = undefined
  st.updates = []
  st.activity = []
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('instance row: a moved app finds its saved value', () => {
  const rows = [
    { id: 1, instance_key: 'shop-prod', data: { huddle: { turn_urls: ['turn:t:3478'] } } },
    { id: 2, instance_key: 'pool-a', data: { cache: {} } }
  ]
  it('uses its own row first, else the ONE other row with the key (shared only)', () => {
    expect(pickInstanceValue(rows, 'pool-a', 'huddle', true)).toMatchObject({
      row: { id: 2 },
      from: 'other',
      value: { turn_urls: ['turn:t:3478'] }
    })
    expect(pickInstanceValue(rows, 'pool-a', 'huddle', false)).toMatchObject({
      row: { id: 2 },
      from: 'none'
    })
    expect(pickInstanceValue(rows, 'shop-prod', 'huddle', true).from).toBe('own')
    // two other rows with it (two environments on one database): ambiguous, none
    const two = [...rows, { id: 3, instance_key: 'shop-test', data: { huddle: {} } }]
    expect(pickInstanceValue(two, 'pool-a', 'huddle', true)).toMatchObject({
      from: 'none',
      value: undefined
    })
    expect(pickInstanceValue([], 'pool-a', 'huddle', true)).toEqual({
      row: null,
      value: undefined,
      from: 'none'
    })
  })
})

describe('huddles on a shared deployment', () => {
  it('uses the app’s own servers there, the platform’s in Nivaro Cloud only', () => {
    const saved = { ...HUDDLE_DEFAULTS, turn_urls: ['turn:t.corp:3478'] }
    expect(d.huddleCloudMode(SHARED)).toBe(false)
    expect(d.withPlatformDestinations(saved, SHARED)).toBe(saved)
    expect(d.huddleCloudMode(CLOUD)).toBe(true)
    expect(d.destinationPatchError({ turn_urls: 'turn:t.corp:3478' }, SHARED)).toBeNull()
    expect(d.destinationPatchError({ livekit_url: 'wss://lk.corp.example' }, SHARED)).toBeNull()
    expect(d.destinationPatchError({ livekit_url: 'wss://x.example' }, CLOUD)).toMatch(/platform/)
    expect(d.sfuDestinationAllowed('wss://lk.corp.example', SHARED)).toBe(true)
    expect(d.iceProbeAllowed(SHARED)).toBe(true)
  })

  it('refuses ws:// to the same computer on any multi-tenant process', () => {
    expect(d.destinationPatchError({ livekit_url: 'ws://localhost:7880' }, SHARED)).toMatch(
      /wss:\/\//
    )
    expect(d.sfuDestinationAllowed('ws://localhost:7880', SHARED)).toBe(false)
    expect(d.sfuDestinationAllowed('ws://localhost:7880', {})).toBe(true)
  })

  it('the TURN probe and the LiveKit calls are guarded on shared only', async () => {
    expect(await d.iceProbeRefusal(['turn:10.0.0.5:3478'])).toBeNull() // not shared
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
    expect(await d.iceProbeRefusal(['turn:10.0.0.5:3478?transport=tcp'])).toMatch(
      /private or reserved address.*SSRF_ALLOW_HOSTS/
    )
    expect(await d.iceProbeRefusal(['stun:[::1]:3478'])).toMatch(/private/)
    expect(await d.iceProbeRefusal(['turn:8.8.8.8:3478', 'stun:1.1.1.1:3478'])).toBeNull()
    await expect(d.huddleFetch('https://10.0.0.5/twirp/x', { method: 'POST' })).rejects.toThrow(
      /private/
    )
  })

  it('seals the three secrets with the app key on shared, opens either form', () => {
    const s = normalizeHuddleSettings({
      turn_urls: ['turn:t.corp:3478'],
      turn_secret: 'coturn-secret',
      livekit_api_secret: 'lk-secret'
    })
    expect(sealHuddleSecrets(s)).toBe(s) // not shared: stored as before
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
    const sealed = sealHuddleSecrets(s)
    expect(sealed.turn_secret).toBe('enc:v1:coturn-secret')
    expect(sealed.livekit_api_secret).toBe('enc:v1:lk-secret')
    expect(sealed.turn_credential).toBeNull()
    expect(sealHuddleSecrets(sealed).turn_secret).toBe('enc:v1:coturn-secret') // not twice
    const opened = normalizeHuddleSettings(openHuddleSecrets(sealed))
    expect(opened.turn_secret).toBe('coturn-secret')
    expect(opened.livekit_api_secret).toBe('lk-secret')
    // one that does not open reads as not set, never as cipher text
    expect(
      normalizeHuddleSettings(openHuddleSecrets({ ...sealed, turn_secret: 'enc:v1:bad' }))
        .turn_secret
    ).toBeNull()
    // plain values (a dedicated app's) pass through
    expect(openHuddleSecrets({ turn_secret: 'plain' })).toEqual({ turn_secret: 'plain' })
  })
})

describe('env mail settings kept for a move to shared', () => {
  const eff = st.smtp
  it('fills only empty columns, only when nothing is saved and a relay is set', () => {
    expect(mailColumnsToKeep({ smtp_host: '' }, eff)).toEqual({
      smtp_host: 'relay.corp.example',
      smtp_port: 587,
      smtp_user: 'mailer',
      smtp_pass: 'pw',
      smtp_from: 'app@corp.example',
      smtp_secure: false
    })
    expect(
      mailColumnsToKeep({ smtp_host: null, smtp_from: 'saved@corp.example', smtp_port: 25 }, eff)
    ).not.toHaveProperty('smtp_from')
    expect(mailColumnsToKeep({ smtp_host: 'saved.example' }, eff)).toBeNull()
    expect(mailColumnsToKeep({ smtp_host: '' }, { ...eff, host: 'localhost' })).toBeNull()
    expect(mailColumnsToKeep(undefined, eff)).toBeNull()
  })

  it('writes them with the password sealed when the app has a key, and logs it', async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64))
    st.row = { id: 1, smtp_host: null, smtp_from: 'saved@corp.example' }
    const r = await keepEnvMailSettings()
    expect(r.kept).toBe(true)
    expect(st.updates).toEqual([
      {
        smtp_host: 'relay.corp.example',
        smtp_port: 587,
        smtp_user: 'mailer',
        smtp_pass: 'enc:v1:pw',
        smtp_secure: false
      }
    ])
    expect(r.fields).not.toContain('smtp_from')
    expect(JSON.stringify(st.activity)).not.toContain('pw"')
  })

  it('stores the password as Settings does without a key; never on a multi-tenant process', async () => {
    vi.stubEnv('ENCRYPTION_KEY', '')
    st.row = { id: 1, smtp_host: '' }
    await keepEnvMailSettings()
    expect(st.updates[0]?.smtp_pass).toBe('pw')
    st.updates = []
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
    expect(await keepEnvMailSettings()).toEqual({ kept: false, fields: [] })
    expect(st.updates).toEqual([])
  })

  it('a second call finds the host saved and does nothing', async () => {
    st.row = { id: 1, smtp_host: 'relay.corp.example' }
    expect(await keepEnvMailSettings()).toEqual({ kept: false, fields: [] })
    expect(st.updates).toEqual([])
  })
})
