import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { readSpreadsheet } from '../../../services/import-spreadsheet.js'
import {
  buildOwnerSheetWorkbook,
  H,
  type OwnerSheetContext,
  opsEmpty,
  planHash,
  planOwnerSheet,
  resolvePerson,
  type SheetPlan,
  valuesToLookUp
} from '../../../services/owner-matrix-sheet.js'
import { buildXlsx } from '../../../services/xlsx-writer.js'
import {
  BOB,
  fixtureContext,
  G1,
  G2,
  G3,
  G4,
  PAT1,
  PAT2,
  S2,
  SAM
} from '../../fixtures/owner-matrix-sheet.js'

type Row = Record<string, unknown>
const CFG = { sheet_match: 'Owners', header_row: 1, file_types: ['xlsx' as const] }

/** Download → (edit the rows) → write the edited sheet back as a file → read → plan. */
function roundTrip(ctx: OwnerSheetContext, edit?: (rows: Row[]) => Row[] | undefined): SheetPlan {
  const file = buildXlsx(buildOwnerSheetWorkbook(ctx))
  let read = readSpreadsheet(file, 'owners.xlsx', CFG)
  if (edit) {
    const rows = edit(read.rows) ?? read.rows
    const cols = read.columns ?? []
    const ws = XLSX.utils.json_to_sheet(rows, { header: cols })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Owners')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    read = readSpreadsheet(buf, 'edited.xlsx', CFG)
  }
  return planOwnerSheet(ctx, read.rows, read.columns ?? [])
}

const rowOf = (rows: Row[], id: string) => rows.find((r) => r[H.id] === id) as Row
const errors = (p: SheetPlan) => p.problems.filter((x) => x.severity === 'error')

describe('owner matrix spreadsheet — download', () => {
  it('writes readable values, people as names + emails, a hidden id and dropdown lists', () => {
    const ctx = fixtureContext()
    const sheets = buildOwnerSheetWorkbook(ctx)
    expect(sheets.map((s) => s.name)).toEqual(['Owners', 'README', 'Lists'])
    const owners = sheets[0]
    const header = owners.rows[0].map((c) => (c as { v: string }).v)
    expect(header).toEqual([
      'Step',
      'Group name',
      'Region',
      'Project Type',
      'Default group',
      'Priority',
      'People',
      'Teams',
      'Other filters',
      'Group ID'
    ])
    expect(owners.hiddenCols).toEqual([header.indexOf('Group ID')])
    const g1 = owners.rows.find((r) => r.includes(G1)) as unknown[]
    expect(g1.slice(0, 4)).toEqual(['Submitted', '', 'East', 'New Build'])
    expect((g1[6] as { v: string }).v).toBe(
      'Ann Lee <ann@example.com>; Bob Ray <bob@example.com>; No Mail'
    )
    expect(g1[7]).toBe('Field Ops')
    // Dropdowns: step, default, priority (whole number) and both dimensions.
    expect(owners.validations?.map((v) => [v.col, v.kind])).toEqual([
      [0, 'list'],
      [4, 'list'],
      [5, 'whole'],
      [2, 'list'],
      [3, 'list']
    ])
    expect(sheets[2].hidden).toBe(true)
    expect(sheets[2].rows[0]).toEqual(['Steps', 'Default', 'Region', 'Project Type'])
    // The workbook really is an .xlsx with the hidden id column.
    const xml = buildXlsx(sheets).toString('latin1')
    expect(xml).toContain('hidden="1"')
  })

  it('leaves the dropdown off a field whose value list was cut', () => {
    const ctx = fixtureContext()
    const cat = ctx.catalogs.get('regions.short_name')
    if (cat) cat.complete = false
    const owners = buildOwnerSheetWorkbook(ctx)[0]
    expect(owners.validations?.some((v) => v.col === 2)).toBe(false)
  })
})

