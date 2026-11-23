import { describe, expect, it } from 'vitest'
import { mssqlUrlConnection } from '../../../db/mssql-url-connection.js'

describe('mssqlUrlConnection (SQL Server URL options reach tedious as booleans)', () => {
  it('encrypt=false: an object with encrypt false, never the string "false"', () => {
    const c = mssqlUrlConnection(
      'mssql://pole_dev:p%40ss@host.docker.internal:14333/PoleAgreement_Dev?encrypt=false'
    )
    expect(c).toMatchObject({
      server: 'host.docker.internal',
      port: 14333,
      database: 'PoleAgreement_Dev',
      user: 'pole_dev',
      password: 'p@ss'
    })
    const o = (c as { options: { encrypt: unknown; trustServerCertificate: unknown } }).options
    expect(o.encrypt).toBe(false)
    expect(typeof o.trustServerCertificate).toBe('boolean')
  })

  it('encrypt=true&trustServerCertificate=true: encrypted, certificate trusted', () => {
    const c = mssqlUrlConnection(
      'sqlserver://u:p@db.example.com/app?encrypt=true&trustServerCertificate=true'
    )
    expect((c as { options: object }).options).toMatchObject({
      encrypt: true,
      trustServerCertificate: true
    })
    expect(c).toMatchObject({ port: 1433 })
  })

  it('encrypt=true alone: encrypted and verified', () => {
    const c = mssqlUrlConnection('mssql://u:p@db.example.com:1433/app?encrypt=true')
    expect((c as { options: object }).options).toMatchObject({
      encrypt: true,
      trustServerCertificate: false
    })
  })

  it('leaves everything else to knex as before: no options, ADO form, other engines', () => {
    expect(mssqlUrlConnection('mssql://u:p@db.example.com:1433/app')).toBeNull()
    expect(
      mssqlUrlConnection('Server=db;Database=app;User Id=u;Password=p;Encrypt=true')
    ).toBeNull()
    expect(mssqlUrlConnection('postgres://u:p@db/app?sslmode=require')).toBeNull()
  })
})
