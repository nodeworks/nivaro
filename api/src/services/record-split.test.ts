import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Split a record's lines into a new record (idea 4): the per-collection switch,
 * the header copy rules (the server twin of More → Duplicate), the line
 * selection rules, and the one-write orchestration judged as the caller.
 */

// ── Fakes for the orchestration ─────────────────────────────────────────────
const state = {
  browserConfig: null as unknown,
  source: null as Record<string, unknown> | null,
  readThrows: null as Error | null,
  lines: [] as Array<{ id: string; parent: string }>,
  refusal: null as null | { status: 403 | 404 | 409; body: Record<string, unknown> },
  canCreate: true,
  canUpdateChild: true,
  lineUpdatable: (_id: string) => true,
  lockThrows: null as Error | null,
  createThrows: null as Error | null,
  created: [] as Array<{ collection: string; data: Record<string, unknown>; opts: unknown }>,
  junction: [] as Array<Record<string, unknown>>,
  activity: [] as Array<Record<string, unknown>>
}

const RELS = [
  {
    id: 1,
    many_collection: 'request_lines',
    many_field: 'request',
    one_collection: 'requests',
    one_field: 'lines',
    junction_field: null,
    one_collection_field: null,
    one_allowed_collections: null
  },
  {
    id: 2,
    many_collection: 'requests_zones',
    many_field: 'requests_id',
    one_collection: 'requests',
    one_field: 'zones',
    junction_field: 'zones_id',
    one_collection_field: null,
    one_allowed_collections: null
  },
  {
    id: 3,
    many_collection: 'requests_zones',
    many_field: 'zones_id',
    one_collection: 'zones',
    one_field: null,
    junction_field: 'requests_id',
    one_collection_field: null,
    one_allowed_collections: null
  },
  {
    id: 4,
    many_collection: 'requests_files',
    many_field: 'requests_id',
    one_collection: 'requests',
    one_field: 'files',
    junction_field: 'directus_files_id',
    one_collection_field: null,
    one_allowed_collections: null
  }
]

const FIELDS: Array<{
  field: string
  hidden?: boolean
  readonly?: boolean
  options?: Record<string, unknown>
  special?: string[]
  computed_type?: 'read' | 'write'
}> = [
  { field: 'id', hidden: true, readonly: true },
  { field: 'request_no', options: { auto_id: { pattern: 'R-{seq}' } } },
  { field: 'title' },
  { field: 'warehouse' },
  { field: 'partner_status' },
  { field: 'order_number', options: { no_duplicate: true } },
  { field: 'external_id', hidden: true },
  { field: 'total', readonly: true, computed_type: 'read' },
  { field: 'state', hidden: true },
  { field: 'user_created', special: ['user-created'] },
  { field: 'lines', special: ['o2m'] },
  { field: 'zones', special: ['m2m'] },
  { field: 'files', special: ['files'] },
  { field: 'split_from' }
]

function chain(rows: () => unknown) {
  const q: Record<string, unknown> = {}
  for (const m of ['where', 'whereNotNull', 'limit', 'orderBy', 'whereIn']) q[m] = () => q
  q.select = () => Promise.resolve(rows())
  q.count = () => ({ first: () => Promise.resolve(rows()) })
  q.first = () => Promise.resolve(rows())
  return q
}