describe('owner matrix spreadsheet — upload', () => {
  it('round trip: an unchanged download is an empty diff', () => {
    const plan = roundTrip(fixtureContext())
    expect(errors(plan)).toEqual([])
    expect(opsEmpty(plan.ops)).toBe(true)
    expect(plan.steps).toEqual([])
    expect(plan.counts.groups_unchanged).toBe(4)
    // Re-written by another program (SheetJS) it is still empty.
    const again = roundTrip(fixtureContext(), (rows) => rows)
    expect(errors(again)).toEqual([])
    expect(opsEmpty(again.ops)).toBe(true)
  })

  it('people added and removed, grouped by step', () => {
    const plan = roundTrip(fixtureContext(), (rows) => {
      rowOf(rows, G1)[H.people] = 'ann@example.com; No Mail; pat2@example.com'
      return rows
    })
    expect(errors(plan)).toEqual([])
    expect(plan.ops.updates).toEqual([
      {
        id: G1,
        set: {},
        add_users: [PAT2],
        remove_users: [BOB],
        add_teams: [],
        remove_teams: []
      }
    ])
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].state_label).toBe('Submitted')
    const ch = plan.steps[0].changes[0]
    expect(ch.kind).toBe('changed')
    expect(ch.label).toBe('East · New Build')
    expect(ch.people_added.map((p) => p.email)).toEqual(['pat2@example.com'])
    expect(ch.people_removed.map((p) => p.email)).toEqual(['bob@example.com'])
    expect(plan.counts).toMatchObject({ people_added: 1, people_removed: 1, groups_changed: 1 })
  })

  it('a row without an id is a new group; a deleted row removes its group', () => {
    const plan = roundTrip(fixtureContext(), (rows) => {
      const kept = rows.filter((r) => r[H.id] !== G2)
      kept.push({
        [H.step]: 'Review',
        Region: 'north',
        'Project Type': 'CRAN',
        [H.people]: 'Bob Ray',
        [H.teams]: 'buyers',
        [H.priority]: 2
      })
      return kept
    })
    expect(errors(plan)).toEqual([])
    expect(plan.ops.deletes).toEqual([G2])
    expect(plan.ops.inserts).toEqual([
      {
        row: 5,
        state: S2,
        name: null,
        filters: [
          { field: 'regions.short_name', op: 'eq', value: 'North', id_value: 3 },
          { field: 'project.project_type.name', op: 'eq', value: 'CRAN', id_value: 12 }
        ],
        is_default: false,
        priority: 2,
        users: [BOB],
        teams: [2]
      }
    ])
    const kinds = plan.steps.flatMap((s) => s.changes.map((c) => `${s.state_label}:${c.kind}`))
    expect(kinds).toEqual(['Submitted:removed', 'Review:added'])
    expect(plan.steps[0].changes[0].people_removed.map((p) => p.id)).toEqual([PAT1])
    // The upload as owner-preview's draft: the new group and the removed one.
    expect(plan.draft_groups).toEqual([
      expect.objectContaining({ id: 'sheet-row-5', state: S2, users: [BOB], teams: [2] }),
      expect.objectContaining({ id: G2, removed: true })
    ])
  })

  it('changed filters, step, default and priority', () => {
    const plan = roundTrip(fixtureContext(), (rows) => {
      const g4 = rowOf(rows, G4)
      g4.Region = 'West'
      g4[H.priority] = 1
      g4[H.step] = 'review'
      const g3 = rowOf(rows, G3)
      g3[H.isDefault] = ''
      g3.Region = 'East'
      return rows
    })
    expect(errors(plan)).toEqual([])
    const g4 = plan.ops.updates.find((u) => u.id === G4)
    expect(g4?.set).toEqual({
      state: S2,
      priority: 1,
      filters: [
        { field: 'regions.short_name', op: 'eq', value: 'West', id_value: 2 },
        { field: 'project.project_id', op: 'neq', value: '1234', id_value: null }
      ]
    })
    const g3 = plan.ops.updates.find((u) => u.id === G3)
    expect(g3?.set.is_default).toBe(false)
    const change = plan.steps.find((s) => s.state_id === S2)?.changes.find((c) => c.group_id === G4)
    expect(change?.fields).toEqual([
      { field: 'step', before: 'Approve', after: 'Review' },
      { field: 'priority', before: '5', after: '1' }
    ])
    expect(change?.filters_before).toEqual(['Region: East', 'project.project_id is not 1234'])
    expect(change?.filters_after).toEqual(['Region: West', 'project.project_id is not 1234'])
  })

  it('teams added and removed', () => {
    const plan = roundTrip(fixtureContext(), (rows) => {
      rowOf(rows, G1)[H.teams] = 'Buyers'
      return rows
    })
    expect(plan.ops.updates[0]).toMatchObject({ id: G1, add_teams: [2], remove_teams: [1] })
    expect(plan.steps[0].changes[0].teams_added).toEqual([{ id: 2, name: 'Buyers' }])
  })
})

