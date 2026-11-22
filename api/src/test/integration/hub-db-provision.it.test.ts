// Hub provisioners against real servers (phase 3 task 3; the controller runs it in task 14).
// Skipped unless a provisioning URL is set per engine:
//   HUB_DB_IT_MSSQL_URL=sqlserver://sa:…@127.0.0.1:3100/master?encrypt=true&trustServerCertificate=true
//   HUB_DB_IT_PG_URL=postgres://postgres:…@127.0.0.1:3101/postgres
//   HUB_DB_IT_MYSQL_URL=mysql://root:…@127.0.0.1:3102/mysql
//   HUB_DB_IT_MARIADB_URL=mariadb://root:…@127.0.0.1:3103/mysql
// Only throwaway containers: a URL whose text contains `efp` (any case) is refused.
//
// Per engine: probe → create login + database + owner → checkApp `empty` as the new login →
// ensure* again is a no-op (existing login refused unless owned) → the login can create tables
// (`foreign`, then `nivaro` with a ledger) → a wrong password is `unreachable` and scrubbed →
// drop leaves neither database nor login.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { connectionFromInput, type HubDbEngine } from '../../services/hub/db/connection.js'
import { generatePassword } from '../../services/hub/db/names.js'
import {
  ProvisionError,
  provisionerFor,
  withAppKnex,
  withServerKnex
} from '../../services/hub/db/provisioner.js'

const ENGINES: Array<[HubDbEngine, string]> = [
  ['mssql', 'HUB_DB_IT_MSSQL_URL'],
  ['pg', 'HUB_DB_IT_PG_URL'],
  ['mysql2', 'HUB_DB_IT_MYSQL_URL'],
  ['mariadb', 'HUB_DB_IT_MARIADB_URL']
]

for (const [engine, envName] of ENGINES) {
  const url = process.env[envName]
  describe.skipIf(!url)(`hub provisioner on ${engine} (${envName})`, () => {
    it('create, check, re-run, drop', { timeout: 180_000 }, async () => {
      if (/efp/i.test(String(url))) throw new Error(`${envName} names an EFP server: refused`)
      const parsed = connectionFromInput({ url })
      if (!parsed.ok) throw new Error(`${envName}: ${parsed.message}`)
      const c = parsed.conn
      expect(c.engine).toBe(engine)
      const server = {
        engine,
        host: c.host,
        port: c.port,
        ssl_mode: c.ssl_mode,
        trust_server_cert: c.trust_server_cert
      }
      const admin = { user: c.user, password: c.password }
      const tag = randomBytes(3).toString('hex')
      const db = `nivaro_hubit_${tag}`
      const login = `hubit_${tag}`
      const pw = generatePassword()
      const p = provisionerFor(engine)
      const app = { ...server, database: db, user: login, password: pw }

      let failure: unknown = null
      try {
        await withServerKnex(server, admin, async (k) => {
          const probe = await p.probe(k)
          expect(probe, probe.text).toMatchObject({ ok: true, can_create: true, missing: [] })
          expect(await p.databaseExists(k, db)).toBe(false)
          expect(await p.loginExists(k, login)).toBe(false)
          expect(await p.ensureLogin(k, login, pw)).toBe('created')
          expect(await p.ensureDatabase(k, db, { collation: null, owner: login })).toBe('created')
          await p.ensureOwner(k, db, login)
          expect(await p.databaseExists(k, db)).toBe(true)
          expect(await p.loginExists(k, login)).toBe(true)
        })

        const first = await withAppKnex(app, (k) => p.checkApp(k))
        expect(first.state, first.text).toBe('empty')

        // A retry: nothing new, the same password, no "already exists".
        await withServerKnex(server, admin, async (k) => {
          const err = await p.ensureLogin(k, login, pw).catch((e) => e)
          expect(err).toBeInstanceOf(ProvisionError)
          expect((err as ProvisionError).code).toBe('LOGIN_EXISTS')
          expect(await p.ensureLogin(k, login, pw, { ownedLogin: true })).toBe('updated')
          expect(await p.ensureDatabase(k, db, { collation: null, owner: login })).toBe('existed')
          await p.ensureOwner(k, db, login)
        })

        await withAppKnex(app, async (k) => {
          expect((await p.checkApp(k)).state).toBe('empty')
          await k.schema.createTable('hubit_foreign', (t) => {
            t.increments('id')
          })
          expect((await p.checkApp(k)).state).toBe('foreign')
          await k.schema.createTable('nivaro_migrations', (t) => {
            t.increments('id')
            t.string('name', 255)
          })
          await k('nivaro_migrations').insert({ name: '001_first.ts' })
          await k('nivaro_migrations').insert({ name: '002_second.ts' })
          const n = await p.checkApp(k)
          expect(n).toMatchObject({
            state: 'nivaro',
            migrations: 2,
            last_migration: '002_second.ts'
          })
        })

        const wrong = generatePassword()
        const down = await withAppKnex({ ...app, password: wrong }, (k) => p.checkApp(k))
        expect(down.state).toBe('unreachable')
        expect(down.text).not.toContain(wrong)
        expect(down.text).not.toMatch(new RegExp(`(?<![A-Za-z0-9_])${login}(?![A-Za-z0-9_])`))
      } catch (err) {
        failure = err
        throw err
      } finally {
        // Cleanup always runs; its own error is reported only when the test itself passed.
        await withServerKnex(server, admin, async (k) => {
          await p.drop(k, db, login)
          expect(await p.databaseExists(k, db)).toBe(false)
          expect(await p.loginExists(k, login)).toBe(false)
        }).catch((err) => {
          if (!failure) throw err
        })
      }
    })
  })
}
