import { describe, expect, it } from 'vitest'
import { fmtCell, NO_WORKFLOW_NUMBER } from './ReportView'

// Army 8 N-B4: the active-timeline proc keeps unnumbered workflows as
// 'undefined-<id>' so they count; a report table cell says what that is.
describe('fmtCell', () => {
  it('reads a made-up workflow id as "No workflow number"', () => {
    expect(fmtCell('undefined-360291')).toBe(NO_WORKFLOW_NUMBER)
    expect(fmtCell('CR26-81410')).toBe('CR26-81410')
    expect(fmtCell(null)).toBe('—')
  })
  it('keeps the formats', () => {
    expect(fmtCell(1234.5, 'currency')).toBe('$1,235')
    expect(fmtCell(12, 'integer')).toBe('12')
    expect(fmtCell(3.25, 'days')).toBe('3.3d')
  })
})