vi.mock('../db/index.js', () => ({
  db: (table: string) => {
    if (table === 'nivaro_workflow_bindings') return chain(() => [{ state_field: 'state' }])
    if (table === 'request_lines')
      return chain(() => ({ n: state.lines.filter((l) => l.parent === 'R1').length }))
    if (table === 'requests_zones') return chain(() => state.junction)
    return chain(() => [])
  }
}))
vi.mock('./db-batch.js', () => ({
  selectInChunks: async (ids: string[]) =>
    state.lines.filter((l) => ids.some((i) => i.toLowerCase() === l.id.toLowerCase())),
  whereInList: (q: unknown) => q
}))
vi.mock('./collections.js', () => ({
  getCollection: async (c: string) =>
    c === 'requests'
      ? { collection: c, browser_config: state.browserConfig, upsert_keys: null, slug_field: null }
      : undefined,
  getFields: async () => FIELDS,
  getRelations: async () => RELS
}))
vi.mock('./permissions.js', () => ({
  can: async (_u: unknown, action: string, collection: string) =>
    action === 'create'
      ? state.canCreate
      : action === 'update' && collection === 'request_lines'
        ? state.canUpdateChild
        : true,
  getAllowedFields: async () => ['*']
}))
vi.mock('./edit-lock.js', () => {
  class EditLockedError extends Error {
    statusCode = 403
    code = 'EDIT_LOCKED'
  }
  return {
    EDIT_LOCKED: 'EDIT_LOCKED',
    EditLockedError,
    recordWriteRefusal: async () => state.refusal,
    assertNotEditLocked: async () => {
      if (state.lockThrows) throw state.lockThrows
    }
  }
})
vi.mock('./activity.js', () => ({
  logActivity: async (row: Record<string, unknown>) => {
    state.activity.push(row)
    return state.activity.length
  }
}))
vi.mock('./items.js', () => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    readOne: async () => {
      if (state.readThrows) throw state.readThrows
      return state.source
    },
    canUpdateItem: async (_u: unknown, _c: string, id: string) => state.lineUpdatable(id),
    isOutOfView: () => false,
    createOne: async (
      _u: unknown,
      collection: string,
      data: Record<string, unknown>,
      _req: unknown,
      _ws: unknown,
      opts: { outcome?: { id?: unknown; linkFailures?: string[] } }
    ) => {
      if (state.createThrows) throw state.createThrows
      state.created.push({ collection, data, opts })
      if (opts?.outcome) {
        opts.outcome.id = 'R2'
        opts.outcome.linkFailures = []
      }
      return { id: 'R2', ...data }
    }
  }
})

const {
  findLineRelation,
  judgeLineSelection,
  normalizeLineIds,
  parseLineSplitConfig,
  parseSplitComment,
  SplitRefusal,
  splitHeaderValues,
  splitNoteText,
  splitOverrideValues,
  splitRecord,
  splitSkipReason
} = await import('./record-split.js')

const ON = { line_split: { enabled: true, relations: ['request_lines.request'] } }
const req = (over: Record<string, unknown> = {}) =>
  ({ user: { id: 'U1', role: 'r' }, isAdmin: false, workspaceId: null, ...over }) as never

beforeEach(() => {
  state.browserConfig = JSON.stringify({ ...ON, record_tabs: true })
  state.source = {
    id: 'R1',
    request_no: 'R-0001',
    title: 'Node build',
    warehouse: 7,
    partner_status: 'shipped',
    order_number: 'SO-1',
    external_id: 'X9',
    total: 12,
    state: 'approved',
    user_created: 'U0',
    lines: ['L1', 'L2', 'L3']
  }
  state.readThrows = null
  state.lines = [
    { id: 'L1', parent: 'R1' },
    { id: 'L2', parent: 'R1' },
    { id: 'L3', parent: 'R1' },
    { id: 'L9', parent: 'R5' }
  ]
  state.refusal = null
  state.canCreate = true
  state.canUpdateChild = true
  state.lineUpdatable = () => true
  state.lockThrows = null
  state.createThrows = null
  state.created = []
  state.junction = [{ zones_id: 3 }, { zones_id: 4 }]
  state.activity = []
})

describe('the per-collection switch', () => {
  it('is off unless enabled with at least one relation', () => {
    expect(parseLineSplitConfig(null)).toBeNull()
    expect(parseLineSplitConfig({})).toBeNull()
    expect(parseLineSplitConfig({ line_split: { relations: ['a.b'] } })).toBeNull()
    expect(parseLineSplitConfig({ line_split: { enabled: true, relations: [] } })).toBeNull()
    expect(parseLineSplitConfig({ line_split: { enabled: false, relations: ['a.b'] } })).toBeNull()
  })

  it('reads the stored JSON text and keeps only well-formed names', () => {
    const cfg = parseLineSplitConfig(
      JSON.stringify({
        line_split: {
          enabled: true,
          relations: ['request_lines.request', 'bad', 'x.y; drop', 'request_lines.request'],
          skip_fields: ['partner_status', '1bad'],
          link_field: 'split_from'
        }
      })
    )
    expect(cfg).toEqual({
      relations: ['request_lines.request'],
      skip_fields: ['partner_status'],
      link_field: 'split_from',
      copy_links: true
    })
  })

  it('never takes id as the link field and honours copy_links: false', () => {
    const cfg = parseLineSplitConfig({
      line_split: { enabled: true, relations: ['a.b'], link_field: 'id', copy_links: false }
    })
    expect(cfg?.link_field).toBeNull()
    expect(cfg?.copy_links).toBe(false)
  })
})

