import { describe, expect, it } from 'vitest'
import { pickBestLayoutTraced } from '../../../routes/collection-layouts.js'
import {
  abArmOf,
  abHalf,
  armResult,
  liveVariants,
  parseAbTest,
  tallyCreations
} from '../../../services/layout-ab.js'
import { buildLayoutOverview } from '../../../services/layout-overview.js'
import { shownConditions } from '../../../services/layout-testing.js'
import { mergeStepStats, parseStepStats } from '../../../services/layout-usage.js'

const ROLE = 'ROLE-1'
const ab = (control_id: number, extra: Record<string, unknown> = {}) => ({
  ab: {
    control_id,
    role_id: ROLE,
    salt: 'salt01',
    started_at: '2026-10-01T00:00:00.000Z',
    ...extra
  }
})

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `L${id}`,
  layout_type: 'grouped',
  is_active: false,
  sort: id,
  conditions: null,
  record_conditions: null,
  ...extra
})

/** A user id in the wanted half of salt01. */
function userIn(half: 'a' | 'b', salt = 'salt01'): string {
  for (let i = 0; ; i++) {
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
    if (abHalf(salt, id) === half) return id
  }
}

describe('parseAbTest', () => {
  it('reads a stored test from JSON text or an object', () => {
    expect(parseAbTest(JSON.stringify(ab(3)))).toMatchObject({ control_id: 3, role_id: ROLE })
    expect(parseAbTest(ab(3))?.salt).toBe('salt01')
  })
  it('refuses malformed tests', () => {
    expect(parseAbTest(null)).toBeNull()
    expect(parseAbTest({ ab: { control_id: 0, role_id: ROLE, salt: 'salt01' } })).toBeNull()
    expect(parseAbTest({ ab: { control_id: 3, role_id: '', salt: 'salt01' } })).toBeNull()
    expect(parseAbTest({ ab: { control_id: 3, role_id: ROLE, salt: 'x' } })).toBeNull()
  })
})

describe('abHalf', () => {
  it('is stable per person and test, ignores id casing, and splits about evenly', () => {
    const id = 'ab12cd34-0000-4000-8000-000000000001'
    expect(abHalf('s1', id)).toBe(abHalf('s1', id.toUpperCase()))
    let b = 0
    for (let i = 0; i < 2000; i++) if (abHalf('s1', `user-${i}`) === 'b') b++
    expect(b).toBeGreaterThan(900)
    expect(b).toBeLessThan(1100)
  })
  it('a new salt reshuffles the halves', () => {
    let moved = 0
    for (let i = 0; i < 400; i++) if (abHalf('s1', `u${i}`) !== abHalf('s2', `u${i}`)) moved++
    expect(moved).toBeGreaterThan(100)
  })
})

describe('liveVariants', () => {
  it('needs the control among the candidates and not itself a variant', () => {
    const a = row(1)
    const b = row(2, { conditions: ab(1) })
    expect([...liveVariants([a, b]).keys()]).toEqual([b])
    expect(liveVariants([b]).size).toBe(0)
    const c = row(3, { conditions: ab(2) })
    expect([...liveVariants([a, b, c]).keys()]).toEqual([b])
  })
})

describe('pickBestLayoutTraced with an A/B test', () => {
  const a = row(1, { is_active: true })
  const b = row(2, { conditions: ab(1) })
  const other = row(3)

  it('never picks the variant on its own', () => {
    const res = pickBestLayoutTraced([a, b, other], 'OTHER', null, false, userIn('b'))
    expect(res.row).toBe(a)
    expect(res.ab).toBeNull()
    // Even as first in order with no default.
    const lone = pickBestLayoutTraced([row(2, { conditions: ab(1) }), row(1)], ROLE, null, false)
    expect(Number(lone.row?.id)).toBe(1)
  })

  it('gives half b the variant and half a the control, deterministically', () => {
    const inB = pickBestLayoutTraced([a, b], ROLE, null, false, userIn('b'))
    expect(inB.row).toBe(b)
    expect(inB.reason).toMatchObject({
      kind: 'ab',
      ab: { control_id: 1, variant_id: 2, half: 'b' }
    })
    expect(inB.checked.find((c) => c.layout_id === 2)).toMatchObject({ matched: true })
    expect(inB.checked.find((c) => c.layout_id === 1)?.why).toMatch(/A\/B test half/)
    const inA = pickBestLayoutTraced([a, b], ROLE, null, false, userIn('a'))
    expect(inA.row).toBe(a)
    expect(inA.ab?.half).toBe('a')
    expect(inA.checked.find((c) => c.layout_id === 2)?.why).toMatch(/keeps/)
    for (let i = 0; i < 5; i++)
      expect(pickBestLayoutTraced([a, b], ROLE, null, false, userIn('b')).row).toBe(b)
  })

  it('role ids compare without case; admins and other roles keep the control', () => {
    expect(pickBestLayoutTraced([a, b], ROLE.toLowerCase(), null, false, userIn('b')).row).toBe(b)
    expect(pickBestLayoutTraced([a, b], null, null, true, userIn('b')).row).toBe(a)
    expect(pickBestLayoutTraced([a, b], 'OTHER', null, false, userIn('b')).row).toBe(a)
  })

  it('explains the split as a role when no person is given', () => {
    const res = pickBestLayoutTraced([a, b], ROLE, null, false)
    expect(res.row).toBe(a)
    expect(res.ab).toMatchObject({ variant_id: 2, half: null })
    expect(res.checked.find((c) => c.layout_id === 2)?.why).toMatch(/half of this role/)
  })

  it('only stands in when resolution picked its control', () => {
    const rule = row(5, {
      record_conditions: JSON.stringify([{ field: 's', op: 'eq', value: 'x' }])
    })
    const res = pickBestLayoutTraced([a, b, rule], ROLE, { s: 'x' }, false, userIn('b'))
    expect(res.row).toBe(rule)
    expect(res.ab).toBeNull()
  })

  it('keeps the control when the variant is closed to the role', () => {
    const closed = row(2, { conditions: { ...ab(1), role_ids: ['SOMEONE-ELSE'] } })
    expect(pickBestLayoutTraced([a, closed], ROLE, null, false, userIn('b')).row).toBe(a)
  })
})

