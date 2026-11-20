import { describe, expect, it } from 'vitest'
import {
  applyDbUrl,
  guessPooler,
  isConnectionStringKey,
  maskConnectionString,
  normaliseSslMode,
  parseDbUrl
} from '../../../db/connection-url.js'
import { mysqlTenantTls } from '../../../db/tenant-context.js'
import { describeTls, mssqlTlsOptions, resolveTls, sqlSslOption } from '../../../db/tls-options.js'

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'

describe('parseDbUrl', () => {
  it('reads a Postgres URL with sslmode and a CA path', () => {
    const p = parseDbUrl(
      'postgresql://app%40corp:p%40ss%2Fw0rd@db.example.com:6543/nivaro?sslmode=verify-full&sslrootcert=/etc/ca.pem'
    )
    expect(p).toMatchObject({
      client: 'pg',
      host: 'db.example.com',
      port: 6543,
      user: 'app@corp',
      password: 'p@ss/w0rd',
      database: 'nivaro',
      sslMode: 'verify-full',
      sslRootCert: '/etc/ca.pem',
      notes: []
    })
  })

  it('maps every scheme to its client', () => {
    expect(parseDbUrl('postgres://h/d').client).toBe('pg')
    expect(parseDbUrl('mysql://h/d').client).toBe('mysql2')
    expect(parseDbUrl('mariadb://h/d').client).toBe('mariadb')
    expect(parseDbUrl('sqlserver://h/d').client).toBe('mssql')
    expect(parseDbUrl('mssql://h/d').client).toBe('mssql')
    expect(() => parseDbUrl('oracle://h/d')).toThrow(/not supported/)
    expect(() => parseDbUrl('db.example.com')).toThrow(/scheme/)
  })

  it('keeps a port that http would drop and reads IPv6 hosts', () => {
    expect(parseDbUrl('postgres://u@[::1]:80/d')).toMatchObject({ host: '::1', port: 80 })
  })

  it('reads Neon, Supabase and Prisma-style parameters', () => {
    const neon = parseDbUrl(
      'postgresql://u:p@ep-cool-1-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require&options=endpoint%3Dep-cool-1'
    )
    expect(neon).toMatchObject({ sslMode: 'require', options: 'endpoint=ep-cool-1', notes: [] })
    const supa = parseDbUrl(
      'postgres://postgres.ref:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1'
    )
    expect(supa).toMatchObject({ pooler: true, port: 6543, notes: [] })
  })

  it('reads MySQL ssl-mode values', () => {
    expect(parseDbUrl('mysql://h/d?ssl-mode=REQUIRED').sslMode).toBe('require')
    expect(parseDbUrl('mysql://h/d?ssl-mode=VERIFY_IDENTITY').sslMode).toBe('verify-full')
    expect(parseDbUrl('mysql://h/d?ssl-mode=VERIFY_CA&ssl-ca=/ca.pem')).toMatchObject({
      sslMode: 'verify-ca',
      sslRootCert: '/ca.pem'
    })
    expect(parseDbUrl('mysql://h/d?ssl=true').sslMode).toBe('require')
    expect(parseDbUrl('mysql://h/d?ssl=0').sslMode).toBe('disable')
  })

  it('names what it ignores and never the password', () => {
    const p = parseDbUrl('postgres://u:hunter2@h/d?sslmode=prefer&sslcert=/c.pem&weird=1')
    expect(p.sslMode).toBe('require')
    expect(p.notes.join(' ')).toMatch(/prefer.*require/)
    expect(p.notes.join(' ')).toMatch(/client certificates/)
    expect(p.notes.join(' ')).toMatch(/weird/)
    expect(p.notes.join(' ')).not.toMatch(/hunter2/)
  })

  it('reads the SQL Server URL and the Azure portal JDBC form', () => {
    expect(
      parseDbUrl('sqlserver://sa:pw@sql.local:1433/app?encrypt=true&trustServerCertificate=true')
    ).toMatchObject({
      client: 'mssql',
      host: 'sql.local',
      port: 1433,
      database: 'app',
      sslMode: 'require'
    })
    const azure = parseDbUrl(
      'jdbc:sqlserver://myserver.database.windows.net:1433;database=mydb;user=admin@myserver;password={p;w=1}};x};encrypt=true;trustServerCertificate=false;hostNameInCertificate=*.database.windows.net;loginTimeout=30;'
    )
    expect(azure).toMatchObject({
      client: 'mssql',
      host: 'myserver.database.windows.net',
      port: 1433,
      database: 'mydb',
      user: 'admin@myserver',
      password: 'p;w=1};x',
      sslMode: 'verify-full',
      trustServerCertificate: false,
      notes: []
    })
    // encrypt=false
    expect(parseDbUrl('mssql://h;database=d;encrypt=false').sslMode).toBe('disable')
  })

  it('normaliseSslMode', () => {
    expect(normaliseSslMode('verify_full').mode).toBe('verify-full')
    expect(normaliseSslMode('nonsense')).toEqual({ note: 'unknown sslmode "nonsense" ignored' })
  })
})

