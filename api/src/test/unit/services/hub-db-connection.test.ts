import { describe, expect, it } from 'vitest'
import { parseDbUrl } from '../../../db/connection-url.js'
import {
  connectionFromInput,
  connectionUrl,
  DEFAULT_PORTS,
  type HubDbConnection,
  type HubDbEngine,
  knexConfigFor,
  PROVISION_ENGINES,
  scrubDbError
} from '../../../services/hub/db/connection.js'
import {
  defaultDatabaseName,
  defaultLoginName,
  generateHexSecret,
  generatePassword,
  isDbIdentifier
} from '../../../services/hub/db/names.js'

const CLIENT: Record<HubDbEngine, string> = {
  mssql: 'mssql',
  pg: 'pg',
  mysql2: 'mysql2',
  mariadb: 'mariadb'
}

const make = (engine: HubDbEngine, over: Partial<HubDbConnection> = {}): HubDbConnection => ({
  engine,
  host: 'db.example.com',
  port: DEFAULT_PORTS[engine] + 1,
  database: 'nivaro_app_prod',
  user: 'app_prod',
  password: 'p@ss/w#rd%25&?=:',
  ssl_mode: 'verify-full',
  trust_server_cert: false,
  ...over
})

describe('connectionUrl round trip', () => {
  for (const engine of PROVISION_ENGINES) {
    it(`${engine}: parseDbUrl returns the same parts`, () => {
      const c = make(engine)
      const p = parseDbUrl(connectionUrl(c))
      expect(p).toMatchObject({
        client: CLIENT[engine],
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
        sslMode: 'verify-full'
      })
    })
  }

  it('keeps other ssl modes and a trusted certificate', () => {
    expect(parseDbUrl(connectionUrl(make('pg', { ssl_mode: 'require' }))).sslMode).toBe('require')
    expect(parseDbUrl(connectionUrl(make('mysql2', { ssl_mode: 'disable' }))).sslMode).toBe(
      'disable'
    )
    const ms = parseDbUrl(
      connectionUrl(make('mssql', { ssl_mode: 'require', trust_server_cert: true }))
    )
    expect(ms.sslMode).toBe('require')
    expect(ms.trustServerCertificate).toBe(true)
    expect(parseDbUrl(connectionUrl(make('mssql', { ssl_mode: 'disable' }))).sslMode).toBe(
      'disable'
    )
  })

  it('omits the port and ssl when null', () => {
    const url = connectionUrl(make('pg', { port: null, ssl_mode: null }))
    expect(url).not.toContain('?')
    expect(parseDbUrl(url).port).toBeUndefined()
  })

  it('round trips through connectionFromInput', () => {
    const c = make('pg')
    const r = connectionFromInput({ url: connectionUrl(c) })
    expect(r).toEqual({ ok: true, conn: { ...c, trust_server_cert: false } })
  })
})

describe('connectionFromInput', () => {
  const parts = {
    engine: 'mariadb',
    host: 'h.example.com',
    database: 'd',
    user: 'u',
    password: 'pw'
  }
  it('accepts parts', () => {
    const r = connectionFromInput(parts)
    expect(r.ok && r.conn).toMatchObject({ engine: 'mariadb', port: null, ssl_mode: null })
  })
  it('refuses sqlite and unknown schemes', () => {
    for (const url of ['sqlite:///tmp/x.db', 'sqlite:x.db', 'oracle://u:p@h/d', 'nonsense']) {
      const r = connectionFromInput({ url })
      expect(r).toMatchObject({ ok: false, code: 'BAD_CONNECTION' })
    }
    expect(connectionFromInput({ ...parts, engine: 'sqlite' })).toMatchObject({ ok: false })
  })
  it('refuses bad parts', () => {
    for (const bad of [
      null,
      [],
      'x',
      { ...parts, host: '' },
      { ...parts, host: 'a b' },
      { ...parts, host: 'h\u0000' },
      { ...parts, port: 70000 },
      { ...parts, port: 1.5 },
      { ...parts, ssl_mode: 'sometimes' },
      { ...parts, password: undefined },
      { ...parts, user: 'x'.repeat(500) },
      { ...parts, trust_server_cert: 'yes' }
    ]) {
      expect(connectionFromInput(bad)).toMatchObject({ ok: false, code: 'BAD_CONNECTION' })
    }
  })
  it('never repeats the password in a message', () => {
    const r = connectionFromInput({ url: 'postgres://u:Secr3t@@@h:notaport/db' })
    expect(JSON.stringify(r)).not.toContain('Secr3t')
  })
})

