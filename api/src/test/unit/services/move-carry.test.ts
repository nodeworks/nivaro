import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap `watch`, review M1/M4/M5/M6: what a dedicated app carries when the Hub moves it to a
// shared deployment. Its OWN per-instance row (never another environment's) goes to the row keyed
// by the deployment's instance; the env mail settings (and a forced mail test mode) go into that
// row, never the database-wide nivaro_settings row; a database error throws.

type Row = { id: number; instance_key: string; data: string }
const st = vi.hoisted(() => ({
  rows: [] as Row[],
  base: {} as Record<string, unknown>,
  baseWrites: 0,
  fail: false,
  own: 'shop-staging',
  smtp: {
    host: 'relay.corp.example',
    port: 587,
    secure: false,
    user: 'mailer',
    pass: 'pw',
    from: 'app@corp.example',
    testMode: false,
    testRecipient: null as string | null
  },
  activity: [] as unknown[]
}))

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    if (st.fail) throw new Error('database unavailable')
    if (table === 'nivaro_settings') {
      const c: Record<string, unknown> = {}
      c.orderBy = () => c
      c.first = async () => st.base
      c.where = () => ({
        update: async () => {
          st.baseWrites++
          return 1
        }
      })
      return c
    }
    let where: Record<string, unknown> = {}
    const q: Record<string, unknown> = {}
    q.where = (w: Record<string, unknown>) => {
      where = w
      return q
    }
    q.orderBy = () => q
    const match = () =>
      st.rows
        .filter((r) => Object.entries(where).every(([k, v]) => r[k as keyof Row] === v))
        .sort((a, b) => a.id - b.id)
    q.first = async () => match()[0]
    q.update = async (u: { data: string }) => {
      for (const r of match()) r.data = u.data
      return 1
    }
    q.insert = async (r: { instance_key: string; data: string }) => {
      st.rows.push({ id: st.rows.length + 1, instance_key: r.instance_key, data: r.data })
      return [st.rows.length]
    }
    return q
  }
  return { db }
})
vi.mock('../../../services/instance-key.js', () => ({ instanceKey: () => st.own }))
vi.mock('../../../services/encryption.js', () => ({
  isEncrypted: (v: unknown) => typeof v === 'string' && v.startsWith('enc:v1:'),
  encryptValue: (v: string) => `enc:v1:${v}`
}))
vi.mock('../../../services/mail.js', () => ({ getSmtpConfig: async () => st.smtp }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (a: unknown) => {
    st.activity.push(a)
    return 1
  }
}))

const carry = await import('../../../services/move-carry.js')

const dataOf = (key: string) =>
  JSON.parse(st.rows.find((r) => r.instance_key === key)?.data ?? 'null') as Record<
    string,
    unknown
  > | null
const row = (instance_key: string, data: Record<string, unknown>): Row => ({
  id: st.rows.length + 1,
  instance_key,
  data: JSON.stringify(data)
})

