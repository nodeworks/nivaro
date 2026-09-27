import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(),
  requireAuth: vi.fn(),
  authenticate: vi.fn()
}))

import { parseRefusal } from '../../../routes/api-analytics.js'

describe('parseRefusal', () => {
  it('reads the code and sentence of a REST refusal', () => {
    const body = JSON.stringify({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'This API key expired on 2026-09-01',
      code: 'API_KEY_EXPIRED'
    })
    expect(parseRefusal(body, 401)).toEqual({
      code: 'API_KEY_EXPIRED',
      message: 'This API key expired on 2026-09-01'
    })
  })

  it('reads a GraphQL refusal from the first error', () => {
    const body = JSON.stringify({
      errors: [{ message: 'Invalid token', extensions: { code: 'TOKEN_INVALID' } }]
    })
    expect(parseRefusal(body, 401)).toEqual({ code: 'TOKEN_INVALID', message: 'Invalid token' })
  })

  it('still finds the code in a body cut short by the log', () => {
    const cut = '{"statusCode":429,"code":"API_KEY_RATE_LIMITED","message":"Rate limit of 5 per min'
    expect(parseRefusal(cut, 429).code).toBe('API_KEY_RATE_LIMITED')
  })

  it('names the refusal by status when the body carries no code', () => {
    expect(parseRefusal(null, 403)).toEqual({ code: 'FORBIDDEN', message: null })
    expect(parseRefusal('', 429).code).toBe('RATE_LIMITED')
    expect(parseRefusal('{"error":"Forbidden"}', 403)).toEqual({
      code: 'FORBIDDEN',
      message: 'Forbidden'
    })
    expect(parseRefusal('not json', 401).code).toBe('UNAUTHORIZED')
  })
})
