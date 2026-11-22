import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 4, Task 7: per-environment stack settings. Real SQLite with the migration
// 542 + 546 tables. Secrets are one sealed JSON blob; SESSION_SECRET / ENCRYPTION_KEY and the
// environment's hub token are generated on first save and never regenerated; no secret value
// appears in the stored column, a public answer or a refusal.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up: up542 } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up546 } = await import('../../../db/migrations/546_hub_stack_settings.js')
const S = await import('../../../services/hub/docker/stack-settings.js')
const { HUB_MASK, openSecret, sealSecret } = await import('../../../services/hub/secrets.js')
const { environmentFromRow } = await import('../../../services/hub/apps.js')

type Env = import('../../../services/hub/promote-types.js').HubEnvironmentRow
type Body = Record<string, unknown>

const KEY = 'a'.repeat(64)
const HEX64 = /^[0-9a-f]{64}$/
const DB_PASS = 'pw-Plain-Value-123'
const DIGEST = `sha256:${'2'.repeat(64)}`

const driver = {
  agent_url: 'https://agent.example.com',
  dns_mode: 'automatic' as const,
  wildcard_domain: 'apps.example.com',
  edge_target: null
}

let envId = 0
let prevKey: string | undefined

async function newEnv(hubToken: string | null = null): Promise<Env> {
  const [row] = await db('nivaro_hub_environments')
    .insert({
      app_id: 1,
      key: `e${++envId}`,
      base_url: `https://e${envId}.apps.example.com`,
      hostnames: '[]',
      hub_token: hubToken
    })
    .returning('id')
  const id = typeof row === 'object' ? (row as { id: number }).id : row
  return envOf(Number(id))
}
async function envOf(id: number): Promise<Env> {
  return environmentFromRow(await db('nivaro_hub_environments').where({ id }).first()) as Env
}
const rawEnv = (id: number) => db('nivaro_hub_environments').where({ id }).first()

async function validate(env: Env, body: Body) {
  return S.validateStackSettings(body, await S.readStackSettings(env.id), { driver, env })
}
async function save(env: Env, body: Body) {
  const v = await validate(env, body)
  if (!v.ok) throw new Error(`${v.code}: ${v.message}`)
  return S.saveStackSettings(env.id, v.row.fields, v.row.extension_pins)
}
async function codeOf(env: Env, body: Body): Promise<string | null> {
  const v = await validate(env, body)
  return v.ok ? null : v.code
}
async function opened(env: Env) {
  return S.openStackSecrets(await S.readStackSettings(env.id))
}

const PG = { DB_CLIENT: 'pg', DB_HOST: 'db.internal', DB_DATABASE: 'acme', DB_USER: 'acme' }

