import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/pipeline-engine.js', () => ({
  getOwnerGroupsForStates: vi.fn(),
  parseJson: (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)
}))
vi.mock('../../../services/owner-explain.js', async () => {
  // redactOwnerFacts is the real one — only the IO-heavy explainer is stubbed.
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../services/owner-explain.js'
  )
  return { ...actual, dimensionLabels: vi.fn(async () => new Map()) }
})
vi.mock('../../../services/branch-instances.js', () => ({ findRecordInstance: vi.fn() }))
vi.mock('../../../services/pipeline-subject.js', () => ({
  ADDENDUM_COLLECTION: 'nivaro_addendums',
  resolvePipelineSubject: vi.fn()
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(),
  applyRowFilter: vi.fn(),
  getRowFilter: vi.fn(),
  getAllowedFields: vi.fn()
}))
vi.mock('../../../services/user-scopes.js', () => ({ isAdminRole: vi.fn(async () => false) }))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(),
  unavailabilityOf: vi.fn(),
  checkTransitionOwner: vi.fn(),
  UNAVAILABLE_TEXT: {}
}))

import {
  bustNarrowingCache,
  collectAccessNotes,
  withAccessNote
} from '../../../services/access-narrowing.js'
import { deniedSummary } from '../../../services/denied-explain.js'
import { redactOwnerFacts } from '../../../services/owner-explain.js'
import { gapFacts, uncoveredDimensions } from '../../../services/owner-gap-explain.js'
import { getAllowedFields } from '../../../services/permissions.js'
import { compileAccessGates } from '../../../services/record-access.js'
import { judgeRoleChanges, parseRoleChanges } from '../../../services/role-change-impact.js'
import { actNowSummary } from '../../../services/who-can-act.js'
import type { User } from '../../../types.js'

const BETH = { id: 'B-1', role: 'R-1', email: 'beth@x' } as unknown as User

afterEach(() => {
  vi.clearAllMocks()
  bustNarrowingCache()
})

describe('judgeRoleChanges (#1958)', () => {
  const label = (c: string) => c
  it('nets a toggle and its reversal to nothing', () => {
    const out = judgeRoleChanges(
      'Vendor',
      [
        { collection: 'invoices', action: 'read', grant: true },
        { collection: 'invoices', action: 'read', grant: false }
      ],
      new Set(),
      label,
      new Map()
    )
    expect(out).toEqual([])
  })
  it('flags changes the wildcard makes moot, using the same matching as can()', () => {
    const held = new Set(['*:read', 'invoices:update'])
    const out = judgeRoleChanges(
      'Vendor',
      [
        { collection: 'invoices', action: 'read', grant: true },
        { collection: 'invoices', action: 'update', grant: false },
        { collection: 'orders', action: 'delete', grant: false }
      ],
      held,
      label,
      new Map([['invoices', 2_700_000]])
    )
    expect(out[0].no_effect).toMatch(/"all collections" read policy already covers it/)
    expect(out[0].rows).toBe(2_700_000)
    expect(out[1].no_effect).toBeNull()
    expect(out[2].no_effect).toMatch(/no delete policy on orders to remove/)
  })
  it('parseRoleChanges drops anything that is not a plain identifier + CRUD action', () => {
    expect(
      parseRoleChanges([
        { collection: 'invoices', action: 'read', grant: true },
        { collection: 'x; drop', action: 'read', grant: true },
        { collection: 'invoices', action: 'share', grant: true },
        'junk'
      ])
    ).toEqual([{ collection: 'invoices', action: 'read', grant: true }])
  })
})

describe('uncoveredDimensions + gapFacts (#2012)', () => {
  const cluster = {
    state_id: 'S',
    state_key: 'finance',
    collection: 'requests',
    count: 38,
    sample_items: [],
    dims: { 'zone.name': 'Zone 4', 'type.name': 'CMTS' },
    filters: [
      { field: 'zone.name', op: 'eq' as const, value: 'Zone 4', id_value: 4 },
      { field: 'type.name', op: 'eq' as const, value: 'CMTS', id_value: null }
    ],
    suggestion: {
      group_id: 'G3',
      group_label: 'Zone 3 Finance',
      matched_filters: ['type.name'],
      mismatched_filters: ['zone.name (wants Zone 3)']
    }
  }
  it('names only values no group mentions on a dimension groups filter on', () => {
    const candidates = [
      {
        filters: [
          { field: 'zone.name', op: 'eq' as const, value: 'Zone 3', id_value: 3 },
          { field: 'type.name', op: 'eq' as const, value: 'cmts' }
        ]
      }
    ]
    expect(uncoveredDimensions(cluster, candidates)).toEqual([
      { field: 'zone.name', label: 'Zone', value: 'Zone 4' }
    ])
  })
  it('stays silent when a group names the value by id, or uses a non-naming op', () => {
    expect(
      uncoveredDimensions(cluster, [
        { filters: [{ field: 'zone.name', op: 'eq' as const, value: 'Z4', id_value: 4 }] }
      ])
    ).toEqual([])
    expect(
      uncoveredDimensions(cluster, [
        { filters: [{ field: 'zone.name', op: 'neq' as const, value: 'Zone 1' }] }
      ])
    ).toEqual([])
  })
  it("names what the closest group wants by its display value, not the filter's id", () => {
    const f = gapFacts(
      {
        ...cluster,
        suggestion: { ...cluster.suggestion, mismatched_filters: ['zone.name (wants 3)'] }
      },
      'Finance Review',
      null,
      [],
      undefined,
      { filters: [{ field: 'zone.name', op: 'eq' as const, value: 'Zone 3', id_value: 3 }] }
    )
    expect(f.suggestion?.missing).toEqual(['Zone 3'])
  })
  it('phrases the closest group without repeating labels', () => {
    const f = gapFacts(cluster, 'Finance Review', 'CMTS requests', [
      { label: 'Zone', value: 'Zone 4' }
    ])
    expect(f.suggestion).toEqual({
      group_label: 'Zone 3 Finance',
      matched: ['Type'],
      missing: ['Zone 3']
    })
  })
})

