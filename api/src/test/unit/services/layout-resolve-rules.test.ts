import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const d = vi.fn()
  return {
    db: Object.assign(d, { transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(d)) })
  }
})

import { conditionsForCopy, pickBestLayoutTraced } from '../../../routes/collection-layouts.js'
import { buildLayoutOverview } from '../../../services/layout-overview.js'
import {
  activeFreeze,
  activeWindowOf,
  checkFreeze,
  LAYOUT_FROZEN,
  lazySectionsOf,
  phoneOf,
  validateResolveConditions,
  windowOpen,
  windowState
} from '../../../services/layout-resolve-rules.js'

const cond = (c: Record<string, unknown>) => JSON.stringify(c)

describe('active dates (#2714)', () => {
  const win = { active_window: { from: '2026-12-15', until: '2027-01-15' } }
  it('reads the window from stored text and ignores junk', () => {
    expect(activeWindowOf(cond(win))).toEqual({ from: '2026-12-15', until: '2027-01-15' })
    expect(activeWindowOf(cond({ active_window: { from: 'soon' } }))).toBeNull()
    expect(activeWindowOf(null)).toBeNull()
  })
  it('is inclusive at both ends', () => {
    const w = activeWindowOf(win)
    expect(windowState(w, '2026-12-14')).toBe('before')
    expect(windowState(w, '2026-12-15')).toBe('open')
    expect(windowState(w, '2027-01-15')).toBe('open')
    expect(windowState(w, '2027-01-16')).toBe('after')
    expect(windowOpen({ role_ids: ['x'] }, '2020-01-01')).toBe(true)
  })
  it('allows open-ended windows', () => {
    expect(windowOpen({ active_window: { from: '2026-12-15' } }, '2099-01-01')).toBe(true)
    expect(windowOpen({ active_window: { until: '2026-12-15' } }, '2026-12-16')).toBe(false)
  })
})

describe('edit freeze (#2717)', () => {
  const frozen = { conditions: cond({ freeze: { until: '2026-11-01', reason: 'Go-live' } }) }
  it('is in force before its day and lifts on it', () => {
    expect(activeFreeze(frozen.conditions, '2026-10-31')?.reason).toBe('Go-live')
    expect(activeFreeze(frozen.conditions, '2026-11-01')).toBeNull()
  })
  it('refuses a write without an override note, with the reason', () => {
    const r = checkFreeze(frozen, undefined, '2026-10-21')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe(LAYOUT_FROZEN)
    expect(r.error).toMatch(/frozen until .*Go-live/)
  })
  it('lets an override note through (and a too-short one does not)', () => {
    expect(checkFreeze(frozen, '  hotfix   for audit ', '2026-10-21')).toEqual({
      ok: true,
      override: 'hotfix for audit'
    })
    expect(checkFreeze(frozen, 'ok', '2026-10-21').ok).toBe(false)
    expect(checkFreeze({ conditions: null }, undefined, '2026-10-21')).toEqual({
      ok: true,
      override: null
    })
  })
  it('a copy drops the freeze and the phone link, keeping the rest', () => {
    const raw = cond({
      role_ids: ['A'],
      freeze: { until: '2027-01-01', reason: 'x y z' },
      phone_of: 3
    })
    expect(JSON.parse(conditionsForCopy(raw) as string)).toEqual({ role_ids: ['A'] })
    expect(conditionsForCopy(cond({ freeze: { until: '2027-01-01', reason: 'abc' } }))).toBeNull()
    expect(conditionsForCopy(null)).toBeNull()
  })
})

describe('lazy sections (#2713)', () => {
  it('reads unique string keys only', () => {
    expect(lazySectionsOf({ lazy_sections: ['a', 'b', 'a', 3] })).toEqual(['a', 'b'])
    expect(lazySectionsOf(null)).toEqual([])
  })
})

/** A knex-ish stub: every query answers `rows` (first() the first). */
function stubQ(rowsByTable: Record<string, unknown[]>) {
  return ((table: string) => {
    const rows = rowsByTable[table] ?? []
    // Awaiting the query answers every row; first() the first.
    const chain = Object.assign(Promise.resolve(rows), {
      first: async () => rows[0]
    }) as unknown as Promise<unknown[]> & Record<string, unknown>
    for (const m of ['where', 'whereNot', 'whereNotNull', 'select']) chain[m] = () => chain
    return chain
  }) as never
}