describe('hub stack settings', () => {
  beforeAll(async () => {
    prevKey = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = KEY
    await up542(db)
    await up546(db)
  })
  afterAll(async () => {
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prevKey
    await db.destroy()
  })
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY
  })

  it('first save generates SESSION_SECRET, ENCRYPTION_KEY and a sealed hub token', async () => {
    const env = await newEnv()
    const row = await save(env, { size: 'small', settings: PG, secrets: { DB_PASSWORD: DB_PASS } })
    expect(row.size).toBe('small')
    const s = await opened(env)
    expect(s.SESSION_SECRET).toMatch(HEX64)
    expect(s.ENCRYPTION_KEY).toMatch(HEX64)
    expect(s.SESSION_SECRET).not.toBe(s.ENCRYPTION_KEY)
    expect(s.DB_PASSWORD).toBe(DB_PASS)
    const raw = await rawEnv(env.id)
    expect(String(raw.hub_token)).toMatch(/^enc:v1:/)
    expect(openSecret(raw.hub_token)).toMatch(HEX64)
  })

  it('stores no plaintext secret in the secrets column', async () => {
    const env = await newEnv()
    await save(env, { settings: PG, secrets: { DB_PASSWORD: DB_PASS } })
    const stored = await db('nivaro_hub_stack_settings').where({ environment_id: env.id }).first()
    expect(String(stored.secrets)).toMatch(/^enc:v1:/)
    const s = await opened(env)
    for (const v of Object.values(s)) expect(String(stored.secrets)).not.toContain(v)
    expect(JSON.stringify(stored)).not.toContain(DB_PASS)
    expect(JSON.parse(stored.settings)).toEqual(PG)
  })

  it('a later save never regenerates a secret or the hub token', async () => {
    const env = await newEnv()
    await save(env, { settings: PG })
    const first = await opened(env)
    const token = (await rawEnv(env.id)).hub_token
    await save(env, { size: 'medium' })
    await save(env, { secrets: { DB_PASSWORD: 'x' } })
    const later = await opened(env)
    expect(later.SESSION_SECRET).toBe(first.SESSION_SECRET)
    expect(later.ENCRYPTION_KEY).toBe(first.ENCRYPTION_KEY)
    expect((await rawEnv(env.id)).hub_token).toBe(token)
  })

  it('keeps an environment hub token that already exists', async () => {
    const sealed = sealSecret('existing-hub-token-value-0000000000')
    const env = await newEnv(sealed)
    await save(env, { settings: PG })
    expect((await rawEnv(env.id)).hub_token).toBe(sealed)
  })

  it('takes a SESSION_SECRET / ENCRYPTION_KEY given on first save', async () => {
    const env = await newEnv()
    const mine = 'b'.repeat(32) + '0123456789abcdef'.repeat(2)
    await save(env, {
      settings: PG,
      secrets: { SESSION_SECRET: mine, ENCRYPTION_KEY: 'c'.repeat(64) }
    })
    const s = await opened(env)
    expect(s.SESSION_SECRET).toBe(mine)
    expect(s.ENCRYPTION_KEY).toBe('c'.repeat(64))
  })

  it('answers secrets only as masks', async () => {
    const env = await newEnv()
    await save(env, { settings: PG, secrets: { DB_PASSWORD: DB_PASS } })
    const pub = S.publicStackSettings(await S.readStackSettings(env.id))
    expect(pub?.secrets).toEqual({
      DB_PASSWORD: HUB_MASK,
      ENCRYPTION_KEY: HUB_MASK,
      SESSION_SECRET: HUB_MASK
    })
    expect(pub?.settings).toEqual(PG)
    const text = JSON.stringify(pub)
    for (const v of Object.values(await opened(env))) expect(text).not.toContain(v)
    expect(S.publicStackSettings(null)).toBeNull()
  })

  it('merges secrets per key: the mask keeps, empty clears, text reseals', async () => {
    const env = await newEnv()
    await save(env, { settings: PG, secrets: { DB_PASSWORD: DB_PASS, MAIL_PASS: 'm1' } })
    const before = (await S.readStackSettings(env.id))?.secrets
    await save(env, { secrets: { DB_PASSWORD: HUB_MASK, MAIL_PASS: '' } })
    let s = await opened(env)
    expect(s.DB_PASSWORD).toBe(DB_PASS)
    expect(s).not.toHaveProperty('MAIL_PASS')
    await save(env, { secrets: { DB_PASSWORD: 'new-pass', MAIL_PASS: null } })
    s = await opened(env)
    expect(s.DB_PASSWORD).toBe('new-pass')
    expect((await S.readStackSettings(env.id))?.secrets).not.toBe(before)
    // secrets left out of the body are kept
    await save(env, { size: 'small' })
    expect((await opened(env)).DB_PASSWORD).toBe('new-pass')
  })

  it('refuses clearing a generated secret', async () => {
    const env = await newEnv()
    await save(env, { settings: PG })
    expect(await codeOf(env, { secrets: { SESSION_SECRET: '' } })).toBe('SECRET_REQUIRED')
    expect(await codeOf(env, { secrets: { ENCRYPTION_KEY: null } })).toBe('SECRET_REQUIRED')
    expect(await codeOf(env, { secrets: { ENCRYPTION_KEY: 'short' } })).toBe('BAD_VALUE')
    expect(await codeOf(env, { secrets: { SESSION_SECRET: 'aaaaaaaa' } })).toBe('BAD_VALUE')
  })

  it('refuses a secret-looking key as a plain setting', async () => {
    const env = await newEnv()
    expect(await codeOf(env, { settings: { ...PG, DB_PASSWORD: 'x' } })).toBe('SECRET_IN_SETTINGS')
    expect(await codeOf(env, { settings: { SMTP_AUTH_USER: 'x' } })).toBe('SECRET_IN_SETTINGS')
    expect(await codeOf(env, { settings: { API_KEY: 'x' } })).toBe('SECRET_IN_SETTINGS')
  })

  // Every key the renderer or the agent owns, and every env family the agent refuses: as a plain
  // setting AND as a secret.
  const RESERVED = [
    'PUBLIC_URL',
    'ADMIN_URL',
    'HUB_TOKEN',
    'HUB_URL',
    'MIGRATION_SAFE_MODE',
    'NODE_ENV',
    'NIVARO_ENVIRONMENT',
    'NIVARO_ROLE',
    'STORAGE_LOCAL_ROOT',
    'REDIS_URL',
    'SOCKETS',
    'CRON_TICKS',
    'IMPORT_WORKER',
    'MEDIA_WORKER',
    'VIDEO_RENDER',
    'PORT',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'OPENSSL_CONF',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'PATH',
    'HOME',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'NIVARO_APP_UID',
    'NIVARO_RUN_AS',
    'DB_HOST_FILE',
    'SESSION_SECRET_FILE',
    'ANYTHING_FILE'
  ]
  it.each(RESERVED)('refuses %s as a setting and as a secret', async (k) => {
    const env = await newEnv()
    expect(await codeOf(env, { settings: { [k]: 'v' } })).toBe('RESERVED_SETTING')
    expect(await codeOf(env, { secrets: { [k]: 'v' } })).toBe('RESERVED_SETTING')
  })

  it('allows the NIVARO_* keys the agent allows', async () => {
    const env = await newEnv()
    expect(
      await codeOf(env, {
        settings: {
          ...PG,
          NIVARO_INSTANCE: 'a',
          NIVARO_EXPECTED_DB: 'acme',
          NIVARO_HEAP_FROM_CGROUP: 'off'
        }
      })
    ).toBeNull()
  })

  it('REDIS_URL belongs to the settings only while redis is external', async () => {
    const env = await newEnv()
    expect(
      await codeOf(env, { redis: 'external', settings: { REDIS_URL: 'redis://r:6379' } })
    ).toBeNull()
    expect(
      await codeOf(env, { redis: 'external', secrets: { REDIS_URL: 'redis://:pw@r:6379' } })
    ).toBeNull()
    await save(env, { redis: 'external', settings: { ...PG, REDIS_URL: 'redis://r:6379' } })
    // switching back to bundled with the stored REDIS_URL is refused
    expect(await codeOf(env, { redis: 'bundled' })).toBe('RESERVED_SETTING')
  })

  it('refuses a key that is both a setting and a secret', async () => {
    const env = await newEnv()
    expect(await codeOf(env, { settings: { DB_HOST: 'h' }, secrets: { DB_HOST: 'h' } })).toBe(
      'BAD_KEY'
    )
  })

  it('checks size, redis, keys, publish port and DB_CLIENT', async () => {
    const env = await newEnv()
    expect(await codeOf(env, { size: 'huge' })).toBe('BAD_SIZE')
    expect(await codeOf(env, { redis: 'shared' })).toBe('BAD_REDIS')
    expect(await codeOf(env, { settings: { lower: 'x' } })).toBe('BAD_KEY')
    expect(await codeOf(env, { settings: { '1X': 'x' } })).toBe('BAD_KEY')
    expect(await codeOf(env, { secrets: { 'bad-key': 'x' } })).toBe('BAD_KEY')
    expect(await codeOf(env, { settings: 'nope' })).toBe('BAD_KEY')
    expect(await codeOf(env, { settings: { X: 1 } })).toBe('BAD_VALUE')
    expect(await codeOf(env, { settings: { X: 'v'.repeat(5000) } })).toBe('BAD_VALUE')
    expect(await codeOf(env, { publish_port: 0 })).toBe('BAD_PUBLISH_PORT')
    expect(await codeOf(env, { publish_port: 70000 })).toBe('BAD_PUBLISH_PORT')
    expect(await codeOf(env, { publish_port: '31000' })).toBe('BAD_PUBLISH_PORT')
    expect(await codeOf(env, { publish_port: 31000 })).toBeNull()
    expect(await codeOf(env, { publish_port: null })).toBeNull()
    expect(await codeOf(env, { settings: { DB_CLIENT: 'oracle' } })).toBe('BAD_DB_CLIENT')
  })

  it('SQLite runs one process: small only', async () => {
    const env = await newEnv()
    const lite = { DB_CLIENT: 'sqlite', DB_DATABASE: '/data/app.db' }
    expect(await codeOf(env, { size: 'medium', settings: lite })).toBe('SQLITE_ONE_PROCESS')
    expect(await codeOf(env, { size: 'large', settings: lite })).toBe('SQLITE_ONE_PROCESS')
    expect(await codeOf(env, { size: 'small', settings: lite })).toBeNull()
    await save(env, { size: 'small', settings: lite })
    expect(await codeOf(env, { size: 'medium' })).toBe('SQLITE_ONE_PROCESS')
  })

  it('checks extension pins and writes them to the environment', async () => {
    const env = await newEnv()
    const good = { 'acme-tools': `registry.example.com/acme/tools-ext@${DIGEST}` }
    expect(await codeOf(env, { extension_pins: { 'acme-tools': 'acme/tools:1.0' } })).toBe(
      'BAD_EXTENSION_PIN'
    )
    expect(
      await codeOf(env, { extension_pins: { 'acme-tools': `acme/tools@sha256:${'A'.repeat(64)}` } })
    ).toBe('BAD_EXTENSION_PIN')
    expect(await codeOf(env, { extension_pins: { Acme: `acme/tools@${DIGEST}` } })).toBe(
      'BAD_EXTENSION_PIN'
    )
    expect(await codeOf(env, { extension_pins: ['x'] })).toBe('BAD_EXTENSION_PIN')
    await save(env, { settings: PG, extension_pins: good })
    expect(JSON.parse((await rawEnv(env.id)).extension_pins)).toEqual(good)
    // left out = unchanged
    await save(env, { size: 'small' })
    expect(JSON.parse((await rawEnv(env.id)).extension_pins)).toEqual(good)
  })

  it('never echoes a secret value in a refusal', async () => {
    const env = await newEnv()
    const value = 'leak-me-if-you-can-12345'
    const bodies: Body[] = [
      { settings: { DB_PASSWORD: value } },
      { settings: { PUBLIC_URL: value } },
      { secrets: { HUB_TOKEN: value } },
      { secrets: { NODE_OPTIONS: value } },
      { secrets: { SESSION_SECRET: value.slice(0, 10) } },
      { secrets: { ENCRYPTION_KEY: value } },
      { secrets: { X: value.repeat(5000) } },
      { size: 'medium', settings: { DB_CLIENT: 'sqlite', DB_DATABASE: value } },
      { extension_pins: { x: value } }
    ]
    for (const b of bodies) {
      const v = await validate(env, b)
      expect(v.ok).toBe(false)
      expect(JSON.stringify(v)).not.toContain(value.slice(0, 10))
    }
  })

  it('a validated row carries secrets only sealed', async () => {
    const env = await newEnv()
    const v = await validate(env, { settings: PG, secrets: { DB_PASSWORD: DB_PASS } })
    expect(v.ok).toBe(true)
    expect(JSON.stringify(v)).not.toContain(DB_PASS)
  })

  it('stores each secret sealed inside the sealed column', async () => {
    const env = await newEnv()
    await save(env, { settings: PG, secrets: { DB_PASSWORD: DB_PASS } })
    const stored = await db('nivaro_hub_stack_settings').where({ environment_id: env.id }).first()
    const inner = JSON.parse(openSecret(stored.secrets) as string)
    expect(Object.keys(inner).sort()).toEqual(['DB_PASSWORD', 'ENCRYPTION_KEY', 'SESSION_SECRET'])
    for (const v of Object.values(inner)) expect(String(v)).toMatch(/^enc:v1:/)
    expect(JSON.stringify(inner)).not.toContain(DB_PASS)
  })

  it('TRUST_PROXY is a setting, never a secret', async () => {
    const env = await newEnv()
    expect(await codeOf(env, { settings: { ...PG, TRUST_PROXY: '1' } })).toBeNull()
    expect(await codeOf(env, { settings: { ...PG, TRUST_PROXY: '' } })).toBeNull()
    expect(await codeOf(env, { secrets: { TRUST_PROXY: '1' } })).toBe('RESERVED_SETTING')
  })

  it('replacing a generated secret needs rotate', async () => {
    const env = await newEnv()
    await save(env, { settings: PG })
    const first = await opened(env)
    const next = 'd'.repeat(64)
    expect(await codeOf(env, { secrets: { ENCRYPTION_KEY: next } })).toBe('SECRET_REQUIRED')
    expect(
      await codeOf(env, { secrets: { SESSION_SECRET: `${'e'.repeat(32)}0123456789abcdef` } })
    ).toBe('SECRET_REQUIRED')
    // the same value again is no replacement
    expect(await codeOf(env, { secrets: { ENCRYPTION_KEY: first.ENCRYPTION_KEY } })).toBeNull()
    expect(await codeOf(env, { rotate: ['DB_PASSWORD'] })).toBe('BAD_KEY')
    expect(await codeOf(env, { rotate: 'ENCRYPTION_KEY' })).toBe('BAD_KEY')
    await save(env, { rotate: ['ENCRYPTION_KEY'], secrets: { ENCRYPTION_KEY: next } })
    const later = await opened(env)
    expect(later.ENCRYPTION_KEY).toBe(next)
    expect(later.SESSION_SECRET).toBe(first.SESSION_SECRET)
  })

  it('refuses a value made only of mask characters', async () => {
    const env = await newEnv()
    await save(env, { settings: PG, secrets: { DB_PASSWORD: DB_PASS } })
    expect(await codeOf(env, { settings: { X: '•••' } })).toBe('BAD_VALUE')
    expect(await codeOf(env, { settings: { X: HUB_MASK } })).toBe('BAD_VALUE')
    expect(await codeOf(env, { secrets: { DB_PASSWORD: ` ${HUB_MASK} ` } })).toBe('BAD_VALUE')
    expect(await codeOf(env, { secrets: { DB_PASSWORD: '••••••••' } })).toBe('BAD_VALUE')
    expect(await codeOf(env, { secrets: { DB_PASSWORD: HUB_MASK } })).toBeNull()
    expect(await codeOf(env, { settings: { X: 'a•b' } })).toBeNull()
  })

  it('a REDIS_URL with a password belongs in the secrets', async () => {
    const env = await newEnv()
    const ext = { redis: 'external' }
    expect(await codeOf(env, { ...ext, settings: { REDIS_URL: 'redis://:pw@r:6379' } })).toBe(
      'SECRET_IN_SETTINGS'
    )
    expect(await codeOf(env, { ...ext, settings: { REDIS_URL: 'redis://u:pw@r:6379/1' } })).toBe(
      'SECRET_IN_SETTINGS'
    )
    expect(await codeOf(env, { ...ext, settings: { REDIS_URL: 'redis://r:6379' } })).toBeNull()
    expect(await codeOf(env, { ...ext, secrets: { REDIS_URL: 'redis://:pw@r:6379' } })).toBeNull()
  })

  // Keys built to slip past a naive check.
  const oddKeys: Array<[string, Record<string, unknown>]> = [
    ['lower-case', { node_options: '--require /x' }],
    ['padded', { ' DB_HOST': 'h' }],
    ['trailing space', { 'DB_HOST ': 'h' }],
    ['unicode lookalike', { 'DB_H\u041eST': 'h' }],
    ['__proto__', JSON.parse('{"__proto__": "x"}')],
    ['constructor', { constructor: 'x' }]
  ]
  it.each(oddKeys)('refuses a %s key as a setting and as a secret', async (_label, map) => {
    const env = await newEnv()
    expect(await codeOf(env, { settings: map })).toBe('BAD_KEY')
    expect(await codeOf(env, { secrets: map })).toBe('BAD_KEY')
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('two first saves at once: the unique clash retries as an update', async () => {
    const env = await newEnv()
    const v = await validate(env, { settings: PG })
    if (!v.ok) throw new Error(v.code)
    // The other save lands between our read and our insert: it stored its own SESSION_SECRET.
    const theirs = sealSecret(JSON.stringify({ SESSION_SECRET: sealSecret('f'.repeat(64)) }))
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((async () => {
      await db('nivaro_hub_stack_settings').insert({ environment_id: env.id, secrets: theirs })
      throw Object.assign(new Error('UNIQUE constraint failed: nivaro_hub_stack_settings'), {
        code: 'SQLITE_CONSTRAINT_UNIQUE'
      })
    }) as never)
    try {
      await S.saveStackSettings(env.id, v.row.fields, v.row.extension_pins)
    } finally {
      spy.mockRestore()
    }
    const rows = await db('nivaro_hub_stack_settings').where({ environment_id: env.id })
    expect(rows).toHaveLength(1)
    const s = await opened(env)
    expect(s.SESSION_SECRET).toBe('f'.repeat(64))
    expect(s.ENCRYPTION_KEY).toMatch(HEX64)
    expect(JSON.parse(rows[0].settings)).toEqual(PG)
  })

  it('lists the names other environments claim', async () => {
    const a = await newEnv()
    await db('nivaro_hub_environments')
      .where({ id: a.id })
      .update({ hostnames: JSON.stringify(['WWW.claimed.example.com']) })
    const b = await newEnv()
    const taken = await S.otherEnvironmentNames(b.id)
    expect(taken.has(new URL(a.base_url).hostname)).toBe(true)
    expect(taken.has('www.claimed.example.com')).toBe(true)
    expect(taken.has(new URL(b.base_url).hostname)).toBe(false)
  })
})

