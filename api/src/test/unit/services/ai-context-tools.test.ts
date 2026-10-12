import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/user-scopes.js', () => ({
  isAdminRole: vi.fn(async () => false),
  getUserScopeEnforcement: vi.fn(async () => ({ deny: false, filters: [] }))
}))
vi.mock('../../../services/team.js', () => ({
  hasReports: vi.fn(async () => false),
  buildTeamTasks: vi.fn(),
  buildTeamCoverage: vi.fn(),
  buildTeamWeek: vi.fn()
}))
vi.mock('../../../services/user-profile.js', () => ({ buildTeamLoad: vi.fn() }))

const { db } = await import('../../../db/index.js')
const { isAdminRole } = await import('../../../services/user-scopes.js')
const team = await import('../../../services/team.js')
const { buildTeamLoad } = await import('../../../services/user-profile.js')
const { cleanDateRange, cleanEntityFilters, executeContextTool, shapeWidgetData } = await import(
  '../../../services/ai-context-tools.js'
)
const { REPLAYABLE_TOOLS } = await import('../../../services/ai-conversations.js')
const { CHAT_TOOLS } = await import('../../../services/ai-chat.js')

const asker = { id: 'AAAAAAAA-0000-0000-0000-000000000001', role: 'r1' } as never

/** A knex-ish chain whose `first` answers `row`. */
function firstAnswers(row: unknown) {
  const chain: Record<string, unknown> = {}
  for (const m of ['where', 'orderBy', 'select', 'modify']) chain[m] = () => chain
  chain.first = async () => row
  return chain
}

describe('context tools are offered, and none of them replays (#1809)', () => {
  it('lists report_data, config_lookup and my_team, outside REPLAYABLE_TOOLS', () => {
    const names = CHAT_TOOLS.map((t) => t.name)
    for (const n of ['report_data', 'config_lookup', 'my_team']) {
      expect(names).toContain(n)
      expect(REPLAYABLE_TOOLS.has(n)).toBe(false)
    }
  })
})

describe('config_lookup — administrators only, checked at call time (#1856)', () => {
  it('refuses a non-admin before reading anything', async () => {
    vi.mocked(isAdminRole).mockResolvedValue(false)
    await expect(
      executeContextTool(asker, 'config_lookup', { mode: 'automations', collection: 'workflows' })
    ).rejects.toThrow(/administrators only/)
    expect(db).not.toHaveBeenCalled()
  })

  it('validates names and modes for an admin', async () => {
    vi.mocked(isAdminRole).mockResolvedValue(true)
    await expect(
      executeContextTool(asker, 'config_lookup', { mode: 'field_usage', collection: 'x;drop' })
    ).rejects.toThrow(/Invalid collection/)
    await expect(
      executeContextTool(asker, 'config_lookup', { mode: 'field_lock', collection: 'workflows' })
    ).rejects.toThrow(/field is required/)
    await expect(
      executeContextTool(asker, 'config_lookup', { mode: 'nope', collection: 'workflows' })
    ).rejects.toThrow(/mode must be/)
  })
})

describe("my_team — the asker's own direct reports only (#1894)", () => {
  beforeEach(() => vi.mocked(buildTeamLoad).mockReset())

  it('refuses someone with no reports, and never builds a team', async () => {
    vi.mocked(team.hasReports).mockResolvedValue(false)
    await expect(executeContextTool(asker, 'my_team', { view: 'workload' })).rejects.toThrow(
      /no direct reports/
    )
    expect(buildTeamLoad).not.toHaveBeenCalled()
  })

  it('answers for the asker as manager, with an access note', async () => {
    vi.mocked(team.hasReports).mockResolvedValue(true)
    vi.mocked(buildTeamLoad).mockResolvedValue({
      reports: [
        {
          id: 'u1',
          name: 'Kim',
          email: null,
          title: null,
          status: 'active',
          out: false,
          ooo_start: null,
          ooo_end: null,
          delegate: null,
          open: 4,
          breached: 1,
          warning: 0,
          hidden: 2,
          oldest_hours: 300,
          uncovered: false,
          stuck: 1,
          oldest: [],
          breached_week: 0
        }
      ],
      total_reports: 1,
      truncated: false,
      stuck_hours: 240
    })
    const out = await executeContextTool(asker, 'my_team', { view: 'workload' })
    expect(vi.mocked(buildTeamLoad).mock.calls[0][0]).toBe('AAAAAAAA-0000-0000-0000-000000000001')
    const res = out.result as { people: Array<Record<string, unknown>>; access_note: string }
    expect(res.people[0]).toMatchObject({ name: 'Kim', open: 4, hidden_from_you: 2 })
    expect(res.access_note).toMatch(/direct reports/)
  })
})

