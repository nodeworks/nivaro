import knex from 'knex'
import { describe, expect, it } from 'vitest'
import { returnedId } from '../../../db/dialect/ef.js'
import { whereEqualsCi } from '../../../db/dialect/h2.js'
import { catalogColumnDefault } from '../../../db/sql-dialect.js'

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

describe('catalogColumnDefault on MySQL', () => {
  it("reads a TEXT column's expression default as its text", () => {
    const my = knex({ client: 'mysql2' })
    expect(catalogColumnDefault(my, "_utf8mb4\\'req\\'")).toBe('req')
    expect(catalogColumnDefault(my, "_utf8mb4\\'it\\'s\\'")).toBe("it's")
    expect(catalogColumnDefault(my, '7')).toBe('7')
    expect(catalogColumnDefault(knex({ client: 'mssql' }), "_utf8mb4\\'req\\'")).toBe(
      "_utf8mb4\\'req\\'"
    )
  })
})
