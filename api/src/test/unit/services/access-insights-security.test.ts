import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A knex stand-in: db(table) answers a fixed result per table, whatever the
// chain (where / join / first / select …) asked for.
const tables = new Map<string, unknown>()
function chain(result: unknown): unknown {
  const p: unknown = new Proxy(() => undefined, {
    get(_t, key) {
      if (key === 'then')
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(result).then(res, rej)
      if (key === 'catch') return () => Promise.resolve(result)
      return () => p
    },
    apply: () => p
  })
  return p
}
vi.mock('../../../db/index.js', () => {
  const db = Object.assign((table: string) => chain(tables.get(table.split(' ')[0])), {
    raw: () => 'raw'
  })
  return { db }
})
vi.mock('../../../services/pipeline-engine.js', () => ({
  getOwnerGroupsForStates: vi.fn(),
  parseJson: (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)
}))
vi.mock('../../../services/branch-instances.js', () => ({ findRecordInstance: vi.fn() }))
vi.mock('../../../services/pipeline-subject.js', () => ({
  ADDENDUM_COLLECTION: 'nivaro_addendums',
  resolvePipelineSubject: vi.fn()
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  applyRowFilter: vi.fn(),
  getRowFilter: vi.fn(async () => null),
  getAllowedFields: vi.fn()
}))
vi.mock('../../../services/user-scopes.js', () => ({ isAdminRole: vi.fn(async () => false) }))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(),
  countVisible: vi.fn(),
  explainIds: vi.fn(),
  visibleIds: vi.fn(),
  unavailabilityOf: vi.fn(),
  checkTransitionOwner: vi.fn(),
  UNAVAILABLE_TEXT: {}
}))
vi.mock('../../../services/access-explain.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../services/access-explain.js'
  )
  return { ...actual, explainAccess: vi.fn() }
})

import { explainAccess, viewerSafeReasons } from '../../../services/access-explain.js'
import { explainDenied, TransitionNotFoundError } from '../../../services/denied-explain.js'
import { redactOwnerFacts } from '../../../services/owner-explain.js'
import { getAllowedFields } from '../../../services/permissions.js'
import { summarizePersonAccess } from '../../../services/person-access.js'
import { compileAccessGates, countVisible } from '../../../services/record-access.js'
import type { User } from '../../../types.js'

const BETH = { id: 'B-1', role: 'R-1', email: 'beth@x' } as unknown as User

beforeEach(() => tables.clear())
afterEach(() => vi.clearAllMocks())

// ── G1 / G2: owner facts on fields the caller cannot read ───────────────────

const ownerEx = () => ({
  collection: 'requests',
  item: '1',
  instance_id: 'I',
  state: { id: 'S', key: 'r', label: 'Review', owners_not_required: false },
  groups: [
    {
      id: 'G',
      name: 'Band A approvers',
      is_default: false,
      filters: [
        { field: 'salary_band', label: 'Salary band', wants: 'A', record_value: 'A' },
        { field: 'zone', label: 'Zone', wants: 'Zone 1', record_value: 'Zone 1' }
      ]
    }
  ],
  outranked: 0,
  owners: [
    {
      id: 'K',
      name: 'Kim',
      email: null,
      unavailable: null,
      sources: [
        {
          kind: 'group' as const,
          group_name: 'Band A approvers',
          matched: [
            { field: 'salary_band', label: 'Salary band', wants: 'A', record_value: 'A' },
            { field: 'zone', label: 'Zone', wants: 'Zone 1', record_value: 'Zone 1' }
          ]
        }
      ],
      sentences: []
    }
  ],
  delegations: [],
  summary: ''
})

describe('redactOwnerFacts (G1, G2)', () => {
  it("blanks the group's wanted value too — a matched filter IS the record's value", async () => {
    vi.mocked(getAllowedFields).mockResolvedValue(['id', 'zone'])
    const out = await redactOwnerFacts(ownerEx(), BETH, false)
    const json = JSON.stringify(out)
    expect(json).not.toContain('salary_band')
    expect(json).not.toContain('Salary band')
    expect(out.groups[0].filters[0]).toEqual({
      field: '',
      label: 'a field you cannot see',
      wants: '',
      record_value: ''
    })
    expect(out.groups[0].filters[1].wants).toBe('Zone 1')
    const sentence = out.owners[0].sentences[0]
    expect(sentence).toContain('matching on a field you cannot see')
    expect(sentence).toContain("this record's Zone is Zone 1")
    expect(sentence).not.toMatch(/\bis A\b/)
  })
  it('treats null from getAllowedFields as every field (nothing blanked)', async () => {
    vi.mocked(getAllowedFields).mockResolvedValue(null)
    const ex = ownerEx()
    expect(await redactOwnerFacts(ex, BETH, false)).toBe(ex)
  })
  it('fails closed when the field list cannot be read', async () => {
    vi.mocked(getAllowedFields).mockRejectedValue(new Error('down'))
    const out = await redactOwnerFacts(ownerEx(), BETH, false)
    expect(out.groups[0].filters.every((f) => f.wants === '')).toBe(true)
  })
})

