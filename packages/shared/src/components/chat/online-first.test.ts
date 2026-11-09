import { describe, expect, it } from 'vitest'
import { onlineFirstOrder } from './ChatPanel'

describe('onlineFirstOrder', () => {
  it('active first, then idle, then away; alphabetical inside each', () => {
    const people = ['Ann', 'Ben', 'Cat', 'Dan', 'Eve']
    const state: Record<string, { is_idle?: boolean; away?: boolean }> = {
      Ann: { is_idle: true },
      Ben: {},
      Cat: { away: true },
      Dan: { is_idle: true },
      Eve: {}
    }
    expect(onlineFirstOrder(people, (p) => state[p])).toEqual(['Ben', 'Eve', 'Ann', 'Dan', 'Cat'])
  })
})
