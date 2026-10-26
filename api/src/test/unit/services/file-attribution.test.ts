import { beforeEach, describe, expect, it, vi } from 'vitest'

// Where a file is used without a foreign key (army v3 round 2): chat attachments → the room,
// ticket attachments → the ticket, addendum attachments and comment links → the record, a
// clip poster → the clip, rich text → the record, avatars and configuration → anyone signed
// in. Built once into per-tenant indexes; a file uploaded after a build is looked up directly.

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`.toUpperCase()
const CHAT = id(1)
const TICKET = id(2)
const ADDENDUM = id(3)
const COMMENT = id(4)
const CLIP = id(5)
const POSTER = id(6)
const RICH = id(7)
const LOGO = id(8)
const NEW_CHAT = id(9)
const NOWHERE = id(10)
const AVATAR = id(11)
const DASH = id(12)
const NO_AUTHOR = id(13)

type Rec = { table: string; likes: string[] }
const data = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; likes: string[] }>,
  /** table → message: building its query throws (a broken builder, a lost connection…). */
  throws: {} as Record<string, string>
}))

vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const rec: Rec = { table, likes: [] }
    data.calls.push(rec)
    const b: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then')
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(data.tables[table] ?? []).then(res, rej)
          if (prop === 'catch') return () => Promise.resolve(data.tables[table] ?? [])
          return (...args: unknown[]) => {
            if (data.throws[table]) throw new Error(data.throws[table])
            if (typeof args[0] === 'function') (args[0] as (x: unknown) => void)(b)
            else if (args[1] === 'like' && typeof args[2] === 'string') rec.likes.push(args[2])
            return b
          }
        }
      }
    )
    return b
  }
  return { db: vi.fn((t: string) => builder(t)) }
})
vi.mock('../../../db/pool-context.js', () => ({ runInBackgroundPool: (fn: () => unknown) => fn() }))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => 't1' }))
vi.mock('../../../services/file-usage.js', () => ({ getFileRefColumns: vi.fn(async () => []) }))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async (c: string) => (c === 'workflows' ? { collection: c } : undefined)),
  getRelations: vi.fn(async () => [])
}))

import {
  fileAttributions,
  forgetFileAttributions,
  recordSite
} from '../../../services/file-attribution.js'

const old = new Date('2020-01-01T00:00:00Z')

beforeEach(() => {
  forgetFileAttributions()
  data.calls = []
  data.throws = {}
  data.tables = {
    chat_messages: [
      { room: 'channel:ops', sender: 'u-sam', attachments: JSON.stringify([CHAT, CLIP]) }
    ],
    nivaro_tasks: [{ id: 12, created_by: 'u-req', attachments: JSON.stringify([TICKET]) }],
    nivaro_addendums: [
      {
        parent_collection: 'workflows',
        parent_id: '7',
        created_by: 'u-pat',
        attachments: JSON.stringify([ADDENDUM])
      }
    ],
    nivaro_comments: [
      {
        collection: 'workflows',
        item: '8',
        user: 'u-kim',
        text: `see /api/files/${COMMENT.toLowerCase()}`
      }
    ],
    nivaro_files: [
      { id: CLIP, uploaded_by: 'u-sam', tags: JSON.stringify(['chat-clip', `poster:${POSTER}`]) }
    ],
    nivaro_relations: [],
    nivaro_collections: [{ collection: 'workflows' }],
    nivaro_fields: [
      {
        collection: 'workflows',
        field: 'objective',
        interface: 'input-rich-text-html',
        special: null
      }
    ],
    'information_schema.columns': [
      { table_name: 'workflows', column_name: 'objective', data_type: 'nvarchar' },
      { table_name: 'workflows', column_name: 'user_created', data_type: 'uniqueidentifier' },
      { table_name: 'workflows', column_name: 'user_updated', data_type: 'uniqueidentifier' },
      { table_name: 'nivaro_settings', column_name: 'brand_logo', data_type: 'uniqueidentifier' },
      { table_name: 'nivaro_users', column_name: 'avatar', data_type: 'nvarchar' },
      { table_name: 'nivaro_dashboards', column_name: 'options', data_type: 'nvarchar' },
      { table_name: 'nivaro_dashboards', column_name: 'created_by', data_type: 'uniqueidentifier' },
      { table_name: 'nivaro_widgets', column_name: 'options', data_type: 'nvarchar' }
    ],
    workflows: [
      { v0: `<p><img src="/api/files/${RICH}"></p>`, k0: '42', a0: 'u-ann', m0: 'u-editor' }
    ],
    nivaro_settings: [{ v0: LOGO }],
    nivaro_users: [{ v0: AVATAR, a0: 'u-lee' }],
    nivaro_dashboards: [{ v0: `{"image":"${DASH}"}`, a0: 'u-dee' }],
    // nivaro_widgets has no author column: what it names counts for nothing.
    nivaro_widgets: [{ v0: `{"image":"${NO_AUTHOR}"}` }]
  }
})

describe('fileAttributions', () => {
  it('names where each file is used without a foreign key', async () => {
    const got = await fileAttributions(
      [CHAT, TICKET, ADDENDUM, COMMENT, POSTER, RICH, LOGO, AVATAR, DASH, NO_AUTHOR, NOWHERE].map(
        (i) => ({
          id: i,
          uploaded_on: old
        })
      )
    )
    // Single-writer rows: the author is the last writer, and admin trust needs that author.
    const a = (by: string) => ({ by, trust: 'author', adminIf: [by] })
    expect(got.get(CHAT)).toEqual([{ kind: 'room', room: 'channel:ops', ...a('U-SAM') }])
    expect(got.get(TICKET)).toEqual([{ kind: 'ticket', id: 12, ...a('U-REQ') }])
    expect(got.get(ADDENDUM)).toEqual([
      { kind: 'record', collection: 'workflows', id: '7', ...a('U-PAT') }
    ])
    expect(got.get(COMMENT)).toEqual([
      { kind: 'record', collection: 'workflows', id: '8', ...a('U-KIM') }
    ])
    // Record editors may re-tag a clip: only the clip uploader's own poster counts, never on admin trust.
    expect(got.get(POSTER)).toEqual([
      { kind: 'poster', of: CLIP, by: 'U-SAM', trust: 'author', adminIf: null }
    ])
    // Rich text credits the LAST writer (user_updated), and admin trust needs both writers.
    expect(got.get(RICH)).toEqual([
      {
        kind: 'record',
        collection: 'workflows',
        id: '42',
        by: 'U-EDITOR',
        trust: 'author',
        adminIf: ['U-ANN', 'U-EDITOR']
      }
    ])
    // Settings: only administrators write it, so it counts as is.
    expect(got.get(LOGO)).toEqual([{ kind: 'shared', by: null, trust: 'table', adminIf: null }])
    // An avatar is its own person's; a dashboard image is its author's.
    expect(got.get(AVATAR)).toEqual([
      { kind: 'shared', by: 'U-LEE', trust: 'owner', adminIf: null }
    ])
    // No modifier column: credited to the creator, but no admin trust (edits since can't be told).
    expect(got.get(DASH)).toEqual([{ kind: 'shared', by: 'U-DEE', trust: 'author', adminIf: null }])
    expect(got.has(NO_AUTHOR)).toBe(false)
    // Used nowhere: no attribution, so file-access grants it to no one but uploader + admins.
    expect(got.has(NOWHERE)).toBe(false)
  })

  it('serves the built index without reading again, and skips the lookup for old files', async () => {
    await fileAttributions([{ id: CHAT, uploaded_on: old }])
    const reads = data.calls.length
    await fileAttributions([{ id: NOWHERE, uploaded_on: old }])
    expect(data.calls.length).toBe(reads)
  })

  it('looks a file uploaded after the build up directly (a fresh chat image)', async () => {
    await fileAttributions([{ id: CHAT, uploaded_on: old }])
    data.tables.chat_messages = [
      ...data.tables.chat_messages,
      { room: 'dm:A:B', sender: 'u-a', attachments: JSON.stringify([NEW_CHAT]) }
    ]
    data.calls = []
    const got = await fileAttributions([{ id: NEW_CHAT, uploaded_on: new Date() }])
    expect(got.get(NEW_CHAT)).toEqual([
      { kind: 'room', room: 'dm:A:B', by: 'U-A', trust: 'author', adminIf: ['U-A'] }
    ])
    // The lookup filtered by the file id (bound LIKE), not a scan for everything.
    const chat = data.calls.find((c) => c.table === 'chat_messages')
    expect(chat?.likes).toEqual([`%${NEW_CHAT}%`])
  })

  it('answers nothing for an id that is not a uuid', async () => {
    expect((await fileAttributions([{ id: "x' OR 1=1 --" }])).size).toBe(0)
    expect(data.calls.length).toBe(0)
  })
})

describe('recordSite', () => {
  it('maps a business row to itself and refuses system or unregistered tables', async () => {
    expect(await recordSite('workflows', 'objective')).toEqual({
      record: 'workflows',
      recordColumn: 'id'
    })
    expect(await recordSite('nivaro_settings', 'brand_logo')).toBeUndefined()
    expect(await recordSite('zz_backup_workflows_files', 'directus_files_id')).toBeUndefined()
  })
})

describe('a source that cannot be read', () => {
  it('never throws: an unmigrated table reads as empty, any other failure is reported', async () => {
    data.throws = { chat_messages: 'Invalid object name chat_messages' }
    let got = await fileAttributions([{ id: TICKET, uploaded_on: old }])
    expect(got.get(TICKET)).toBeTruthy()
    expect([...got.incomplete]).toEqual([])
    forgetFileAttributions()
    data.throws = { chat_messages: 'db(...).whereNotNull is not a function' }
    got = await fileAttributions([{ id: CHAT, uploaded_on: old }])
    expect(got.has(CHAT)).toBe(false)
    expect([...got.incomplete]).toContain('chat')
  })
})
