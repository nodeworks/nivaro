import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// #17 — every purge that removes a record's history skips records under an active legal hold:
// revision retention, expired-file cleanup, the trash purge (activity: purge.test.ts).

const state = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  held: new Set<string>(),
  refs: new Map<string, Array<{ collection: string; id: string }>>(),
  refsFailed: false,
  deleted: [] as string[]
}))

vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      state.ran.push(q)
      if (q.sql.includes('group by'))
        return [
          { collection: 'articles', item: '1', cnt: 9 },
          { collection: 'articles', item: '2', cnt: 9 }
        ]
      if (q.method === 'pluck') return [99, 98]
      if (q.sql.includes('[nivaro_files]') && q.method === 'select')
        return [{ id: 'F1' }, { id: 'f2' }, { id: 'f3' }]
      if (q.method === 'del') return 1
      return []
    })
  }
})
vi.mock('../../../services/legal-holds.js', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('../../../services/legal-holds.js')
  return {
    ...orig,
    heldRecordKeys: vi.fn(async () => state.held)
  }
})
vi.mock('../../../services/file-access.js', () => ({
  fileRecordRefs: vi.fn(async () => Object.assign(state.refs, { failed: state.refsFailed }))
}))
vi.mock('../../../services/files.js', () => ({
  deleteFile: vi.fn(async (id: string) => {
    state.deleted.push(id)
  })
}))
vi.mock('../../../services/storage/index.js', () => ({ getStorage: () => ({}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))

import { runFileCleanup } from '../../../hooks/file-cleanup.js'
import { holdKey } from '../../../services/legal-holds.js'
import { pruneRevisionsByCount } from '../../../services/revision-retention.js'
import { purgeExpiredTrash } from '../../../services/trash.js'

beforeEach(() => {
  state.ran = []
  state.held = new Set()
  state.refs = new Map()
  state.refsFailed = false
  state.deleted = []
})

describe('revision retention', () => {
  it('trims unheld records and leaves held ones whole', async () => {
    state.held = new Set([holdKey('articles', '1')])
    expect(await pruneRevisionsByCount(5)).toBe(1)
    const dels = state.ran.filter((q) => q.method === 'del')
    expect(dels).toHaveLength(1)
    expect(dels[0].bindings).toEqual(expect.arrayContaining(['articles', '2']))
    expect(dels[0].bindings).not.toContain('1')
  })
})

describe('expired-file cleanup', () => {
  it('keeps files held directly or linked to a held record', async () => {
    state.held = new Set([holdKey('articles', '7'), holdKey('nivaro_files', 'f2')])
    state.refs = new Map([['f1', [{ collection: 'articles', id: '7' }]]])
    const r = await runFileCleanup()
    expect(state.deleted).toEqual(['f3'])
    expect(r.expired).toBe(1)
  })

  it('keeps every file when holds exist but links cannot be read', async () => {
    state.held = new Set([holdKey('articles', '7')])
    state.refsFailed = true
    await runFileCleanup()
    expect(state.deleted).toEqual([])
  })

  it('deletes as before when nothing is held', async () => {
    await runFileCleanup()
    expect(state.deleted).toEqual(['F1', 'f2', 'f3'])
  })
})

describe('trash purge', () => {
  it('every delete carries the legal-hold guard', async () => {
    await purgeExpiredTrash()
    const dels = state.ran.filter((q) => q.method === 'del')
    expect(dels.length).toBeGreaterThan(0)
    for (const d of dels) {
      expect(d.sql).toMatch(/not exists \(select \* from \[nivaro_legal_holds\]/i)
      expect(d.sql).toMatch(/\[released_at\] is null/i)
    }
  })
})
