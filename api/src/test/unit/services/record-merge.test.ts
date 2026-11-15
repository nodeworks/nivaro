import type { FastifyRequest } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMerge, type MergeDeps, undoMerge } from '../../../services/record-merge/apply.js'
import {
  type AttachedGates,
  type AttachedRow,
  judgeAttached
} from '../../../services/record-merge/attached.js'
import {
  judgeRelationCounts,
  type MergePlan,
  type MergePlanRecord
} from '../../../services/record-merge/plan.js'
import {
  emptyUndoLog,
  type InboundRelation,
  inboundRelations,
  isMergeField,
  type MergeUndoLog,
  mergeSettingOf,
  survivorPatch,
  UNDO_WINDOW_MS,
  undoRefusal
} from '../../../services/record-merge/rules.js'

vi.mock('../../../services/edit-lock.js', () => ({
  recordWriteRefusal: vi.fn(async (_req: unknown, _c: string, id: string) =>
    id === 'locked'
      ? {
          status: 403,
          body: {
            error:
              'This record is at Approved — only the person who created it, the owners of that step and administrators can change it.'
          }
        }
      : id === 'held'
        ? {
            status: 409,
            body: { error: 'Beth is editing this record — your changes were not saved.' }
          }
        : null
  )
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  isAdminRole: vi.fn(async () => false)
}))
vi.mock('../../../services/delete-in-flight.js', () => ({
  assertDeletableByPerson: vi.fn(async (_c: string, id: string, isAdmin: boolean) => {
    if (id === 'submitted' && !isAdmin)
      throw new Error('This record was submitted — cancel it instead.')
  })
}))

// ─── Rules ───────────────────────────────────────────────────────────────────

describe('merge switch', () => {
  it('is on by default, on its own (not tied to the duplicate warning)', () => {
    expect(mergeSettingOf('vendors', null)).toEqual({ allowed: true, source: 'default' })
    expect(mergeSettingOf('vendors', { duplicate_check: { mode: 'off' } })).toEqual({
      allowed: true,
      source: 'default'
    })
    expect(
      mergeSettingOf(
        'vendors',
        JSON.stringify({ duplicate_check: { mode: 'off' }, merge_records: { mode: 'on' } })
      )
    ).toEqual({ allowed: true, source: 'configured' })
    expect(mergeSettingOf('vendors', { merge_records: { mode: 'off' } }).allowed).toBe(false)
    expect(mergeSettingOf('nivaro_users', null).allowed).toBe(false)
  })
})

describe('merge fields', () => {
  it('leaves out ids, stamps, generated numbers, computed values and aliases', () => {
    const aliases = new Set(['lines'])
    expect(isMergeField({ field: 'name', type: 'string' }, aliases)).toBe(true)
    expect(isMergeField({ field: 'id' }, aliases)).toBe(false)
    expect(isMergeField({ field: 'created_at' }, aliases)).toBe(false)
    expect(isMergeField({ field: 'lines' }, aliases)).toBe(false)
    expect(isMergeField({ field: 'when', special: ['date-updated'] }, aliases)).toBe(false)
    expect(isMergeField({ field: 'total', computed_type: 'write' }, aliases)).toBe(false)
    expect(
      isMergeField({ field: 'number', options: { auto_id: { pattern: 'X-' } } }, aliases)
    ).toBe(false)
  })

  it('patches only differing values and refuses a field the person may not write', () => {
    const fields = new Set(['name', 'city', 'notes', 'owner'])
    const writable = new Set(['name', 'notes', 'owner'])
    const current = { name: 'Acme', city: 'Dover', notes: null, owner: 'u1' }
    expect(
      survivorPatch(current, { name: 'Acme', notes: 'a\nb', owner: { id: 'u2' } }, fields, writable)
    ).toEqual({ patch: { notes: 'a\nb', owner: 'u2' }, refused: [], unknown: [] })
    expect(survivorPatch(current, { city: 'Paris', zzz: 1 }, fields, writable)).toEqual({
      patch: {},
      refused: ['city'],
      unknown: ['zzz']
    })
  })
})

