import { beforeEach, describe, expect, it, vi } from 'vitest'

// A record's attachment follows the record (army 2026-10-25): reading it needs one
// referencing record readable as the caller, changing it needs every one updatable and
// not edit-locked. A file no FK-linked record grants follows where it is used without a
// foreign key (round 2): the chat room, the ticket, the addendum's or comment's record, the
// clip of a poster, anyone for configuration; used nowhere = uploader and admins only.

const FILE = '11111111-1111-4111-8111-111111111111'
const state = vi.hoisted(() => ({
  refs: [] as Array<{ f: string; r: string }>,
  readable: new Set<string>(),
  updatable: new Set<string>(),
  locked: new Set<string>(),
  attrs: new Map<string, unknown[]>(),
  rooms: new Set<string>(),
  ticketRows: [] as Array<Record<string, unknown>>,
  ticketSeers: new Set<string>(),
  fileRows: [] as Array<Record<string, unknown>>,
  chatMsg: undefined as Record<string, unknown> | undefined,
  versions: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  logged: [] as unknown[],
  incomplete: new Set<string>(),
  refsFail: false,
  attrsThrow: false
}))

vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const b: any = {
      whereIn: () => b,
      whereNotNull: () => b,
      where: () => b,
      first: async () => (t === 'chat_messages' ? state.chatMsg : undefined),
      select: () =>
        t === 'nivaro_tasks'
          ? Promise.resolve(state.ticketRows)
          : t === 'nivaro_files'
            ? Promise.resolve(state.fileRows)
            : t === 'nivaro_chat_message_history'
              ? Promise.resolve(state.versions)
              : b,
      limit: async () => {
        if (state.refsFail) throw new Error('connection lost')
        return state.refs
      }
    }
    return b
  })
}))
vi.mock('../../../services/file-attribution.js', () => ({
  adminAuthors: vi.fn(
    async (ids: string[]) => new Set(ids.filter((i) => i.toUpperCase().startsWith('ADMIN')))
  ),
  recordSite: vi.fn(async () => ({ record: 'workflows', recordColumn: 'workflows_id' })),
  fileAttributions: vi.fn(async (files: Array<{ id: unknown }>) => {
    if (state.attrsThrow) throw new Error('index broke')
    const out = Object.assign(new Map<string, unknown[]>(), { incomplete: state.incomplete })
    for (const f of files) {
      const a = state.attrs.get(String(f.id).toUpperCase())
      if (a) out.set(String(f.id).toUpperCase(), a)
    }
    return out
  })
}))
vi.mock('../../../services/chat.js', () => ({
  parseRoom: (room: string) =>
    room.startsWith('dm:')
      ? { kind: 'dm' }
      : room.startsWith('channel:')
        ? { kind: 'channel', channelKey: room.slice(8) }
        : { kind: 'entity' },
  channels: async () =>
    new Map([
      ['priv', { visibility: 'private', is_direct: false }],
      ['ops', { visibility: 'open', is_direct: false }]
    ]),
  newRoomVisibilityCache: () => new Map(),
  canSeeRoom: vi.fn(async (u: { id: string }, room: string) => state.rooms.has(`${u.id}|${room}`))
}))
vi.mock('../../../services/support-tickets.js', () => ({
  canSeeTicket: vi.fn(async (v: { id: string }) => state.ticketSeers.has(v.id))
}))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (e: unknown) => {
    state.logged.push(e)
    return 1
  })
}))
vi.mock('../../../services/collections.js', () => ({
  getFields: vi.fn(async () => state.fields)
}))
vi.mock('../../../services/file-usage.js', () => ({
  getFileRefColumns: vi.fn(async () => [{ table: 'workflows_files', column: 'directus_files_id' }])
}))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) =>
    state.readable.has(id) ? { id } : null
  ),
  canUpdateItem: vi.fn(async (_u: unknown, _c: string, id: string) => state.updatable.has(id))
}))
vi.mock('../../../services/edit-lock.js', () => {
  class EditLockedError extends Error {}
  return {
    EDIT_LOCKED: 'EDIT_LOCKED',
    EditLockedError,
    assertNotEditLocked: vi.fn(async (_u: unknown, _c: string, o: { ids: string[] }) => {
      if (state.locked.has(o.ids[0])) throw new EditLockedError('This record is at Finance Review')
    })
  }
})
vi.mock('../../../services/socket-access.js', () => ({
  visibleRecordIds: vi.fn(async (_u: unknown, _c: string, ids: string[]) =>
    ids.filter((i) => state.readable.has(i))
  )
}))

