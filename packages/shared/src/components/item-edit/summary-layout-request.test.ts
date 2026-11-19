import { describe, expect, it } from 'vitest'
import {
  summaryLayoutEnabled,
  summaryLayoutParams,
  summaryLayoutQueryKey
} from './summary-layout-request'

describe('summaryLayoutQueryKey', () => {
  it('includes the form layout id', () => {
    expect(summaryLayoutQueryKey('wf', 7, null)).toEqual(['summary-layout', 'wf', 7])
    expect(summaryLayoutQueryKey('wf', 8, null)).not.toEqual(summaryLayoutQueryKey('wf', 7, null))
  })
  it('uses none without a form and appends the viewport', () => {
    expect(summaryLayoutQueryKey('wf', null, null)).toEqual(['summary-layout', 'wf', 'none'])
    expect(summaryLayoutQueryKey('wf', 7, 'phone')).toEqual(['summary-layout', 'wf', 7, 'phone'])
  })
})

describe('summaryLayoutParams', () => {
  it('carries for_layout and viewport', () => {
    expect(summaryLayoutParams(7, 'phone')).toEqual({ for_layout: '7', viewport: 'phone' })
    expect(summaryLayoutParams(7, null)).toEqual({ for_layout: '7' })
    expect(summaryLayoutParams(null, 'tablet')).toEqual({ viewport: 'tablet' })
  })
  it('is undefined with nothing to send', () => {
    expect(summaryLayoutParams(null, null)).toBeUndefined()
  })
})

describe('summaryLayoutEnabled', () => {
  it('waits for the form layout so the default never flashes first', () => {
    expect(summaryLayoutEnabled({ isNew: false, designOn: false, layoutResolved: false })).toBe(
      false
    )
    expect(summaryLayoutEnabled({ isNew: false, designOn: false, layoutResolved: true })).toBe(true)
  })
  it('is off for new records and design mode', () => {
    expect(summaryLayoutEnabled({ isNew: true, designOn: false, layoutResolved: true })).toBe(false)
    expect(summaryLayoutEnabled({ isNew: false, designOn: true, layoutResolved: true })).toBe(false)
  })
})