describe('validateResolveConditions', () => {
  it('checks dates and order', async () => {
    const q = stubQ({})
    expect(await validateResolveConditions(q, 1, 'c', { active_window: { from: 'x' } })).toMatch(
      /date/
    )
    expect(
      await validateResolveConditions(q, 1, 'c', {
        active_window: { from: '2027-01-02', until: '2027-01-01' }
      })
    ).toMatch(/end before/)
    expect(
      await validateResolveConditions(q, 1, 'c', { active_window: { from: '2027-01-01' } })
    ).toBeNull()
  })
  it('needs a freeze reason', async () => {
    const q = stubQ({})
    expect(
      await validateResolveConditions(q, 1, 'c', { freeze: { until: '2027-01-01', reason: '' } })
    ).toMatch(/reason/)
    expect(
      await validateResolveConditions(q, 1, 'c', {
        freeze: { until: '2027-01-01', reason: 'Go-live' }
      })
    ).toBeNull()
  })
  it('refuses a phone version of itself, of another collection, or of a phone version', async () => {
    expect(await validateResolveConditions(stubQ({}), 4, 'c', { phone_of: 4 })).toMatch(/own/)
    const other = stubQ({ nivaro_collection_layouts: [{ id: 2, collection: 'x' }] })
    expect(await validateResolveConditions(other, 4, 'c', { phone_of: 2 })).toMatch(/collection/)
    const chained = stubQ({
      nivaro_collection_layouts: [
        { id: 2, collection: 'c', layout_type: 'grouped', conditions: cond({ phone_of: 9 }) }
      ]
    })
    expect(await validateResolveConditions(chained, 4, 'c', { phone_of: 2 })).toMatch(
      /itself a phone version/
    )
  })
})

describe('pickBestLayoutTraced with active dates and phone versions', () => {
  const desk = { id: 1, name: 'Main', is_active: 1, sort: 0, conditions: null }
  const close = {
    id: 2,
    name: 'Year-end close',
    is_active: 0,
    sort: 1,
    conditions: cond({
      role_ids: ['R'],
      active_window: { from: '2026-12-15', until: '2027-01-15' }
    })
  }
  const phone = {
    id: 3,
    name: 'Main (phone)',
    is_active: 0,
    sort: 2,
    conditions: cond({ phone_of: 1 })
  }
  const all = [desk, close, phone]

  it('a form outside its dates leaves the race', () => {
    const inside = pickBestLayoutTraced(all, 'R', null, false, { today: '2026-12-20' })
    expect(inside.row?.id).toBe(2)
    const outside = pickBestLayoutTraced(all, 'R', null, false, { today: '2026-11-01' })
    expect(outside.row?.id).toBe(1)
    expect(outside.checked.find((c) => c.layout_id === 2)?.why).toMatch(/Outside its active dates/)
  })

  it('a phone version never wins on its own', () => {
    const r = pickBestLayoutTraced([phone, desk], null, null, true, { today: '2026-11-01' })
    expect(r.row?.id).toBe(1)
    expect(r.checked.find((c) => c.layout_id === 3)?.why).toMatch(/small screens only/)
  })

  it('stands in for its desktop form on a phone', () => {
    const r = pickBestLayoutTraced(all, null, null, true, {
      today: '2026-11-01',
      viewport: 'phone'
    })
    expect(r.row?.id).toBe(3)
    expect(r.reason).toMatchObject({ kind: 'phone', phone_of: 1, desktop_kind: 'default' })
    expect(r.checked.find((c) => c.layout_id === 1)?.why).toMatch(/phone version “Main \(phone\)”/)
  })

  it('a desktop form without a phone version stays on a phone', () => {
    const r = pickBestLayoutTraced(all, 'R', null, false, {
      today: '2026-12-20',
      viewport: 'phone'
    })
    expect(r.row?.id).toBe(2)
    expect(r.reason?.kind).toBe('role')
  })
})

describe('overview rows (#2714 #2715 #2717)', () => {
  it('lists a phone version right after its form, with the extras', () => {
    const rows = buildLayoutOverview(
      [
        {
          id: 1,
          name: 'Main',
          layout_type: 'grouped',
          is_active: 1,
          sort: 0,
          conditions: cond({ freeze: { until: '2999-01-01', reason: 'Audit' } })
        },
        {
          id: 3,
          name: 'Main (phone)',
          layout_type: 'grouped',
          is_active: 0,
          sort: 2,
          conditions: cond({ phone_of: 1 })
        },
        {
          id: 2,
          name: 'Close',
          layout_type: 'grouped',
          is_active: 0,
          sort: 1,
          conditions: cond({ role_ids: ['R'], active_window: { until: '2000-01-01' } })
        }
      ],
      new Map(),
      [{ id: 'R', name: 'Finance' }]
    )
    const forms = rows.filter((r) => r.section === 'forms').map((r) => r.layout_id)
    expect(forms.indexOf(3)).toBe(forms.indexOf(1) + 1)
    const main = rows.find((r) => r.layout_id === 1)
    expect(main?.phone_version).toEqual({ layout_id: 3, name: 'Main (phone)' })
    expect(main?.frozen).toEqual({ until: '2999-01-01', reason: 'Audit' })
    expect(rows.find((r) => r.layout_id === 3)?.reason.kind).toBe('phone')
    const close = rows.find((r) => r.layout_id === 2)
    expect(close?.active_window?.state).toBe('after')
    expect(close?.warnings.join(' ')).toMatch(/no longer in use/)
    expect(phoneOf(cond({ phone_of: '3' }))).toBe(3)
  })
})
