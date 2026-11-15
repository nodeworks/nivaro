import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetDerivedCauseMemory,
  type CauseDeps,
  causesForViewer,
  cleanNotes,
  noteDerivedCauses,
  readDerivedCauses,
  type StoredCause,
  sameDerived
} from './derived-causes.js'
import {
  __resetFieldChangeRelay,
  type RelayDeps,
  uploadNameDelivery
} from './field-change-relay.js'
import { summarizeRecordHelp } from './record-help.js'
import { rollupInputs } from './rollups.js'
import {
  MAX_IN_FLIGHT,
  PROGRESS_GAP_MS,
  parseUploadReport,
  uploadEvent,
  uploadTracker
} from './upload-presence.js'

// ─── #19 help requested ───────────────────────────────────────────────────────

describe('record help (rt9 #19)', () => {
  const row = (id: number, by: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Ticket ${id}`,
    status: 'open',
    created_by: by,
    assignee: null,
    team_id: null,
    created_at: new Date('2026-11-15T10:00:00Z'),
    requester_first: 'Beth',
    requester_last: 'Ames',
    ...extra
  })

  it('answers only the requests the viewer may see (others are not even counted)', async () => {
    const out = await summarizeRecordHelp(
      [row(1, 'U1'), row(2, 'U2')] as never,
      async (r) => Number(r.id) === 2
    )
    expect(out.open).toBe(1)
    expect(out.tickets.map((t) => t.id)).toEqual([2])
    expect(out.tickets[0].requested_by).toBe('Beth Ames')
  })

  it('a viewer who may see none gets nothing at all', async () => {
    const out = await summarizeRecordHelp([row(1, 'U1')] as never, async () => false)
    expect(out).toEqual({ open: 0, tickets: [] })
  })
})

// ─── #10 derived values explain themselves ──────────────────────────────────

describe('derived causes (rt9 #10)', () => {
  beforeEach(() => _resetDerivedCauseMemory())

  it('compares dates by instant, numbers by value', () => {
    expect(sameDerived('2026-11-14', new Date('2026-11-14T00:00:00Z'))).toBe(true)
    expect(sameDerived(10, '10.000')).toBe(true)
    expect(sameDerived(null, '')).toBe(true)
    expect(sameDerived('2026-11-14', '2026-11-16')).toBe(false)
  })

  it('keeps only real changes that name an input', () => {
    const out = cleanNotes([
      { field: 'a', kind: 'computed', from: 1, to: 1, inputs: [{ collection: 'c', field: 'x' }] },
      { field: 'b', kind: 'computed', from: 1, to: 2, inputs: [] },
      {
        field: 'd',
        kind: 'rule',
        from: null,
        to: '2026-11-14',
        inputs: [{ collection: 'c', field: 'x' }]
      }
    ])
    expect(out.map((n) => n.field)).toEqual(['d'])
  })

  it('stores and reads back notes per record (no Redis: process memory)', async () => {
    await noteDerivedCauses('workflows', 7, [
      {
        field: 'need_by',
        kind: 'computed',
        from: '2026-11-12',
        to: '2026-11-14',
        inputs: [{ collection: 'workflows', field: 'po_due' }]
      }
    ])
    const got = await readDerivedCauses('workflows', '7')
    expect(got).toHaveLength(1)
    expect(got[0].field).toBe('need_by')
    expect(await readDerivedCauses('workflows', '8')).toEqual([])
  })

  const stored = (over: Partial<StoredCause> = {}): StoredCause => ({
    field: 'need_by',
    kind: 'rollup',
    from: '2026-11-12',
    to: '2026-11-14',
    at: Date.parse('2026-11-15T10:00:00Z'),
    inputs: [{ collection: 'purchase_orders', field: 'due_date', item: '42' }],
    ...over
  })
  const deps = (over: Partial<CauseDeps> = {}): CauseDeps => ({
    readable: async () => null,
    fieldLabel: async (_c, f) => (f === 'due_date' ? 'Due date' : f),
    collectionLabel: async () => 'Purchase order',
    recordLabels: async () => ({ 'purchase_orders:42': 'PO-1042' }),
    ...over
  })

  it('names the other record only through the viewer’s own label read', async () => {
    const [c] = await causesForViewer('workflows', { need_by: '2026-11-14' }, [stored()], deps())
    expect(c.inputs[0]).toMatchObject({ label: 'Due date', record_label: 'PO-1042', own: false })
    const [d] = await causesForViewer(
      'workflows',
      { need_by: '2026-11-14' },
      [stored()],
      deps({ recordLabels: async () => ({}) })
    )
    expect(d.inputs[0].record_label).toBeUndefined()
    expect(d.inputs[0].collection_label).toBe('Purchase order')
  })

  it('says nothing when the viewer cannot read the field, the input or the value moved on', async () => {
    const noField = deps({
      readable: async (c) => (c === 'workflows' ? new Set(['id']) : null)
    })
    expect(await causesForViewer('workflows', { id: 1 }, [stored()], noField)).toEqual([])
    const noInput = deps({ readable: async (c) => (c === 'purchase_orders' ? false : null) })
    expect(
      await causesForViewer('workflows', { need_by: '2026-11-14' }, [stored()], noInput)
    ).toEqual([])
    expect(
      await causesForViewer('workflows', { need_by: '2026-12-01' }, [stored()], deps())
    ).toEqual([])
  })

  it('a rollup names what it reads and the child that changed', () => {
    const inputs = rollupInputs(
      {
        sources: [
          { related_collection: 'lines', fk_field: 'wf', aggregate: 'sum', value_field: 'amount' },
          {
            related_collection: 'credits',
            fk_field: 'wf',
            aggregate: 'sum',
            value_field: '',
            value_formula: '{{qty}} * {{price}}'
          }
        ] as never
      },
      { collection: 'lines', item: 9 }
    )
    expect(inputs).toEqual([
      { collection: 'lines', field: 'amount', item: '9' },
      { collection: 'credits', field: 'qty' },
      { collection: 'credits', field: 'price' }
    ])
  })
})

// ─── #9 upload progress ─────────────────────────────────────────────────────

describe('upload presence (rt9 #9)', () => {
  it('reads old and new client reports', () => {
    expect(parseUploadReport('r', { name: 'a.pdf', state: 'done' }, 'x')).toMatchObject({
      phase: 'done',
      upload: 'x',
      field: null
    })
    const r = parseUploadReport(
      'r',
      { upload: 'u1', field: 'quote', name: 'q.pdf', phase: 'progress', pct: 61.4 },
      'x'
    )
    expect(r).toMatchObject({ upload: 'u1', field: 'quote', pct: 61, phase: 'progress' })
    expect(parseUploadReport('r', { field: '1;drop', name: '' }, 'x')).toMatchObject({
      field: null,
      name: 'a file'
    })
  })

  it('throttles progress, always passes start / finish, ends in-flight uploads on leave', () => {
    const t = uploadTracker()
    const at = (phase: string, pct: number | null = null, upload = 'u1') =>
      parseUploadReport('room1', { upload, name: 'q.pdf', phase, pct }, 'x')!
    expect(t.accept(at('start', 0), 0)).toBe(true)
    expect(t.accept(at('progress', 10), 100)).toBe(false)
    expect(t.accept(at('progress', 30), PROGRESS_GAP_MS + 1)).toBe(true)
    expect(t.accept(at('progress', 100), PROGRESS_GAP_MS + 50)).toBe(true)
    expect(t.accept(at('start', 0, 'u2'), 0)).toBe(true)
    const dropped = t.drop('room1')
    expect(dropped.map((d) => [d.upload, d.phase])).toEqual([
      ['u1', 'cancel'],
      ['u2', 'cancel']
    ])
    expect(t.accept(at('done'), 1000)).toBe(true)
    expect(t.size()).toBe(0)
  })

  it('caps uploads in flight per socket', () => {
    const t = uploadTracker()
    for (let i = 0; i < MAX_IN_FLIGHT; i++)
      expect(t.accept(parseUploadReport('r', { upload: `u${i}`, phase: 'start' }, 'x')!)).toBe(true)
    expect(t.accept(parseUploadReport('r', { upload: 'over', phase: 'start' }, 'x')!)).toBe(false)
  })

  it('a viewer who may not read the field never gets the file name', () => {
    const r = parseUploadReport(
      'r',
      { upload: 'u', name: 'salary.xlsx', phase: 'progress', pct: 40 },
      'x'
    )!
    const rec = { collection: 'workflows', item: '5' }
    const who = { id: 'U1', name: 'Beth' }
    expect(uploadEvent(r, rec, who, true)).toMatchObject({
      name: 'salary.xlsx',
      state: 'start',
      pct: 40
    })
    const hidden = uploadEvent(r, rec, who, false)
    expect(hidden.name).toBe('a file')
    expect(hidden.name_hidden).toBe(true)
    expect(JSON.stringify(hidden)).not.toContain('salary')
  })

  it('names go only to sockets whose person may read the field; others hear nothing (L4)', async () => {
    __resetFieldChangeRelay()
    const deps: RelayDeps = {
      loadUser: async (id) => ({ id }) as never,
      allowedFields: async (u) => ((u as { id: string }).id === 'A' ? ['quote'] : ['title']),
      valueFields: async () => new Set(['quote', 'title']),
      now: () => 0
    }
    const viewers = [
      { socket: 's1', id: 'A', kind: 'session' },
      { socket: 's2', id: 'B', kind: 'session' },
      { socket: 's3', id: 'C', kind: 'apikey' }
    ]
    const d = await uploadNameDelivery(viewers, 'workflows', 'quote', deps)
    expect(d.valueTo).toEqual(['s1'])
    // The event names the field: a non-reader (B) and an API-key socket (C) get nothing.
    expect(d.nameTo).toEqual([])
    // No field named: everyone hears "uploading a file".
    const none = await uploadNameDelivery(viewers, 'workflows', null, deps)
    expect(none.valueTo).toEqual([])
    expect(none.nameTo.sort()).toEqual(['s1', 's2', 's3'])
  })
})