describe('missingSettings', () => {
  const row = (
    settings: Record<string, string>,
    redis: 'bundled' | 'external' = 'bundled'
  ): import('../../../services/hub/docker/stack-settings.js').StackSettingsRow => ({
    environment_id: 1,
    size: 'small',
    redis,
    publish_port: null,
    settings,
    secrets: null
  })
  const gen = { SESSION_SECRET: 's', ENCRYPTION_KEY: 'e' }

  it('pg needs host, database, user and the password secret', () => {
    expect(S.missingSettings(row(PG), { ...gen, DB_PASSWORD: 'p' })).toEqual([])
    expect(S.missingSettings(row({ DB_CLIENT: 'pg' }), gen)).toEqual([
      'DB_HOST',
      'DB_DATABASE',
      'DB_USER',
      'DB_PASSWORD'
    ])
  })

  it('sqlite needs only the database file', () => {
    expect(S.missingSettings(row({ DB_CLIENT: 'sqlite', DB_DATABASE: '/d.db' }), gen)).toEqual([])
    expect(S.missingSettings(row({ DB_CLIENT: 'sqlite' }), gen)).toEqual(['DB_DATABASE'])
  })

  it('external redis needs REDIS_URL (a setting or a secret)', () => {
    const p = { ...gen, DB_PASSWORD: 'p' }
    expect(S.missingSettings(row(PG, 'external'), p)).toEqual(['REDIS_URL'])
    expect(S.missingSettings(row({ ...PG, REDIS_URL: 'redis://r' }, 'external'), p)).toEqual([])
    expect(S.missingSettings(row(PG, 'external'), { ...p, REDIS_URL: 'redis://r' })).toEqual([])
  })

  it('no row = everything', () => {
    expect(S.missingSettings(null, {})).toEqual([
      'DB_CLIENT',
      'DB_HOST',
      'DB_DATABASE',
      'DB_USER',
      'DB_PASSWORD',
      'SESSION_SECRET',
      'ENCRYPTION_KEY'
    ])
  })
})
