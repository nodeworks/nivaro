import { describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ api: { post: vi.fn(async () => ({})) } }))

import { type ReportState, takeGlobalError } from './global-error-report'

const fresh = (): ReportState => ({ seen: new Set(), sent: 0 })

describe('takeGlobalError', () => {
  it('takes a code error once per fingerprint', () => {
    const s = fresh()
    const err = new TypeError("Cannot read properties of null (reading 'id')")
    expect(takeGlobalError(err, s)).toBe(true)
    expect(takeGlobalError(err, s)).toBe(false)
  })

  it('leaves the network, server answers and plain values alone', () => {
    const s = fresh()
    expect(takeGlobalError(new TypeError('Failed to fetch'), s)).toBe(false)
    expect(takeGlobalError(Object.assign(new Error('Forbidden'), { status: 403 }), s)).toBe(false)
    expect(takeGlobalError('boom', s)).toBe(false)
    expect(takeGlobalError(null, s)).toBe(false)
  })

  it('ignores a browser extension failing in its own script', () => {
    const err = new TypeError('x is undefined')
    err.stack = 'TypeError: x is undefined\n    at chrome-extension://abc/content.js:1:1'
    expect(takeGlobalError(err, fresh())).toBe(false)
  })

  it('stops after ten reports in one page load', () => {
    const s = fresh()
    let taken = 0
    for (let i = 0; i < 15; i++) if (takeGlobalError(new RangeError(`bad ${i}`), s)) taken++
    expect(taken).toBe(10)
  })
})
