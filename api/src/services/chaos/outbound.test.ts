import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { modelFallbacksSinceBoot, withModelFallback } from '../ai-client.js'
import { AiUnavailableError, isProviderFailure } from '../ai-quality.js'
import { _resetCatalogForTests } from './catalog.js'
import {
  aiCallChaos,
  graphChaos,
  idpUnreachable,
  oidcChaos,
  withAiChaos
} from './outbound-points.js'
import { _resetRegistryForTests, armFault, stopAll } from './registry.js'

beforeAll(async () => {
  _resetCatalogForTests()
  await import('./faults/outbound.js')
})
afterEach(async () => {
  vi.useRealTimers()
  await stopAll('test')
  await _resetRegistryForTests()
})

/** A stand-in AI client: answers with the model it was built for. */
function fakeAi(model: string) {
  const promise = Promise.resolve({ model, content: [{ type: 'text', text: 'ok' }] })
  return { promise, client: { messages: { create: () => promise } } }
}

describe('AI gateway faults (#2834)', () => {
  it('unarmed: the client is called directly, its own promise returned', async () => {
    const { client, promise } = fakeAi('m1')
    const wrapped = withAiChaos(client, 'm1', true)
    expect(wrapped.messages.create()).toBe(promise)
  })

  it('5xx: the gateway error shape, which the provider-failure guard treats as an outage', async () => {
    await armFault({ fault_key: 'ai_gateway_fault', params: { mode: 'error_5xx', status: 502 } })
    const wrapped = withAiChaos(fakeAi('m1').client, 'm1', true)
    const err = await (wrapped.messages.create() as Promise<unknown>).catch((e) => e)
    expect(err).toMatchObject({ message: 'AI gateway 502: Service Unavailable', status: 502 })
    expect(isProviderFailure(err)).toBe(true)
    expect(new AiUnavailableError('x')).toMatchObject({ statusCode: 503, code: 'AI_UNAVAILABLE' })
  })

  it('timeout: waits, then the SDK timeout (a provider failure)', async () => {
    vi.useFakeTimers()
    await armFault({ fault_key: 'ai_gateway_fault', params: { mode: 'timeout', delay_ms: 1000 } })
    const p = aiCallChaos('m1', true).catch((e) => e)
    await vi.advanceTimersByTimeAsync(1000)
    const err = await p
    expect(err.message).toBe('Request timed out.')
    expect(isProviderFailure(err)).toBe(true)
  })

  it('model refused: withModelFallback moves to the next model and counts the fallback', async () => {
    await armFault({ fault_key: 'ai_gateway_fault', params: { mode: 'model_refused' } })
    const before = modelFallbacksSinceBoot()
    const chain = ['pinned-model', 'chat-model']
    const client = withModelFallback(
      chain,
      (m) => withAiChaos(fakeAi(m).client, m, m === chain[0]) as never
    )
    const res = (await client.messages.create({
      model: 'x',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }]
    })) as unknown as { model: string }
    expect(res.model).toBe('chat-model')
    expect(modelFallbacksSinceBoot()).toBe(before + 1)
  })

  it('slow: the call waits and then answers', async () => {
    vi.useFakeTimers()
    await armFault({ fault_key: 'ai_gateway_fault', params: { mode: 'slow', delay_ms: 500 } })
    let done = false
    const p = aiCallChaos('m1', true).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(done).toBe(true)
  })

  it('ends with Stop all', async () => {
    await armFault({ fault_key: 'ai_gateway_fault', params: { mode: 'error_5xx' } })
    await expect(aiCallChaos('m', true)).rejects.toThrow(/AI gateway 503/)
    await stopAll('test')
    await expect(aiCallChaos('m', true)).resolves.toBeUndefined()
  })
})

describe('sign-in provider and Graph faults (#2834)', () => {
  it('unarmed: nothing happens', async () => {
    await expect(oidcChaos('discovery')).resolves.toBeUndefined()
    await expect(graphChaos()).resolves.toBeUndefined()
  })

  it('IdP down: an unreachable fetch at the chosen step only', async () => {
    await armFault({ fault_key: 'oidc_down', params: { mode: 'down', step: 'token' } })
    await expect(oidcChaos('discovery')).resolves.toBeUndefined()
    const err = await oidcChaos('token').catch((e) => e)
    expect(err.message).toBe('fetch failed')
    expect(idpUnreachable(err)).toBe(true)
    // A refused sign-in (bad state, bad code) is not "unreachable".
    expect(idpUnreachable(new Error('unexpected JWT claim value encountered'))).toBe(false)
  })

  it('Graph slow past the caller timeout fails as the aborted fetch would', async () => {
    vi.useFakeTimers()
    await armFault({ fault_key: 'graph_down', params: { mode: 'slow', delay_ms: 9000 } })
    const p = graphChaos(5000).catch((e) => e)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await p).name).toBe('TimeoutError')
  })

  it('Graph down: fetch failed; the window end clears it', async () => {
    vi.useFakeTimers()
    await armFault({ fault_key: 'graph_down', params: { mode: 'down' }, seconds: 5 })
    await expect(graphChaos()).rejects.toThrow('fetch failed')
    await vi.advanceTimersByTimeAsync(5001)
    await expect(graphChaos()).resolves.toBeUndefined()
  })
})