describe('inbound relations', () => {
  it('classifies lines, links, many-to-many and files; skips system tables', () => {
    const rels = [
      {
        many_collection: 'po_lines',
        many_field: 'po',
        one_collection: 'pos',
        one_field: 'lines',
        junction_field: null
      },
      {
        many_collection: 'invoices',
        many_field: 'po',
        one_collection: 'pos',
        one_field: null,
        junction_field: null
      },
      {
        many_collection: 'pos_tags',
        many_field: 'pos_id',
        one_collection: 'pos',
        one_field: 'tags',
        junction_field: 'tags_id'
      },
      {
        many_collection: 'pos_tags',
        many_field: 'tags_id',
        one_collection: 'tags',
        one_field: null,
        junction_field: 'pos_id'
      },
      {
        many_collection: 'pos_files',
        many_field: 'pos_id',
        one_collection: 'pos',
        one_field: 'docs',
        junction_field: 'file'
      },
      {
        many_collection: 'pos_files',
        many_field: 'file',
        one_collection: 'nivaro_files',
        one_field: null,
        junction_field: 'pos_id'
      },
      {
        many_collection: 'nivaro_tasks',
        many_field: 'po',
        one_collection: 'pos',
        one_field: null,
        junction_field: null
      }
    ]
    const out = inboundRelations('pos', rels, [
      { table: 'legacy_po_audit', column: 'po_id' },
      { table: 'invoices', column: 'po' }
    ])
    expect(out.map((r) => [r.key, r.kind, r.raw])).toEqual([
      ['po_lines.po', 'lines', false],
      ['invoices.po', 'links', false],
      ['pos_tags.pos_id', 'm2m', false],
      ['pos_files.pos_id', 'files', false],
      ['legacy_po_audit.po_id', 'links', true]
    ])
    expect(out[2].other_field).toBe('tags_id')
  })
})

describe('undo window', () => {
  const log = {
    ...emptyUndoLog({
      merge_id: 'm',
      collection: 'c',
      survivor: 'a',
      discarded: ['b'],
      kept: [],
      user: 'u1'
    })
  }
  it('is the merger’s or an admin’s for 24 hours', () => {
    expect(undoRefusal(log, { id: 'U1', isAdmin: false })).toBeNull()
    expect(undoRefusal(log, { id: 'u2', isAdmin: false })).toMatch(/Only the person/)
    expect(undoRefusal(log, { id: 'u2', isAdmin: true })).toBeNull()
    expect(
      undoRefusal(log, { id: 'u1', isAdmin: false }, Date.now() + UNDO_WINDOW_MS + 1000)
    ).toMatch(/24 hours/)
    expect(
      undoRefusal({ ...log, undone_at: new Date().toISOString() }, { id: 'u1', isAdmin: false })
    ).toMatch(/already/)
    expect(undoRefusal(null, { id: 'u1', isAdmin: false })).toMatch(/not known/)
  })
})

// ─── Per-record verdicts (locks, delete rules) ───────────────────────────────

describe('record verdicts', () => {
  it('refuses keeping a post-approval locked record and discarding a submitted one, in plain words', async () => {
    const { recordVerdicts } = await import('../../../services/record-merge/plan.js')
    const req = { user: { id: 'u1' } } as unknown as FastifyRequest
    const locked = await recordVerdicts(req, 'pos', 'locked', 'orders', true, false)
    expect(locked.survive).toMatch(/at Approved/)
    expect(locked.discard).toMatch(/at Approved/)
    const held = await recordVerdicts(req, 'pos', 'held', 'orders', true, false)
    expect(held.survive).toMatch(/Beth is editing/)
    const submitted = await recordVerdicts(req, 'pos', 'submitted', 'orders', true, false)
    expect(submitted.survive).toBeNull()
    expect(submitted.discard).toMatch(/cancel it instead/)
    expect((await recordVerdicts(req, 'pos', 'submitted', 'orders', true, true)).discard).toBeNull()
    const noDelete = await recordVerdicts(req, 'pos', 'ok', 'orders', false, false)
    expect(noDelete).toEqual({
      survive: null,
      discard: 'You cannot delete orders, so you cannot discard this one.'
    })
  })
})

