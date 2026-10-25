import { beforeEach, describe, expect, it, vi } from 'vitest'

// A record's attachment follows the record (army 2026-10-25): reading it needs one
// referencing record readable as the caller, changing it needs every one updatable and
// not edit-locked; an unreferenced file reads as before and only its uploader changes it.

const FILE = '11111111-1111-4111-8111-111111111111'
const state = vi.hoisted(() => ({
  refs: [] as Array<{ f: string; r: string }>,
  readable: new Set<string>(),
  updatable: new Set<string>(),
  locked: new Set<string>()
}))

vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const b: any = {
      whereIn: () => b,
      whereNotNull: () => b,
      select: () => b,
      limit: async () => state.refs
    }
    return b
  })
}))
vi.mock('../../../services/file-usage.js', () => ({
  getFileRefColumns: vi.fn(async () => [{ table: 'workflows_files', column: 'directus_files_id' }])
}))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async () => ({ collection: 'workflows_files' })),
  getRelations: vi.fn(async () => [
    {
      many_collection: 'workflows_files',
      many_field: 'directus_files_id',
      junction_field: 'workflows_id',
      one_collection: 'nivaro_files'
    },
    {
      many_collection: 'workflows_files',
      many_field: 'workflows_id',
      junction_field: 'directus_files_id',
      one_collection: 'workflows'
    }
  ])
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

import { mayChangeFile, mayReadFile, readableFileIds } from '../../../services/file-access.js'

const file = { id: FILE.toUpperCase(), uploaded_by: 'UPLOADER' }
const req = (id: string, isAdmin = false) =>
  ({ user: { id, role: 'R' }, isAdmin, workspaceId: null }) as never

beforeEach(() => {
  state.refs = [{ f: FILE.toUpperCase(), r: '372786' }]
  state.readable = new Set()
  state.updatable = new Set()
  state.locked = new Set()
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

  it('an unreferenced file reads as before', async () => {
    state.refs = []
    expect(await mayReadFile(file, req('STRANGER'))).toBe(true)
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