import {
  assertEmbeddedFilesReadable,
  assertFileIdsReadable,
  attributionCounts,
  chatComplianceRead,
  mayChangeFile,
  mayReadFile,
  readableFileIds,
  unreadableFileIds
} from '../../../services/file-access.js'

const file = { id: FILE.toUpperCase(), uploaded_by: 'UPLOADER' }
const req = (id: string, isAdmin = false) =>
  ({ user: { id, role: 'R' }, isAdmin, workspaceId: null }) as never

beforeEach(() => {
  state.refs = [{ f: FILE.toUpperCase(), r: '372786' }]
  state.readable = new Set()
  state.updatable = new Set()
  state.locked = new Set()
  state.attrs = new Map()
  state.rooms = new Set()
  state.ticketRows = []
  state.ticketSeers = new Set()
  state.fileRows = []
  state.chatMsg = undefined
  state.versions = []
  state.fields = []
  state.logged = []
  state.incomplete = new Set()
  state.refsFail = false
  state.attrsThrow = false
})

describe('reading a record attachment', () => {
  it('is refused to someone who cannot open the record it is attached to', async () => {
    expect(await mayReadFile(file, req('STRANGER'))).toBe(false)
    expect((await readableFileIds([file], req('STRANGER'))).size).toBe(0)
  })

  it('is allowed to someone who can open the record, to the uploader and to admins', async () => {
    expect(await mayReadFile(file, req('UPLOADER'))).toBe(true)
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(true)
    state.readable.add('372786')
    expect(await mayReadFile(file, req('READER'))).toBe(true)
    expect([...(await readableFileIds([file], req('READER')))]).toEqual([FILE])
  })

  it('a file used nowhere reads only for its uploader and admins', async () => {
    state.refs = []
    expect(await mayReadFile(file, req('STRANGER'))).toBe(false)
    expect((await readableFileIds([file], req('STRANGER'))).size).toBe(0)
    expect(await mayReadFile(file, req('UPLOADER'))).toBe(true)
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(true)
  })
})

