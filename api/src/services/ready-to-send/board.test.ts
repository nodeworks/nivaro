import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: vi.fn() }))

import type { User } from '../../types.js'
import type { AccessGates } from '../record-access.js'
import {
  applyCheck,
  boardGroups,
  parseResult,
  problemLabel,
  type ReadyEntry,
  type ReadyResult,
  serializeResult,
  summarizeResult,
  visibleEntries,
  worstOf
} from './board.js'

const entry = (over: Partial<ReadyEntry> & Pick<ReadyEntry, 'item'>): ReadyEntry => ({
  collection: 'orders',
  label: `Order ${over.item}`,
  state: 'Approved',
  transition: { id: 't1', label: 'Send to partner' },
  partners: ['Acme ERP'],
  owners: [],
  issues: [],
  worst: 'block',
  checked_at: '2026-11-14T09:00:00.000Z',
  ...over
})

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), label: `Line ${i + 1}` }))

describe('ready-to-send grouping', () => {
  it('folds the same problem across records, whatever the line count', () => {
    expect(problemLabel('Asks for Sales order on 2 lines')).toBe(
      'Asks for Sales order on some lines'
    )
    expect(problemLabel('Asks for Sales order on 1 line')).toBe(
      'Asks for Sales order on some lines'
    )

    const g = boardGroups([
      entry({
        item: 'a',
        worst: 'ask',
        issues: [
          {
            severity: 'ask',
            kind: 'requirement',
            message: 'Asks for Sales order on 2 lines',
            rows: lines(2)
          }
        ]
      }),
      entry({
        item: 'b',
        worst: 'block',
        issues: [
          {
            severity: 'ask',
            kind: 'requirement',
            message: 'Asks for Sales order on 3 lines',
            rows: lines(3)
          },
          {
            severity: 'block',
            kind: 'push',
            partner: 'Acme ERP',
            message: 'Acme ERP will not be sent: PO number is empty'
          }
        ]
      }),
      entry({
        item: 'c',
        partners: ['Ship Co'],
        worst: 'warn',
        issues: [
          {
            severity: 'warn',
            kind: 'contract',
            partner: 'Ship Co',
            message: 'Ship Co would receive no Contact email'
          }
        ]
      })
    ])
    const sales = g.problems.find((p) => p.label === 'Asks for Sales order on some lines')
    expect(sales).toMatchObject({ records: 2, lines: 5, severity: 'ask' })
    // Refusals first, then warnings, then asks.
    expect(g.problems.map((p) => p.severity)).toEqual(['block', 'warn', 'ask'])
    expect(g.totals).toEqual({ records: 3, refused: 1, warnings: 1, asks: 1 })
    expect(g.partners).toEqual([
      { partner: 'Acme ERP', records: 2, refused: 1, warnings: 0, asks: 1 },
      { partner: 'Ship Co', records: 1, refused: 0, warnings: 1, asks: 0 }
    ])
  })

  it('counts a record once even with two send moves, at its worst', () => {
    const g = boardGroups([
      entry({ item: 'a', worst: 'warn', transition: { id: 't1', label: 'Send' } }),
      entry({ item: 'A', worst: 'block', transition: { id: 't2', label: 'Send again' } })
    ])
    expect(g.totals).toMatchObject({ records: 1, refused: 1, warnings: 0 })
  })

  it('names the worst severity', () => {
    expect(worstOf([])).toBeNull()
    expect(
      worstOf([
        { severity: 'ask', message: 'x' },
        { severity: 'warn', message: 'y' }
      ])
    ).toBe('warn')
  })
})

describe('ready-to-send visibility', () => {
  const user = { id: 'u1' } as User
  const gates = (collection: string, bypass = false) =>
    ({
      collection,
      user,
      bypass,
      permitted: true,
      rowFilter: null,
      scopes: [],
      strict: null
    }) as AccessGates

  it('keeps only the records the viewer can read, judged per collection', async () => {
    const compile = vi.fn(async (_u: User, collection: string, _opts: { actingAdmin?: boolean }) =>
      gates(collection)
    )
    const visible = vi.fn(async (g: AccessGates, ids: string[]) =>
      g.collection === 'orders'
        ? new Set(ids.filter((i) => i !== 'b').map((i) => i.toUpperCase()))
        : new Set<string>()
    )
    const all = [
      entry({ item: 'a' }),
      entry({ item: 'b' }),
      entry({ item: 'x', collection: 'requests' })
    ]
    const out = await visibleEntries(all, user, false, { compile, visible })
    expect(out.map((e) => e.item)).toEqual(['a'])
    expect(compile).toHaveBeenCalledTimes(2)
    // One set-based check per collection, never one per record.
    expect(visible).toHaveBeenCalledTimes(2)
    expect(compile.mock.calls[0][2]).toEqual({ actingAdmin: false })
  })

  it('an admin without restrict scopes sees everything; unreadable gates hide rows', async () => {
    const compile = vi.fn(async (_u: User, collection: string) => {
      if (collection === 'broken') throw new Error('no')
      return gates(collection, true)
    })
    const visible = vi.fn(async () => new Set<string>())
    const out = await visibleEntries(
      [entry({ item: 'a' }), entry({ item: 'z', collection: 'broken' })],
      user,
      true,
      { compile, visible }
    )
    expect(out.map((e) => e.item)).toEqual(['a'])
    expect(visible).not.toHaveBeenCalled()
  })
})

describe('ready-to-send stored result', () => {
  const result: ReadyResult = {
    kind: 'ready-to-send',
    generated_at: '2026-11-14T09:00:00.000Z',
    trigger: 'cron',
    candidates: 10,
    checked: 10,
    ready: 8,
    errors: 0,
    partial: null,
    collections: { orders: 'Orders' },
    entries: [entry({ item: 'a' }), entry({ item: 'b' })],
    duration_ms: 5
  }

  it('Check again replaces one record and counts it ready when nothing is left', () => {
    const fixed = applyCheck(result, 'orders', 'A', [])
    expect(fixed.entries.map((e) => e.item)).toEqual(['b'])
    expect(fixed.ready).toBe(9)
    const gone = applyCheck(result, 'orders', 'b', [], { gone: true })
    expect(gone.entries.map((e) => e.item)).toEqual(['a'])
    expect(gone.ready).toBe(8)
    const worse = applyCheck(result, 'orders', 'c', [entry({ item: 'c' })])
    expect(worse.ready).toBe(7)
  })

  it('round-trips, and older runs keep counts only', () => {
    expect(parseResult(serializeResult(result))?.entries).toHaveLength(2)
    const summary = JSON.parse(summarizeResult(result))
    expect(summary).toMatchObject({ kind: 'ready-to-send-summary', with_problems: 2 })
    expect(parseResult(summarizeResult(result))).toBeNull()
  })
})
