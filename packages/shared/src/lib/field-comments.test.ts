import { describe, expect, it } from 'vitest'
import {
  fieldDeepLinkQuery,
  fieldThread,
  openFieldCommentCounts,
  parseFieldDeepLink
} from './field-comments'

describe('parseFieldDeepLink (#3232)', () => {
  it('reads ?field= from a search string', () => {
    expect(parseFieldDeepLink('?field=amount')).toBe('amount')
    expect(parseFieldDeepLink('tab=lines&field=po_number')).toBe('po_number')
    expect(parseFieldDeepLink('?focus=x')).toBeNull()
    expect(parseFieldDeepLink('')).toBeNull()
    expect(parseFieldDeepLink(null)).toBeNull()
  })

  it('refuses anything that is not a plain field name', () => {
    expect(parseFieldDeepLink('?field=a.b')).toBeNull()
    expect(parseFieldDeepLink('?field=__pipeline__')).toBeNull()
    expect(parseFieldDeepLink('?field=%22%5D%3Cimg%3E')).toBeNull()
    expect(parseFieldDeepLink('?field=1abc')).toBeNull()
  })

  it('round-trips with the link builder', () => {
    expect(parseFieldDeepLink(fieldDeepLinkQuery('vendor_id'))).toBe('vendor_id')
  })
})

describe('field comment counts and threads', () => {
  const comments = [
    { id: '1', field: 'amount', created_at: '2026-10-02T00:00:00Z' },
    { id: '2', field: 'amount', created_at: '2026-10-01T00:00:00Z' },
    { id: '3', field: 'amount', resolved_at: '2026-10-03T00:00:00Z', created_at: '2026-09-01' },
    { id: '4', field: 'amount', deleted: true, created_at: '2026-10-04' },
    { id: '5', field: null, created_at: '2026-10-05' },
    { id: '6', field: 'type', created_at: '2026-10-06' }
  ]

  it('counts open comments per field only', () => {
    expect(openFieldCommentCounts(comments)).toEqual({ amount: 2, type: 1 })
  })

  it('threads one field: open oldest first, resolved apart, deleted gone', () => {
    const t = fieldThread(comments, 'amount')
    expect(t.open.map((c) => c.id)).toEqual(['2', '1'])
    expect(t.resolved.map((c) => c.id)).toEqual(['3'])
  })
})
