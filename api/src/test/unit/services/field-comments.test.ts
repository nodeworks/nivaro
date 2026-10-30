import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: Object.assign(vi.fn(), { schema: {} }) }))

import {
  cleanCommentField,
  fieldCommentQuery,
  plainFieldLabel
} from '../../../services/field-comments.js'

describe('field comments (#3232)', () => {
  it('takes a plain field name, nothing else', () => {
    expect(cleanCommentField(undefined)).toBeNull()
    expect(cleanCommentField('')).toBeNull()
    expect(cleanCommentField(' amount ')).toBe('amount')
    expect(cleanCommentField('vendor.name')).toBe('invalid')
    expect(cleanCommentField('__pipeline__')).toBe('invalid')
    expect(cleanCommentField('1abc')).toBe('invalid')
    expect(cleanCommentField(42)).toBe('invalid')
  })

  it('builds the link the client reads (lib/field-comments.ts parseFieldDeepLink)', () => {
    expect(fieldCommentQuery('po_number')).toBe('field=po_number')
  })

  it('names the field by the label the writer saw, else its key in words', () => {
    expect(plainFieldLabel('order_amount', '  Order   amount ')).toBe('Order amount')
    expect(plainFieldLabel('order_amount')).toBe('Order Amount')
    expect(plainFieldLabel('x', 'y'.repeat(200))).toHaveLength(120)
  })
})
