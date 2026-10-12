import { beforeEach, describe, expect, it, vi } from 'vitest'

// System tables through the generic items API. A role holding a `*` policy
// used to read nivaro_users whole (static_token included) and write any
// user's role or token. Now: a non-admin reads only the listed people
// columns and writes nothing; credentials are never selected, filtered,
// sorted or grouped, admins included.

const USER_COLS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'external_id',
  'role',
  'status',
  'static_token',
  'totp_secret',
  'password_hash',
  'phone',
  'avatar',
  'is_redacted',
  'account_kind',
  'title'
]

// Any query-builder call chains; awaiting answers rows for the table. Every
// select is recorded per table.
const rec = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  selects: [] as Array<{ table: string; cols: unknown[] }>
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rec.rows[table] ?? []).then(res, rej)
        if (prop === 'columnInfo')
          return async () =>
            table === 'nivaro_users'
              ? Object.fromEntries(USER_COLS.map((c) => [c, {}]))
              : table === 'workflows'
                ? Object.fromEntries(['id', 'name', 'zone', 'salary'].map((c) => [c, {}]))
                : {}
        if (prop === 'first') return () => Promise.resolve((rec.rows[table] ?? [])[0])
        if (prop === 'select')
          return (...cols: unknown[]) => {
            rec.selects.push({ table, cols: cols.flat() })
            return chain(table)
          }
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(table), {
    get(_t, prop) {
      if (prop === 'raw')
        return (sql: string, bindings?: unknown[]) =>
          /information_schema\.columns/i.test(sql) && bindings?.[0] === 'nivaro_users'
            ? USER_COLS.map((c) => ({ c, t: 'nvarchar', l: 255, COLUMN_NAME: c }))
            : { sql, toString: () => sql }
      if (prop === 'transaction') return async (fn: (t: unknown) => unknown) => fn(db)
      return () => chain('raw')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})

const perm = vi.hoisted(() => ({ admin: false, limited: null as string[] | null }))
vi.mock('../../../services/permissions.js', async (orig) => {
  const real = await orig<typeof import('../../../services/permissions.js')>()
  const { systemReadableColumns, isSystemCollection } = await import(
    '../../../services/system-collections.js'
  )
  return {
    ...real,
    isAdminRole: vi.fn(async () => perm.admin),
    // The `*` role: everything on business tables; on system tables what
    // permissions.ts now answers (covered on its own in permissions.test.ts).
    can: vi.fn(async (_u: unknown, action: string, c: string) =>
      perm.admin || !isSystemCollection(c) ? true : action === 'read' && !!systemReadableColumns(c)
    ),
    // The listed columns the table has (permissions.ts learns them the same way).
    getAllowedFields: vi.fn(async (_u: unknown, _a: string, c: string) =>
      perm.admin
        ? null
        : !isSystemCollection(c)
          ? perm.limited
          : (systemReadableColumns(c) ?? []).filter((f) => USER_COLS.includes(f))
    ),
    getRowFilter: vi.fn(async () => null)
  }
})
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) =>
    c === 'nivaro_users' || c === 'workflows' ? { collection: c } : undefined
  ),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async (c: string) =>
    c === 'workflows'
      ? [
          {
            many_collection: 'workflows',
            many_field: 'created_by',
            one_collection: 'nivaro_users'
          },
          {
            many_collection: 'workflows',
            many_field: 'approver_id',
            one_collection: 'nivaro_users'
          },
          // M2M workflows.watchers → workflows_watchers → nivaro_users
          {
            many_collection: 'workflows_watchers',
            many_field: 'workflows_id',
            one_collection: 'workflows',
            one_field: 'watchers',
            junction_field: 'user_id'
          },
          {
            many_collection: 'workflows_watchers',
            many_field: 'user_id',
            one_collection: 'nivaro_users',
            junction_field: 'workflows_id'
          }
        ]
      : []
  )
}))

import { planAggregate } from '../../../services/item-aggregates.js'
import {
  CollectionNotFoundError,
  createOne,
  deleteOne,
  ForbiddenError,
  readItems,
  readOne,
  updateOne
} from '../../../services/items.js'

const someone = { id: 'U-1', role: 'WORKFLOW-CREATOR' } as never
const ADMIN_ID = 'AAAAAAAA-0000-4000-8000-000000000001'

const SECRETS = ['static_token', 'password_hash', 'totp_secret', 'external_id']
const usersSelect = () =>
  rec.selects.filter((s) => s.table === 'nivaro_users').flatMap((s) => s.cols.map(String))

beforeEach(() => {
  perm.admin = false
  perm.limited = null
  rec.selects = []
  rec.rows = {}
})