// ─── Apply + undo against an in-memory world ────────────────────────────────

type Row = Record<string, unknown>

function world() {
  const tables: Record<string, Map<string, Row>> = {
    pos: new Map([
      ['A', { id: 'A', name: 'Acme', city: 'Dover', notes: 'one' }],
      ['B', { id: 'B', name: 'ACME Inc', city: 'Paris', notes: 'two' }]
    ]),
    po_lines: new Map([
      ['l1', { id: 'l1', po: 'B' }],
      ['l2', { id: 'l2', po: 'B' }],
      ['l3', { id: 'l3', po: 'A' }]
    ]),
    pos_tags: new Map([
      ['j1', { id: 'j1', pos_id: 'A', tags_id: 'red' }],
      ['j2', { id: 'j2', pos_id: 'B', tags_id: 'red' }],
      ['j3', { id: 'j3', pos_id: 'B', tags_id: 'blue' }]
    ])
  }
  const trash: Array<{ collection: string; row: Row }> = []
  const comments = new Map([['c1', 'B']])
  // Attached rows the person may / may not manage (attached.ts judges them for real).
  const attachedStore: Record<string, Array<AttachedRow & { at: string }>> = {
    comments: [
      { id: 'c1', item: 'B', at: 'B', movable: true },
      { id: 'c2', item: 'B', at: 'B', movable: false }
    ],
    tasks: [
      { id: '11', item: 'B', at: 'B', movable: true },
      { id: '12', item: 'B', at: 'B', movable: false }
    ],
    record_links: [
      {
        id: '21',
        item: 'B',
        at: 'B',
        side: 'from',
        other: { collection: 'sites', item: 'S1' },
        movable: true
      },
      {
        id: '22',
        item: 'B',
        at: 'B',
        side: 'from',
        other: { collection: 'secret', item: 'X' },
        movable: false
      },
      {
        id: '23',
        item: 'B',
        at: 'B',
        side: 'to',
        other: { collection: 'pos', item: 'A' },
        movable: true
      }
    ]
  }
  const where = (kind: string, id: string) => attachedStore[kind].find((r) => r.id === id)
  const attachedRequests: string[] = []
  const writes: string[] = []
  const saved: { log: MergeUndoLog | null } = { log: null }
  let failRemove: string | null = null
  const inbound: InboundRelation[] = [
    {
      key: 'po_lines.po',
      kind: 'lines',
      collection: 'po_lines',
      field: 'po',
      alias: 'lines',
      other_field: null,
      target: null,
      raw: false
    },
    {
      key: 'pos_tags.pos_id',
      kind: 'm2m',
      collection: 'pos_tags',
      field: 'pos_id',
      alias: 'tags',
      other_field: 'tags_id',
      target: 'tags',
      raw: false
    }
  ]
  const record = (id: string, extra: Partial<MergePlanRecord> = {}): MergePlanRecord => ({
    id,
    label: `PO ${id}`,
    stamp: JSON.stringify(tables.pos.get(id) ?? {}),
    ref: `#${id}`,
    created_at: null,
    values: { ...(tables.pos.get(id) ?? {}) },
    state: null,
    can_survive: true,
    survive_reason: null,
    can_discard: true,
    discard_reason: null,
    partner: null,
    open_tasks: 0,
    open_approvals: 0,
    ...extra
  })
  const planOverrides: {
    records?: Record<string, Partial<MergePlanRecord>>
    linesMovable?: boolean
  } = {}
  const deps: MergeDeps = {
    async plan(_req, _c, ids): Promise<MergePlan> {
      return {
        collection: 'pos',
        noun: 'order',
        plural: 'orders',
        is_admin: false,
        records: ids.map((id) => record(id, planOverrides.records?.[id])),
        fields: [
          {
            field: 'name',
            label: 'Name',
            type: 'string',
            interface: null,
            writable: true,
            relation: null,
            choices: null
          },
          {
            field: 'city',
            label: 'City',
            type: 'string',
            interface: null,
            writable: false,
            relation: null,
            choices: null
          },
          {
            field: 'notes',
            label: 'Notes',
            type: 'text',
            interface: 'textarea',
            writable: true,
            relation: null,
            choices: null
          }
        ],
        relations: [
          {
            key: 'po_lines.po',
            kind: 'lines',
            label: 'Lines',
            collection: 'po_lines',
            field: 'po',
            counts: { B: 2, A: 1 },
            hidden: {},
            movable: planOverrides.linesMovable ?? true,
            reason:
              planOverrides.linesMovable === false
                ? 'You cannot change these, so they stay where they are.'
                : null,
            default: 'move',
            move_word: '',
            leave_word: ''
          },
          {
            key: 'pos_tags.pos_id',
            kind: 'm2m',
            label: 'Tags',
            collection: 'pos_tags',
            field: 'pos_id',
            counts: { A: 1, B: 2 },
            hidden: {},
            movable: true,
            reason: null,
            default: 'move',
            move_word: '',
            leave_word: ''
          },
          ...(['comments', 'tasks', 'record_links'] as const).map((kind) => ({
            key: kind,
            kind,
            label: kind,
            collection: 'x',
            field: 'item',
            counts: { B: attachedStore[kind].filter((r) => r.movable).length },
            hidden: { B: attachedStore[kind].filter((r) => !r.movable).length },
            movable: true,
            reason: 'some stay',
            default: 'move' as const,
            move_word: '',
            leave_word: ''
          }))
        ],
        labels: {},
        undo_hours: 24,
        max_records: 5,
        read_at: new Date().toISOString()
      }
    },
    inbound: async () => inbound,
    rehearse: async (_r, _c, _id, patch) => (patch.name === '' ? 'Name is required' : null),
    async rows(_req, r, ids) {
      return [...tables[r.collection].values()].filter((row) => ids.includes(String(row[r.field])))
    },
    async update(_req, c, id, patch) {
      const row = tables[c].get(id)
      if (!row) throw Object.assign(new Error('Not found'), { statusCode: 404 })
      writes.push(`update ${c}/${id} ${JSON.stringify(patch)}`)
      Object.assign(row, patch)
    },
    async remove(_req, c, id) {
      if (failRemove === id)
        throw Object.assign(new Error('Linked purchase orders still point at it'), {
          statusCode: 409
        })
      const row = tables[c].get(id)
      if (!row) throw new Error('gone')
      tables[c].delete(id)
      trash.push({ collection: c, row: { ...row } })
      writes.push(`delete ${c}/${id}`)
    },
    async rawSet(t, f, id, v) {
      Object.assign(tables[t].get(id) ?? {}, { [f]: v })
    },
    read: async (_r, c, id) => ({ ...(tables[c].get(id) ?? {}) }),
    async restore(_r, c, id) {
      const i = trash.findIndex((t) => t.collection === c && String(t.row.id) === id)
      if (i < 0) throw new Error('not in trash')
      tables[c].set(id, trash[i].row)
      trash.splice(i, 1)
      writes.push(`restore ${c}/${id}`)
    },
    async attached(_req, kind, _c, ids) {
      attachedRequests.push(kind)
      return attachedStore[kind]
        .filter((r) => ids.includes(r.at))
        .map(({ at, ...r }) => ({ ...r, item: at }))
    },
    changedBy: async () => 'Beth Ortiz',
    async moveComments(rows, to) {
      for (const r of rows) {
        comments.set(r.id, to)
        const row = where('comments', r.id)
        if (row) row.at = to
      }
      return rows.map((r) => ({ id: r.id, from: r.item }))
    },
    setCommentItem: async (id, item) => {
      comments.set(id, item)
      const row = where('comments', id)
      if (row) row.at = item
    },
    async moveTasks(rows, to) {
      for (const r of rows) {
        const row = where('tasks', r.id)
        if (row) row.at = to
      }
      return rows.map((r) => ({ id: Number(r.id), from: r.item }))
    },
    setTaskItem: async (id, item) => {
      const row = where('tasks', String(id))
      if (row) row.at = item
    },
    closeTasks: async () => [],
    reopenTasks: async () => undefined,
    async moveRecordLinks(rows, to) {
      for (const r of rows) {
        const row = where('record_links', r.id)
        if (row) row.at = to
      }
      return rows.map((r) => ({ id: Number(r.id), side: r.side ?? 'from', from: r.item }))
    },
    setRecordLink: async (id, _side, item) => {
      const row = where('record_links', String(id))
      if (row) row.at = item
    },
    cancelApprovals: async () => [],
    setApprovalStatus: async () => undefined,
    note: async (_r, _c, id, action) => {
      writes.push(`note ${id} ${action}`)
      return 7
    },
    saveLog: async (log) => {
      saved.log = JSON.parse(JSON.stringify(log))
    },
    loadLog: async () => saved.log,
    claimUndo: async (_log, u) => {
      // Compare-and-set like the store: only the first claim wins.
      if (!saved.log || saved.log.undone_at) return false
      saved.log = { ...saved.log, undone_at: new Date().toISOString(), undone_by: u }
      return true
    },
    releaseUndo: async (log) => {
      saved.log = { ...log, undone_at: null, undone_by: null }
    },
    unit: (fn) => fn(() => undefined)
  }
  return {
    tables,
    trash,
    comments,
    attachedStore,
    attachedRequests,
    writes,
    saved,
    deps,
    planOverrides,
    failOn: (id: string) => {
      failRemove = id
    }
  }
}