// ── G3: a refused person never hears the hidden record's value ──────────────

const scopeReason = {
  type: 'scope' as const,
  dimension: 'zone',
  dimension_label: 'Zone',
  allowed_values: ['Zone 1', 'Zone 2'],
  record_ids: ['4'],
  record_values: ['Zone 4'],
  message:
    "The Zone access filter excludes this record — this record's Zone is Zone 4, and access is limited to: Zone 1, Zone 2."
}

describe('viewerSafeReasons + denied explain (G3)', () => {
  it("keeps the person's own allowed values and drops the record side", () => {
    const [r] = viewerSafeReasons([{ ...scopeReason, trash_id: 9 }])
    expect(r.message).toBe(
      'This record is not visible to you: your Zone filter limits you to Zone 1, Zone 2.'
    )
    expect(r).not.toHaveProperty('record_values')
    expect(r).not.toHaveProperty('record_ids')
    expect(r).not.toHaveProperty('trash_id')
    expect(JSON.stringify(r)).not.toContain('Zone 4')
  })
  it('explainDenied for a non-admin carries no record-side value', async () => {
    vi.mocked(explainAccess).mockResolvedValue({ access: false, reasons: [{ ...scopeReason }] })
    tables.set('nivaro_users', [])
    const out = await explainDenied(BETH, false, {
      collection: 'requests',
      id: '7',
      action: 'update'
    })
    expect(JSON.stringify(out)).not.toContain('Zone 4')
    expect(out.summary).toContain('not visible to you')
    expect(out.summary).toContain('Zone 1, Zone 2')
  })
})

// ── G4: the transition must belong to the record's workflow ─────────────────

describe('denied explain for a transition (G4)', () => {
  beforeEach(() => {
    vi.mocked(explainAccess).mockResolvedValue({ access: true, reasons: [] })
    tables.set('nivaro_item_locks', undefined)
  })
  it('404s a transition from a template the record does not run', async () => {
    tables.set('nivaro_workflow_transitions', { template: 'OTHER', label: 'Approve' })
    tables.set('nivaro_workflow_instances', undefined)
    await expect(
      explainDenied(BETH, true, {
        collection: 'requests',
        id: '7',
        action: 'transition',
        transitionId: 'TX'
      })
    ).rejects.toBeInstanceOf(TransitionNotFoundError)
  })
  it('404s an unknown transition id', async () => {
    tables.set('nivaro_workflow_transitions', undefined)
    await expect(
      explainDenied(BETH, true, {
        collection: 'requests',
        id: '7',
        action: 'transition',
        transitionId: 'nope'
      })
    ).rejects.toBeInstanceOf(TransitionNotFoundError)
  })
  it("explains a transition of the record's own workflow", async () => {
    tables.set('nivaro_workflow_transitions', {
      template: 'T',
      label: 'Approve',
      from_state: 'S1',
      required_roles: null
    })
    tables.set('nivaro_workflow_instances', { id: 'I', current_state: 'S2' })
    const out = await explainDenied(BETH, true, {
      collection: 'requests',
      id: '7',
      action: 'transition',
      transitionId: 'TX'
    })
    expect(out.reasons.map((r) => r.message)).toEqual([
      '"Approve" does not start from the record\'s current step'
    ])
  })
})

// ── G7: a person reading their own access gets no totals ────────────────────

describe('summarizePersonAccess self view (G7)', () => {
  beforeEach(() => {
    tables.set('nivaro_users', { id: 'B-1', role: 'R-1', first_name: 'Beth', last_name: 'Ng' })
    tables.set('nivaro_roles', { name: 'Vendor' })
    tables.set('nivaro_workflow_bindings', [{ collection: 'workflows' }])
    tables.set('nivaro_policies', [])
    tables.set('nivaro_collections', [{ collection: 'workflows', display_name: 'Workflows' }])
    tables.set('nivaro_relations', [])
    tables.set('workflows', { n: 88000 })
    vi.mocked(compileAccessGates).mockResolvedValue({
      collection: 'workflows',
      user: BETH,
      bypass: false,
      permitted: true,
      rowFilter: null,
      scopes: [{ label: 'Zone', target: 'divisions', displayField: 'name', values: [1] }],
      strict: null
    } as never)
    tables.set('divisions', [{ id: 1, label: 'Zone 1' }])
    vi.mocked(countVisible).mockResolvedValue(4271)
  })
  it('an admin view says "4,271 of 88,000"', async () => {
    const out = await summarizePersonAccess('B-1')
    expect(out?.collections[0].total).toBe(88000)
    expect(out?.sentences[0]).toContain('4,271 of 88,000 workflows')
  })
  it('a self view gives the visible count only', async () => {
    const out = await summarizePersonAccess('B-1', { selfView: true })
    expect(out?.collections[0].total).toBeNull()
    expect(out?.sentences[0]).toBe(
      'Beth Ng sees 4,271 workflows because their Zone filter is Zone 1 and their role reads workflows, and can edit them.'
    )
    expect(JSON.stringify(out)).not.toContain('88')
  })
})
