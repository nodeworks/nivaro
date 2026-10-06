import { describe, expect, it, vi } from 'vitest'
import type { KeyUsageReport } from '../../../services/api-key-usage.js'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { monthWindow, previousMonth, retentionFor, routeFamily, usageToCsv } = await import(
  '../../../services/api-key-usage.js'
)
const { buildUsageStatementMail, monthLabel } = await import(
  '../../../services/api-key-usage-statements.js'
)

describe('monthWindow', () => {
  it('is the UTC month', () => {
    const w = monthWindow('2026-02')
    expect(w?.start.toISOString()).toBe('2026-02-01T00:00:00.000Z')
    expect(w?.end.toISOString()).toBe('2026-03-01T00:00:00.000Z')
    expect(monthWindow('2026-12')?.end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
  it('refuses malformed months', () => {
    expect(monthWindow('2026-13')).toBeNull()
    expect(monthWindow('26-01')).toBeNull()
    expect(monthWindow('')).toBeNull()
  })
  it('previousMonth crosses the year', () => {
    expect(previousMonth(new Date('2026-01-01T07:10:00Z'))).toBe('2025-12')
    expect(previousMonth(new Date('2026-10-01T07:10:00Z'))).toBe('2026-09')
  })
})

describe('routeFamily', () => {
  it('keeps the collection for item routes and drops ids', () => {
    expect(routeFamily('/api/items/workflows/12')).toBe('items/workflows')
    expect(routeFamily('/api/items/workflows?limit=5')).toBe('items/workflows')
    expect(routeFamily('/api/graphql')).toBe('graphql')
    expect(routeFamily('/api/inbound/mwf')).toBe('inbound/mwf')
    expect(routeFamily('/api/files/abc')).toBe('files')
    expect(routeFamily('/api-keys')).toBe('api-keys')
  })
})

describe('retentionFor', () => {
  const now = new Date('2026-10-06T12:00:00Z')
  it('marks a month older than the log as partial or gone', () => {
    const sept = monthWindow('2026-09')!
    const r = retentionFor(sept, new Date('2026-09-22T12:00:00Z'), now)
    expect(r.partial).toBe(true)
    expect(r.note).toContain('only calls from 2026-09-22')
    const aug = retentionFor(monthWindow('2026-08')!, new Date('2026-09-22T12:00:00Z'), now)
    expect(aug.note).toContain('nothing from this month is left')
  })
  it('the current month inside the window is whole', () => {
    const r = retentionFor(monthWindow('2026-10')!, new Date('2026-09-22T12:00:00Z'), now)
    expect(r.partial).toBe(false)
    expect(r.note).toBeNull()
  })
})

const report: KeyUsageReport = {
  key: { id: 7, name: 'Partner, "LinX"', prefix: 'nvk_abcd' },
  month: '2026-09',
  window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
  retention: { days: 14, oldest_log: null, partial: true, note: 'partial month' },
  totals: {
    calls: 100,
    errors: 10,
    rate_limited: 3,
    avg_ms: 42,
    error_rate: 0.1,
    refused: 2,
    reads_ok: 80,
    writes_ok: 10
  },
  by_day: [{ day: '2026-09-30', calls: 100, errors: 10, rate_limited: 3, avg_ms: 42 }],
  by_family: [{ family: 'items/workflows', calls: 100, errors: 10, rate_limited: 3, avg_ms: 42 }],
  graphql: [{ operation: 'GetWorkflows', kind: 'query', calls: 5, errors: 0 }],
  egress: { reads_ok: 80, note: '' }
}

describe('usageToCsv', () => {
  it('writes one row per section, every cell quoted', () => {
    const csv = usageToCsv(report).trim().split('\n')
    expect(csv[0]).toBe('"section","label","calls","errors","error_rate","rate_limited","avg_ms"')
    expect(csv[1]).toBe('"total","2026-09","100","10","0.1000","3","42"')
    expect(csv).toContain('"day","2026-09-30","100","10","0.1000","3","42"')
    expect(csv).toContain('"route_family","items/workflows","100","10","0.1000","3","42"')
    expect(csv).toContain('"graphql","query GetWorkflows","5","0","0.0000","",""')
    expect(csv.at(-1)).toBe('"note","partial month","","","","",""')
  })

  it('neutralises caller-supplied text that would run as a formula', () => {
    const hostile: KeyUsageReport = {
      ...report,
      by_family: [
        { family: '=HYPERLINK("http://evil","x")', calls: 1, errors: 0, rate_limited: 0, avg_ms: 1 }
      ],
      graphql: [
        { operation: '+cmd|"/c calc"!A1', kind: null, calls: 1, errors: 0 },
        { operation: '@SUM(A1)', kind: null, calls: 1, errors: 0 },
        { operation: '-2+3', kind: null, calls: 1, errors: 0 }
      ]
    }
    const csv = usageToCsv(hostile)
    expect(csv).toContain('"route_family","\'=HYPERLINK(""http://evil"",""x"")","1"')
    expect(csv).toContain('"graphql","\'+cmd|""/c calc""!A1","1"')
    expect(csv).toContain('"graphql","\'@SUM(A1)","1"')
    expect(csv).toContain('"graphql","\'-2+3","1"')
    for (const line of csv.trim().split('\n'))
      for (const cell of line.match(/"(?:[^"]|"")*"/g) ?? [])
        expect(/^"[=+\-@\t\r]/.test(cell)).toBe(false)
  })
})

describe('buildUsageStatementMail', () => {
  it('names the key, month and the figures', () => {
    expect(monthLabel('2026-09')).toBe('September 2026')
    const m = buildUsageStatementMail(report)
    expect(m.template).toBe('notice')
    expect(m.subject).toBe('API usage for Partner, "LinX" — September 2026')
    const facts = m.data.facts as Array<{ label: string; value: string | null }>
    expect(facts.find((f) => f.label === 'Error rate')?.value).toBe('10.0% (10 calls)')
    expect(facts.find((f) => f.label === 'Rate-limited')?.value).toBe('3')
    expect(m.data.footnote).toBe('partial month')
  })
})