const req = { user: { id: 'u1', role: 'r' }, isAdmin: false } as unknown as FastifyRequest

describe('applyMerge', () => {
  let w: ReturnType<typeof world>
  beforeEach(() => {
    w = world()
  })

  it('takes values from either record, moves lines, combines links, discards to the trash', async () => {
    const out = await applyMerge(
      req,
      'pos',
      {
        survivor: 'A',
        discard: ['B'],
        values: { name: 'ACME Inc', notes: 'one\ntwo', city: 'Dover' }
      },
      w.deps
    )
    expect(out.survivor).toBe('A')
    expect(out.fields_changed.sort()).toEqual(['name', 'notes'])
    expect(w.tables.pos.get('A')).toMatchObject({
      name: 'ACME Inc',
      notes: 'one\ntwo',
      city: 'Dover'
    })
    expect(w.tables.pos.has('B')).toBe(false)
    expect(w.trash.map((t) => t.row.id)).toEqual(['j2', 'B'])
    // Lines repointed one at a time through the items service.
    expect(w.tables.po_lines.get('l1')?.po).toBe('A')
    expect(w.tables.po_lines.get('l2')?.po).toBe('A')
    // m2m: the pair A already had (red) is dropped, the new one (blue) moves.
    expect(w.tables.pos_tags.has('j2')).toBe(false)
    expect(w.tables.pos_tags.get('j3')?.pos_id).toBe('A')
    expect(w.comments.get('c1')).toBe('A')
    expect(w.writes.filter((x) => x.startsWith('note'))).toEqual([
      'note A record-merge',
      'note B record-merged-into'
    ])
    expect(w.saved.log?.moved.map((m) => m.id)).toEqual(['l1', 'l2', 'j3'])
  })

  it('leaves a relation where it is when asked', async () => {
    await applyMerge(
      req,
      'pos',
      { survivor: 'A', discard: ['B'], relations: { 'po_lines.po': 'leave', comments: 'leave' } },
      w.deps
    )
    expect(w.tables.po_lines.get('l1')?.po).toBe('B')
    expect(w.comments.get('c1')).toBe('B')
  })

  it('refuses a locked survivor, an undiscardable record and a field the person may not write', async () => {
    w.planOverrides.records = {
      A: { can_survive: false, survive_reason: 'This record is at Approved.' }
    }
    await expect(
      applyMerge(req, 'pos', { survivor: 'A', discard: ['B'] }, w.deps)
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'You cannot keep PO A: This record is at Approved.'
    })
    w.planOverrides.records = {
      B: {
        can_discard: false,
        discard_reason: 'This record was sent to Ledger — only an administrator can discard it.'
      }
    }
    await expect(
      applyMerge(req, 'pos', { survivor: 'A', discard: ['B'] }, w.deps)
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/sent to Ledger/)
    })
    w.planOverrides.records = {}
    await expect(
      applyMerge(req, 'pos', { survivor: 'A', discard: ['B'], values: { city: 'Paris' } }, w.deps)
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/cannot change City/)
    })
    expect(w.writes).toEqual([])
  })

  it('refuses moving rows the person cannot change, and a survivor value that would not save', async () => {
    w.planOverrides.linesMovable = false
    await expect(
      applyMerge(
        req,
        'pos',
        { survivor: 'A', discard: ['B'], relations: { 'po_lines.po': 'move' } },
        w.deps
      )
    ).rejects.toMatchObject({
      message: 'Lines: You cannot change these, so they stay where they are.'
    })
    w.planOverrides.linesMovable = true
    await expect(
      applyMerge(req, 'pos', { survivor: 'A', discard: ['B'], values: { name: '' } }, w.deps)
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/Name is required/) })
    expect(w.writes).toEqual([])
  })

  it('puts everything back when a step fails part-way', async () => {
    w.failOn('B')
    await expect(
      applyMerge(
        req,
        'pos',
        { survivor: 'A', discard: ['B'], values: { name: 'ACME Inc' } },
        w.deps
      )
    ).rejects.toMatchObject({
      code: 'MERGE_FAILED',
      message: 'Linked purchase orders still point at it. Nothing was merged.'
    })
    expect(w.tables.pos.get('A')?.name).toBe('Acme')
    expect(w.tables.po_lines.get('l1')?.po).toBe('B')
    expect(w.tables.pos_tags.get('j2')?.pos_id).toBe('B')
    expect(w.tables.pos_tags.get('j3')?.pos_id).toBe('B')
    expect(w.comments.get('c1')).toBe('B')
    expect(w.saved.log).toBeNull()
  })
})

