import { describe, expect, it } from 'vitest'
import {
  type CopyRuleContext,
  childRowSkip,
  copyableValues,
  copySkipMap,
  copySkipReason,
  parseNeverCopy
} from '../../../services/copy-rules.js'

const ctx = (over: Partial<CopyRuleContext> = {}): CopyRuleContext => ({
  stateFields: new Set(['workflow_state']),
  autoIds: new Set(['workflow_id']),
  rollups: new Set(['line_total']),
  neverCopy: new Set(['po_number']),
  ...over
})

describe('copySkipReason — the one "never copied" rule', () => {
  it('copies a plain field people type', () => {
    expect(copySkipReason({ field: 'description' }, ctx())).toBeNull()
  })

  it('never copies the pipeline state field, even when it is editable and visible', () => {
    expect(copySkipReason({ field: 'workflow_state' }, ctx())).toBe('pipeline-state')
  })

  it('never copies audit stamps by name or by special', () => {
    expect(copySkipReason({ field: 'id' }, ctx())).toBe('audit')
    expect(copySkipReason({ field: 'last_state_change' }, ctx())).toBe('audit')
    expect(copySkipReason({ field: 'made_by', special: ['user-created'] }, ctx())).toBe('audit')
    expect(copySkipReason({ field: 'stamp', special: 'date-updated' }, ctx())).toBe('audit')
  })

  it('never copies generated, calculated and rollup fields', () => {
    expect(copySkipReason({ field: 'workflow_id' }, ctx())).toBe('generated')
    expect(copySkipReason({ field: 'ref', options: '{"auto_id":{"pattern":"X"}}' }, ctx())).toBe(
      'generated'
    )
    expect(copySkipReason({ field: 'f', computed_type: 'write' }, ctx())).toBe('calculated')
    expect(copySkipReason({ field: 'amount', computed_type: 'rollup' }, ctx())).toBe('rollup')
    expect(copySkipReason({ field: 'line_total' }, ctx())).toBe('rollup')
  })

  it('never copies read-only, hidden or "do not duplicate" fields (partner state)', () => {
    expect(copySkipReason({ field: 'partner_status', readonly: true }, ctx())).toBe('read-only')
    expect(copySkipReason({ field: 'trigger_push', hidden: true }, ctx())).toBe('hidden')
    expect(copySkipReason({ field: 'order_number', options: { no_duplicate: true } }, ctx())).toBe(
      'do-not-duplicate'
    )
  })

  it("a rollup filter's yes/no switch stays behind; a type it filters on copies", () => {
    const c = ctx({ rollupFilters: new Set(['follows_cars', 'workflow_type']) })
    expect(copySkipReason({ field: 'follows_cars', type: 'boolean' }, c)).toBe('rollup-switch')
    expect(copySkipReason({ field: 'workflow_type', type: 'integer' }, c)).toBeNull()
  })

  it("honours the collection's own never-copy list", () => {
    expect(copySkipReason({ field: 'po_number' }, ctx())).toBe('never-copy')
  })

  it('never copies link lists', () => {
    expect(copySkipReason({ field: 'lines', special: ['o2m'] }, ctx())).toBe('list')
    expect(copySkipReason({ field: 'zones', type: 'alias' }, ctx())).toBe('list')
  })
})

describe('copySkipMap / copyableValues', () => {
  it('keeps only what copies, including state fields with no metadata row', () => {
    const skip = copySkipMap(
      [{ field: 'name' }, { field: 'order_number', options: { no_duplicate: true } }],
      ctx()
    )
    const row = {
      id: 9,
      name: 'A',
      order_number: 'SO-1',
      workflow_state: 4,
      workflow_id: 'W-1',
      po_number: 'PO-1',
      'project.name': 'x',
      $state: 'review'
    }
    expect(copyableValues(row, skip)).toEqual({ name: 'A' })
  })

  it('child rows keep hidden columns but drop the rest of the rule', () => {
    const skip = copySkipMap(
      [
        { field: 'sort', hidden: true },
        { field: 'shipped_qty', readonly: true }
      ],
      ctx({ stateFields: new Set(), neverCopy: new Set() })
    )
    const child = childRowSkip(skip)
    expect(child).toContain('shipped_qty')
    expect(child).not.toContain('sort')
  })
})

describe('parseNeverCopy', () => {
  it('reads browser_config.never_copy from text or object, dropping junk', () => {
    expect(parseNeverCopy('{"never_copy":["po_number","bad name",""]}')).toEqual(['po_number'])
    expect(parseNeverCopy({ never_copy: ['a', 'a', 'b'] })).toEqual(['a', 'b'])
    expect(parseNeverCopy(null)).toEqual([])
    expect(parseNeverCopy('not json')).toEqual([])
  })
})