describe('the header copy (the Duplicate rules)', () => {
  const skip = new Set(['state', 'partner_status'])

  it('copies only fields people see and type', () => {
    expect(splitHeaderValues(state.source as Record<string, unknown>, FIELDS, skip)).toEqual({
      title: 'Node build',
      warehouse: 7
    })
  })

  it('says why a field stays behind', () => {
    const why = (f: string) => splitSkipReason(FIELDS.find((x) => x.field === f) as never, skip)
    expect(why('id')).toBe('audit')
    expect(why('user_created')).toBe('audit')
    expect(why('request_no')).toBe('generated')
    expect(why('order_number')).toBe('do-not-duplicate')
    expect(why('external_id')).toBe('hidden')
    expect(why('total')).toBe('read-only')
    expect(why('lines')).toBe('list')
    expect(why('partner_status')).toBe('skipped')
    expect(why('title')).toBeNull()
  })

  it("lets the caller's own values set only what the copy could carry", () => {
    expect(
      splitOverrideValues(
        { warehouse: 9, total: 1, request_no: 'X', external_id: 'Y', nope: 1, title: { a: 1 } },
        FIELDS,
        skip
      )
    ).toEqual({ warehouse: 9 })
    expect(splitOverrideValues('not json', FIELDS, skip)).toEqual({})
  })
})

describe('the line selection', () => {
  const rows = [
    { id: 'L1', parent: 'R1' },
    { id: 'L2', parent: 'R1' },
    { id: 'L9', parent: 'R5' }
  ]

  it('needs one line to move and one to stay', () => {
    expect(judgeLineSelection('R1', [], rows, 2)?.code).toBe('SPLIT_NO_LINES')
    expect(judgeLineSelection('R1', ['L1', 'L2'], rows, 2)?.code).toBe('SPLIT_KEEP_ONE')
    expect(judgeLineSelection('R1', ['L1'], rows, 2)).toBeNull()
  })

  it('refuses a line of another record or one that is gone', () => {
    const r = judgeLineSelection('r1', ['L1', 'L9', 'L404'], rows, 5)
    expect(r?.code).toBe('SPLIT_LINE_NOT_ON_RECORD')
    expect(r?.extra).toEqual({ lines: ['L9', 'L404'] })
  })

  it('normalizes ids from numbers, strings and {id} objects', () => {
    expect(normalizeLineIds([1, '1', ' 2 ', { id: 3 }, '', null, 'a', 'A'])).toEqual([
      '1',
      '2',
      '3',
      'a'
    ])
    expect(normalizeLineIds('1,2')).toEqual([])
  })

  it('finds only a plain one-to-many line relation', () => {
    expect(findLineRelation(RELS as never, 'requests', 'request_lines.request')?.one_field).toBe(
      'lines'
    )
    expect(findLineRelation(RELS as never, 'requests', 'requests_zones.requests_id')).toBeNull()
    expect(findLineRelation(RELS as never, 'other', 'request_lines.request')).toBeNull()
  })
})

