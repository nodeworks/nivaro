import knexFactory from 'knex'
import { describe, expect, it } from 'vitest'
import { compileFormulaToSql } from '../../../services/virtual-sql.js'

const cols = new Set([
  'fusion_status',
  'mdsi_status',
  'requisition_amount',
  'forecast_total',
  'qty'
])
const knex = knexFactory({ client: 'mssql' })
const render = (formula: string) => {
  const c = compileFormulaToSql(formula, 'orders', cols)
  if (!c) return null
  return knex('orders')
    .whereRaw(`${c.sql} = ?`, [...c.bindings, 1])
    .toSQL().sql
}

describe('calculated fields as SQL', () => {
  it('compiles coalesce over columns', () => {
    const c = compileFormulaToSql('coalesce(item.fusion_status, item.mdsi_status)', 'orders', cols)
    expect(c?.kind).toBe('value')
    expect(render('coalesce(item.fusion_status, item.mdsi_status)')).toContain(
      'COALESCE([orders].[fusion_status], [orders].[mdsi_status])'
    )
  })

  it('compiles arithmetic with empty operands counted as zero', () => {
    const c = compileFormulaToSql('item.requisition_amount - item.forecast_total', 'orders', cols)
    expect(c?.kind).toBe('number')
    expect(render('item.requisition_amount - item.forecast_total')).toContain(
      '(ISNULL(CAST([orders].[requisition_amount] AS float), 0) - ISNULL(CAST([orders].[forecast_total] AS float), 0))'
    )
  })

  it('keeps precedence, parentheses, unary minus and literals', () => {
    const sql = render('-(item.qty + 2) * 3 / item.forecast_total')
    expect(sql).toContain('NULLIF(')
    expect(sql).toContain('(((-((ISNULL(CAST([orders].[qty] AS float), 0) + ?))) * ?) / NULLIF(')
    expect(
      compileFormulaToSql("coalesce(item.mdsi_status, 'none')", 'orders', cols)?.bindings
    ).toEqual(['orders', 'mdsi_status', 'none'])
  })

  it('declines what it cannot express exactly', () => {
    for (const f of [
      'item.unknown_column + 1',
      'concat(item.fusion_status, "x")',
      'item.qty > 3 ? 1 : 0',
      'item.qty or 0',
      'max(item.qty, 2)',
      'item.vendor.name',
      'item.qty +',
      '(item.qty',
      '42',
      "'text'",
      '',
      'item.qty; drop table orders',
      "coalesce(item.mdsi_status, 'a\\'b')"
    ]) {
      expect(compileFormulaToSql(f, 'orders', cols), f).toBeNull()
    }
  })

  it('never puts formula text into the SQL', () => {
    const c = compileFormulaToSql("coalesce(item.mdsi_status, 'x'' OR 1=1 --')", 'orders', cols)
    // the quote ends the literal early; what follows is not a formula
    expect(c).toBeNull()
    const ok = compileFormulaToSql('coalesce(item.mdsi_status, "x OR 1=1 --")', 'orders', cols)
    expect(ok?.sql).not.toContain('OR 1=1')
    expect(ok?.bindings).toContain('x OR 1=1 --')
  })
})
