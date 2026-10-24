import { describe, expect, it, vi } from 'vitest'
import { logRouteError } from '../../../services/error-log-level.js'

describe('logRouteError', () => {
  const logger = () => ({ error: vi.fn(), info: vi.fn() })

  it('logs a 5xx as an error with the error itself (stack included)', () => {
    const log = logger()
    const err = new Error('pool exhausted')
    logRouteError(log, err, 503, '/api/items/x')
    expect(log.error).toHaveBeenCalledWith(err)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('logs a refusal (401/403/404) as one info line without the stack', () => {
    const log = logger()
    const err = Object.assign(new Error('Unauthorized'), { code: 'NOT_SIGNED_IN' })
    logRouteError(log, err, 401, '/api/events/stream')
    expect(log.error).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      { statusCode: 401, code: 'NOT_SIGNED_IN', url: '/api/events/stream' },
      'Unauthorized'
    )
    expect(JSON.stringify(log.info.mock.calls[0][0])).not.toContain('stack')
  })
})
