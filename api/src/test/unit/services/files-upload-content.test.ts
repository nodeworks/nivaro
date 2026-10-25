import { describe, expect, it, vi } from 'vitest'

// Uploads are refused when their bytes cannot be what the name says (army 2026-10-25:
// a Windows program renamed .pdf went out to approvers as application/pdf), and
// download names lose direction-override characters (`‮fdp.txt` reads as "txt.pdf").

const st = vi.hoisted(() => ({ listed: [] as string[], deleted: [] as string[] }))

vi.mock('../../../db/index.js', () => {
  const db = () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'leftJoin', 'where', 'update']) chain[m] = () => chain
    chain.first = async () => ({
      id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
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

import { assertUploadContent, cleanDownloadName } from '../../../services/files.js'

const PDF = Buffer.from('%PDF-1.7\n1 0 obj')
const EXE = Buffer.from('MZ\x90\x00This program cannot be run in DOS mode.', 'latin1')

describe('upload content check', () => {
  it('refuses an empty file, a program named .pdf and a fake image', () => {
    expect(() => assertUploadContent(Buffer.alloc(0), 'a.txt', 'text/plain')).toThrow(/empty/)
    expect(() => assertUploadContent(EXE, 'army-fake.pdf', 'application/pdf')).toThrow(/program/)
    expect(() => assertUploadContent(Buffer.from('hello'), 'x.pdf', 'application/pdf')).toThrow(
      /not a PDF/
    )
    expect(() => assertUploadContent(Buffer.from('hello'), 'x.png', 'image/png')).toThrow(
      /does not match/
    )
  })

  it('accepts real files of those kinds, plain text and an honest program', () => {
    expect(() => assertUploadContent(PDF, 'quote.pdf', 'application/pdf')).not.toThrow()
    expect(() =>
      assertUploadContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]), 'a.png', 'image/png')
    ).not.toThrow()
    expect(() => assertUploadContent(Buffer.from([0x50, 0x4b, 3, 4]), 'a.docx', '')).not.toThrow()
    expect(() => assertUploadContent(Buffer.from('a,b\n1,2'), 'a.csv', 'text/csv')).not.toThrow()
    expect(() => assertUploadContent(EXE, 'setup.exe', 'application/x-msdownload')).not.toThrow()
  })

  it('download names drop direction overrides', () => {
    expect(cleanDownloadName('ARMY \u202efdp.txt')).toBe('ARMY fdp.txt')
    expect(() => cleanDownloadName('\u202e')).toThrow()
  })
})
