import { beforeEach, describe, expect, it, vi } from 'vitest'

// The cleanup compared lower-case transform keys with upper-case row ids
// (SQL Server returns uniqueidentifiers upper case), so it deleted the cached
// transforms of every file, every hour.

const LIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const st = vi.hoisted(() => ({ keys: [] as string[], deleted: [] as string[] }))

vi.mock('../../../db/index.js', () => {
  const db = () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['whereNotNull', 'where']) chain[m] = () => chain
    chain.whereIn = () => chain
    // expired query and the existing-ids query share the chain: rows for LIVE only
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    chain.then = (res: (v: unknown) => unknown) =>
      Promise.resolve([{ id: LIVE.toUpperCase() }]).then(res)
    chain.select = () => chain
    return chain
  }
  return { db }
})
vi.mock('../../../services/files.js', () => ({ deleteFile: vi.fn(async () => undefined) }))
vi.mock('../../../services/storage/index.js', () => ({
  getStorage: () => ({
    list: async () => st.keys,
    delete: async (k: string) => {
      st.deleted.push(k)
    }
  })
}))

import { runFileCleanup } from '../../../hooks/file-cleanup.js'
import { deleteFile } from '../../../services/files.js'

beforeEach(() => {
  st.keys = [`transforms/${LIVE}/0123456789abcdef.webp`, `transforms/${GONE}/0123456789abcdef.webp`]
  st.deleted = []
  vi.mocked(deleteFile).mockClear()
})

describe('orphaned transform cleanup', () => {
  it('keeps the transforms of a file that still exists (upper-case row id, lower-case key)', async () => {
    const res = await runFileCleanup()
    expect(st.deleted).toEqual([`transforms/${GONE}/0123456789abcdef.webp`])
    expect(res.orphans).toBe(1)
  })
})
