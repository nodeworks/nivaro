import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DB_IDENTITY_DEFAULT_PORT,
  DB_IDENTITY_SQL,
  dbIdentitySql,
  formatDbIdentity,
  oidcIdentity
} from '../../../services/db-identity.js'

// Hub phase 6 parked wave (T9 Minor 10): the server-identity statements and the OIDC identity rule
// lived in three / two copies (Hub database checks, a shared deployment's db-check, a dedicated
// app's shared readiness). One leaf now; the move plan compares identities across them, so they
// must never drift.

describe('formatDbIdentity', () => {
  it('engine|server|port|database, lower case, from what the server reported', () => {
    expect(
      formatDbIdentity(
        'pg',
        { s: '10.0.0.5', p: 5433, d: 'App_A' },
        {
          server: 'db.internal',
          port: 5432,
          database: 'x'
        }
      )
    ).toBe('pg|10.0.0.5|5433|app_a')
  })

  it('an empty server, port or database falls back to the configured one', () => {
    expect(
      formatDbIdentity(
        'mssql',
        { s: '  ', p: null, d: '' },
        {
          server: 'SQL01',
          port: DB_IDENTITY_DEFAULT_PORT.mssql,
          database: 'EFP'
        }
      )
    ).toBe('mssql|sql01|1433|efp')
    expect(formatDbIdentity('mysql2', undefined, { server: 'h', port: null, database: 'd' })).toBe(
      'mysql2|h|null|d'
    )
    // a port reported as text is a number all the same
    expect(
      formatDbIdentity(
        'mariadb',
        { s: 'h', p: '3307', d: 'd' },
        { server: '', port: 1, database: '' }
      )
    ).toBe('mariadb|h|3307|d')
  })

  it('SQLite and unknown clients have no statement', () => {
    expect(dbIdentitySql('sqlite3')).toBeNull()
    expect(dbIdentitySql('better-sqlite3')).toBeNull()
    expect(dbIdentitySql('constructor')).toBeNull()
    expect(dbIdentitySql('pg')).toBe(DB_IDENTITY_SQL.pg)
    expect(dbIdentitySql('mariadb')).toBe(DB_IDENTITY_SQL.mariadb)
  })
})

describe('oidcIdentity', () => {
  it('host plus the Entra tenant segment; none for a version-only path; null when unset or bad', () => {
    expect(oidcIdentity('https://login.microsoftonline.com/T1/v2.0')).toEqual({
      issuer_host: 'login.microsoftonline.com',
      tenant: 't1'
    })
    expect(oidcIdentity('https://idp.example.test/v2')).toEqual({
      issuer_host: 'idp.example.test',
      tenant: null
    })
    expect(oidcIdentity('')).toBeNull()
    expect(oidcIdentity(null)).toBeNull()
    expect(oidcIdentity('not a url')).toBeNull()
  })
})

describe('one copy', () => {
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
  function* files(dir: string): Generator<string> {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) {
        if (n === 'test' || n === 'node_modules') continue
        yield* files(p)
      } else if (n.endsWith('.ts')) yield p
    }
  }

  it('no other module carries the identity statements or its own oidcIdentity', () => {
    const offenders: string[] = []
    for (const f of files(SRC)) {
      if (f.endsWith('services/db-identity.ts')) continue
      const s = readFileSync(f, 'utf8')
      if (/AS s, CAST\(NULL AS int\) AS p|inet_server_port\(\) AS p|@@port AS p/.test(s))
        offenders.push(f.slice(SRC.length))
      if (/function oidcIdentity\s*\(/.test(s))
        offenders.push(`${f.slice(SRC.length)} (oidcIdentity)`)
    }
    expect(offenders).toEqual([])
  })
})
