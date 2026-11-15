import { describe, expect, it, vi } from 'vitest'

const trace = vi.hoisted(() => ({ req: null as object | null }))
vi.mock('../../../services/request-trace.js', () => ({
  currentTraceRequestObject: () => trace.req
}))

import { notePartialRead, partialReadsOf } from '../../../services/partial-reads.js'

describe('partial read notes', () => {
  it('are kept per request, names only, once each', () => {
    const a = {}
    const b = {}
    trace.req = a
    notePartialRead('$approval_changed')
    notePartialRead('$approval_changed')
    expect(partialReadsOf(a)).toEqual(['$approval_changed'])
    expect(partialReadsOf(b)).toEqual([])
  })

  it('go nowhere outside a request', () => {
    trace.req = null
    expect(() => notePartialRead('$approval_changed')).not.toThrow()
    expect(partialReadsOf(null)).toEqual([])
  })
})
