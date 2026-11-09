import { describe, expect, it, vi } from 'vitest'

// Army 11 (2026-11-08): prod held 24,061 .xlsm and 141 .xlsx files stored as
// text/plain — a multipart part with no Content-Type reaches us as busboy's
// default text/plain — and the workbook opened as raw bytes. The stored type now
// comes from the name (and first bytes) whenever the claim is generic.

const st = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[], put: [] as string[] }))

vi.mock('../../../db/index.js', () => {
  const db = () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'leftJoin', 'where', 'update']) chain[m] = () => chain
    chain.insert = async (row: Record<string, unknown>) => {
      st.inserted.push(row)
      return [1]
    }
    chain.first = async () => st.inserted[st.inserted.length - 1]
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
  getStorage: () => ({}),
  getStorageProviderName: () => 'local'
}))
vi.mock('../../../services/storage-drivers.js', () => ({
  deleteStoredObject: vi.fn(async () => undefined),
  getActiveStorageDriver: async () => ({
    name: 'local',
    put: vi.fn(async (_k: string, _b: Buffer, type: string) => {
      st.put.push(type)
    })
  }),
  readStoredObject: vi.fn()
}))
vi.mock('../../../services/stored-object-stream.js', () => ({ putStoredObjectFromFile: vi.fn() }))

import { uploadFile, uploadFileBuffer } from '../../../services/files.js'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00])
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00])
const user = { id: 'U1' } as never

function part(filename: string, mimetype: string, buffer: Buffer) {
  return { filename, mimetype, toBuffer: async () => buffer } as never
}

describe('stored type at upload (army 11)', () => {
  it('a text/plain part named .xlsm stores the macro-enabled workbook type', async () => {
    const f = await uploadFile(user, part('HQ26-81397 quote.xlsm', 'text/plain', ZIP))
    expect(f.type).toBe('application/vnd.ms-excel.sheet.macroenabled.12')
    expect(st.put.at(-1)).toBe('application/vnd.ms-excel.sheet.macroenabled.12')
  })

  it('octet-stream and empty claims take the name: xlsx, docx, xls, pdf', async () => {
    expect((await uploadFile(user, part('a.xlsx', 'application/octet-stream', ZIP))).type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    expect((await uploadFile(user, part('a.docx', '', ZIP))).type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect((await uploadFile(user, part('a.xls', 'text/plain', OLE))).type).toBe(
      'application/vnd.ms-excel'
    )
    expect(
      (await uploadFile(user, part('a.pdf', 'text/plain', Buffer.from('%PDF-1.7\n')))).type
    ).toBe('application/pdf')
  })

  it('real text keeps its text type; .csv becomes text/csv', async () => {
    expect((await uploadFile(user, part('notes.txt', 'text/plain', Buffer.from('hi')))).type).toBe(
      'text/plain'
    )
    expect((await uploadFile(user, part('rows.csv', 'text/plain', Buffer.from('a,b')))).type).toBe(
      'text/csv'
    )
  })

  it('a specific claim stands', async () => {
    expect((await uploadFileBuffer(user, ZIP, 'book.xlsm', 'application/vnd.ms-excel')).type).toBe(
      'application/vnd.ms-excel'
    )
  })

  it('binary bytes under a text name and text claim are not stored as text', async () => {
    expect((await uploadFileBuffer(user, ZIP, 'export.txt', 'text/plain')).type).toBe(
      'application/zip'
    )
    expect(
      (await uploadFileBuffer(user, Buffer.from([0x41, 0x00, 0x42, 0x00]), 'blob', 'text/plain'))
        .type
    ).toBe('application/octet-stream')
  })
})
