import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { childCopySkip, copyRulesQuery, fetchCopySkip, headerCopySkip } from './copy-rules'

const skip = {
  request_state: 'pipeline-state',
  order_number: 'do-not-duplicate',
  sort: 'hidden',
  lines: 'list',
  shipped_qty: 'read-only',
  requisition_amount: 'rollup'
}

describe('copy rule sets', () => {
  it('the header leaves out every field the server names but stored rollups', () => {
    const header = headerCopySkip(skip)
    expect(header.has('request_state')).toBe(true)
    expect(header.has('order_number')).toBe(true)
    expect(header.has('sort')).toBe(true)
    // A rollup is judged per record by the form (a typed PUB amount still copies).
    expect(header.has('requisition_amount')).toBe(false)
  })

  it('a copied line keeps its hidden columns', () => {
    const child = childCopySkip(skip)
    expect(child.has('sort')).toBe(false)
    expect(child.has('lines')).toBe(false)
    expect(child.has('request_state')).toBe(true)
    expect(child.has('shipped_qty')).toBe(true)
  })

  it('no rule (unreadable) leaves nothing out', () => {
    expect(headerCopySkip(null).size).toBe(0)
    expect(childCopySkip(undefined).size).toBe(0)
  })
})

describe('fetchCopySkip', () => {
  it('reads GET /copy-rules/:collection once and caches it', async () => {
    const request = vi.fn(async () => ({ data: { skip } })) as never
    const qc = new QueryClient()
    expect(await fetchCopySkip({ request }, qc, 'inventory_request')).toEqual(skip)
    expect(await fetchCopySkip({ request }, qc, 'inventory_request')).toEqual(skip)
    expect(request).toHaveBeenCalledTimes(1)
    expect(copyRulesQuery({ request }, 'x').queryKey).toEqual(['copy-rules', 'x'])
  })

  it('a refused read answers null (callers keep their own rules)', async () => {
    const request = vi.fn(async () => {
      throw new Error('403')
    }) as never
    expect(await fetchCopySkip({ request }, new QueryClient(), 'x')).toBeNull()
  })
})