describe('reading a file used without a foreign key', () => {
  beforeEach(() => {
    state.refs = []
  })

  // The uploader's own use, and a use by an administrator, count.
  const own = { by: 'UPLOADER', trust: 'author' }

  it('a chat attachment reads only for people who can see the room', async () => {
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'room', room: 'dm:A:B', ...own }])
    expect(await mayReadFile(file, req('STRANGER'))).toBe(false)
    state.rooms.add('MEMBER|dm:A:B')
    expect(await mayReadFile(file, req('MEMBER'))).toBe(true)
    expect([...(await readableFileIds([file], req('MEMBER')))]).toEqual([FILE])
    expect((await readableFileIds([file], req('STRANGER'))).size).toBe(0)
  })

  it('a rich-text image or addendum attachment reads with its record', async () => {
    state.attrs.set(FILE.toUpperCase(), [
      { kind: 'record', collection: 'workflows', id: '99', ...own }
    ])
    expect(await mayReadFile(file, req('STRANGER'))).toBe(false)
    state.readable.add('99')
    expect(await mayReadFile(file, req('READER'))).toBe(true)
  })

  it("someone else's comment or rich text naming the file grants nothing", async () => {
    // STRANGER pastes the uploader's file id into a comment on their own record.
    state.attrs.set(FILE.toUpperCase(), [
      { kind: 'record', collection: 'workflows', id: '99', by: 'STRANGER', trust: 'author' },
      { kind: 'record', collection: 'workflows', id: '98', by: null, trust: 'author' }
    ])
    state.readable.add('99')
    state.readable.add('98')
    expect(await mayReadFile(file, req('STRANGER'))).toBe(false)
    expect((await readableFileIds([file], req('STRANGER'))).size).toBe(0)
    // The same use written by an administrator counts.
    state.attrs.set(FILE.toUpperCase(), [
      {
        kind: 'record',
        collection: 'workflows',
        id: '99',
        by: 'ADMIN-1',
        trust: 'author',
        adminIf: ['ADMIN-1']
      }
    ])
    expect(await mayReadFile(file, req('STRANGER'))).toBe(true)
  })

  it("an avatar pointing at someone else's upload grants nothing; one's own reads for all", async () => {
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'shared', by: 'STRANGER', trust: 'owner' }])
    expect(await mayReadFile(file, req('ANYONE'))).toBe(false)
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'shared', by: 'ADMIN-1', trust: 'owner' }])
    expect(await mayReadFile(file, req('ANYONE'))).toBe(false)
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'shared', by: 'UPLOADER', trust: 'owner' }])
    expect(await mayReadFile(file, req('ANYONE'))).toBe(true)
  })

  it('a ticket attachment reads only for people who can see the ticket', async () => {
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'ticket', id: 5, ...own }])
    state.ticketRows = [{ id: 5, created_by: 'REQ', assignee: null, team_id: 3 }]
    expect(await mayReadFile(file, req('STRANGER'))).toBe(false)
    state.ticketSeers.add('DESK')
    expect(await mayReadFile(file, req('DESK'))).toBe(true)
  })

  it('a clip poster reads with the clip', async () => {
    const CLIP = '22222222-2222-4222-8222-222222222222'
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'poster', of: CLIP, ...own }])
    state.attrs.set(CLIP.toUpperCase(), [
      { kind: 'room', room: 'channel:ops', by: 'UPLOADER', trust: 'author' }
    ])
    state.fileRows = [{ id: CLIP.toUpperCase(), uploaded_by: 'UPLOADER', tags: null }]
    expect(await mayReadFile(file, req('STRANGER'))).toBe(false)
    state.rooms.add('MEMBER|channel:ops')
    expect(await mayReadFile(file, req('MEMBER'))).toBe(true)
  })

  it('configuration and avatars read for anyone signed in, never anonymously', async () => {
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'shared', by: null, trust: 'table' }])
    expect(await mayReadFile(file, req('ANYONE'))).toBe(true)
    expect(await mayReadFile(file, { user: null, isAdmin: false } as never)).toBe(false)
  })

  it('a file with an FK reference stays hidden despite any other use of it', async () => {
    state.refs = [{ f: FILE.toUpperCase(), r: '372786' }]
    state.attrs.set(FILE.toUpperCase(), [
      { kind: 'room', room: 'channel:ops', ...own },
      { kind: 'shared', by: null, trust: 'table' }
    ])
    state.rooms.add('MEMBER|channel:ops')
    expect(await mayReadFile(file, req('MEMBER'))).toBe(false)
    expect((await readableFileIds([file], req('MEMBER'))).size).toBe(0)
    // …and reads once its record does.
    state.readable.add('372786')
    expect(await mayReadFile(file, req('MEMBER'))).toBe(true)
  })
})

describe('unreadableFileIds (write paths storing file ids)', () => {
  it('names the files the writer cannot read, and nothing for an admin', async () => {
    state.refs = []
    state.fileRows = [{ id: FILE.toUpperCase(), uploaded_by: 'UPLOADER', tags: null }]
    expect(await unreadableFileIds([FILE, 'not-a-uuid'], req('STRANGER'))).toEqual([FILE])
    expect(await unreadableFileIds([FILE], req('UPLOADER'))).toEqual([])
    expect(await unreadableFileIds([FILE], req('ADMIN', true))).toEqual([])
  })
})

describe('changing a file', () => {
  it('is refused when the caller cannot update the record, or it is edit-locked', async () => {
    state.readable.add('372786')
    expect((await mayChangeFile(file, req('READER'))).ok).toBe(false)
    state.updatable.add('372786')
    state.locked.add('372786')
    const locked = await mayChangeFile(file, req('READER'))
    expect(locked).toMatchObject({ ok: false, code: 'EDIT_LOCKED' })
  })

  it('is allowed when the caller may update every referencing record', async () => {
    state.updatable.add('372786')
    expect((await mayChangeFile(file, req('EDITOR'))).ok).toBe(true)
    expect((await mayChangeFile(file, req('ADMIN', true))).ok).toBe(true)
  })

  it('an unreferenced file changes only for its uploader', async () => {
    state.refs = []
    expect((await mayChangeFile(file, req('STRANGER'))).ok).toBe(false)
    expect((await mayChangeFile(file, req('UPLOADER'))).ok).toBe(true)
  })
})