describe('applyDbUrl', () => {
  it('fills unset DB_* from the URL', () => {
    const env: NodeJS.ProcessEnv = {
      DB_URL: 'postgres://u:secret@db.host:5432/app?sslmode=verify-full&sslrootcert=/ca.pem'
    }
    const r = applyDbUrl(env)
    expect(r.errors).toEqual([])
    expect(env).toMatchObject({
      DB_CLIENT: 'pg',
      DB_HOST: 'db.host',
      DB_PORT: '5432',
      DB_USER: 'u',
      DB_PASSWORD: 'secret',
      DB_DATABASE: 'app',
      DB_SSL_MODE: 'verify-full',
      DB_SSL_CA: '/ca.pem'
    })
  })

  it('explicit DB_* win, with a warning that never shows the password', () => {
    const env: NodeJS.ProcessEnv = {
      DB_URL: 'postgres://u:secret@db.host/app?sslmode=require',
      DB_HOST: 'other.host',
      DB_PASSWORD: 'mine',
      DB_ENCRYPT: 'false'
    }
    const r = applyDbUrl(env)
    expect(env.DB_HOST).toBe('other.host')
    expect(env.DB_PASSWORD).toBe('mine')
    expect(env.DB_SSL_MODE).toBeUndefined()
    expect(r.conflicts).toEqual(['DB_HOST', 'DB_PASSWORD'])
    const all = r.warnings.join('\n')
    expect(all).toMatch(/DB_HOST=other.host.*db.host/)
    expect(all).not.toMatch(/secret|mine/)
    expect(all).toMatch(/DB_ENCRYPT/)
  })

  it('refuses an unusable URL and a migration URL for another engine', () => {
    expect(applyDbUrl({ DB_URL: 'redis://x' }).errors[0]).toMatch(/not supported/)
    const r = applyDbUrl({ DB_URL: 'postgres://h/d', DB_MIGRATION_URL: 'mysql://h/d' })
    expect(r.errors[0]).toMatch(/DB_MIGRATION_URL is a mysql2 URL but DB_CLIENT is pg/)
  })

  it('does nothing without DB_URL', () => {
    const env: NodeJS.ProcessEnv = { DB_HOST: 'h' }
    expect(applyDbUrl(env)).toEqual({ applied: [], conflicts: [], warnings: [], errors: [] })
    expect(env).toEqual({ DB_HOST: 'h' })
  })
})

describe('guessPooler', () => {
  it('knows the managed poolers by name and PgBouncer by port', () => {
    expect(guessPooler('ep-x-pooler.us-east-2.aws.neon.tech', 5432)).toBe('transaction')
    expect(guessPooler('ep-x.us-east-2.aws.neon.tech', 5432)).toBe('none')
    expect(guessPooler('aws-0-us-east-1.pooler.supabase.com', 6543)).toBe('transaction')
    expect(guessPooler('aws-0-us-east-1.pooler.supabase.com', 5432)).toBe('session')
    expect(guessPooler('db.abc.supabase.co', 5432)).toBe('none')
    expect(guessPooler('app.proxy-c1x2.us-east-1.rds.amazonaws.com', 5432)).toBe('transaction')
    expect(guessPooler('localhost', 6432)).toBe('transaction')
    expect(guessPooler('localhost', 6432, 'none')).toBe('none')
  })
})