describe('A/B arm tagging and counts', () => {
  const tests = [
    {
      control_id: 1,
      variant_id: 2,
      role_id: ROLE,
      salt: 'salt01',
      started_at: '',
      started_by: null
    }
  ]
  it('tags a session only for the half that gets that form', () => {
    const ua = userIn('a')
    const ub = userIn('b')
    expect(abArmOf(tests, 1, { id: ua, role: ROLE }, false)).toBe('salt01')
    expect(abArmOf(tests, 2, { id: ua, role: ROLE }, false)).toBeNull()
    expect(abArmOf(tests, 2, { id: ub, role: ROLE }, false)).toBe('salt01')
    expect(abArmOf(tests, 1, { id: ub, role: ROLE }, false)).toBeNull()
    expect(abArmOf(tests, 1, { id: ua, role: 'OTHER' }, false)).toBeNull()
    expect(abArmOf(tests, 1, { id: ua, role: ROLE }, true)).toBeNull()
  })

  it('keeps arm and section counts beside the steps without touching them', () => {
    const base = {
      layout_id: 1,
      collection: 'orders',
      item: null,
      open: true,
      saved: true,
      abandoned_step: null,
      steps: { __form__: 4000 },
      save_ms: 4000,
      sections: { shown: ['basics', 'notes'], opened: ['basics'] }
    }
    const once = mergeStepStats(null, base, 'salt01')
    const twice = mergeStepStats(
      once,
      { ...base, saved: false, save_ms: null, open: false },
      'salt01'
    )
    const v = JSON.parse(twice)
    expect(v['~ab:salt01']).toEqual({ o: 1, s: 1, a: 0, ms: 8000, t: 4000, tn: 1 })
    expect(v['~s:basics']).toEqual({ n: 2, o: 2 })
    expect(parseStepStats(twice)).toEqual({ __form__: { ms: 8000, n: 2, a: 0 } })
  })

  it('splits records created by people in each half and counts edits within a day', () => {
    const ua = userIn('a')
    const ub = userIn('b')
    const t0 = new Date('2026-10-02T10:00:00Z')
    const hour = (h: number) => new Date(t0.getTime() + h * 3_600_000)
    const made = tallyCreations(
      'salt01',
      [
        { item: '1', creator: ua, at: t0 },
        { item: '2', creator: ub, at: t0 },
        { item: '3', creator: ub, at: t0 }
      ],
      [
        { item: '1', at: hour(1) },
        { item: '1', at: hour(30) },
        { item: '2', at: hour(2) },
        { item: '2', at: hour(3) }
      ]
    )
    expect(made.a).toEqual({ created: 1, edited: 1, edits: 1 })
    expect(made.b).toEqual({ created: 2, edited: 1, edits: 2 })
    const r = armResult(2, 'b', 10, { o: 8, s: 6, a: 1, ms: 0, t: 60_000, tn: 3 }, made.b)
    expect(r).toMatchObject({ save_rate: 0.75, avg_save_ms: 20_000, edits_per_record: 1 })
  })
})

describe('A/B in the overview and on the wire', () => {
  it('lists the variant right after its control, never as a picked form', () => {
    const rows = buildLayoutOverview(
      [
        { id: 1, name: 'Main', is_active: true, sort: 1 },
        { id: 2, name: 'Main (new)', sort: 2, conditions: JSON.stringify(ab(1)) },
        { id: 3, name: 'Spare', sort: 3 }
      ],
      new Map(),
      [{ id: ROLE, name: 'Field Tech' }]
    )
    expect(rows.map((r) => r.layout_id)).toEqual([1, 2, 3])
    expect(rows[1].reason.kind).toBe('ab')
    expect(rows[1].reason.type_use).toBe('A/B test: half of Field Tech get it instead of “Main”')
  })

  it('never sends the test to non-admins', () => {
    expect(shownConditions({ role_ids: ['x'], ...ab(1) }, false)).toEqual({ role_ids: ['x'] })
    expect(shownConditions(ab(1), false)).toBeNull()
  })
})
