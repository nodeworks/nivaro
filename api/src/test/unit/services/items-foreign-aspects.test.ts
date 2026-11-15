import { describe, expect, it, vi } from 'vitest'

// Realtime ideas 3 + 18 (2026-11-14): every items-service write path announces the aspects other
// records' pages listen for — `$related` to the parents a child points at, `$files` when a file
// junction row or a file field moves. Ids and aspect names only.

const rows = vi.hoisted(() => ({
  workflow_lines: [{ id: 5, workflow: 77, amount: 10 }],
  workflows_files: [{ id: 1, workflows_id: 9, directus_files_id: 'F-1' }]
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve((rows as Record<string, unknown[]>)[table] ?? []).then(res, rej)
        if (prop === 'first')
          return () => Promise.resolve(((rows as Record<string, unknown[]>)[table] ?? [])[0])
        if (prop === 'columnInfo')
          return () =>
            Promise.resolve(
              Object.fromEntries(
                Object.keys(((rows as Record<string, unknown[]>)[table] ?? [{}])[0] ?? {}).map(
                  (c) => [c, {}]
                )
              )
            )
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(String(table).split(' ')[0]), {
    get(_t, prop) {
      if (prop === 'raw') return (sql: string) => ({ sql, toString: () => sql })
      return () => chain('raw')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => true),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
const LEGS = vi.hoisted(() => [
  { many_collection: 'workflow_lines', many_field: 'workflow', one_collection: 'workflows' },
  {
    many_collection: 'workflows_files',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'files',
    junction_field: 'directus_files_id'
  },
  {
    many_collection: 'workflows_files',
    many_field: 'directus_files_id',
    one_collection: 'directus_files',
    one_field: null,
    junction_field: 'workflows_id'
  }
])
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c })),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async () => LEGS)
}))
vi.mock('../../../services/physical-tables.js', async (orig) => ({
  ...(await orig<object>()),
  tableIsMissing: vi.fn(async () => false),
  liveRelations: vi.fn(async (r: unknown) => r)
}))
vi.mock('../../../services/tree-permissions.js', async (orig) => ({
  ...(await orig<object>()),
  getTreePermission: vi.fn(async () => null)
}))
vi.mock('../../../services/edit-lock.js', async (orig) => ({
  ...(await orig<object>()),
  assertNotEditLocked: vi.fn(async () => {})
}))
const sent = vi.hoisted(() => [] as Array<{ collection: string; item: unknown; extra: unknown }>)
vi.mock('../../../services/realtime.js', async (orig) => ({
  ...(await orig<object>()),
  broadcastCollectionUpdate: vi.fn(
    (_io: unknown, collection: string, item: unknown, extra: unknown) => {
      sent.push({ collection, item, extra })
    }
  )
}))
const emits = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('../../../services/event-journal.js', async (orig) => ({
  ...(await orig<object>()),
  journaledEmit: vi.fn(async (room: string, _e: string, payload: Record<string, unknown>) => {
    emits.push({ room, ...payload })
    return { seq: 1, path: 'adapter', room }
  })
}))

import { deleteOne } from '../../../services/items.js'
import { flushForeignAspects } from '../../../services/related-announce.js'

const admin = { id: 'U-1', role: 'ADMIN' } as never
async function settle(until: () => boolean) {
  for (let i = 0; i < 40 && !until(); i++) await new Promise((r) => setTimeout(r, 5))
  await new Promise((r) => setTimeout(r, 10))
  flushForeignAspects()
}

describe('a child delete tells its parent ($related)', () => {
  it('deleting a line queues ONE $related notice on its workflow, no action, no values', async () => {
    emits.length = 0
    sent.length = 0
    await deleteOne(admin, 'workflow_lines', 5)
    await settle(() => sent.some((e) => e.collection === 'workflow_lines'))
    expect(emits).toContainEqual({
      room: 'collection:workflows',
      collection: 'workflows',
      item: '77',
      changed_fields: ['$related']
    })
    expect(JSON.stringify(emits)).not.toContain('amount')
  })
})

describe('a file junction write tells the parent ($files)', () => {
  it('removing a file link names the files field, $related and $files on the workflow', async () => {
    emits.length = 0
    sent.length = 0
    await deleteOne(admin, 'workflows_files', 1)
    await settle(() => sent.some((e) => e.collection === 'workflows'))
    expect(sent).toContainEqual({
      collection: 'workflows',
      item: '9',
      extra: { action: 'update', changed_fields: ['files', '$related', '$files'] }
    })
    // The far leg (the files table) is never a parent.
    expect(
      sent.some((e) => /files$/.test(e.collection) && e.collection !== 'workflows_files')
    ).toBe(false)
  })
})