describe('splitRecord', () => {
  it('creates the copy with its link sets and the lines moved in one write', async () => {
    const out = await splitRecord(req(), 'requests', 'R1', {
      relation: 'request_lines.request',
      line_ids: ['L2', 'l3'.toUpperCase()],
      values: { warehouse: 11 }
    })
    expect(out).toMatchObject({ id: 'R2', moved: 2, field: 'lines', readable: true })
    expect(state.created).toHaveLength(1)
    const { collection, data, opts } = state.created[0]
    expect(collection).toBe('requests')
    expect(data).toEqual({
      title: 'Node build',
      warehouse: 11,
      partner_status: 'shipped',
      zones: [3, 4],
      lines: { move: ['L2', 'L3'] }
    })
    expect(opts).toMatchObject({ scopeGuard: true })
    // Both records name each other; the comment carries ids, never labels.
    expect(state.activity.map((a) => [a.action, a.item])).toEqual([
      ['split-out', 'R1'],
      ['split-in', 'R2']
    ])
    expect(JSON.parse(String(state.activity[0].comment))).toEqual({
      to: 'R2',
      field: 'lines',
      lines: 2
    })
  })

  it('skips configured fields and sets the link field', async () => {
    state.browserConfig = {
      line_split: {
        enabled: true,
        relations: ['request_lines.request'],
        skip_fields: ['partner_status'],
        link_field: 'split_from',
        copy_links: false
      }
    }
    await splitRecord(req(), 'requests', 'R1', {
      relation: 'request_lines.request',
      line_ids: ['L1']
    })
    expect(state.created[0].data).toEqual({
      title: 'Node build',
      warehouse: 7,
      split_from: 'R1',
      lines: { move: ['L1'] }
    })
  })

  const refusal = async (body: Record<string, unknown>, r = req()) => {
    try {
      await splitRecord(r, 'requests', 'R1', body)
    } catch (err) {
      expect(err).toBeInstanceOf(SplitRefusal)
      return err as InstanceType<typeof SplitRefusal>
    }
    throw new Error('expected a refusal')
  }
  const body = { relation: 'request_lines.request', line_ids: ['L1'] }

  it('is refused while the collection has it off', async () => {
    state.browserConfig = { record_tabs: true }
    expect((await refusal(body)).code).toBe('SPLIT_OFF')
    expect(state.created).toHaveLength(0)
  })

  it('refuses a relation the config does not name', async () => {
    expect((await refusal({ ...body, relation: 'requests_zones.requests_id' })).code).toBe(
      'SPLIT_RELATION'
    )
  })

  it('answers 404 for a record the caller cannot read', async () => {
    state.source = null
    expect((await refusal(body)).statusCode).toBe(404)
  })

  it('refuses on a locked record with its plain reason, before creating anything', async () => {
    state.refusal = {
      status: 403,
      body: { error: 'Only administrators can change this record now.', code: 'EDIT_LOCKED' }
    }
    const r = await refusal(body)
    expect(r.statusCode).toBe(403)
    expect(r.code).toBe('EDIT_LOCKED')
    expect(r.message).toBe('Only administrators can change this record now.')
    expect(state.created).toHaveLength(0)
  })

  it('refuses while someone else holds the edit lock', async () => {
    state.refusal = {
      status: 409,
      body: { error: 'Pat is editing this record.', code: 'RECORD_LOCKED', locked_by: 'U7' }
    }
    const r = await refusal(body)
    expect(r.statusCode).toBe(409)
    expect(r.extra).toEqual({ locked_by: 'U7' })
  })

  it('needs create rights in the collection and update rights on the lines', async () => {
    state.canCreate = false
    expect((await refusal(body)).statusCode).toBe(403)
    state.canCreate = true
    state.canUpdateChild = false
    expect((await refusal(body)).statusCode).toBe(403)
    state.canUpdateChild = true
    state.lineUpdatable = (id) => id !== 'L1'
    expect((await refusal(body)).extra).toEqual({ line: 'L1' })
    expect(state.created).toHaveLength(0)
  })

  it('refuses a line locked with its record', async () => {
    const { EditLockedError } = await import('./edit-lock.js')
    state.lockThrows = new EditLockedError('This request waits on its approvers.')
    const r = await refusal(body)
    expect(r.code).toBe('EDIT_LOCKED')
    expect(r.message).toBe('This request waits on its approvers.')
  })

  it('keeps at least one line on the record', async () => {
    expect((await refusal({ ...body, line_ids: ['L1', 'L2', 'L3'] })).code).toBe('SPLIT_KEEP_ONE')
    expect((await refusal({ ...body, line_ids: ['L1', 'L9'] })).code).toBe(
      'SPLIT_LINE_NOT_ON_RECORD'
    )
  })

  it('writes no history when the create is refused', async () => {
    state.createThrows = Object.assign(new Error('lines move L1: refused — nothing was changed'), {
      statusCode: 403
    })
    await expect(splitRecord(req(), 'requests', 'R1', body)).rejects.toThrow(/nothing was changed/)
    expect(state.activity).toHaveLength(0)
  })
})

describe('the Notes entry', () => {
  it('reads the split comment both ways', () => {
    expect(parseSplitComment('split-out', '{"to":"R2","field":"lines","lines":2}')).toEqual({
      other: 'R2',
      lines: 2,
      direction: 'out'
    })
    expect(parseSplitComment('split-in', { from: 'R1', lines: 1 })).toEqual({
      other: 'R1',
      lines: 1,
      direction: 'in'
    })
    expect(parseSplitComment('update', '{"to":"R2"}')).toBeNull()
    expect(parseSplitComment('split-out', 'not json')).toBeNull()
    expect(parseSplitComment('split-out', '{"lines":2}')).toBeNull()
  })

  it('says what happened in plain words', () => {
    expect(splitNoteText({ direction: 'out', lines: 1 })).toBe('Moved 1 line to a new record')
    expect(splitNoteText({ direction: 'in', lines: 3 })).toBe(
      'Created from another record — 3 lines moved here'
    )
  })
})