describe('attached rows (comments, tasks, related-record links)', () => {
  it('moves only what the person may see and manage; the rest stays put, judged at merge time', async () => {
    const w = world()
    await applyMerge(req, 'pos', { survivor: 'A', discard: ['B'] }, w.deps)
    const at = (kind: string, id: string) => w.attachedStore[kind].find((r) => r.id === id)?.at
    expect(at('comments', 'c1')).toBe('A')
    expect(at('comments', 'c2')).toBe('B') // a field comment on a field they cannot read
    expect(at('tasks', '11')).toBe('A')
    expect(at('tasks', '12')).toBe('B') // someone else's task
    expect(at('record_links', '21')).toBe('A')
    expect(at('record_links', '22')).toBe('B') // the other end is not readable to them
    expect(at('record_links', '23')).toBe('B') // a link to the kept record itself is never made
    // Judged again by the merge, not taken from the plan.
    expect(w.attachedRequests.sort()).toEqual(['comments', 'record_links', 'tasks'])
  })

  it('a row that became hidden after the plan is not moved', async () => {
    const w = world()
    w.attachedStore.tasks[0].movable = false
    await applyMerge(req, 'pos', { survivor: 'A', discard: ['B'] }, w.deps)
    expect(w.attachedStore.tasks.map((t) => t.at)).toEqual(['B', 'B'])
  })

  it('the gates: field comments by field access, tasks by who may work them, links by the other end', async () => {
    const gates: AttachedGates = {
      commentField: (f) => f !== 'salary',
      task: (t) => t.assignee === 'me' || t.created_by === 'me',
      readable: async (c) => c !== 'secret'
    }
    const ids = ['B']
    expect(
      (
        await judgeAttached(
          'comments',
          [
            { id: 1, item: 'b', field: null },
            { id: 2, item: 'B', field: 'salary' },
            { id: 3, item: 'B', field: 'name' }
          ],
          ids,
          gates
        )
      ).map((r) => [r.id, r.item, r.movable])
    ).toEqual([
      ['1', 'B', true],
      ['2', 'B', false],
      ['3', 'B', true]
    ])
    expect(
      (
        await judgeAttached(
          'tasks',
          [
            { id: 5, item: 'B', assignee: 'me', created_by: 'x' },
            { id: 6, item: 'B', assignee: 'x', created_by: 'y' }
          ],
          ids,
          gates
        )
      ).map((r) => r.movable)
    ).toEqual([true, false])
    expect(
      (
        await judgeAttached(
          'record_links',
          [
            { id: 7, item: 'B', side: 'from', other_collection: 'sites', other_item: '1' },
            { id: 8, item: 'B', side: 'to', other_collection: 'secret', other_item: '2' }
          ],
          ids,
          gates
        )
      ).map((r) => [r.side, r.movable])
    ).toEqual([
      ['from', true],
      ['to', false]
    ])
  })
})

