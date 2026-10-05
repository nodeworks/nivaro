import { describe, expect, it } from 'vitest'
import {
  effectiveParams,
  maskParams,
  paramSetHash
} from '../../../../services/db-tuning/param-sets.js'

describe('param sets', () => {
  it('hash is key-order stable', () => {
    expect(paramSetHash({ a: 1, b: 'x' })).toBe(paramSetHash({ b: 'x', a: 1 }))
  })
  it('masks credential-looking keys and keeps the rest', () => {
    expect(maskParams({ Zone: 'Zone 1', api_token: 'abc' })).toEqual({
      Zone: 'Zone 1',
      api_token: '••••••'
    })
  })
  it('effectiveParams drops what the call did not bind', () => {
    const raw = { A: 1, B: '', C: null, D: undefined }
    expect(effectiveParams(raw)).toEqual({ A: 1 })
    expect(paramSetHash(effectiveParams(raw))).toBe(paramSetHash({ A: 1 }))
  })
  it('hash ignores masking so a masked and unmasked set do not double', () => {
    expect(paramSetHash({ api_token: 'abc' })).toBe(paramSetHash(maskParams({ api_token: 'abc' })))
  })
})
