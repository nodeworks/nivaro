import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  readOne: vi.fn(
    async (..._a: unknown[]): Promise<Record<string, unknown> | null> => ({
      id: 5,
      photo: null
    })
  ),
  updateOne: vi.fn(async (..._a: unknown[]) => ({})),
  uploadFileBuffer: vi.fn(async (..._a: unknown[]) => ({
    id: 'F1',
    filename_download: 'a.pdf',
    type: 'application/pdf',
    filesize: 9
  })),
  deleteFile: vi.fn(async (..._a: unknown[]) => undefined),
  recordWriteRefusal: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  getAllowedFields: vi.fn(async (..._a: unknown[]): Promise<string[] | null> => null),
  logActivity: vi.fn(async () => 1)
}))

vi.mock('../../../db/index.js', () => ({
  db: () => ({ where: () => ({ first: async () => ({ file_max_size_mb: 50 }) }) })
}))
vi.mock('../../../services/items.js', () => ({ readOne: h.readOne, updateOne: h.updateOne }))
vi.mock('../../../services/activity.js', () => ({ logActivity: h.logActivity }))
vi.mock('../../../services/edit-lock.js', () => ({ recordWriteRefusal: h.recordWriteRefusal }))
vi.mock('../../../services/permissions.js', () => ({ getAllowedFields: h.getAllowedFields }))
vi.mock('../../../services/files.js', async () => ({
  assertUploadContent: (b: Buffer) => {
    if (!b.length) throw Object.assign(new Error('The file is empty.'), { statusCode: 400 })
  },
  cleanDownloadName: (s: string) => s.trim() || 'download',
  deleteFile: h.deleteFile,
  uploadFileBuffer: h.uploadFileBuffer
}))
vi.mock('../../../services/collections.js', () => ({
  getFields: async () => [
    { field: 'id', interface: null },
    { field: 'photo', interface: 'file-image' },
    { field: 'documents', interface: 'files' },
    { field: 'title', interface: 'input' }
  ],
  getRelations: async () => [
    {
      many_collection: 'work_orders_files',
      many_field: 'work_orders_id',
      one_collection: 'work_orders',
      one_field: 'documents',
      junction_field: 'nivaro_files_id'
    },
    {
      many_collection: 'work_orders_files',
      many_field: 'nivaro_files_id',
      one_collection: 'nivaro_files',
      junction_field: 'work_orders_id'
    }
  ]
}))

const { attachFileToRecord, decodeBase64File, fileFieldsOf, AttachError } = await import(
  '../../../services/file-attach.js'
)

const pdf = Buffer.from('%PDF-1.4 x').toString('base64')
const req = { user: { id: 'U1' }, workspaceId: null } as never
const input = (over: Record<string, unknown> = {}) => ({
  collection: 'work_orders',
  item: '5',
  filename: 'a.pdf',
  content_base64: pdf,
  ...over
})

beforeEach(() => {
  for (const f of Object.values(h)) f.mockClear()
})

describe('fileFieldsOf', () => {
  it('finds single and to-many file fields', () => {
    expect(
      fileFieldsOf(
        'work_orders',
        [
          { field: 'photo', interface: 'file-image' },
          { field: 'cover', interface: null },
          { field: 'documents', interface: null }
        ],
        [
          { many_collection: 'work_orders', many_field: 'cover', one_collection: 'nivaro_files' },
          {
            many_collection: 'j',
            many_field: 'wo_id',
            one_collection: 'work_orders',
            one_field: 'documents',
            junction_field: 'file_id'
          },
          { many_collection: 'j', many_field: 'file_id', one_collection: 'nivaro_files' }
        ]
      )
    ).toEqual([
      { field: 'photo', kind: 'single' },
      { field: 'cover', kind: 'single' },
      { field: 'documents', kind: 'many' }
    ])
  })
})

describe('decodeBase64File', () => {
  it('decodes plain base64 and data URLs, refusing junk and oversize', () => {
    expect(decodeBase64File(pdf, 100).buffer.toString()).toBe('%PDF-1.4 x')
    expect(decodeBase64File(`data:application/pdf;base64,${pdf}`, 100).dataUrlType).toBe(
      'application/pdf'
    )
    expect(() => decodeBase64File('not base64!', 100)).toThrow(/not valid base64/)
    expect(() => decodeBase64File(pdf, 4)).toThrow(/larger than/)
    expect(() => decodeBase64File('', 100)).toThrow(/required/)
  })
})

describe('attachFileToRecord', () => {
  it('needs a field when the record has several file fields', async () => {
    await expect(attachFileToRecord(req, input())).rejects.toThrow(/Say which field/)
    expect(h.uploadFileBuffer).not.toHaveBeenCalled()
  })

  it('links a single-file field through the items service as the caller', async () => {
    const out = await attachFileToRecord(req, input({ field: 'photo' }))
    expect(h.updateOne).toHaveBeenCalledWith(
      { id: 'U1' },
      'work_orders',
      '5',
      { photo: 'F1' },
      req,
      undefined,
      { callerPayload: true }
    )
    expect(out).toMatchObject({ field: 'photo', replaced: null, file: { id: 'F1' } })
  })

  it('adds to a to-many file field', async () => {
    await attachFileToRecord(req, input({ field: 'documents' }))
    expect(h.updateOne.mock.calls[0][3]).toEqual({ documents: ['F1'] })
  })

  it('answers 404 for a record the caller cannot open, before storing anything', async () => {
    h.readOne.mockResolvedValueOnce(null)
    const err = await attachFileToRecord(req, input({ field: 'photo' })).catch((e) => e)
    expect(err).toBeInstanceOf(AttachError)
    expect(err.statusCode).toBe(404)
    expect(h.uploadFileBuffer).not.toHaveBeenCalled()
  })

  it('refuses when the caller may not change the record or the field', async () => {
    h.recordWriteRefusal.mockResolvedValueOnce({ status: 403, body: { error: 'Locked' } })
    await expect(attachFileToRecord(req, input({ field: 'photo' }))).rejects.toThrow('Locked')
    h.getAllowedFields.mockResolvedValueOnce(['title'])
    await expect(attachFileToRecord(req, input({ field: 'photo' }))).rejects.toThrow(
      /cannot change photo/
    )
    expect(h.uploadFileBuffer).not.toHaveBeenCalled()
  })

  it('keeps an existing file unless replace is set', async () => {
    h.readOne.mockResolvedValue({ id: 5, photo: 'OLD' })
    await expect(attachFileToRecord(req, input({ field: 'photo' }))).rejects.toThrow(
      /already holds a file/
    )
    const out = await attachFileToRecord(req, input({ field: 'photo', replace: true }))
    expect(out.replaced).toBe('OLD')
    h.readOne.mockResolvedValue({ id: 5, photo: null })
  })

  it('removes the upload when the link is refused', async () => {
    h.updateOne.mockRejectedValueOnce(Object.assign(new Error('Invalid'), { statusCode: 400 }))
    await expect(attachFileToRecord(req, input({ field: 'photo' }))).rejects.toThrow('Invalid')
    expect(h.deleteFile).toHaveBeenCalledWith('F1')
  })
})
