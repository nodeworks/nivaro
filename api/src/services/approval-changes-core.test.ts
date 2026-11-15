import { describe, expect, it } from 'vitest'
import {
  approvalChangesConfigOf,
  approvalMomentOf,
  diffSinceApproval,
  type HistoryStep,
  parseChangedAfterApproval,
  sameValue,
  trackedFields,
  validateChangedAfterApproval,
  writerOf
} from './approval-changes-core.js'
import { parseSummaryModeRules, validateSummaryModeRules } from './summary-mode.js'

const lock = {
  edit_lock: {
    states: ['manager_review', 'director_review'],
    admin_only: { states: ['approved', 'closed'], open_fields: ['is_on_hold'] }
  }
}

describe('approval changes setting', () => {
  it('is on by default where the post-approval lock exists, with its states', () => {
    expect(approvalChangesConfigOf(lock)).toEqual({
      states: ['approved', 'closed'],
      approvalStates: ['manager_review', 'director_review'],
      ignore: ['is_on_hold']
    })
  })
  it('is off with false, and off without a lock unless states are named', () => {
    expect(approvalChangesConfigOf({ ...lock, changed_after_approval: false })).toBeNull()
    expect(approvalChangesConfigOf({})).toBeNull()
    expect(
      approvalChangesConfigOf({ changed_after_approval: { states: ['done'] } })?.states
    ).toEqual(['done'])
  })
  it('reads and validates the key', () => {
    expect(parseChangedAfterApproval(false)).toBe(false)
    expect(parseChangedAfterApproval({ enabled: false })).toBe(false)
    expect(parseChangedAfterApproval(true)).toBeUndefined()
    expect(parseChangedAfterApproval({ states: ['a', 'bad key!'] })).toEqual({ states: ['a'] })
    expect(validateChangedAfterApproval('yes')).toHaveProperty('error')
    expect(validateChangedAfterApproval({ states: [1] })).toHaveProperty('error')
    expect(validateChangedAfterApproval(false)).toEqual({ value: false })
  })
  it('survives the summary_mode_rules parse and Form UX validation', () => {
    expect(parseSummaryModeRules({ changed_after_approval: false }).changed_after_approval).toBe(
      false
    )
    const v = validateSummaryModeRules({
      default: 'edit',
      rules: [],
      changed_after_approval: false
    })
    expect(v.value?.changed_after_approval).toBe(false)
    const same = validateSummaryModeRules({ default: 'edit', rules: [] })
    expect(same.value).toBeNull()
  })
})

const t = (m: number) => new Date(Date.UTC(2026, 10, 10, 12, m))
const step = (from: string | null, to: string, user: string | null, m: number): HistoryStep => ({
  from_key: from,
  to_key: to,
  user,
  at: t(m)
})
const cfg = {
  states: ['approved', 'closed'],
  approvalStates: ['manager_review', 'director_review']
}

describe('approval moment', () => {
  it('is the move into the approved stretch; approved → closed stays one stretch', () => {
    const steps = [
      step(null, 'draft', 'creator', 0),
      step('draft', 'manager_review', 'creator', 1),
      step('manager_review', 'director_review', 'mgr', 2),
      step('director_review', 'approved', 'dir', 3),
      step('approved', 'closed', 'admin', 4)
    ]
    const m = approvalMomentOf(steps, 'closed', cfg)
    expect(m?.at).toEqual(t(3))
    expect(m?.state).toBe('approved')
    expect(m?.approvers).toEqual(['dir', 'mgr'])
  })
  it('a send-back and re-approval starts a new moment', () => {
    const steps = [
      step('director_review', 'approved', 'dir', 3),
      step('approved', 'draft', 'admin', 5),
      step('draft', 'director_review', 'creator', 6),
      step('director_review', 'approved', 'dir2', 7)
    ]
    expect(approvalMomentOf(steps, 'approved', cfg)?.at).toEqual(t(7))
  })
  it('is null when the record is not in an approved state', () => {
    expect(
      approvalMomentOf([step('draft', 'manager_review', 'c', 1)], 'manager_review', cfg)
    ).toBeNull()
  })
  it('a run that started approved counts from its start', () => {
    expect(approvalMomentOf([], 'approved', cfg, t(9))).toEqual({
      at: t(9),
      state: 'approved',
      approvers: []
    })
    expect(approvalMomentOf([], 'approved', cfg, null)).toBeNull()
  })
})

