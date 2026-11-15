import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetAiAllowanceChecks,
  AiAllowanceError,
  checkAiAllowance,
  registerAiAllowanceCheck
} from './ai-allowance.js'

afterEach(() => {
  _resetAiAllowanceChecks()
  vi.useRealTimers()
})

describe('AI allowance checks', () => {
  it('nothing registered (self-hosted) never limits', async () => {
    await expect(checkAiAllowance()).resolves.toBeUndefined()
  })

  it('a refusal stops the call with 429 AI_ALLOWANCE_USED and its own words', async () => {
    registerAiAllowanceCheck(() => ({
      message: "Your plan's AI allowance for this month is used up.",
      action_url: '/account'
    }))
    const err = await checkAiAllowance().catch((e) => e)
    expect(err).toBeInstanceOf(AiAllowanceError)
    expect(err.statusCode).toBe(429)
    expect(err.code).toBe('AI_ALLOWANCE_USED')
    expect(err.message).toContain('allowance')
    expect(err.action_url).toBe('/account')
  })

  it('null lets the call through', async () => {
    registerAiAllowanceCheck(async () => null)
    await expect(checkAiAllowance()).resolves.toBeUndefined()
  })

  it('a check that throws fails open', async () => {
    registerAiAllowanceCheck(() => {
      throw new Error('meta db down')
    })
    await expect(checkAiAllowance()).resolves.toBeUndefined()
  })

  it('a check that hangs fails open after the time limit', async () => {
    vi.useFakeTimers()
    registerAiAllowanceCheck(() => new Promise(() => {}))
    const p = checkAiAllowance()
    await vi.advanceTimersByTimeAsync(1600)
    await expect(p).resolves.toBeUndefined()
  })

  it('the same owner registering again replaces its check', async () => {
    registerAiAllowanceCheck(() => ({ message: 'old' }), 'cloud-quota')
    registerAiAllowanceCheck(() => null, 'cloud-quota')
    await expect(checkAiAllowance()).resolves.toBeUndefined()
  })
})
