import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * changes_since (#3221): the activity log read forward by id, folded per record, cut to what
 * the caller may see now — ids and field NAMES only.
 */
const answers: Record<string, unknown> = {}
const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = []

function builder(table: string) {
  const entry = { table, ops: [] as Array<[string, unknown[]]> }
  calls.push(entry)
  const b: Record<string, unknown> = {}
  for (const m of [
    'where',
    'whereIn',
    'whereNotNull',
    'whereNot',
    'orderBy',
    'limit',
    'select',
    'max'
  ])
    b[m] = (...args: unknown[]) => {
      entry.ops.push([m, args])
      return b
    }
  b.first = async () => answers[`${table}:first`]
  // biome-ignore lint/suspicious/noThenProperty: stands in for an awaited knex query builder
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(answers[table] ?? []).then(res, rej)
  return b
}

vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => builder(t)) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  checkApiKeyScope: vi.fn(() => true)
}))
const can = vi.fn(async (_u: unknown, _a: string, c: string) => c !== 'secret_things')
vi.mock('../../../services/permissions.js', () => ({
  can: (...a: unknown[]) => can(...(a as [unknown, string, string]))
}))
const gates = vi.fn(async (_u: unknown, c: string) => ({
  permitted: true,
  rowFilter: c === 'orders' ? { owner: { _eq: '$CURRENT_USER' } } : null,
  scopes: [],
  strict: null
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: (...a: unknown[]) => gates(...(a as [unknown, string]))
}))
vi.mock('../../../services/revision-fields.js', () => ({
  readableFieldSet: vi.fn(async (_u: unknown, c: string) =>
    c === 'orders' ? new Set(['id', 'status', 'amount']) : null
  ),
  keepReadable: (names: string[], fields: Set<string> | null) =>
    fields ? names.filter((n) => fields.has(n)) : names
}))
const visible = vi.fn(async (_u: unknown, _c: string, ids: string[]) =>
  ids.filter((id) => id !== '2')
)
vi.mock('../../../services/socket-access.js', () => ({
  visibleRecordIds: (...a: unknown[]) => visible(...(a as [unknown, string, string[]]))
}))

const { decodeCursor, encodeCursor, foldChanges, deltaFieldNames, readChangeFeed, FeedRefusal } =
  await import('../../../services/change-feed.js')

const old = new Date(Date.now() - 60_000)
const req = (over: Record<string, unknown> = {}) =>
  ({ user: { id: 'U-ME' }, isAdmin: false, ...over }) as never

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k]
  calls.length = 0
})

describe('cursor', () => {
  it('round-trips and refuses anything it did not make', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42)
    expect(decodeCursor('42')).toBeNull()
    expect(decodeCursor('c1.not-json')).toBeNull()
    expect(decodeCursor(`c1.${Buffer.from('{"a":-1}').toString('base64url')}`)).toBeNull()
  })
})

describe('foldChanges', () => {
  const row = (id: number, action: string, item: string, fields?: string[] | null) => ({
    id,
    action,
    collection: 'orders',
    item,
    timestamp: old,
    fields
  })
  it('one change per record: create stays create, delete wins, updates union fields', () => {
    const { changes, consumed } = foldChanges(
      [
        row(1, 'create', '1'),
        row(2, 'update', '1', ['a']),
        row(3, 'update', '2', ['a']),
        row(4, 'update', '2', ['b']),
        row(5, 'update', '3', ['a']),
        row(6, 'delete', '3')
      ],
      10
    )
    expect(consumed).toBe(6)
    expect(changes.map((c) => [c.id, c.action, c.fields])).toEqual([
      ['1', 'create', undefined],
      ['2', 'update', ['a', 'b']],
      ['3', 'delete', undefined]
    ])
  })
  it('an update that did not say which fields makes the fields unknown', () => {
    const { changes } = foldChanges([row(1, 'update', '1', ['a']), row(2, 'update', '1', null)], 5)
    expect(changes[0].fields).toBeUndefined()
  })
  it('stops at the limit without consuming a row that did not fit', () => {
    const { changes, consumed } = foldChanges(
      [row(1, 'update', '1', ['a']), row(2, 'update', '2', ['a']), row(3, 'update', '1', ['b'])],
      1
    )
    expect(changes).toHaveLength(1)
    expect(consumed).toBe(1)
  })
  it('reads delta field names without the audit stamps', () => {
    expect(deltaFieldNames('{"status":"x","date_updated":"t"}')).toEqual(['status'])
    expect(deltaFieldNames('nope')).toBeNull()
  })
})