describe('owner matrix spreadsheet — problems', () => {
  it('unknown person, and a shared name needs the email', () => {
    const plan = roundTrip(fixtureContext(), (rows) => {
      rowOf(rows, G1)[H.people] = 'Ann Lee; nobody@example.com; Pat Kim; Zed Zulu'
      return rows
    })
    const msgs = errors(plan).map((p) => [p.row, p.column, p.message])
    expect(msgs).toEqual([
      [2, 'People', 'No one has the email "nobody@example.com" — check the spelling'],
      [
        2,
        'People',
        '2 people are named "Pat Kim" — write the email of the one you mean (Pat Kim <pat1@example.com>, Pat Kim <pat2@example.com>)'
      ],
      [2, 'People', 'No one is named "Zed Zulu" — write their email instead']
    ])
    // A problem row changes nothing and removes nothing.
    expect(plan.ops.updates).toEqual([])
    expect(plan.ops.deletes).toEqual([])
  })

  it('resolves a shared name once the email is given, and warns about inactive people', () => {
    const ctx = fixtureContext()
    const idx = {
      byId: new Map(ctx.people.map((p) => [p.id, p])),
      byEmail: new Map(ctx.people.filter((p) => p.email).map((p) => [String(p.email), [p]])),
      byName: new Map([['pat kim', ctx.people.filter((p) => p.first_name === 'Pat')]])
    }
    const r = resolvePerson('Pat Kim <PAT2@example.com>', idx)
    expect(r.ok && r.person.id).toBe(PAT2)
    const plan = roundTrip(ctx, (rows) => {
      rowOf(rows, G2)[H.people] = 'Pat Kim <pat1@example.com>; sam@example.com'
      return rows
    })
    expect(errors(plan)).toEqual([])
    expect(plan.ops.updates[0].add_users).toEqual([SAM])
    expect(plan.problems.map((p) => p.message)).toContain(
      'Sam Ode is suspended or has left — they cannot act on records.'
    )
  })

  it('unknown dimension value, unknown step, bad default/priority', () => {
    const plan = roundTrip(fixtureContext(), (rows) => {
      const g2 = rowOf(rows, G2)
      g2.Region = 'Atlantis'
      g2[H.step] = 'Shipping'
      g2[H.isDefault] = 'maybe'
      g2[H.priority] = 'high'
      return rows
    })
    expect(errors(plan).map((p) => p.column)).toEqual([
      'Step',
      'Region',
      'Default group',
      'Priority'
    ])
    expect(errors(plan)[1].message).toBe(
      '"Atlantis" is not a Region value — pick one from the list.'
    )
  })

  it('duplicate group: a copied row keeps the id; the same values twice in one step', () => {
    const copy = roundTrip(fixtureContext(), (rows) => [...rows, { ...rowOf(rows, G1) }])
    expect(errors(copy).map((p) => [p.row, p.column])).toEqual([[6, 'Group ID']])
    const same = roundTrip(fixtureContext(), (rows) => [
      ...rows,
      { [H.step]: 'Submitted', Region: 'West', [H.people]: 'ann@example.com' }
    ])
    expect(errors(same).map((p) => [p.row, p.message])).toEqual([
      [
        6,
        'Duplicate group: row 3 already owns this step for the same values. Put the people on one row.'
      ]
    ])
  })

  it('an id from another pipeline, a missing column and an empty sheet are refused', () => {
    const foreign = roundTrip(fixtureContext(), (rows) => {
      rowOf(rows, G1)[H.id] = 'DDDDDDDD-0000-4000-8000-000000000009'
      return rows
    })
    expect(errors(foreign)[0].column).toBe('Group ID')
    expect(foreign.ops.deletes).toEqual([G1])
    const ctx = fixtureContext()
    const noRegion = planOwnerSheet(
      ctx,
      [{ Step: 'Review', 'Group ID': G3 }],
      ['Step', 'Group name', 'Project Type', 'People', 'Group ID']
    )
    expect(errors(noRegion)[0].message).toMatch(/"Region" column is missing/)
    expect(noRegion.ops.deletes).toEqual([])
    const empty = roundTrip(fixtureContext(), () => [])
    expect(errors(empty).map((p) => p.message)).toContain(
      'The Owners sheet has no rows. Uploading it would remove every owner group.'
    )
  })

  it('names values to look up when a value list was cut', () => {
    const ctx = fixtureContext()
    const cat = ctx.catalogs.get('regions.short_name')
    if (cat) cat.complete = false
    const wanted = valuesToLookUp(
      ctx,
      [{ Region: 'East' }, { Region: 'South' }],
      ['Region', 'Step']
    )
    expect([...wanted]).toEqual([['regions.short_name', ['South']]])
  })
})

describe('owner matrix spreadsheet — binding', () => {
  it('the plan hash moves when the matrix or the file changes', () => {
    const plan = roundTrip(fixtureContext(), (rows) => {
      rowOf(rows, G1)[H.people] = 'ann@example.com'
      return rows
    })
    const h = planHash('a'.repeat(64), plan.ops)
    expect(planHash('b'.repeat(64), plan.ops)).not.toBe(h)
    const other = roundTrip(fixtureContext(), (rows) => {
      rowOf(rows, G1)[H.people] = 'bob@example.com'
      return rows
    })
    expect(planHash('a'.repeat(64), other.ops)).not.toBe(h)
    expect(planHash('a'.repeat(64), plan.ops)).toBe(h)
  })

  it('keeps unknown-to-the-directory members it cannot write', () => {
    const ctx = fixtureContext()
    ctx.groups[0].members.push('EEEEEEEE-0000-4000-8000-000000000001')
    const plan = roundTrip(ctx)
    expect(opsEmpty(plan.ops)).toBe(true)
  })
})