describe('a non-admin with a * role', () => {
  it('readOne selects only the people columns, never a credential', async () => {
    await readOne(someone, 'nivaro_users', ADMIN_ID).catch(() => undefined)
    const cols = usersSelect()
    expect(cols.length).toBeGreaterThan(0)
    expect(cols).not.toContain('*')
    for (const s of [...SECRETS, 'phone', 'role']) expect(cols).not.toContain(s)
    expect(cols).toEqual(expect.arrayContaining(['id', 'first_name', 'last_name', 'email']))
  })

  it('readOne with an explicit fields list naming secrets gets none of them', async () => {
    await readOne(someone, 'nivaro_users', ADMIN_ID, undefined, [
      'id',
      '*',
      'static_token',
      'password_hash'
    ]).catch(() => undefined)
    const cols = usersSelect()
    expect(cols).not.toContain('*')
    for (const s of SECRETS) expect(cols).not.toContain(s)
  })

  it('readItems (list and batch-read) selects only the people columns', async () => {
    await readItems(someone, 'nivaro_users', { fields: ['id', '*'], limit: 5 }).catch(
      () => undefined
    )
    const cols = usersSelect()
    expect(cols.length).toBeGreaterThan(0)
    expect(cols).not.toContain('*')
    for (const s of [...SECRETS, 'phone', 'role']) expect(cols).not.toContain(s)
    expect(cols).toEqual(expect.arrayContaining(['id', 'first_name', 'email', 'is_redacted']))
  })

  it('cannot filter, sort or search-by-cursor on a credential', async () => {
    const asks = [
      { filter: { static_token: { _starts_with: 'a' } } },
      { filter: { _or: [{ password_hash: { _nnull: true } }] } },
      { sort: ['-static_token'] },
      { sort: ['totp_secret'], after: 'x' },
      { filter: { external_id: { _eq: 'x' } } }
    ]
    for (const q of asks) {
      await expect(readItems(someone, 'nivaro_users', q as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'FIELD_NOT_FILTERABLE'
      })
    }
  })

  it('cannot reach a credential through a relation path from a business record', async () => {
    await expect(
      readItems(someone, 'workflows', {
        filter: { created_by: { static_token: { _starts_with: 'a' } } }
      } as never)
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      readItems(someone, 'workflows', { sort: ['created_by.static_token'] } as never)
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('cannot write nivaro_users: own role, an admin static_token, create, delete', async () => {
    await expect(
      updateOne(someone, 'nivaro_users', 'U-1', { role: 'ADMIN-ROLE' })
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      updateOne(someone, 'nivaro_users', ADMIN_ID, { static_token: 'mine' })
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(createOne(someone, 'nivaro_users', { email: 'x@y' })).rejects.toBeInstanceOf(
      ForbiddenError
    )
    await expect(deleteOne(someone, 'nivaro_users', ADMIN_ID)).rejects.toBeInstanceOf(
      ForbiddenError
    )
  })

  it('an unlisted system table answers as unknown, read or write', async () => {
    for (const c of ['nivaro_settings', 'directus_users', 'NIVARO_API_KEYS']) {
      await expect(readItems(someone, c)).rejects.toBeInstanceOf(CollectionNotFoundError)
      await expect(readOne(someone, c, '1')).rejects.toBeInstanceOf(CollectionNotFoundError)
      await expect(updateOne(someone, c, '1', { x: 1 })).rejects.toBeInstanceOf(
        CollectionNotFoundError
      )
    }
  })
})

describe('an administrator', () => {
  it('reads nivaro_users whole except the credentials', async () => {
    perm.admin = true
    await readOne(someone, 'nivaro_users', ADMIN_ID).catch(() => undefined)
    const cols = usersSelect()
    expect(cols).toEqual(expect.arrayContaining(['id', 'role', 'phone', 'email']))
    for (const s of SECRETS) expect(cols).not.toContain(s)
  })

  it('still cannot filter or sort on a credential', async () => {
    perm.admin = true
    await expect(
      readItems(someone, 'nivaro_users', { filter: { static_token: { _eq: 'x' } } } as never)
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('passes the system-table gate for a write', async () => {
    perm.admin = true
    // Whatever happens further in (the mock database), it is not the gate.
    const err = await updateOne(someone, 'nivaro_users', ADMIN_ID, { title: 'x' }).catch((e) => e)
    expect(err).not.toBeInstanceOf(ForbiddenError)
    expect(err).not.toBeInstanceOf(CollectionNotFoundError)
  })
})

describe('aggregates', () => {
  it('never group or aggregate a credential, whoever asks', async () => {
    const guards = { allowedFields: null, sensitive: SECRETS }
    for (const spec of [{ groupBy: ['static_token'] }, { countDistinct: ['password_hash'] }]) {
      await expect(planAggregate('nivaro_users', spec, guards)).rejects.toMatchObject({
        code: 'FIELD_FORBIDDEN'
      })
    }
    // The same column without the guard plans fine: the refusal is the guard's.
    await expect(
      planAggregate('nivaro_users', { groupBy: ['title'] }, guards)
    ).resolves.toMatchObject({ groupBy: ['title'] })
  })
})

// A request naming only fields the caller may not read narrowed to nothing
// and then fell back to `*` — every column, credentials included.
describe('a projection that narrows to nothing never becomes *', () => {
  it('readItems fields=static_token as a * role: no credential, no *', async () => {
    await readItems(someone, 'nivaro_users', { fields: ['static_token'] }).catch(() => undefined)
    const cols = usersSelect()
    expect(cols).not.toContain('*')
    for (const s of SECRETS) expect(cols).not.toContain(s)
  })

  it('readOne fields=static_token as a * role: no credential, no *', async () => {
    await readOne(someone, 'nivaro_users', ADMIN_ID, undefined, ['static_token']).catch(
      () => undefined
    )
    const cols = usersSelect()
    expect(cols).not.toContain('*')
    for (const s of SECRETS) expect(cols).not.toContain(s)
  })

  it('an admin asking fields=static_token still gets no credential', async () => {
    perm.admin = true
    await readItems(someone, 'nivaro_users', { fields: ['static_token'] }).catch(() => undefined)
    await readOne(someone, 'nivaro_users', ADMIN_ID, undefined, ['static_token']).catch(
      () => undefined
    )
    for (const s of SECRETS) expect(usersSelect()).not.toContain(s)
  })

  it('a field-limited role reading a business collection with * gets its listed columns only', async () => {
    perm.limited = ['id', 'name', 'zone']
    await readItems(someone, 'workflows', {}).catch(() => undefined)
    await readItems(someone, 'workflows', { fields: ['salary'] }).catch(() => undefined)
    const cols = rec.selects
      .filter((x) => x.table === 'workflows')
      .flatMap((x) => x.cols.map(String))
    expect(cols.length).toBeGreaterThan(0)
    expect(cols).not.toContain('*')
    expect(cols).not.toContain('salary')
  })
})

// A filter is an oracle: a path reaching a system table names only columns
// the caller may read there.
describe('filters and sorts that reach a system table', () => {
  it('a * role cannot filter or sort nivaro_users by a non-directory column', async () => {
    await expect(
      readItems(someone, 'nivaro_users', { filter: { role: { _eq: 'ADMIN' } } })
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(readItems(someone, 'nivaro_users', { sort: ['-phone'] })).rejects.toMatchObject({
      statusCode: 403
    })
  })

  it('nor through a relation hop from a business record', async () => {
    await expect(
      readItems(someone, 'workflows', { filter: { created_by: { role: { _eq: 'ADMIN' } } } })
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      readItems(someone, 'workflows', { sort: ['created_by.phone'] })
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a dotted filter key is checked like a nested one', async () => {
    await expect(
      readItems(someone, 'workflows', { filter: { 'created_by.role': { _eq: 'ADMIN' } } })
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('external_id is refused through a relation path too', async () => {
    perm.admin = true
    await expect(
      readItems(someone, 'workflows', { filter: { created_by: { external_id: { _eq: 'x' } } } })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('directory columns stay filterable, directly and through a hop', async () => {
    await readItems(someone, 'nivaro_users', { filter: { last_name: { _eq: 'Lee' } } }).catch(
      (e) => {
        expect((e as { statusCode?: number }).statusCode).not.toBe(403)
      }
    )
    await readItems(someone, 'workflows', {
      filter: { created_by: { first_name: { _eq: 'Rob' } } }
    }).catch((e) => {
      expect((e as { statusCode?: number }).statusCode).not.toBe(403)
    })
  })
})

// The checker follows a path exactly as the compilers would (#parser differential).
describe('the path check resolves hops the way the compilers do', () => {
  const refused = (q: object) =>
    expect(readItems(someone, 'workflows', q)).rejects.toMatchObject({ statusCode: 403 })

  it('case-variant segments', async () => {
    await refused({ filter: { CREATED_BY: { ROLE: { _eq: 'ADMIN' } } } })
    await refused({ sort: ['Created_By.Phone'] })
  })

  it('the FK alias without its _id suffix', async () => {
    await refused({ filter: { approver: { role: { _eq: 'ADMIN' } } } })
  })

  it('an M2M alias path into nivaro_users', async () => {
    await refused({ filter: { watchers: { role: { _eq: 'ADMIN' } } } })
  })

  it('an unresolvable middle segment', async () => {
    await refused({ filter: { nonsense: { role: { _eq: 'ADMIN' } } } })
  })

  it('an admin is not refused by the path check', async () => {
    perm.admin = true
    await readItems(someone, 'workflows', {
      filter: { CREATED_BY: { ROLE: { _eq: 'ADMIN' } } }
    }).catch((e) => expect((e as { statusCode?: number }).statusCode).not.toBe(403))
  })
})
