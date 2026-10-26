import knexFactory from 'knex'
import { describe, expect, it } from 'vitest'
import { PEOPLE_CAP, peopleSearchQuery } from '../../../routes/global-search.js'
import { systemReadableColumns } from '../../../services/system-collections.js'

// Cmd+K people block (army 2026-10-25): one TOP-N query over nivaro_users as
// the caller. A non-admin gets the person directory only; an admin also finds
// suspended and machine accounts.

const knex = knexFactory({ client: 'mssql' })
const compile = (q: string, isAdmin: boolean, readable?: readonly string[] | null) => {
  const qb = peopleSearchQuery(knex, q, isAdmin, readable)
  if (!qb) throw new Error('expected a query')
  return qb.toSQL()
}

/** The column list of `select top (?) [a], [b] from …`. */
function selected(sql: string): string[] {
  const m = /^select top \(\?\) (.*?) from \[nivaro_users\]/.exec(sql)
  return (m?.[1] ?? '').split(',').map((c) => c.trim().replace(/^\[|\]$/g, ''))
}

describe('global search — people', () => {
  it('a non-admin reads only directory columns, never status or account kind', () => {
    const { sql } = compile('jane', false)
    const cols = selected(sql)
    expect(cols).toEqual(['id', 'first_name', 'last_name', 'email', 'title', 'department'])
    const allowed = new Set(systemReadableColumns('nivaro_users'))
    for (const c of cols) expect(allowed.has(c)).toBe(true)
    expect(sql).not.toMatch(/static_token|password_hash|totp_secret|external_id|preferences/)
  })

  it('a non-admin never finds a suspended, redacted, placeholder or machine account', () => {
    const { sql, bindings } = compile('jane', false)
    expect(sql).toContain('[account_kind] is null')
    expect(sql).toMatch(/\[status\] != \? or \[status\] is null/)
    expect(bindings).toContain('suspended')
    expect(sql).toMatch(/\[is_redacted\] = \?/)
    expect(sql).toContain(`email not like 'legacy-%'`)
  })

  it('an admin also finds suspended and machine accounts, and sees status and kind', () => {
    const { sql, bindings } = compile('jane', true)
    expect(selected(sql)).toEqual([
      'id',
      'first_name',
      'last_name',
      'email',
      'title',
      'department',
      'status',
      'account_kind'
    ])
    expect(sql).not.toContain('account_kind] is null')
    expect(bindings).not.toContain('suspended')
    // Anonymised rows stay out even for an admin.
    expect(sql).toMatch(/\[is_redacted\] = \?/)
  })

  it('matches every word across name, email and job title', () => {
    const { sql, bindings } = compile('Jane  Doe', false)
    expect(sql.split(' order by ')[0].match(/\[title\] LIKE \? ESCAPE/g)).toHaveLength(2)
    expect(bindings).toContain('%Jane%')
    expect(bindings).toContain('%Doe%')
  })

  it('ranks exact, then prefix, under one TOP N; newest for an admin', () => {
    const { sql, bindings } = compile('Jane Doe', false)
    expect(sql).toMatch(
      /order by CASE WHEN \[first_name\] = \? OR \[last_name\] = \? OR \[email\] = \? OR \[title\] = \? OR CONCAT\(\[first_name\], ' ', \[last_name\]\) = \? THEN 0/
    )
    // created_at is not a directory column: a non-admin's tie-break is by name.
    expect(sql).toMatch(/THEN 1 ELSE 2 END, \[last_name\], \[first_name\]$/)
    expect(compile('Jane Doe', true).sql).toMatch(/THEN 1 ELSE 2 END, \[created_at\] DESC$/)
    expect(bindings[0]).toBe(PEOPLE_CAP)
    expect(bindings).toContain('Jane Doe')
    expect(bindings).toContain('Jane Doe%')
  })

  it('never searches or ranks on a column the caller may not read', () => {
    const noEmail = ['id', 'first_name', 'last_name', 'title', 'department']
    const { sql, bindings } = compile('jane@corp.com', false, noEmail)
    // The fixed listing rules still name email; nothing the caller typed does.
    expect(sql).not.toMatch(/\[email\] (LIKE|=)/)
    expect(sql).not.toMatch(/(?<!\[)\bemail = \?/)
    expect(selected(sql)).not.toContain('email')
    // Matched only against readable columns: first, last, title (+ full name rank).
    expect(bindings.filter((b) => b === '%jane@corp.com%')).toHaveLength(3)
    // With email readable, the same value is matched against it.
    expect(compile('jane@corp.com', false).sql).toMatch(/\[email\] LIKE \? ESCAPE/)
  })

  it('denies a non-admin when the readable list is missing or lacks id', () => {
    expect(peopleSearchQuery(knex, 'jane', false, null)).toBeNull()
    expect(peopleSearchQuery(knex, 'jane', false, [])).toBeNull()
    expect(peopleSearchQuery(knex, 'jane', false, ['first_name', 'email'])).toBeNull()
    expect(peopleSearchQuery(knex, 'jane', false, ['id', 'department'])).toBeNull()
    // An admin is not bound by the directory list.
    expect(peopleSearchQuery(knex, 'jane', true, null)).not.toBeNull()
  })

  it('escapes LIKE wildcards the caller types', () => {
    const { bindings } = compile('50%_off', false)
    expect(bindings).toContain('%50\\%\\_off%')
  })

  it('caps the words it searches', () => {
    const { sql } = compile('a b c d e f g', false)
    expect(sql.split(' order by ')[0].match(/\[title\] LIKE \? ESCAPE/g)).toHaveLength(4)
  })
})
