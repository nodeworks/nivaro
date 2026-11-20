import type { Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import { hourBucket, textParam } from './traffic-d.js'

const k = (client: string) => ({ client: { config: { client } } }) as unknown as Knex

describe('traffic-d dialect helpers', () => {
  it('hourBucket keeps the SQL Server text and has a form per dialect', () => {
    expect(hourBucket(k('mssql'), 'created_at')).toBe(
      'DATEADD(hour, DATEDIFF(hour, 0, created_at), 0)'
    )
    expect(hourBucket(k('pg'), 'created_at')).toBe("date_trunc('hour', created_at)")
    expect(hourBucket(k('mysql2'), 'created_at')).toContain('INTERVAL HOUR(created_at) HOUR')
  })

  it('textParam types the binding on Postgres only', () => {
    expect(textParam(k('pg'))).toBe('?::text')
    expect(textParam(k('mssql'))).toBe('?')
    expect(textParam(k('mysql2'))).toBe('?')
  })
})
