import { describe, expect, it } from 'vitest'
import { findingFieldLabel, findingRecordName } from './ConformanceView'

// Army 11 O4-9: Form conformance showed "#372501" (a row id) and raw field keys.
describe('Form conformance names', () => {
  it('never shows the internal id for a record with no number', () => {
    expect(findingRecordName(null)).toBe('Record with no number')
    expect(findingRecordName('  ')).toBe('Record with no number')
    expect(findingRecordName('TP26-81259')).toBe('TP26-81259')
  })

  it('shows field labels, falling back to the name in words', () => {
    const labels = { project_sub_types: 'Project Sub Type' }
    expect(findingFieldLabel(labels, 'project_sub_types')).toBe('Project Sub Type')
    expect(findingFieldLabel(labels, 'workflow_lines')).toBe('Workflow Lines')
  })
})
