import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { toTsv } from '../../../services/staged-imports.js'

// BULK INSERT has no text qualifier: it splits on the terminators and stores
// whatever is between them. Everything here guards a real production failure —
// quoted values silently broke every procedure join against staging.
describe('toTsv', () => {
  it('writes bare values, so procedure joins match real data', () => {
    const out = toTsv([{ region: 'HRT', vendor: 'MasTec' }], ['region', 'vendor'])
    const [header, row] = out.split('\n')
    assert.equal(header, 'region||vendor')
    assert.equal(row, 'HRT||MasTec')
    assert.ok(!row.includes("'"), 'a wrapping quote would be stored as data')
  })

  it('neutralises a value containing the field delimiter', () => {
    // Left intact this would split the row and shift every later column.
    const out = toTsv([{ a: 'x||y', b: 'z' }], ['a', 'b'])
    const row = out.split('\n')[1]
    assert.equal(row.split('||').length, 2)
    assert.equal(row, 'x y||z')
  })

  it('neutralises a pipe at either end of a value, which would join the delimiter', () => {
    // `a|` + `||` + `|b` = `a||||b`: BULK INSERT would read three fields.
    const out = toTsv([{ a: 'a|', b: '|b', c: 'c' }], ['a', 'b', 'c'])
    const row = out.split('\n')[1]
    assert.equal(row, 'a || b||c')
    assert.equal(row.split('||').length, 3)
    assert.ok(!/\|{3,}/.test(row))
  })

  it('keeps a single pipe inside a value', () => {
    assert.equal(toTsv([{ a: 'A|B', b: 'z' }], ['a', 'b']).split('\n')[1], 'A|B||z')
  })

  it('flattens a lone carriage return too', () => {
    assert.equal(toTsv([{ a: 'x\ry' }], ['a']).split('\n')[1], 'x y')
  })

  it('flattens newlines, which would otherwise terminate the row early', () => {
    const out = toTsv([{ note: 'line one\r\nline two' }], ['note'])
    assert.equal(out.split('\n')[1], 'line one line two')
  })

  it('emits an empty field for a missing or null value rather than dropping it', () => {
    const out = toTsv([{ a: 'v' } as Record<string, string>], ['a', 'b'])
    assert.equal(out.split('\n')[1], 'v||')
  })

  it('ends with a trailing newline, since ROWTERMINATOR is 0x0a', () => {
    assert.ok(toTsv([{ a: '1' }], ['a']).endsWith('\n'))
  })
})
