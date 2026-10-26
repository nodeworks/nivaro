import { describe, expect, it } from 'vitest'
import { describeError, pushFailure } from './push-failure'

const domErr = (name: string, message: string) => Object.assign(new Error(message), { name })

describe('pushFailure', () => {
  it('tells a blocked permission apart from a dismissed prompt', () => {
    expect(pushFailure('permission', null, { permission: 'denied' }).text).toMatch(/blocked/)
    expect(pushFailure('permission', null, { permission: 'default' }).text).toMatch(/Allow/)
  })

  it('names the push-service refusals browsers raise on subscribe', () => {
    const abort = pushFailure(
      'subscribe',
      domErr('AbortError', 'Registration failed - push service error')
    )
    expect(abort.text).toMatch(/push service/)
    expect(abort.detail).toBe('AbortError: Registration failed - push service error')
    expect(pushFailure('subscribe', domErr('NotAllowedError', 'x')).text).toMatch(/refused/)
    // Chrome Incognito: AbortError, but the message says what it is
    const incognito = domErr('AbortError', 'Registration failed - permission denied')
    expect(pushFailure('subscribe', incognito).text).toMatch(/Incognito/)
  })

  it('blames the server, not the browser, when the push key cannot be read', () => {
    const e = Object.assign(new Error('Service Unavailable'), { status: 503 })
    const f = pushFailure('key', e)
    expect(f.text).toMatch(/administrator/)
    expect(f.detail).toBe('HTTP 503: Service Unavailable')
    expect(pushFailure('key', Object.assign(new Error('no'), { status: 401 })).text).toMatch(
      /Sign in/
    )
  })

  it('has a specific sentence for every stage', () => {
    const stages = ['unsupported', 'insecure', 'register', 'ready', 'save'] as const
    const texts = stages.map((s) => pushFailure(s).text)
    expect(new Set(texts).size).toBe(stages.length)
    for (const t of texts) expect(t).not.toBe('Could not turn on browser notifications.')
  })
})

describe('describeError', () => {
  it('reads plain strings and empty values', () => {
    expect(describeError('boom')).toBe('boom')
    expect(describeError(undefined)).toBe('')
  })
})
