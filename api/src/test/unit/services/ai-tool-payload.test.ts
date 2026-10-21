import { describe, expect, it } from 'vitest'
import { COMPACT_FORMAT_NOTE, compactToolResult } from '../../../services/ai-tool-payload.js'

// #2765 — compact tool payloads: tables for lists of records, labels once.

describe('compactToolResult (#2765)', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    name: `Request ${i + 1}`,
    status: i % 2 ? 'open' : 'closed',
    vendor: { id: 5, label: 'Acme Supplies Incorporated' }
  }))

  it('sends a list of records as columns once + rows as arrays', () => {
    const out = compactToolResult({ total: 20, rows })
    const parsed = JSON.parse(out.content)
    expect(parsed.$format).toBe(COMPACT_FORMAT_NOTE)
    expect(parsed.total).toBe(20)
    expect(parsed.rows.$cols).toEqual(['id', 'name', 'status', 'vendor'])
    expect(parsed.rows.$rows[0]).toEqual([1, 'Request 1', 'closed', 5])
    expect(parsed.rows.$rows).toHaveLength(20)
  })

  it('keeps each link label once per column', () => {
    const parsed = JSON.parse(compactToolResult({ total: 20, rows }).content)
    expect(parsed.rows.$labels).toEqual({ vendor: { '5': 'Acme Supplies Incorporated' } })
    expect(compactToolResult({ total: 20, rows }).content.match(/Acme/g)).toHaveLength(1)
  })

  it('measures both sizes and is smaller than the readable JSON', () => {
    const out = compactToolResult({ total: 20, rows })
    const readable = JSON.stringify({ total: 20, rows })
    expect(out.before).toBe(Math.ceil(readable.length / 4))
    expect(out.after).toBeLessThan(out.before)
    expect(out.after).toBe(Math.ceil(out.content.length / 4))
  })

  it('leaves a result with no list of records exactly as before', () => {
    const r = { collection: 'workflows', fields: ['id', 'name'], count: 3 }
    const out = compactToolResult(r)
    expect(out.content).toBe(JSON.stringify(r))
    expect(out.before).toBe(out.after)
  })

  it('keeps the readable form when the table would not be smaller', () => {
    const r = { rows: [{ a: 1 }, { b: 2 }] }
    const out = compactToolResult(r)
    expect(out.content).toBe(JSON.stringify(r))
  })

  it('fills a column a row lacks with null and keeps mixed cells as they are', () => {
    const r = {
      rows: Array.from({ length: 20 }, (_, i) => ({
        id: i,
        owner: i === 2 ? 'free text' : { id: 9, label: 'Pat Lee' },
        ...(i === 3 ? {} : { note: 'a fairly long repeated note value here' })
      }))
    }
    const parsed = JSON.parse(compactToolResult(r).content)
    expect(parsed.rows.$rows[3][2]).toBeNull()
    // `owner` mixes a link and a string — not a link column, cells stay readable
    expect(parsed.rows.$labels).toBeUndefined()
    expect(parsed.rows.$rows[0][1]).toEqual({ id: 9, label: 'Pat Lee' })
  })

  it('compacts nested lists (queue summaries) and caps what is sent', () => {
    const r = { stats: { total: 50 }, oldest: rows, breached: rows }
    const out = compactToolResult(r, 500)
    expect(out.content.length).toBeLessThanOrEqual(500)
    const full = JSON.parse(compactToolResult(r).content)
    expect(full.oldest.$cols).toContain('vendor')
    expect(full.stats).toEqual({ total: 50 })
  })

  it('wraps a bare list', () => {
    const parsed = JSON.parse(compactToolResult(rows).content)
    expect(parsed.$format).toBe(COMPACT_FORMAT_NOTE)
    expect(parsed.$rows).toHaveLength(20)
  })
})
