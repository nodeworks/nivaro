import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NestedGate } from '../../../services/graphql-nested-access.js'
import {
  assertNestedArgsAllowed,
  chargeNestedRows,
  nestedArgPaths,
  takeNestedQuery
} from '../../../services/graphql-nested-guard.js'

const gate = (fields: string[] | null, allowed = true): NestedGate => ({
  allowed,
  open: fields === null,
  rowFilter: null,
  scopes: { filters: [], deny: false },
  fields: fields ? new Set(fields) : null
})
const member = { user: { id: 'U' } as never, isAdmin: false }
const admin = { user: { id: 'A' } as never, isAdmin: true }
const m2o = (f: string) =>
  ({ created_by: 'nivaro_users', year: 'years' }) as Record<string, string | undefined>
const m2oOf = (f: string) => m2o(f)[f]

afterEach(() => vi.unstubAllEnvs())

describe('nested GraphQL filter / sort guard (M7)', () => {
  it('collects filter and sort paths', () => {
    expect(
      nestedArgPaths({
        filter: { _and: [{ year: { name: { _eq: 1 } } }, { 'a.b': { _eq: 2 } }] },
        sort: ['-x', 'year.id']
      })
    ).toEqual([['year'], ['year', 'name'], ['a', 'b'], ['x'], ['year', 'id']])
  })

  it('refuses a credential anywhere in a sort path, admins included', async () => {
    await expect(
      assertNestedArgsAllowed(
        admin,
        'lines',
        gate(null),
        { sort: ['created_by.static_token'] },
        m2oOf,
        async () => gate(null)
      )
    ).rejects.toMatchObject({ extensions: { code: 'FIELD_NOT_FILTERABLE' } })
    await expect(
      assertNestedArgsAllowed(
        member,
        'lines',
        gate(null),
        { filter: { created_by: { password_hash: { _null: false } } } },
        m2oOf,
        async () => gate(null)
      )
    ).rejects.toMatchObject({ extensions: { code: 'FIELD_NOT_FILTERABLE' } })
  })

  it('refuses a field outside the caller field list', async () => {
    await expect(
      assertNestedArgsAllowed(
        member,
        'lines',
        gate(['qty']),
        { sort: ['-cost'] },
        m2oOf,
        async () => gate(null)
      )
    ).rejects.toMatchObject({ extensions: { code: 'FIELD_NOT_READABLE', fields: ['cost'] } })
  })

  it('checks one M2O hop: system table readable columns, business gate fields', async () => {
    await expect(
      assertNestedArgsAllowed(
        member,
        'lines',
        gate(null),
        { sort: ['created_by.role'] },
        m2oOf,
        async () => gate(null)
      )
    ).rejects.toMatchObject({ extensions: { code: 'FIELD_NOT_READABLE' } })
    await expect(
      assertNestedArgsAllowed(
        member,
        'lines',
        gate(null),
        { sort: ['created_by.email'] },
        m2oOf,
        async () => gate(null)
      )
    ).resolves.toBeUndefined()
    await expect(
      assertNestedArgsAllowed(
        member,
        'lines',
        gate(null),
        { filter: { year: { secret: { _eq: 1 } } } },
        m2oOf,
        async () => gate(['name'])
      )
    ).rejects.toMatchObject({ extensions: { code: 'FIELD_NOT_READABLE' } })
  })

  it('lets readable fields and admins through', async () => {
    await expect(
      assertNestedArgsAllowed(
        member,
        'lines',
        gate(['qty']),
        { sort: ['qty', 'id'], filter: { qty: { _gt: 1 } } },
        m2oOf,
        async () => gate(null)
      )
    ).resolves.toBeUndefined()
    await expect(
      assertNestedArgsAllowed(admin, 'lines', gate(['qty']), { sort: ['cost'] }, m2oOf, async () =>
        gate(null)
      )
    ).resolves.toBeUndefined()
  })
})

describe('nested fan-out budget (M9)', () => {
  it('throws once past the query cap, then answers false quietly', () => {
    vi.stubEnv('GRAPHQL_MAX_NESTED_QUERIES', '2')
    const ctx = {}
    expect(takeNestedQuery(ctx)).toBe(true)
    expect(takeNestedQuery(ctx)).toBe(true)
    expect(() => takeNestedQuery(ctx)).toThrow(/nested reads/)
    expect(takeNestedQuery(ctx)).toBe(false)
    expect(chargeNestedRows(ctx, 1)).toBe(false)
  })

  it('caps rows per request and is per request', () => {
    vi.stubEnv('GRAPHQL_MAX_NESTED_ROWS', '10')
    const a = {}
    expect(chargeNestedRows(a, 10)).toBe(true)
    expect(() => chargeNestedRows(a, 1)).toThrow(/nested rows/)
    expect(chargeNestedRows({}, 10)).toBe(true)
  })

  it('0 turns a cap off', () => {
    vi.stubEnv('GRAPHQL_MAX_NESTED_ROWS', '0')
    expect(chargeNestedRows({}, 10_000_000)).toBe(true)
  })
})
