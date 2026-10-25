import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { userErrorMessage } from './safe-error'

const WHY =
  'Only the owner of Engineering Review or the person who created this record can make this move.'

/** An SDK-shaped request error: the parsed body rides on `response`. */
function sdkError(status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status ${status}`), {
    status,
    response: { status, ...body }
  })
}

describe('transition refusal toast text', () => {
  it('a coded refusal from the global handler shows the reason, not "Forbidden"', () => {
    const err = sdkError(403, {
      statusCode: 403,
      error: 'Forbidden',
      message: WHY,
      code: 'TRANSITION_OWNER_REQUIRED'
    })
    expect(userErrorMessage(err, 'Failed to execute transition')).toBe(WHY)
  })

  it('the transition route’s own {error: reason} body still shows the reason', () => {
    const err = sdkError(403, { error: WHY, code: 'TRANSITION_OWNER_REQUIRED' })
    expect(userErrorMessage(err, 'Failed to execute transition')).toBe(WHY)
  })

  it('axios-shaped hosts read the same body from response.data', () => {
    const err = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: { error: 'Forbidden', message: WHY, code: 'TRANSITION_OWNER_REQUIRED' }
      }
    })
    expect(userErrorMessage(err, 'Failed to execute transition')).toBe(WHY)
  })

  it('both PipelinePanel transition toasts go through userErrorMessage', () => {
    const src = readFileSync(
      new URL('../components/panels/PipelinePanel.tsx', import.meta.url),
      'utf8'
    )
    expect(
      src.match(/toast\.error\(userErrorMessage\(err, 'Failed to execute transition'\)/g)
    ).toHaveLength(2)
    expect(src).not.toMatch(/resp\?\.error \?\? resp\?\.data\?\.error/)
  })
})