describe('value equality', () => {
  it('compares values, not spellings', () => {
    expect(sameValue('12.50', 12.5)).toBe(true)
    expect(sameValue(null, '')).toBe(true)
    expect(sameValue(new Date('2026-11-10T12:00:00Z'), '2026-11-10T12:00:00.000Z')).toBe(true)
    expect(sameValue(true, 1)).toBe(true)
    expect(sameValue('a', 'b')).toBe(false)
    expect(sameValue(5, 6)).toBe(false)
  })
  it('a legacy rich-text document and the HTML it was converted to are the same words', () => {
    const doc = { time: 1, blocks: [{ type: 'paragraph', data: { text: 'C2085.024' } }] }
    expect(sameValue(doc, '<p>C2085.024</p>')).toBe(true)
    expect(sameValue(JSON.stringify(doc), '<p>C2085.024</p>')).toBe(true)
    expect(sameValue('<p>C2085.024</p>', doc)).toBe(true)
    expect(sameValue({ blocks: [{ data: { text: '' } }] }, '<p></p>')).toBe(true)
  })
  it('a text change in rich text is a change', () => {
    const doc = { time: 1, blocks: [{ type: 'paragraph', data: { text: 'C2085.024' } }] }
    expect(sameValue(doc, '<p>C2085.025</p>')).toBe(false)
    expect(sameValue('<p>Ship Monday</p>', '<p>Ship Friday</p>')).toBe(false)
  })
  it('two HTML values compare as markup: a changed link or image source is a change', () => {
    expect(
      sameValue(
        '<p><a href="https://a.example/q1">Quote</a></p>',
        '<p><a href="https://b.example/q1">Quote</a></p>'
      )
    ).toBe(false)
    expect(sameValue('<p><img src="/api/files/1"></p>', '<p><img src="/api/files/2"></p>')).toBe(
      false
    )
    // Whitespace between and inside tags is spelling only.
    expect(sameValue('<p>A  B</p>\n<p>C</p>', '<p>A B</p><p>C</p>')).toBe(true)
    // Escaped text is not the markup it spells.
    expect(sameValue('<p>&lt;b&gt;x&lt;/b&gt;</p>', '<p><b>x</b></p>')).toBe(false)
    expect(sameValue('<p><a href="x&quot;y">q</a></p>', "<p><a href='x\"y'>q</a></p>")).toBe(false)
  })
  it('two documents compare as their blocks (the save stamp is not content)', () => {
    const one = { time: 1, blocks: [{ type: 'paragraph', data: { text: 'x' } }] }
    expect(sameValue(one, { ...one, time: 2 })).toBe(true)
    expect(sameValue(one, { time: 1, blocks: [{ type: 'paragraph', data: { text: 'y' } }] })).toBe(
      false
    )
  })
})

describe('diff since approval', () => {
  const beth = { id: 'u-beth', name: 'Beth Ann', via: 'user' as const }
  it('approved value → now, with the newest writer per field', () => {
    const changes = diffSinceApproval({
      approved: { amount: 100, vendor: 4, title: 'A', note: 'x' },
      current: { amount: 150, vendor: 4, title: 'B', note: 'x' },
      fields: ['amount', 'vendor', 'title', 'note'],
      writes: [{ at: t(30), delta: { amount: 150 }, by: beth }]
    })
    expect(changes.map((c) => c.field)).toEqual(['amount', 'title'])
    expect(changes[0]).toMatchObject({ before: 100, after: 150, by: beth, before_known: true })
    // No app write explains `title`: it was written outside the app.
    expect(changes[1].by.via).toBe('outside')
    expect(changes[1].at).toBeNull()
  })
  it('a field put back to its approved value is not listed', () => {
    expect(
      diffSinceApproval({
        approved: { amount: 100 },
        current: { amount: '100.00' },
        fields: ['amount'],
        writes: [{ at: t(30), delta: { amount: 100 }, by: beth }]
      })
    ).toEqual([])
  })
  it('without an approved snapshot, lists what app writes touched', () => {
    const changes = diffSinceApproval({
      approved: null,
      current: { amount: 150, title: 'B' },
      fields: ['amount', 'title'],
      writes: [{ at: t(30), delta: { amount: 150 }, by: beth }]
    })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ field: 'amount', before_known: false })
  })
  it('never lists a field outside the reader cut', () => {
    expect(
      diffSinceApproval({
        approved: { secret: 1 },
        current: { secret: 2 },
        fields: [],
        writes: []
      })
    ).toEqual([])
  })
})

describe('writers and tracked fields', () => {
  it('names proposals, imports, the system and integrations', () => {
    expect(
      writerOf({
        user_id: 'u',
        first_name: 'Mark',
        comment: 'Accepted change proposal #12 from Beth: x'
      })
    ).toMatchObject({ via: 'proposal', name: 'Mark (accepted proposal #12)' })
    expect(writerOf({ user_id: 'u', comment: 'import:lines.xlsx:abc' })).toMatchObject({
      via: 'import',
      name: 'Import (lines.xlsx)'
    })
    expect(writerOf({ user_id: null })).toMatchObject({ via: 'system' })
    expect(writerOf({ user_id: 'u', first_name: 'Svc', machine: true })).toMatchObject({
      via: 'integration'
    })
  })
  it('skips stamps, links lists, read-computed figures and named fields', () => {
    expect(
      trackedFields(
        [
          { field: 'id' },
          { field: 'amount', type: 'decimal' },
          { field: 'date_updated', special: ['date-updated'] },
          { field: 'lines', type: 'alias', special: ['o2m'] },
          { field: 'total', computed_type: 'read' },
          { field: 'stored_total', computed_type: 'read', computed_store: true },
          { field: 'status' },
          { field: 'is_on_hold' }
        ],
        ['status', 'is_on_hold']
      )
    ).toEqual(['amount', 'stored_total'])
  })
})
