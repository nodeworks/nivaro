import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub: the sealed secrets (a driver's GitLab token, an environment's hub token) are
// never read through the generic items API — not selected, filtered or sorted — whoever asks,
// administrators included. The Hub's own routes only ever answer them masked.

const COLS: Record<string, string[]> = {
  nivaro_hub_drivers: ['id', 'kind', 'name', 'config', 'secret'],
  nivaro_hub_environments: ['id', 'app_id', 'key', 'base_url', 'hub_token', 'placement_id'],
  nivaro_hub_apps: ['id', 'key', 'name', 'oidc', 'oidc_secret'],
  nivaro_hub_db_servers: ['id', 'name', 'engine', 'host', 'admin_secret'],
  nivaro_hub_databases: ['id', 'host', 'database_name', 'connection'],
  nivaro_hub_targets: ['id', 'kind', 'name', 'config', 'secret']
}

const rec = vi.hoisted(() => ({ selects: [] as Array<{ table: string; cols: unknown[] }> }))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve([]).then(res, rej)
        if (prop === 'columnInfo')
          return async () => Object.fromEntries((COLS[table] ?? []).map((c) => [c, {}]))
        if (prop === 'first') return () => Promise.resolve(undefined)
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
          /information_schema\.columns/i.test(sql) && COLS[String(bindings?.[0])]
            ? COLS[String(bindings?.[0])].map((c) => ({ c, t: 'nvarchar', l: 255, COLUMN_NAME: c }))
            : { sql, toString: () => sql }
      if (prop === 'transaction') return async (fn: (t: unknown) => unknown) => fn(db)
      return () => chain('raw')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})

vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/permissions.js')>()),
  isAdminRole: vi.fn(async () => true),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => (COLS[c] ? { collection: c } : undefined)),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async () => [])
}))

import { readItems, readOne } from '../../../services/items.js'
import { sensitiveColumns } from '../../../services/system-collections.js'

const admin = { id: 'AAAAAAAA-0000-4000-8000-000000000001', role: 'ADMIN' } as never
const SEALED: Record<string, string> = {
  nivaro_hub_drivers: 'secret',
  nivaro_hub_environments: 'hub_token',
  nivaro_hub_apps: 'oidc_secret',
  nivaro_hub_db_servers: 'admin_secret',
  nivaro_hub_databases: 'connection',
  nivaro_hub_targets: 'secret'
}
const selected = (table: string) =>
  rec.selects.filter((s) => s.table === table).flatMap((s) => s.cols.map(String))

beforeEach(() => {
  rec.selects = []
})

describe('hub sealed columns through /items', () => {
  it('are on the sensitive list', () => {
    expect(sensitiveColumns('nivaro_hub_drivers')).toContain('secret')
    expect(sensitiveColumns('nivaro_hub_environments')).toContain('hub_token')
    expect(sensitiveColumns('NIVARO_HUB_DRIVERS')).toContain('secret')
    expect(sensitiveColumns('nivaro_hub_apps')).toContain('oidc_secret')
    expect(sensitiveColumns('nivaro_hub_db_servers')).toContain('admin_secret')
    expect(sensitiveColumns('nivaro_hub_databases')).toContain('connection')
    expect(sensitiveColumns('nivaro_hub_targets')).toContain('secret')
  })

  for (const [table, col] of Object.entries(SEALED)) {
    it(`${table}: an administrator never selects ${col}, even by name`, async () => {
      await readItems(admin, table, {}).catch(() => undefined)
      await readItems(admin, table, { fields: [col] }).catch(() => undefined)
      await readOne(admin, table, '1', undefined, [col]).catch(() => undefined)
      const cols = selected(table)
      expect(cols.length).toBeGreaterThan(0)
      expect(cols).not.toContain(col)
      expect(cols).not.toContain('*')
    })

    it(`${table}: an administrator cannot filter or sort on ${col}`, async () => {
      await expect(
        readItems(admin, table, { filter: { [col]: { _eq: 'x' } } } as never)
      ).rejects.toMatchObject({ statusCode: 400 })
      await expect(readItems(admin, table, { sort: [col] } as never)).rejects.toMatchObject({
        statusCode: 400
      })
    })
  }
})
