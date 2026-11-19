import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const d = vi.fn()
  return {
    db: Object.assign(d, { transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(d)) })
  }
})

import { conditionsForCopy } from '../../../routes/collection-layouts.js'
import { validateResolveConditions } from '../../../services/layout-resolve-rules.js'

type Row = {
  id: number
  collection: string
  layout_type: string | null
  conditions: unknown
  name?: string
}

/** Knex-ish stub: where({id}).first() = one row by id; whereIn('id', ids) = those rows. */
function stub(rows: Row[]) {
  const calls: { whereIn: number[][] } = { whereIn: [] }
  const q = ((table: string) => {
    if (table !== 'nivaro_collection_layouts') throw new Error(`unexpected table ${table}`)
    let ids: number[] | null = null
    const pick = () => rows.filter((r) => ids?.includes(r.id))
    const chain: Record<string, unknown> = {}
    chain.where = (w: { id: number }) => {
      ids = [Number(w.id)]
      return chain
    }
    chain.whereIn = (_c: string, v: number[]) => {
      calls.whereIn.push(v)
      ids = v
      return chain
    }
    chain.first = async () => pick()[0]
    chain.select = () => chain
    // biome-ignore lint/suspicious/noThenProperty: awaitable query stub
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(pick()).then(res, rej)
    return chain
  }) as never
  return { q, calls }
}

const summary = (id: number, conditions: unknown = null): Row => ({
  id,
  collection: 'c',
  layout_type: 'summary',
  conditions
})
const form = (id: number, over: Partial<Row> = {}): Row => ({
  id,
  collection: 'c',
  layout_type: 'grouped',
  conditions: null,
  ...over
})

const check = (rows: Row[], summary_for: unknown) =>
  validateResolveConditions(stub(rows).q, 1, 'c', { summary_for })

describe('summary_for validation', () => {
  it('refuses a non-list, non-integers and more than 50 ids', async () => {
    const msg = 'conditions.summary_for must be a list of record form ids'
    const rows = [summary(1)]
    expect(await check(rows, 5)).toBe(msg)
    expect(await check(rows, ['x'])).toBe(msg)
    expect(await check(rows, [1.5])).toBe(msg)
    expect(await check(rows, [0])).toBe(msg)
    expect(
      await check(
        rows,
        Array.from({ length: 51 }, (_, i) => i + 10)
      )
    ).toBe(msg)
  })
  it('only a Summary layout may be pinned', async () => {
    expect(await check([form(1), form(10)], [10])).toBe(
      'Only a Summary layout can be pinned to forms'
    )
  })
  it('a Summary screen version follows its desktop', async () => {
    expect(await check([summary(1, { phone_of: 2 }), form(10)], [10])).toBe(
      'A phone or tablet version follows its desktop Summary’s forms'
    )
    expect(await check([summary(1, JSON.stringify({ tablet_of: 2 })), form(10)], [10])).toBe(
      'A phone or tablet version follows its desktop Summary’s forms'
    )
  })
  it('a pinned form must exist in this collection (the message names it)', async () => {
    expect(await check([summary(1)], [10])).toBe('A pinned form is not in this collection (#10)')
    expect(
      await check([summary(1), form(10, { collection: 'other', name: 'Other form' })], [10])
    ).toBe('A pinned form is not in this collection (“Other form”, #10)')
  })
  it('only record forms can be pinned, never screen versions', async () => {
    expect(await check([summary(1), form(10, { layout_type: 'summary' })], [10])).toBe(
      'Only record forms can be pinned (#10)'
    )
    expect(await check([summary(1), form(10, { layout_type: 'list', name: 'List' })], [10])).toBe(
      'Only record forms can be pinned (“List”, #10)'
    )
    expect(await check([summary(1), form(10, { conditions: { phone_of: 11 } })], [10])).toBe(
      'Pin the desktop form; its phone and tablet versions follow it (#10)'
    )
    expect(await check([summary(1), form(10, { conditions: { tablet_of: 11 } })], [10])).toBe(
      'Pin the desktop form; its phone and tablet versions follow it (#10)'
    )
  })
  it('a stale pin already stored (form deleted or now a screen version) does not block a save', async () => {
    // #10 was deleted, #12 became a phone version since the pins were saved.
    const stored = summary(1, { summary_for: [10, 12, 11] })
    const rows = [stored, form(11), form(12, { conditions: { phone_of: 11 } })]
    expect(await check(rows, [10, 12, 11])).toBeNull()
    expect(await check(rows, [10, 11])).toBeNull()
  })
  it('a NEW id still fails beside stale stored ones, named in the message', async () => {
    const stored = summary(1, JSON.stringify({ summary_for: [10] }))
    expect(await check([stored, form(11)], [10, 11, 13])).toBe(
      'A pinned form is not in this collection (#13)'
    )
    expect(
      await check(
        [stored, form(11), form(14, { conditions: { phone_of: 11 }, name: 'Phone' })],
        [10, 14]
      )
    ).toBe('Pin the desktop form; its phone and tablet versions follow it (“Phone”, #14)')
  })
  it('accepts a valid list (null layout_type counts as a form), reading targets in one query', async () => {
    const s = stub([summary(1), form(10), form(11, { layout_type: null })])
    expect(await validateResolveConditions(s.q, 1, 'c', { summary_for: [10, 11] })).toBeNull()
    expect(s.calls.whereIn).toEqual([[10, 11]])
  })
  it('reads only the new ids (stored pins are not re-read)', async () => {
    const s = stub([summary(1, { summary_for: [10] }), form(10), form(11)])
    expect(await validateResolveConditions(s.q, 1, 'c', { summary_for: [10, 11] })).toBeNull()
    expect(s.calls.whereIn).toEqual([[11]])
  })
  it('an empty list clears the pins; an overlap with another Summary is not refused', async () => {
    expect(await check([summary(1)], [])).toBeNull()
    expect(await check([summary(1), summary(2, { summary_for: [10] }), form(10)], [10])).toBeNull()
  })
})

describe('a clone does not copy Summary pins', () => {
  it('drops summary_for, keeps the rest', () => {
    const raw = JSON.stringify({ role_ids: ['A'], summary_for: [10], phone_of: 3 })
    expect(JSON.parse(conditionsForCopy(raw) as string)).toEqual({ role_ids: ['A'] })
    expect(conditionsForCopy(JSON.stringify({ summary_for: [10] }))).toBeNull()
  })
})