describe('knexConfigFor', () => {
  it('uses one pooled connection and bounded timeouts per engine', () => {
    const ms = knexConfigFor({ ...make('mssql'), database: null }) as any
    expect(ms.client).toBe('mssql')
    expect(ms.pool).toEqual({ min: 0, max: 1 })
    expect(ms.acquireConnectionTimeout).toBe(10_000)
    expect(ms.connection.options.requestTimeout).toBe(120_000)
    expect(ms.connection.database).toBeUndefined()
    const pg = knexConfigFor({ ...make('pg'), database: null }) as any
    expect(pg.connection.statement_timeout).toBe(120_000)
    expect(pg.connection.database).toBe('postgres')
    const my = knexConfigFor(make('mysql2')) as any
    expect(my.client).toBe('mysql2')
    expect(my.pool.max).toBe(1)
    const ma = knexConfigFor(make('mariadb')) as any
    expect(ma.client).toBe('mysql2')
  })
  it('default port when null, tls from ssl_mode', () => {
    const pg = knexConfigFor(make('pg', { port: null, ssl_mode: 'disable' })) as any
    expect(pg.connection.port).toBe(5432)
    expect(pg.connection.ssl).toBe(false)
    const ms = knexConfigFor(make('mssql', { ssl_mode: null, trust_server_cert: true })) as any
    expect(ms.connection.options).toMatchObject({ encrypt: true, trustServerCertificate: true })
  })
})

describe('scrubDbError', () => {
  it('removes secrets and connection string users', () => {
    const out = scrubDbError(new Error('connect postgres://u:Secr3t@h/db failed Secr3t'), [
      'Secr3t'
    ])
    expect(out).not.toContain('Secr3t')
    expect(out).not.toContain('u:')
  })
  it('handles encoded secrets, null secrets, jdbc and long text', () => {
    const pw = 'a@b/c#d'
    const out = scrubDbError(
      `bad ${encodeURIComponent(pw)} and ${pw} Password=hunter2;x=1 ${'z'.repeat(1000)}`,
      [pw, null, undefined, '']
    )
    expect(out).not.toContain(pw)
    expect(out).not.toContain(encodeURIComponent(pw))
    expect(out).not.toContain('hunter2')
    expect(out.length).toBeLessThanOrEqual(300)
  })
  it('copes with non-errors', () => {
    expect(scrubDbError({ a: 1 }, [])).toContain('a')
    expect(scrubDbError(undefined, [])).toBeTypeOf('string')
  })
})

describe('names', () => {
  it('database and login names', () => {
    expect(defaultDatabaseName('my-app', 'staging')).toBe('nivaro_my_app_staging')
    expect(defaultLoginName('my-app', 'staging', 'pg')).toBe('my_app_staging')
  })
  it('mysql login for a 40-char app key fits 32 and is stable', () => {
    const key = 'a'.repeat(40)
    for (const e of ['mysql2', 'mariadb'] as const) {
      const a = defaultLoginName(key, 'production', e)
      expect(a.length).toBeLessThanOrEqual(32)
      expect(a).toBe(defaultLoginName(key, 'production', e))
      expect(isDbIdentifier(a)).toBe(true)
    }
    expect(defaultLoginName(key, 'production', 'mysql2')).not.toBe(
      defaultLoginName(key, 'staging', 'mysql2')
    )
  })
  it('long and odd keys still give valid identifiers', () => {
    for (const [a, e] of [
      ['x'.repeat(200), 'y'.repeat(200)],
      ['9lives', '1'],
      ["x'; drop", 'a"b'],
      ['日本語', '[x]'],
      ['', '']
    ]) {
      expect(isDbIdentifier(defaultDatabaseName(a, e))).toBe(true)
      for (const eng of PROVISION_ENGINES) {
        const l = defaultLoginName(a, e, eng)
        expect(isDbIdentifier(l)).toBe(true)
        if (eng.startsWith('m') && eng !== 'mssql') expect(l.length).toBeLessThanOrEqual(32)
      }
    }
  })
  it('isDbIdentifier refuses hostile values', () => {
    for (const v of [
      "x'; drop",
      'a;b',
      '[x]',
      '"x"',
      'x`y',
      'Abc',
      '1abc',
      'a',
      'ünï',
      'a b',
      'a-b',
      'x'.repeat(64),
      '',
      null,
      undefined,
      42,
      'ab\n',
      'ab\u0000'
    ])
      expect(isDbIdentifier(v)).toBe(false)
    expect(isDbIdentifier('x'.repeat(63))).toBe(true)
    expect(isDbIdentifier('nivaro_my_app_2')).toBe(true)
  })
  it('generates strong passwords and hex secrets', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const p = generatePassword()
      expect(p).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z0-9]{32}$/)
      seen.add(p)
    }
    expect(seen.size).toBe(200)
    expect(generateHexSecret()).toMatch(/^[0-9a-f]{64}$/)
    expect(generateHexSecret(8)).toMatch(/^[0-9a-f]{16}$/)
  })
})