describe('readChangeFeed', () => {
  it('without a cursor starts from now', async () => {
    answers['nivaro_activity:first'] = { id: 900 }
    const page = await readChangeFeed(req(), {})
    expect(page.changes).toEqual([])
    expect(decodeCursor(page.cursor)).toBe(900)
  })

  it('lists only records the caller sees, readable field names, and never a value', async () => {
    answers.nivaro_activity = [
      { id: 11, action: 'update', collection: 'orders', item: 1, timestamp: old, user: 'U-X' },
      { id: 12, action: 'update', collection: 'orders', item: 2, timestamp: old, user: 'U-X' },
      { id: 13, action: 'delete', collection: 'orders', item: 7, timestamp: old, user: 'U-X' },
      { id: 14, action: 'delete', collection: 'orders', item: 8, timestamp: old, user: 'U-ME' },
      {
        id: 15,
        action: 'create',
        collection: 'secret_things',
        item: 3,
        timestamp: old,
        user: null
      },
      { id: 16, action: 'delete', collection: 'notes', item: 4, timestamp: old, user: 'U-X' }
    ]
    answers.nivaro_revisions = [
      { activity: 11, delta: '{"status":"closed","salary":1,"date_updated":"t"}' },
      { activity: 12, delta: '{"status":"x"}' }
    ]
    const page = await readChangeFeed(req(), { cursor: encodeCursor(10) })
    expect(page.changes).toEqual([
      {
        collection: 'orders',
        id: '1',
        action: 'update',
        fields: ['status'],
        at: old.toISOString()
      },
      // the caller's own delete is listed; another person's delete behind a row filter is not
      { collection: 'orders', id: '8', action: 'delete', at: old.toISOString() },
      // unrestricted reads: any delete there was visible to them
      { collection: 'notes', id: '4', action: 'delete', at: old.toISOString() }
    ])
    expect(JSON.stringify(page)).not.toContain('closed')
    expect(page.notes?.[0]).toMatch(/Deletes/)
    // The cursor moves past the hidden rows too.
    expect(decodeCursor(page.cursor)).toBe(16)
    expect(page.has_more).toBe(false)
  })

  it('leaves rows that are still settling for the next call', async () => {
    answers.nivaro_activity = [
      { id: 21, action: 'update', collection: 'notes', item: 1, timestamp: old, user: null },
      { id: 22, action: 'update', collection: 'notes', item: 5, timestamp: new Date(), user: null },
      { id: 23, action: 'update', collection: 'notes', item: 6, timestamp: old, user: null }
    ]
    const page = await readChangeFeed(req(), { cursor: encodeCursor(20) })
    expect(page.changes.map((c) => c.id)).toEqual(['1'])
    expect(decodeCursor(page.cursor)).toBe(21)
  })

  it('says which named collections cannot be read and refuses a foreign cursor', async () => {
    const page = await readChangeFeed(req(), {
      cursor: encodeCursor(5),
      collections: ['secret_things', 'nivaro_users']
    })
    expect(page.not_readable).toEqual(['secret_things', 'nivaro_users'])
    expect(calls.some((c) => c.table === 'nivaro_activity')).toBe(false)
    await expect(readChangeFeed(req(), { cursor: 'abc' })).rejects.toBeInstanceOf(FeedRefusal)
  })
})