describe('actNowSummary (#1907)', () => {
  const p = (over: Partial<Parameters<typeof actNowSummary>[1][0]>) => ({
    id: 'x',
    name: 'Kim',
    available: true,
    unavailable_reason: null,
    online: null,
    stands_in_for: [],
    ...over
  })
  it('names who can act, delegates, and who is online', () => {
    expect(
      actNowSummary('Finance Review', [
        p({ name: 'Kim', online: true }),
        p({ name: 'Ana', stands_in_for: ['Rob'], online: false })
      ])
    ).toBe('Kim and Ana (standing in for Rob) can act on Finance Review now. Kim is online now.')
  })
  it('says when every owner is unavailable', () => {
    expect(
      actNowSummary('Review', [
        p({ name: 'Kim', available: false, unavailable_reason: 'suspended' })
      ])
    ).toBe('Nobody can act on Review right now — every owner is unavailable (Kim: suspended).')
  })
  it('never calls someone offline when presence was not shown to the asker', () => {
    expect(actNowSummary('Review', [p({ name: 'Kim', online: null })])).toBe(
      'Kim can act on Review now.'
    )
  })
})

describe('deniedSummary (#1867)', () => {
  it('joins the refusal reasons', () => {
    expect(
      deniedSummary('update', [
        {
          type: 'permission',
          message: 'Your role does not have permission to update invoices records.'
        }
      ])
    ).toBe(
      'You cannot save changes to this record: Your role does not have permission to update invoices records.'
    )
  })
  it('treats an edit lock as context, not the refusal', () => {
    expect(deniedSummary('update', [{ type: 'lock', message: 'Kim is editing this record' }])).toBe(
      'Nothing in your access stops you — but Kim is editing this record.'
    )
  })
})

describe('access notes (#1889)', () => {
  it('attaches the note to items-path tools only, and wraps arrays', async () => {
    vi.mocked(compileAccessGates).mockResolvedValue({
      collection: 'workflows',
      user: BETH,
      bypass: false,
      permitted: true,
      rowFilter: [{ field: 'zone', op: '_eq', value: 1 }],
      scopes: [],
      strict: null
    } as never)
    vi.mocked(getAllowedFields).mockResolvedValue(['*'] as never)
    const agg = await withAccessNote(
      BETH,
      'aggregate',
      { collection: 'workflows' },
      { result: [{ n: 3 }], summary: '1 row' }
    )
    expect(agg.result).toEqual({ rows: [{ n: 3 }], access_note: expect.stringMatching(/row rule/) })
    expect(agg.summary).toMatch(/1 row · Limited by your access/)
    const other = await withAccessNote(
      BETH,
      'my_tasks',
      { collection: 'workflows' },
      { result: [], summary: 's' }
    )
    expect(other.result).toEqual([])
  })
  it('leaves an unshaped answer exactly as it was', async () => {
    vi.mocked(compileAccessGates).mockResolvedValue({
      collection: 'workflows',
      user: BETH,
      bypass: false,
      permitted: true,
      rowFilter: null,
      scopes: [],
      strict: null
    } as never)
    vi.mocked(getAllowedFields).mockResolvedValue(['*'] as never)
    const out = { result: { data: [] }, summary: '0 rows' }
    expect(await withAccessNote(BETH, 'query_items', { collection: 'workflows' }, out)).toBe(out)
  })
  it('collects distinct notes in order', () => {
    expect(
      collectAccessNotes([{ access_note: 'a' }, [], { access_note: 'a' }, { access_note: 'b' }])
    ).toEqual(['a', 'b'])
  })
})

describe('redactOwnerFacts', () => {
  const ex = {
    collection: 'requests',
    item: '1',
    instance_id: 'I',
    state: { id: 'S', key: 'r', label: 'Review', owners_not_required: false },
    groups: [
      {
        id: 'G',
        name: 'Secret',
        is_default: false,
        filters: [{ field: 'salary_band', label: 'Salary band', wants: 'A', record_value: 'A' }]
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
            group_name: 'Secret',
            matched: [{ field: 'salary_band', label: 'Salary band', wants: 'A', record_value: 'A' }]
          }
        ],
        sentences: []
      }
    ],
    delegations: [],
    summary: ''
  }
  it("blanks the record's value for a field the caller cannot read", async () => {
    vi.mocked(getAllowedFields).mockResolvedValue(['id', 'title'] as never)
    const out = await redactOwnerFacts(ex, BETH, false)
    expect(out.groups[0].filters[0].record_value).toBe('')
    expect(out.owners[0].sources[0].matched?.[0].record_value).toBe('')
    expect(out.groups[0].filters[0].wants).toBe('')
    expect(out.owners[0].sentences[0]).toContain('matching on a field you cannot see')
    expect(out.owners[0].sentences[0]).not.toContain('Salary band')
  })
  it('leaves everything for admins and for full-field roles', async () => {
    expect(await redactOwnerFacts(ex, BETH, true)).toBe(ex)
    vi.mocked(getAllowedFields).mockResolvedValue(['*'] as never)
    expect(await redactOwnerFacts(ex, BETH, false)).toBe(ex)
  })
})
