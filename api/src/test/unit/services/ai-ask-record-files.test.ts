import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/user-scopes.js', () => ({ isAdminRole: vi.fn(async () => false) }))

const { readableRecordFileIds } = await import('../../../services/ai-ask-context.js')
const { zipDeclaredSize, extractForAsk, ZIP_MAX_UNCOMPRESSED } = await import(
  '../../../services/ai-ask-extract.js'
)
const { clearAskAttachmentMemory, takeUploadSlot, UPLOADS_PER_WINDOW } = await import(
  '../../../services/ai-ask-attachments.js'
)

const F = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const record = { collection: 'workflows', id: '7' }

/** A world where the asker reads what `opts` lets them read. */
function deps(opts: {
  row?: Record<string, unknown> | null
  parentAllowed?: string[] | null
  childAllowed?: string[] | null
  childRows?: Array<Record<string, unknown>>
  canReadChild?: boolean
  canReadParent?: boolean
}) {
  const readChildren = vi.fn(async () => opts.childRows ?? [])
  return {
    readChildren,
    d: {
      readRecord: async () =>
        opts.row === undefined ? { id: 7, quote: F(1), contract: F(2) } : opts.row,
      fileColumns: async () => [
        { table: 'workflows', column: 'quote' },
        { table: 'workflows', column: 'contract' },
        { table: 'workflow_lines', column: 'receipt' },
        { table: 'workflows_files', column: 'directus_files_id' }
      ],
      childLinks: async () => [
        { table: 'workflow_lines', column: 'workflow' },
        { table: 'workflows_files', column: 'workflows_id' }
      ],
      relationFor: async (table: string) =>
        table === 'workflows_files'
          ? { one_field: 'files', junction_field: 'directus_files_id' }
          : { one_field: 'lines', junction_field: null },
      allowedFields: async (c: string) =>
        c === 'workflows' ? (opts.parentAllowed ?? null) : (opts.childAllowed ?? null),
      canRead: async (c: string) =>
        c === 'workflows' ? opts.canReadParent !== false : opts.canReadChild !== false,
      readChildren,
      junctionFileIds: async () => [F(4)],
      addendumFileIds: async () => [F(5)]
    }
  }
}

describe('readableRecordFileIds — only files the asker can see (S1)', () => {
  it('null when the record is unreadable', async () => {
    expect(await readableRecordFileIds(record, deps({ row: null }).d)).toBeNull()
  })

  it('collects own fields, readable child rows, the M2M junction and addendums', async () => {
    const { d, readChildren } = deps({ childRows: [{ id: 1, receipt: F(3) }] })
    const ids = await readableRecordFileIds(record, d)
    expect([...ids!].sort()).toEqual([F(1), F(2), F(3), F(4), F(5)])
    // Children are read through the asker's items read, file fields only.
    expect(readChildren).toHaveBeenCalledWith('workflow_lines', 'workflow', '7', ['receipt'])
  })

  it('leaves out a file field the role hides — whether readOne returned it or not', async () => {
    const hiddenByRow = await readableRecordFileIds(record, deps({ row: { id: 7, quote: F(1) } }).d)
    expect(hiddenByRow!.has(F(2))).toBe(false)
    const hiddenByPolicy = await readableRecordFileIds(
      record,
      deps({ parentAllowed: ['id', 'quote'] }).d
    )
    expect(hiddenByPolicy!.has(F(2))).toBe(false)
    expect(hiddenByPolicy!.has(F(1))).toBe(true)
    // …and the M2M junction behind a hidden alias field.
    expect(hiddenByPolicy!.has(F(4))).toBe(false)
  })

  it('leaves out child rows the asker cannot read, and child file fields they cannot read', async () => {
    // readItems as the asker returned no rows (RLS / scopes): nothing from children.
    const none = await readableRecordFileIds(record, deps({ childRows: [] }).d)
    expect(none!.has(F(3))).toBe(false)
    const { d, readChildren } = deps({ childAllowed: ['id'], childRows: [{ receipt: F(3) }] })
    const fieldHidden = await readableRecordFileIds(record, d)
    expect(fieldHidden!.has(F(3))).toBe(false)
    expect(readChildren).not.toHaveBeenCalled()
    const noCollection = await readableRecordFileIds(
      record,
      deps({ canReadChild: false, childRows: [{ receipt: F(3) }] }).d
    )
    expect(noCollection!.has(F(3))).toBe(false)
  })

  it("reads addendum attachments only under the addendum route's rule", async () => {
    const ids = await readableRecordFileIds(record, deps({ canReadParent: false }).d)
    expect(ids!.has(F(5))).toBe(false)
  })
})

/** A minimal zip: one central-directory entry declaring `size` bytes. */
function zipDeclaring(size: number): Buffer {
  const name = Buffer.from('xl/a.xml')
  const cen = Buffer.alloc(46)
  cen.writeUInt32LE(0x02014b50, 0)
  cen.writeUInt32LE(size, 24)
  cen.writeUInt16LE(name.length, 28)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + name.length, 12)
  eocd.writeUInt32LE(0, 16)
  return Buffer.concat([cen, name, eocd])
}

describe('bounded extraction for dropped files (S2)', () => {
  it('reads the declared size from the central directory', () => {
    expect(zipDeclaredSize(zipDeclaring(1234))).toEqual({ total: 1234, entries: 1 })
    expect(zipDeclaredSize(Buffer.from('not a zip at all, just text bytes here'))).toBeNull()
  })

  it('refuses a zip that would inflate past the cap, and a non-zip .xlsx', async () => {
    await expect(extractForAsk(zipDeclaring(ZIP_MAX_UNCOMPRESSED + 1), 'big.xlsx')).rejects.toThrow(
      /too large/
    )
    await expect(extractForAsk(Buffer.from('plain'), 'fake.docx')).rejects.toThrow(
      /could not be read/
    )
  })

  it('a plain text file still reads under the time bound', async () => {
    const out = await extractForAsk(Buffer.from('hello world, plain text'), 'a.txt', null, 1000)
    expect(out.text).toContain('hello world')
  })

  it('limits uploads per person per window', async () => {
    clearAskAttachmentMemory()
    const app = {} as never
    for (let i = 0; i < UPLOADS_PER_WINDOW; i++) expect(await takeUploadSlot(app, 'u1')).toBe(true)
    expect(await takeUploadSlot(app, 'U1')).toBe(false)
    expect(await takeUploadSlot(app, 'u2')).toBe(true)
  })
})
