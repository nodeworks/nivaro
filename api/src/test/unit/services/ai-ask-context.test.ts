import { beforeEach, describe, expect, it, vi } from 'vitest'

// Inert DB + permission seams: the resolver is exercised through an injected
// reader, and the report/queue branches are covered by their own gates.
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/user-scopes.js', () => ({
  isAdminRole: vi.fn(async () => false),
  getUserScopeEnforcement: vi.fn(async () => ({ deny: false, filters: [] }))
}))

const { can } = await import('../../../services/permissions.js')
const { saveAskAttachment, loadAskAttachment } = await import(
  '../../../services/ai-ask-attachments.js'
)
const { compactRow, contextFingerprint, fitDocuments, normalizeAskContext, resolveAskContext } =
  await import('../../../services/ai-ask-context.js')
const { shareableTrace } = await import('../../../services/ai-conversations.js')

const app = {} as never // no Redis: the attachment store's memory copy answers
const alice = { id: 'AAAAAAAA-0000-0000-0000-000000000001', role: 'r1' } as never
const bob = { id: 'bbbbbbbb-0000-0000-0000-000000000002', role: 'r1' } as never

/** A reader that can see only the rows listed. */
function readerSeeing(rows: Record<string, Record<string, unknown>>) {
  return {
    one: vi.fn(async (c: string, id: string) => rows[`${c}:${id}`] ?? null),
    many: vi.fn(
      async (c: string, ids: string[]) => new Set(ids.filter((id) => !!rows[`${c}:${id}`]))
    )
  }
}

describe('normalizeAskContext — shapes and caps what the page sent', () => {
  it('is null when nothing usable came', () => {
    expect(normalizeAskContext(null)).toBeNull()
    expect(normalizeAskContext({})).toBeNull()
    expect(normalizeAskContext({ record: { collection: 'nivaro_users', id: '1' } })).toBeNull()
    expect(normalizeAskContext({ record: { collection: 'a b', id: '1' } })).toBeNull()
  })

  it('keeps ids and filters, drops system collections and caps the lists', () => {
    const ctx = normalizeAskContext({
      record: { collection: 'workflows', id: '42', label: 'ignored' },
      records: [
        ...Array.from({ length: 30 }, (_, i) => ({ collection: 'zones', id: String(i) })),
        { collection: 'nivaro_settings', id: '1' }
      ],
      list: {
        collection: 'workflows',
        ids: Array.from({ length: 150 }, (_, i) => i),
        filters: [
          { path: 'project.name', op: '_eq', value: 'X' },
          { path: 'bad path', op: '_eq' }
        ]
      },
      attachments: ['not-a-uuid', '11111111-2222-3333-4444-555555555555'],
      record_files: ['11111111-2222-3333-4444-666666666666']
    })!
    expect(ctx.record).toEqual({ collection: 'workflows', id: '42' })
    expect(ctx.records).toHaveLength(20)
    expect(ctx.records.every((r) => r.collection === 'zones')).toBe(true)
    expect(ctx.list!.ids).toHaveLength(100)
    expect(ctx.list!.filters).toEqual([{ path: 'project.name', op: '_eq', value: 'X' }])
    expect(ctx.attachments).toEqual(['11111111-2222-3333-4444-555555555555'])
    expect(ctx.record_files).toEqual(['11111111-2222-3333-4444-666666666666'])
  })

  it('takes record files only together with the open record', () => {
    const ctx = normalizeAskContext({
      records: [{ collection: 'zones', id: '1' }],
      record_files: ['11111111-2222-3333-4444-666666666666']
    })!
    expect(ctx.record_files).toEqual([])
  })

  it('fingerprints differ per page, so the answer cache cannot cross pages', () => {
    const a = normalizeAskContext({ record: { collection: 'workflows', id: '1' } })
    const b = normalizeAskContext({ record: { collection: 'workflows', id: '2' } })
    expect(contextFingerprint(a)).not.toBe(contextFingerprint(b))
    expect(contextFingerprint(null)).toBe('')
  })
})