describe('a use counts only for its last writer', () => {
  it('a row edited since by someone else, or one whose edits cannot be told, gets no admin trust', () => {
    const admins = new Set(['ADMIN-1'])
    // Last writer STRANGER on a record the uploader created: does not count.
    expect(
      attributionCounts(
        { by: 'STRANGER', trust: 'author', adminIf: ['UPLOADER', 'STRANGER'] },
        'UPLOADER',
        admins
      )
    ).toBe(false)
    // An admin-created row later edited by a non-admin: no admin trust.
    expect(
      attributionCounts(
        { by: 'BOB', trust: 'author', adminIf: ['ADMIN-1', 'BOB'] },
        'UPLOADER',
        admins
      )
    ).toBe(false)
    // No modifier column: who edited since can't be told, so admin trust never applies.
    expect(
      attributionCounts({ by: 'ADMIN-1', trust: 'author', adminIf: null }, 'UPLOADER', admins)
    ).toBe(false)
    // Allowed: the uploader is the last writer; or creator and last writer are admins.
    expect(
      attributionCounts({ by: 'UPLOADER', trust: 'author', adminIf: null }, 'UPLOADER', admins)
    ).toBe(true)
    expect(
      attributionCounts(
        { by: 'ADMIN-1', trust: 'author', adminIf: ['ADMIN-1'] },
        'UPLOADER',
        admins
      )
    ).toBe(true)
  })
})

describe('administrators and DM / private-channel attachments', () => {
  beforeEach(() => {
    state.refs = []
  })
  const own = { by: 'UPLOADER', trust: 'author', adminIf: ['UPLOADER'] }

  it('an admin outside the DM gets nothing; a member admin or the compliance view reads it', async () => {
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'room', room: 'dm:UPLOADER:BOB', ...own }])
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(false)
    expect((await readableFileIds([file], req('ADMIN', true))).size).toBe(0)
    state.rooms.add('ADMIN|dm:UPLOADER:BOB')
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(true)
  })

  it('a private channel is closed to a non-member admin; an open channel is not', async () => {
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'room', room: 'channel:priv', ...own }])
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(false)
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'room', room: 'channel:ops', ...own }])
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(true)
  })

  it("a DM file that is also a record attachment, or the admin's own upload, stays readable", async () => {
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'room', room: 'dm:UPLOADER:BOB', ...own }])
    state.refs = [{ f: FILE.toUpperCase(), r: '372786' }]
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(true)
    state.refs = []
    expect(await mayReadFile({ ...file, uploaded_by: 'ADMIN' }, req('ADMIN', true))).toBe(true)
  })

  it('the compliance read needs an admin and a message that carries the file, and is logged', async () => {
    const admin = { ...(req('ADMIN', true) as object), query: {} } as never
    state.chatMsg = { room: 'dm:UPLOADER:BOB', attachments: JSON.stringify([FILE]) }
    expect(await chatComplianceRead(file, '41', req('BOB') as never)).toBe(false)
    expect(await chatComplianceRead(file, 'x', admin)).toBe(false)
    expect(await chatComplianceRead(file, '41', admin)).toBe(true)
    expect(state.logged).toEqual([
      expect.objectContaining({
        action: 'chat-admin-read',
        item: '41',
        collection: 'chat_messages',
        comment: expect.stringContaining(FILE.toUpperCase())
      })
    ])
    // Every fetch is its own row.
    expect(await chatComplianceRead(file, '41', admin)).toBe(true)
    expect(state.logged).toHaveLength(2)
    state.chatMsg = { room: 'dm:UPLOADER:BOB', attachments: '[]' }
    state.versions = [{ attachments: JSON.stringify([FILE]) }]
    expect(await chatComplianceRead(file, '41', admin)).toBe(true)
    // A message that does not carry the file (nor any version of it), or no message: no read, no row.
    state.versions = []
    expect(await chatComplianceRead(file, '41', admin)).toBe(false)
    state.chatMsg = undefined
    expect(await chatComplianceRead(file, '41', admin)).toBe(false)
    expect(state.logged).toHaveLength(3)
  })
})