describe("report_data — the report's own visibility rule (#1837)", () => {
  it('refuses a private report owned by someone else', async () => {
    vi.mocked(isAdminRole).mockResolvedValue(false)
    vi.mocked(db).mockImplementation((() =>
      firstAnswers({
        id: 'r1',
        name: 'Spend',
        owner: 'someone-else',
        is_shared: false,
        role_id: null,
        global_filters: null
      })) as never)
    await expect(executeContextTool(asker, 'report_data', { report_id: 'r1' })).rejects.toThrow(
      /No report/
    )
  })

  it('cleans the date range and filters the model passes', () => {
    expect(cleanDateRange({ preset: 'ytd' })).toEqual({ preset: 'ytd' })
    expect(cleanDateRange({ preset: 'custom', start: '2026-01-01' })).toBeNull()
    expect(cleanDateRange({ preset: 'whenever' })).toBeNull()
    expect(
      cleanEntityFilters([
        { field: 'zone', values: [3] },
        { field: 'project.name', values: ['x'] },
        { field: 'zone', values: [] }
      ])
    ).toEqual([{ field: 'zone', values: [3] }])
  })

  it('trims a widget for the model', () => {
    const shaped = shapeWidgetData(
      {
        value: 10,
        series: Array.from({ length: 40 }, (_, i) => ({ dim: `d${i}`, value: i, raw: i })),
        rows: Array.from({ length: 30 }, (_, i) => ({ id: i }))
      },
      30
    )
    expect((shaped.series as unknown[]).length).toBe(30)
    expect(shaped.series_note).toBe('10 more points not shown')
    expect((shaped.rows as unknown[]).length).toBe(10)
    expect((shaped.series as Array<Record<string, unknown>>)[0]).not.toHaveProperty('raw')
  })
})

describe('owner matrix matching for config_lookup owners (#1856)', () => {
  const g = (id: string, filters: unknown[], extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    filters: JSON.stringify(filters),
    is_default: false,
    priority: 100,
    ...extra
  })
  const dims = [
    { field: 'division.short_name', label: 'Zone' },
    { field: 'project.project_type.name', label: 'Project Type' }
  ]
  const zone3 = { field: 'division.short_name', op: 'eq', value: 'Zone 3', id_value: 3 }
  const big = { field: 'amount', op: 'gt', value: 50000 }
  const commercial = { field: 'project_type.name', op: 'eq', value: 'Commercial', id_value: 26 }
  const groups = [g('a', [zone3]), g('b', [zone3, big]), g('c', [zone3, commercial])]

  it('matches display values or ids, by dimension label, and picks the most specific', async () => {
    const { matchOwnerGroups, ownerValueLookup } = await import(
      '../../../services/ai-context-tools.js'
    )
    const exact = matchOwnerGroups(
      groups,
      ownerValueLookup({ Zone: 'zone 3', amount: 60000 }, dims)
    )
    expect(exact.kind).toBe('exact')
    expect(exact.groups.map((x) => x.id)).toEqual(['b'])
    const byId = matchOwnerGroups(groups, ownerValueLookup({ Zone: 3 }, dims))
    expect(byId.groups.map((x) => x.id)).toEqual(['a'])
  })

  it('lists the groups nothing contradicts when the values do not decide one', async () => {
    const { matchOwnerGroups, ownerValueLookup } = await import(
      '../../../services/ai-context-tools.js'
    )
    const partial = matchOwnerGroups(
      [
        g('b', [zone3, big]),
        g('c', [zone3, commercial]),
        g('d', [{ ...zone3, value: 'Zone 1', id_value: 1 }, big])
      ],
      ownerValueLookup({ Zone: 'Zone 3' }, dims)
    )
    expect(partial.kind).toBe('partial')
    expect(partial.groups.map((x) => x.id)).toEqual(['b', 'c'])
    const fallback = matchOwnerGroups(
      [g('x', [zone3]), g('def', [], { is_default: true })],
      ownerValueLookup({ Zone: 'Zone 9' }, dims)
    )
    expect(fallback.kind).toBe('default')
    // A project-type dimension stored deeper than the group's filter field still resolves.
    const typed = matchOwnerGroups(
      [g('c', [commercial])],
      ownerValueLookup({ 'Project Type': 'Commercial' }, dims)
    )
    expect(typed.kind).toBe('exact')
  })
})