describe('TLS options', () => {
  const read = () => PEM

  it('legacy DB_ENCRYPT / DB_TRUST_SERVER_CERT give exactly the old options on pg and SQL Server', () => {
    expect(sqlSslOption('pg', { DB_ENCRYPT: false, DB_TRUST_SERVER_CERT: true })).toBe(false)
    expect(sqlSslOption('pg', { DB_ENCRYPT: true, DB_TRUST_SERVER_CERT: true })).toEqual({
      rejectUnauthorized: false
    })
    expect(sqlSslOption('pg', { DB_ENCRYPT: true, DB_TRUST_SERVER_CERT: false })).toEqual({
      rejectUnauthorized: true
    })
    expect(mssqlTlsOptions({ DB_ENCRYPT: true, DB_TRUST_SERVER_CERT: true })).toEqual({
      encrypt: true,
      trustServerCertificate: true
    })
    expect(mssqlTlsOptions({ DB_ENCRYPT: false, DB_TRUST_SERVER_CERT: true })).toEqual({
      encrypt: false,
      trustServerCertificate: true
    })
  })

  it('MySQL: the old pair means the same as elsewhere (host name checked when not trusted)', () => {
    expect(sqlSslOption('mysql2', { DB_ENCRYPT: false })).toBe(false)
    expect(sqlSslOption('mysql2', { DB_ENCRYPT: true, DB_TRUST_SERVER_CERT: true })).toEqual({
      rejectUnauthorized: false
    })
    expect(sqlSslOption('mysql2', { DB_ENCRYPT: true, DB_TRUST_SERVER_CERT: false })).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: true
    })
  })

  it('DB_SSL_MODE drives each driver', () => {
    expect(sqlSslOption('pg', { DB_SSL_MODE: 'disable', DB_ENCRYPT: true })).toBe(false)
    expect(sqlSslOption('pg', { DB_SSL_MODE: 'require' })).toEqual({ rejectUnauthorized: false })
    const ca = sqlSslOption(
      'pg',
      { DB_SSL_MODE: 'verify-ca', DB_SSL_CA: '/ca.pem' },
      read
    ) as Record<string, unknown>
    expect(ca).toMatchObject({ rejectUnauthorized: true, ca: PEM })
    expect((ca.checkServerIdentity as () => unknown)()).toBeUndefined()
    expect(sqlSslOption('pg', { DB_SSL_MODE: 'verify-full', DB_SSL_CA: PEM })).toEqual({
      rejectUnauthorized: true,
      ca: PEM
    })
    expect(sqlSslOption('mysql2', { DB_SSL_MODE: 'verify-ca', DB_SSL_CA: PEM })).toEqual({
      rejectUnauthorized: true,
      ca: PEM,
      verifyIdentity: false
    })
    expect(sqlSslOption('mysql2', { DB_SSL_MODE: 'verify-full' })).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: true
    })
    expect(mssqlTlsOptions({ DB_SSL_MODE: 'verify-full', DB_SSL_CA: PEM })).toEqual({
      encrypt: true,
      trustServerCertificate: false,
      cryptoCredentialsDetails: { ca: PEM }
    })
    expect(mssqlTlsOptions({ DB_SSL_MODE: 'require', DB_TRUST_SERVER_CERT: false })).toEqual({
      encrypt: true,
      trustServerCertificate: true
    })
    expect(mssqlTlsOptions({ DB_SSL_MODE: 'disable' })).toEqual({
      encrypt: false,
      trustServerCertificate: true
    })
  })

  it('verify-full by IP address checks the IP on Postgres', () => {
    const o = sqlSslOption('pg', { DB_SSL_MODE: 'verify-full' }, undefined, '10.0.0.5') as Record<
      string,
      unknown
    >
    const check = o.checkServerIdentity as (h: string, c: unknown) => Error | undefined
    expect(
      check('localhost', { subject: { CN: 'localhost' }, subjectaltname: 'DNS:localhost' })
    ).toBeInstanceOf(Error)
    expect(check('x', { subject: {}, subjectaltname: 'IP Address:10.0.0.5' })).toBeUndefined()
    expect(sqlSslOption('pg', { DB_SSL_MODE: 'verify-full' }, undefined, 'db.host')).toEqual({
      rejectUnauthorized: true
    })
  })

  it('a CA upgrades require to verify-ca and turns TLS on (libpq)', () => {
    expect(resolveTls({ DB_SSL_MODE: 'require', DB_SSL_CA: PEM }).mode).toBe('verify-ca')
    expect(resolveTls({ DB_ENCRYPT: true, DB_TRUST_SERVER_CERT: true, DB_SSL_CA: PEM }).mode).toBe(
      'verify-ca'
    )
    expect(resolveTls({ DB_ENCRYPT: false, DB_SSL_CA: PEM }).mode).toBe('verify-ca')
  })

  it('refuses a bad mode and an unreadable CA file', () => {
    expect(() => resolveTls({ DB_SSL_MODE: 'on' })).toThrow(/DB_SSL_MODE must be one of/)
    expect(() => resolveTls({ DB_SSL_CA: '/nope/ca.pem' })).toThrow(/cannot read \/nope\/ca.pem/)
  })

  it('describeTls', () => {
    expect(describeTls('pg', { DB_ENCRYPT: false })).toBe('disable')
    expect(describeTls('mssql', { DB_SSL_MODE: 'verify-ca', DB_SSL_CA: '/x' })).toBe(
      'verify-ca (DB_SSL_CA) (= verify-full on SQL Server)'
    )
  })
})

