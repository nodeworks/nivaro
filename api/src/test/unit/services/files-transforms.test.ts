import { beforeEach, describe, expect, it, vi } from 'vitest'

// Replacing a file's bytes clears its cached transforms. Keys are written
// under the lower-cased row id, while the caller may pass any casing.

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const st = vi.hoisted(() => ({ listed: [] as string[], deleted: [] as string[] }))

vi.mock('../../../db/index.js', () => {
  const db = () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'leftJoin', 'where', 'update']) chain[m] = () => chain
    chain.first = async () => ({
      id: ID.toUpperCase(),
      filename_disk: 'old.png',
      filename_download: 'a.png',
      type: 'image/png'
    })
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(1).then(res)
    return chain
  }
  return { db: Object.assign(db, { raw: () => '' }) }
})
vi.mock('../../../db/tenant-context.js', () => ({
  getTenantId: () => null,
  getTenantSlug: () => null
}))
vi.mock('../../../config.js', () => ({ config: {} }))
vi.mock('../../../services/storage/index.js', () => ({
  getStorage: () => ({
    list: async (prefix: string) => st.listed.filter((k) => k.startsWith(prefix)),
    delete: async (k: string) => {
      st.deleted.push(k)
    }
  }),
  getStorageProviderName: () => 'local'
}))
vi.mock('../../../services/storage-drivers.js', () => ({
  deleteStoredObject: vi.fn(async () => undefined),
  getActiveStorageDriver: async () => ({ name: 'local', put: vi.fn(async () => undefined) }),
  readStoredObject: vi.fn()
}))
vi.mock('../../../services/stored-object-stream.js', () => ({ putStoredObjectFromFile: vi.fn() }))

import { deleteTransforms, replaceFileContent } from '../../../services/files.js'

beforeEach(() => {
  st.listed = [`transforms/${ID}/0123456789abcdef.webp`, `transforms/${ID}/fedcba9876543210.png`]
  st.deleted = []
})

describe('transform cache clearing', () => {
  it('replace clears the transforms of the file', async () => {
    await replaceFileContent(ID.toUpperCase(), Buffer.from('x'), 'b.png', 'image/png')
    expect(st.deleted.sort()).toEqual([...st.listed].sort())
  })

  it('deleteTransforms finds lower-case keys for an upper-case id', async () => {
    await deleteTransforms(ID.toUpperCase())
    expect(st.deleted).toHaveLength(2)
  })
})