beforeEach(() => {
  st.rows = []
  st.base = {}
  st.baseWrites = 0
  st.fail = false
  st.own = 'shop-staging'
  st.activity = []
  st.smtp = { ...st.smtp, testMode: false, testRecipient: null }
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('carrying the per-instance row', () => {
  it('copies its OWN row to the target key, never another environment’s (two candidate rows)', async () => {
    st.rows.push(row('shop-dev', { huddle: { turn_urls: ['turn:dev.corp:3478'] } }))
    st.rows.push(row('shop-staging', { huddle: { turn_urls: ['turn:stg.corp:3478'] } }))
    const r = await carry.carryInstanceRow('pool-a')
    expect(r).toEqual({ result: 'created', keys: ['huddle'], differed: [] })
    expect(dataOf('pool-a')).toEqual({ huddle: { turn_urls: ['turn:stg.corp:3478'] } })
    // both source rows untouched
    expect(dataOf('shop-dev')).toEqual({ huddle: { turn_urls: ['turn:dev.corp:3478'] } })
    expect(dataOf('shop-staging')).toEqual({ huddle: { turn_urls: ['turn:stg.corp:3478'] } })
  })

  it('a database cloned from production carries only this environment’s row', async () => {
    st.rows.push(row('shop-prod', { huddle: { turn_secret: 'prod-secret' }, cache: { a: 1 } }))
    st.rows.push(row('shop-staging', { outside_writes: { enabled: false } }))
    await carry.carryInstanceRow('pool-a')
    expect(dataOf('pool-a')).toEqual({ outside_writes: { enabled: false } })
    expect(JSON.stringify(st.rows.find((r) => r.instance_key === 'pool-a'))).not.toContain('prod')
    // no row of its own: nothing is carried (never production's)
    st.rows = [row('shop-prod', { huddle: { turn_secret: 'prod-secret' } })]
    expect(await carry.carryInstanceRow('pool-a')).toMatchObject({ result: 'none' })
    expect(dataOf('pool-a')).toBeNull()
  })

  it('a retried move fills only empty keys and names the ones that differ', async () => {
    st.rows.push(row('shop-staging', { huddle: { a: 1 }, ops_report: { on: true }, cache: {} }))
    st.rows.push(row('pool-a', { huddle: { a: 2 }, ops_report: null }))
    const r = await carry.carryInstanceRow('pool-a')
    expect(r).toEqual({ result: 'filled', keys: ['cache', 'ops_report'], differed: ['huddle'] })
    expect(dataOf('pool-a')).toEqual({ huddle: { a: 2 }, ops_report: { on: true }, cache: {} })
    // again: nothing more to do
    expect(await carry.carryInstanceRow('pool-a')).toEqual({
      result: 'same',
      keys: [],
      differed: ['huddle']
    })
  })

  it('the same key as its own is a no-op; a bad key or a multi-tenant process throws', async () => {
    st.rows.push(row('shop-staging', { huddle: {} }))
    expect(await carry.carryInstanceRow('shop-staging')).toMatchObject({ result: 'same' })
    await expect(carry.carryInstanceRow('pool a;drop')).rejects.toThrow(/bad target/)
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
    await expect(carry.carryInstanceRow('pool-a')).rejects.toThrow(/multi-tenant/)
  })

  it('a database error throws (the route answers 503, the move stops)', async () => {
    st.fail = true
    await expect(carry.carryInstanceRow('pool-a')).rejects.toThrow(/database/)
    await expect(carry.keepEnvMail('pool-a')).rejects.toThrow(/database/)
  })
})

describe('keeping the env mail settings', () => {
  it('writes them into the target instance row, never the database-wide settings row', async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64))
    const r = await carry.keepEnvMail('pool-a')
    expect(r).toEqual({
      env_mail: 'kept',
      fields: ['smtp_from', 'smtp_host', 'smtp_pass', 'smtp_port', 'smtp_secure', 'smtp_user']
    })
    expect(dataOf('pool-a')).toMatchObject({
      smtp_host: 'relay.corp.example',
      smtp_user: 'mailer',
      smtp_pass: 'enc:v1:pw'
    })
    expect(st.baseWrites).toBe(0)
    expect(JSON.stringify(st.activity)).not.toContain('"pw"')
  })

  it('fills only what neither the saved settings nor the carried row hold', async () => {
    st.base = { smtp_host: null, smtp_from: 'saved@corp.example', smtp_secure: false }
    st.rows.push(row('pool-a', { smtp_user: 'carried' }))
    await carry.keepEnvMail('pool-a')
    const d = dataOf('pool-a') as Record<string, unknown>
    expect(d.smtp_user).toBe('carried')
    expect(d).not.toHaveProperty('smtp_from')
    expect(d).not.toHaveProperty('smtp_secure')
    // a second call: everything is there now
    expect((await carry.keepEnvMail('pool-a')).env_mail).toBe('none_needed')
  })

  it('a mail test mode the environment forces stays on, with its recipient', async () => {
    st.smtp = { ...st.smtp, testMode: true, testRecipient: 'qa@corp.example' }
    st.base = { mail_test_mode: false }
    await carry.keepEnvMail('pool-a')
    expect(dataOf('pool-a')).toMatchObject({
      mail_test_mode: true,
      mail_test_recipient: 'qa@corp.example'
    })
    // already on in the saved settings: left alone
    st.rows = []
    st.base = { mail_test_mode: 1, mail_test_recipient: 'saved@corp.example' }
    await carry.keepEnvMail('pool-a')
    expect(dataOf('pool-a')).not.toHaveProperty('mail_test_mode')
  })

  it('nothing without a relay; the password plain without a key', async () => {
    st.smtp = { ...st.smtp, host: 'localhost' }
    expect(await carry.keepEnvMail('pool-a')).toEqual({ env_mail: 'none_needed', fields: [] })
    st.smtp = { ...st.smtp, host: 'relay.corp.example' }
    vi.stubEnv('ENCRYPTION_KEY', '')
    await carry.keepEnvMail('pool-a')
    expect(dataOf('pool-a')?.smtp_pass).toBe('pw')
  })
})