describe('mysqlTenantTls', () => {
  it('passes a URL without sslmode through unchanged', () => {
    const uri = 'mysql://u:p@h:3306/t1'
    expect(mysqlTenantTls(uri)).toEqual({ uri })
  })
  it('turns sslmode into mysql2 ssl and drops it from the URI', () => {
    expect(mysqlTenantTls('mysql://u:p@h:3306/t1?sslmode=require&charset=utf8mb4')).toEqual({
      uri: 'mysql://u:p@h:3306/t1?charset=utf8mb4',
      ssl: { rejectUnauthorized: false }
    })
    expect(mysqlTenantTls('mysql://u:p@h/t1?ssl-mode=VERIFY_IDENTITY')).toEqual({
      uri: 'mysql://u:p@h/t1',
      ssl: { rejectUnauthorized: true, verifyIdentity: true }
    })
  })
})

describe('maskConnectionString', () => {
  const M = '••••••'
  it('masks URL userinfo, also with unencoded / or @ in the password', () => {
    expect(maskConnectionString('postgres://user:PASS@host:5432/db?sslmode=require')).toBe(
      `postgres://user:${M}@host:5432/db?sslmode=require`
    )
    expect(maskConnectionString('postgres://u:p@ss@host/db')).toBe(`postgres://u:${M}@host/db`)
    expect(maskConnectionString('postgres://u:pa/ss@host/db')).toBe(`postgres://u:${M}@host/db`)
    expect(maskConnectionString('redis://default:s3cret@redis:6379/0')).toBe(
      `redis://default:${M}@redis:6379/0`
    )
    expect(maskConnectionString('postgres://host/db')).toBe('postgres://host/db')
    expect(maskConnectionString('postgres://user@host/db')).toBe('postgres://user@host/db')
  })
  it('masks JDBC / ODBC property lists, braced values with }} escapes and & inside', () => {
    expect(
      maskConnectionString(
        'jdbc:sqlserver://h:1433;database=d;user=u;password={a;b}}c&d};encrypt=true'
      )
    ).toBe(`jdbc:sqlserver://h:1433;database=d;user=u;password=${M};encrypt=true`)
    expect(maskConnectionString('Server=tcp:h,1433;Uid=u;Pwd=x&y;Encrypt=yes')).toBe(
      `Server=tcp:h,1433;Uid=u;Pwd=${M};Encrypt=yes`
    )
    expect(maskConnectionString('sqlserver://h;PASSWORD = p ;database=d')).toBe(
      `sqlserver://h;PASSWORD =${M};database=d`
    )
  })
  it('masks password= query parameters', () => {
    expect(maskConnectionString('mssql://h/d?user=u&password=p%26q&encrypt=true')).toBe(
      // the backstop runs to the next ';' or the end: an unencoded '&' in the password is covered
      `mssql://h/d?user=u&password=${M}`
    )
  })
  it('fails closed on adversarial passwords', () => {
    const cases: Array<[string, string]> = [
      ['postgres://u:p@ss:w/rd#x?y&z;{}@host:5432/db', `postgres://u:${M}@host:5432/db`],
      ['postgres://u:a@b/c@host/db', `postgres://u:${M}@host/db`],
      ['postgres://u:%40%2F%3A%23@host/db', `postgres://u:${M}@host/db`],
      ['mysql://u:p{w}d;x@h/db', `mysql://u:${M}@h/db`],
      ['postgres://u:pa ss@@@host', `postgres://u:${M}@host`],
      ['postgres://u:pw@host/db?password=a#b&c=1', `postgres://u:${M}@host/db?password=${M}`],
      ['sqlserver://h;password={a;b}}c};x=1', `sqlserver://h;password=${M};x=1`],
      ['Server=h;Pwd= {x;y};Uid=u', `Server=h;Pwd=${M};Uid=u`],
      ['jdbc:sqlserver://h;user=a@b;password=p&q', `jdbc:sqlserver://h;user=a@b;password=${M}`]
    ]
    for (const [raw, want] of cases) {
      const out = maskConnectionString(raw)
      expect(out).toBe(want)
      for (const secret of ['p@ss', 'a@b/c', '%40%2F', 'p{w}d', 'pa ss', 'a;b', 'x;y', 'p&q'])
        if (raw.includes(secret)) expect(out).not.toContain(secret)
    }
    // the JDBC host:port colon can over-mask the user; the password never shows
    const odd = maskConnectionString('jdbc:sqlserver://h:1433;user=a@b;password=s3cret')
    expect(odd).not.toContain('s3cret')
  })

  it('knows the connection-string env names', () => {
    for (const k of [
      'DB_URL',
      'DB_MIGRATION_URL',
      'REDIS_URL',
      'CLOUD_META_DB_URL',
      'TENANT_DATABASE_URL'
    ])
      expect(isConnectionStringKey(k)).toBe(true)
    expect(isConnectionStringKey('PUBLIC_URL')).toBe(false)
  })
})