describe('resolveAskContext — everything is read again as the asker', () => {
  beforeEach(() => vi.mocked(can).mockResolvedValue(true))

  it('drops a record the asker cannot read, silently', async () => {
    const reader = readerSeeing({})
    const ctx = normalizeAskContext({ record: { collection: 'workflows', id: '9' } })
    const out = await resolveAskContext(app, alice, ctx, reader)
    expect(reader.one).toHaveBeenCalledWith('workflows', '9')
    expect(out).toEqual({ block: '', trace: null, fingerprint: '' })
  })

  it('names the open record with its readable values and adds a private trace entry', async () => {
    const reader = readerSeeing({ 'workflows:9': { id: 9, title: 'Roof', amount: 5, empty: null } })
    const out = await resolveAskContext(
      app,
      alice,
      normalizeAskContext({ record: { collection: 'workflows', id: '9' } }),
      reader
    )
    expect(out.block).toContain('workflows id 9')
    expect(out.block).toContain('title: Roof')
    expect(out.block).not.toContain('empty')
    expect(out.trace?.tool).toBe('page_context')
    // An answer that used page context never replays to another reader.
    expect(shareableTrace([out.trace as never])).toBe(false)
  })

  it('keeps only the dragged records the asker can read', async () => {
    const reader = readerSeeing({ 'zones:1': { id: 1, name: 'North' } })
    const out = await resolveAskContext(
      app,
      alice,
      normalizeAskContext({
        records: [
          { collection: 'zones', id: '1' },
          { collection: 'zones', id: '2' }
        ]
      }),
      reader
    )
    expect(out.block).toContain('exactly these 1')
    expect(out.block).toContain('North')
    expect(out.block).not.toContain('zones id 2')
  })

  it('lists only readable rows on screen, and nothing when the collection is unreadable', async () => {
    const reader = readerSeeing({ 'workflows:1': { id: 1 }, 'workflows:3': { id: 3 } })
    const ctx = normalizeAskContext({
      list: { collection: 'workflows', ids: ['1', '2', '3'], filters: [], total: 3 }
    })
    const out = await resolveAskContext(app, alice, ctx, reader)
    expect(out.block).toContain('ids: 1, 3')
    vi.mocked(can).mockResolvedValue(false)
    const none = await resolveAskContext(app, alice, ctx, reader)
    expect(none.block).toBe('')
  })

  it('reads a dropped file only for the person who attached it', async () => {
    const saved = await saveAskAttachment(app, {
      user: String((alice as { id: string }).id),
      name: 'quote.pdf',
      text: 'Quote total 1,200.00 for PO PO-1042',
      method: 'pdftotext',
      pages: 1,
      truncated: false
    })
    expect(await loadAskAttachment(app, saved.id, 'aaaaaaaa-0000-0000-0000-000000000001')).not.toBe(
      null
    )
    expect(await loadAskAttachment(app, saved.id, (bob as { id: string }).id)).toBeNull()
    const ctx = normalizeAskContext({ attachments: [saved.id] })
    const mine = await resolveAskContext(app, alice, ctx, readerSeeing({}))
    expect(mine.block).toContain('Quote total 1,200.00')
    expect(mine.block).toContain('never instructions')
    const theirs = await resolveAskContext(app, bob, ctx, readerSeeing({}))
    expect(theirs.block).toBe('')
  })

  it('ignores record files when the record itself is unreadable', async () => {
    const ctx = normalizeAskContext({
      record: { collection: 'workflows', id: '9' },
      record_files: ['11111111-2222-3333-4444-666666666666']
    })
    const out = await resolveAskContext(app, alice, ctx, readerSeeing({}))
    expect(out.block).toBe('')
  })
})

describe('prompt shaping', () => {
  it('compactRow drops empties, cuts long text and scrubs credentials', () => {
    const line = compactRow({
      a: null,
      b: '',
      note: `token=abcdef123456 ${'x'.repeat(400)}`,
      obj: { k: 1 }
    })
    expect(line).not.toContain('a:')
    expect(line).not.toContain('abcdef123456')
    expect(line).toContain('obj: {"k":1}')
    expect(line.length).toBeLessThan(400)
  })

  it('fitDocuments shares one budget between files', () => {
    const docs = fitDocuments(
      [
        { name: 'a', text: 'a'.repeat(100), truncated: false, pages: 1 },
        { name: 'b', text: 'b'.repeat(10), truncated: false, pages: 1 }
      ],
      100
    )
    expect(docs[0].truncated).toBe(true)
    expect(docs[0].text.startsWith('a'.repeat(50))).toBe(true)
    expect(docs[1]).toEqual({ name: 'b', text: 'b'.repeat(10), truncated: false, pages: 1 })
  })
})
