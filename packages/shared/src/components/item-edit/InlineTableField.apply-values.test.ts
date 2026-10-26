import { describe, expect, it } from 'vitest'
import { applyValueColumns } from './InlineTableField'
import type { CMSField } from './types'

const col = (c: Partial<CMSField>) =>
  ({ type: 'string', interface: 'input', group_key: '__apply_values__', ...c }) as CMSField

describe('lines grid "apply values…" columns', () => {
  it('leaves out a read-only column (EFP REQ ID) so a form of only those never shows', () => {
    expect(applyValueColumns([col({ field: 'requisition_id', readonly: true })])).toEqual([])
  })

  it('keeps writable configured columns and drops derived ones', () => {
    const got = applyValueColumns([
      col({ field: 'requisition_id', readonly: true }),
      col({ field: 'task' }),
      col({ field: 'total', computed_type: 'write', computed_formula: 'qty*price' } as never),
      col({ field: 'calc', interface: 'formula-column' }),
      col({ field: 'quantity', group_key: 'main' })
    ])
    expect(got.map((c) => c.field)).toEqual(['task'])
  })
})
