import knexLib from 'knex'
import { describe, expect, it } from 'vitest'
import {
  dropsRowGoal,
  longInListColumn,
  ROW_GOAL_IN_MIN,
  sortsByIdOnly,
  withoutRowGoal
} from '../../../services/list-row-goal.js'

// Prod 2026-11-17: the Forecast export's invoice join (`purchase_order _in [250 POs]`,
// sort=id, TOP 1000) cached a plan that scanned all 901k invoices in id order (row goal:
// est. 71k rows) — 1.4–1.8 s per page in SQL, 3–6 s per request. Without the row goal
// the same statement seeks the purchase_order index: same rows, same order.

const ids = (n: number) => Array.from({ length: n }, (_, i) => String(155260 + i))
const base = { sort: ['id'], pkOrder: true }

describe('list reads: an id list on an fk ordered by id skips the row goal', () => {
  it('finds a long `_in` on a plain column, top level or in a top-level _and', () => {
    expect(longInListColumn({ purchase_order: { _in: ids(250) } })).toBe('purchase_order')
    expect(longInListColumn({ _and: [{ x: { _eq: 1 } }, { po: { _in: ids(50) } }] })).toBe('po')
    // a person's short filter can match half the table: the row goal stays
    expect(longInListColumn({ status: { _in: ['open', 'held'] } })).toBeNull()
    expect(longInListColumn({ po: { _in: ids(ROW_GOAL_IN_MIN - 1) } })).toBeNull()
    // the id list on the key itself seeks the clustered index anyway
    expect(longInListColumn({ id: { _in: ids(250) } })).toBeNull()
    // not a plain column: _or branches, relation hops
    expect(longInListColumn({ _or: [{ po: { _in: ids(250) } }] })).toBeNull()
    expect(longInListColumn({ project: { name: { _in: ids(250) } } })).toBeNull()
    expect(longInListColumn(null)).toBeNull()
  })

  it('only when the page is ordered by id alone', () => {
    expect(sortsByIdOnly(['id'], false)).toBe(true)
    expect(sortsByIdOnly(['-id'], false)).toBe(true)
    expect(sortsByIdOnly([], true)).toBe(true) // the default primary-key order
    expect(sortsByIdOnly([], false)).toBe(false) // no id column: (SELECT NULL)
    expect(sortsByIdOnly(['purchase_order', 'id'], true)).toBe(false)
    expect(sortsByIdOnly(['name'], true)).toBe(false)
  })

  it('never for a search, a cursor walk or a label lookup', () => {
    const filter = { purchase_order: { _in: ids(250) } }
    expect(dropsRowGoal({ ...base, filter })).toBe(true)
    expect(dropsRowGoal({ ...base, filter, search: 'abc' })).toBe(false)
    expect(dropsRowGoal({ ...base, filter, keyset: true })).toBe(false)
    expect(dropsRowGoal({ ...base, filter, labelLookup: true })).toBe(false)
    expect(dropsRowGoal({ ...base, filter, sort: ['purchase_order', 'id'] })).toBe(false)
  })

  it('appends the hint to the compiled page — every gate and binding unchanged', () => {
    const k = knexLib({ client: 'mssql' })
    const page = (offset: number) =>
      k('invoices')
        .select(['id', 'purchase_order', 'amount', 'due_date'])
        .whereIn('invoices.purchase_order', ids(250))
        .whereExists(function () {
          this.select(k.raw('1'))
            .from('projects as s0')
            .whereRaw('[s0].[id] = [invoices].[project]')
            .whereIn('s0.division', [1, 2, 3])
        })
        .orderBy('id', 'asc')
        .limit(1000)
        .offset(offset)
        .toSQL()
    for (const offset of [0, 1000]) {
      const c = page(offset)
      const out = withoutRowGoal(c.sql, c.bindings)
      expect(out?.sql).toBe(`${c.sql} OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))`)
      expect(out?.bindings).toEqual([...c.bindings])
      // re-run as raw SQL: the placeholders still line up with the bindings
      const native = k
        .raw(out?.sql ?? '', out?.bindings as never[])
        .toSQL()
        .toNative()
      expect(native.sql).toMatch(
        /order by \[id\] asc.* OPTION \(USE HINT\('DISABLE_OPTIMIZER_ROWGOAL'\)\)$/
      )
      expect(native.bindings).toHaveLength(c.bindings.length)
    }
  })

  it('runs the page as built when the SQL cannot be re-read safely', () => {
    // a literal ? would be taken for a binding
    expect(withoutRowGoal("select * from t where a = '?' and b = ?", [1])).toBeNull()
    // already hinted
    expect(withoutRowGoal('select 1 OPTION (RECOMPILE)', [])).toBeNull()
    expect(withoutRowGoal("select * from t where a LIKE '%??%'", [])).toBeNull()
  })
})
