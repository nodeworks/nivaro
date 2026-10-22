import { describe, expect, it } from 'vitest'
import { rejectionLogger } from './process-guards.js'

describe('rejectionLogger', () => {
  it('logs a rejection once a minute per message and counts the rest', () => {
    const lines: unknown[] = []
    let t = 0
    const onRejection = rejectionLogger({ error: (obj) => lines.push(obj) }, () => t)
    const boom = new Error('Reached the max retries per request limit (which is 3)')
    boom.name = 'MaxRetriesPerRequestError'
    expect(onRejection(boom)).toBe(true)
    t = 1_000
    expect(onRejection(boom)).toBe(false)
    expect(onRejection(boom)).toBe(false)
    expect(onRejection('a plain string')).toBe(true)
    t = 61_000
    expect(onRejection(boom)).toBe(true)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatchObject({ suppressed_since_last: 0 })
    expect(lines[1]).toMatchObject({ suppressed_since_last: 2 })
  })
})
