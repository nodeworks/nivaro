import knex from 'knex'
import { describe, expect, it } from 'vitest'
import { returnedId } from '../../../db/dialect/ef.js'
import { whereEqualsCi } from '../../../db/dialect/h2.js'

describe('returnedId', () => {
  it('reads a returning row or a bare insert id', () => {
    expect(returnedId({ id: 7 })).toBe(7)
    expect(returnedId({ id: 'a-b' })).toBe('a-b')
    expect(returnedId(7)).toBe(7) // MySQL insertId
    expect(returnedId({ key: 3 }, 'key')).toBe(3)
    expect(returnedId(undefined)).toBeNull()
    expect(returnedId({})).toBeNull()
  })
})

describe('whereEqualsCi', () => {
  const sqlOf = (client: string) => {
    const k = knex({ client })
    return whereEqualsCi(k('u'), k, 'email', 'A@B.c').toSQL().toNative()
  }
  it('is the plain builder equality on SQL Server and MySQL', () => {
    expect(sqlOf('mssql').sql).toBe('select * from [u] where [email] = @p0')
    expect(sqlOf('mysql2').sql).toBe('select * from `u` where `email` = ?')
  })
  it('folds case on Postgres and SQLite', () => {
    expect(sqlOf('pg').sql).toBe('select * from "u" where LOWER("email") = LOWER($1)')
    expect(sqlOf('better-sqlite3').sql).toBe('select * from `u` where LOWER(`email`) = LOWER(?)')
    expect(sqlOf('pg').bindings).toEqual(['A@B.c'])
  })
})