describe('write-time: a stored file id must be readable by its writer', () => {
  beforeEach(() => {
    state.refs = [{ f: FILE.toUpperCase(), r: '372786' }]
    state.fileRows = [{ id: FILE.toUpperCase(), uploaded_by: 'UPLOADER', tags: null }]
  })

  it('refuses a writer embedding a file they cannot read (400, naming the field)', async () => {
    const err = await assertFileIdsReadable(
      'text',
      `see /api/files/${FILE}`,
      req('STRANGER')
    ).catch((e) => e)
    expect(err).toMatchObject({ statusCode: 400, code: 'FILE_NOT_READABLE', field: 'text' })
  })

  it('passes the uploader, an admin, a reader of the file, and ids already there', async () => {
    await assertFileIdsReadable('text', `see ${FILE}`, req('UPLOADER'))
    await assertFileIdsReadable('text', `see ${FILE}`, req('ADMIN', true))
    await assertFileIdsReadable('text', `still ${FILE}`, req('STRANGER'), `was ${FILE}`)
    state.readable.add('372786')
    await assertFileIdsReadable('text', `see ${FILE}`, req('READER'))
  })

  it('items: a rich-text field naming an unreadable file is refused; other fields are not judged', async () => {
    state.fields = [
      { field: 'objective', interface: 'input-rich-text-html', special: null },
      { field: 'title', interface: 'input', special: null }
    ]
    const html = `<p><img src="/api/files/${FILE}"></p>`
    const err = await assertEmbeddedFilesReadable(
      'workflows',
      { objective: html },
      req('STRANGER')
    ).catch((e) => e)
    expect(err).toMatchObject({ statusCode: 400, field: 'objective' })
    await assertEmbeddedFilesReadable('workflows', { title: FILE }, req('STRANGER'))
    await assertEmbeddedFilesReadable('workflows', { objective: html }, req('UPLOADER'))
    await assertEmbeddedFilesReadable('workflows', { objective: html }, req('ADMIN', true))
  })
})

describe('a failed lookup denies, never 500, never allows', () => {
  const own = { by: 'UPLOADER', trust: 'author', adminIf: ['UPLOADER'] }

  it('non-admin: a failed FK lookup or a broken index grants nothing (no throw)', async () => {
    state.refs = []
    state.attrs.set(FILE.toUpperCase(), [
      { kind: 'shared', by: null, trust: 'table', adminIf: null }
    ])
    expect(await mayReadFile(file, req('ANYONE'))).toBe(true)
    state.refsFail = true
    expect(await mayReadFile(file, req('ANYONE'))).toBe(false)
    expect((await readableFileIds([file], req('ANYONE'))).size).toBe(0)
    expect((await mayChangeFile(file, req('UPLOADER'))).ok).toBe(false)
    state.refsFail = false
    state.attrsThrow = true
    expect(await mayReadFile(file, req('ANYONE'))).toBe(false)
    // The uploader still reads their own file.
    expect(await mayReadFile(file, req('UPLOADER'))).toBe(true)
  })

  it('admin: when the chat source could not be read, a loose file is denied; a record attachment is not', async () => {
    state.refs = []
    state.attrs.set(FILE.toUpperCase(), [{ kind: 'room', room: 'channel:ops', ...own }])
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(true)
    state.incomplete = new Set(['chat'])
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(false)
    state.refs = [{ f: FILE.toUpperCase(), r: '372786' }]
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(true)
    state.incomplete = new Set()
    state.refs = []
    state.attrsThrow = true
    expect(await mayReadFile(file, req('ADMIN', true))).toBe(false)
    expect(await mayReadFile({ ...file, uploaded_by: 'ADMIN' }, req('ADMIN', true))).toBe(true)
  })
})