describe('stale guard', () => {
  it('refuses with who changed which record when a record changed since the screen opened', async () => {
    const w = world()
    const stamps = {
      A: JSON.stringify(w.tables.pos.get('A')),
      B: JSON.stringify(w.tables.pos.get('B'))
    }
    w.tables.pos.get('B')!.city = 'Lyon'
    await expect(
      applyMerge(
        req,
        'pos',
        { survivor: 'A', discard: ['B'], stamps, opened_at: new Date().toISOString() },
        w.deps
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'MERGE_STALE',
      record: 'B',
      message: 'Beth Ortiz changed #B (PO B) while you were merging — review it again.'
    })
    expect(w.writes).toEqual([])
    // Fresh stamps go through.
    const fresh = {
      A: JSON.stringify(w.tables.pos.get('A')),
      B: JSON.stringify(w.tables.pos.get('B'))
    }
    await expect(
      applyMerge(req, 'pos', { survivor: 'A', discard: ['B'], stamps: fresh }, w.deps)
    ).resolves.toMatchObject({ survivor: 'A' })
  })
})

describe('undoMerge', () => {
  it('restores the discarded record, moves rows back and keeps a field changed since', async () => {
    const w = world()
    const out = await applyMerge(
      req,
      'pos',
      { survivor: 'A', discard: ['B'], values: { name: 'ACME Inc', notes: 'merged' } },
      w.deps
    )
    // Someone edits the survivor's notes after the merge.
    w.tables.pos.get('A')!.notes = 'edited later'
    const back = await undoMerge(req, out.merge_id, w.deps)
    expect(back.restored).toEqual(['B'])
    expect(back.kept_fields).toEqual(['notes'])
    expect(back.problems).toEqual([])
    expect(w.tables.pos.get('B')?.name).toBe('ACME Inc')
    expect(w.tables.pos.get('A')).toMatchObject({ name: 'Acme', notes: 'edited later' })
    expect(w.tables.po_lines.get('l1')?.po).toBe('B')
    expect(w.tables.pos_tags.get('j2')?.pos_id).toBe('B')
    expect(w.tables.pos_tags.get('j3')?.pos_id).toBe('B')
    expect(w.comments.get('c1')).toBe('B')
    expect(w.attachedStore.tasks.map((t) => t.at)).toEqual(['B', 'B'])
    expect(w.attachedStore.record_links.map((t) => t.at)).toEqual(['B', 'B', 'B'])
    expect(w.saved.log?.undone_at).toBeTruthy()
    // A second undo is refused.
    await expect(undoMerge(req, out.merge_id, w.deps)).rejects.toMatchObject({
      code: 'UNDO_REFUSED'
    })
  })

  it('runs only once when two undos race (claim first, then undo)', async () => {
    const w = world()
    const out = await applyMerge(req, 'pos', { survivor: 'A', discard: ['B'] }, w.deps)
    const results = await Promise.allSettled([
      undoMerge(req, out.merge_id, w.deps),
      undoMerge(req, out.merge_id, w.deps)
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ statusCode: 409, code: 'UNDO_REFUSED' })
    expect(w.writes.filter((x) => x === 'restore pos/B')).toHaveLength(1)
  })

  it('gives the claim back when the undo itself fails', async () => {
    const w = world()
    const out = await applyMerge(req, 'pos', { survivor: 'A', discard: ['B'] }, w.deps)
    const unit = w.deps.unit
    w.deps.unit = async () => {
      throw new Error('database went away')
    }
    await expect(undoMerge(req, out.merge_id, w.deps)).rejects.toThrow(/database went away/)
    expect(w.saved.log?.undone_at).toBeNull()
    w.deps.unit = unit
    await expect(undoMerge(req, out.merge_id, w.deps)).resolves.toMatchObject({
      restored: ['B']
    })
  })

  it('refuses someone else’s merge', async () => {
    const w = world()
    const out = await applyMerge(req, 'pos', { survivor: 'A', discard: ['B'] }, w.deps)
    const other = { user: { id: 'u9' }, isAdmin: false } as unknown as FastifyRequest
    await expect(undoMerge(other, out.merge_id, w.deps)).rejects.toMatchObject({
      message: expect.stringMatching(/Only the person who merged/)
    })
  })
})

