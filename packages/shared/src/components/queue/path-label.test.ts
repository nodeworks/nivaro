import { describe, expect, it } from 'vitest'
import { pathHeader } from './path-label'

// army 7 N7 — Peek labelled fields by their raw paths.
describe('pathHeader', () => {
  it('names a relation by itself when the leaf is its display column', () => {
    expect(pathHeader('project_type.name')).toBe('Project Type')
    expect(pathHeader('divisions.name')).toBe('Divisions')
    expect(pathHeader('funding_years.id')).toBe('Funding Years')
    expect(pathHeader('workflow_lines.id')).toBe('Workflow Lines')
    expect(pathHeader('workflow_type.type')).toBe('Workflow Type')
    expect(pathHeader('billing_location.name')).toBe('Billing Location')
  })
  it('drops a repeated relation name', () => {
    expect(pathHeader('project.project_id')).toBe('Project ID')
  })
  it('keeps the hop otherwise, and plain columns read as words', () => {
    expect(pathHeader('workflow_lines.requisition_id')).toBe('Workflow Lines → Requisition ID')
    expect(pathHeader('amount_total')).toBe('Amount Total')
    expect(pathHeader('vendor_id')).toBe('Vendor ID')
  })
})