describe('relation counts (no hidden-row counts for non-admins)', () => {
  it('a non-admin sees only their own counts and a reason without numbers', () => {
    const out = judgeRelationCounts({
      raw: false,
      isAdmin: false,
      counts: { A: 5, B: 2 },
      visible: { A: 3, B: 2 },
      mayUpdate: true
    })
    expect(out).toEqual({
      counts: { A: 3, B: 2 },
      hidden: {},
      movable: false,
      reason: 'Some of them you cannot see, so they cannot be moved by you. Ask an administrator.'
    })
    expect(out.reason).not.toMatch(/\d/)
  })

  it('a raw table gives a non-admin no counts at all', () => {
    expect(
      judgeRelationCounts({
        raw: true,
        isAdmin: false,
        counts: { A: 4 },
        visible: {},
        mayUpdate: false
      })
    ).toMatchObject({ counts: {}, hidden: {}, movable: false })
  })

  it('an administrator still gets the hidden counts and the raw counts', () => {
    expect(
      judgeRelationCounts({
        raw: false,
        isAdmin: true,
        counts: { A: 5 },
        visible: { A: 3 },
        mayUpdate: true
      })
    ).toMatchObject({ counts: { A: 3 }, hidden: { A: 2 }, movable: false })
    expect(
      judgeRelationCounts({
        raw: true,
        isAdmin: true,
        counts: { A: 4 },
        visible: {},
        mayUpdate: true
      })
    ).toEqual({ counts: { A: 4 }, hidden: {}, movable: true, reason: null })
  })

  it('everything visible and changeable moves', () => {
    expect(
      judgeRelationCounts({
        raw: false,
        isAdmin: false,
        counts: { A: 2 },
        visible: { A: 2 },
        mayUpdate: true
      })
    ).toEqual({ counts: { A: 2 }, hidden: {}, movable: true, reason: null })
  })
})
