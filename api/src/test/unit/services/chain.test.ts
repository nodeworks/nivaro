import { describe, expect, it } from 'vitest'
import { currentChain, newChainId, startChain, withChainStep } from '../../../services/chain.js'

describe('chain context', () => {
  it('is null outside a chain and withChainStep passes through', () => {
    expect(currentChain()).toBeNull()
    expect(withChainStep('history:1', () => 5)).toBe(5)
    expect(currentChain()).toBeNull()
  })

  it('startChain sets the root parent from the id', () => {
    const seen = startChain(
      (id) => `request:${id}`,
      () => currentChain()
    )
    expect(seen?.chain_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(seen?.parent).toBe(`request:${seen?.chain_id}`)
  })

  it('startChain accepts a fixed id and a string root', () => {
    const id = newChainId()
    const seen = startChain('cron:nightly', () => currentChain(), id)
    expect(seen).toEqual({ chain_id: id, parent: 'cron:nightly' })
  })

  it('withChainStep nests the parent and restores it', () => {
    startChain('cron:x', () => {
      withChainStep('history:7', () => {
        expect(currentChain()?.parent).toBe('history:7')
      })
      expect(currentChain()?.parent).toBe('cron:x')
    })
  })

  it('parallel withChainStep scopes do not leak', async () => {
    const out = await startChain('cron:x', () =>
      Promise.all(
        ['history:1', 'history:2'].map((k) =>
          withChainStep(k, async () => {
            await new Promise((r) => setTimeout(r, k.endsWith('1') ? 20 : 5))
            return currentChain()?.parent
          })
        )
      )
    )
    expect(out).toEqual(['history:1', 'history:2'])
  })

  it('timers started inside a chain inherit it', async () => {
    const seen = await startChain(
      'cron:x',
      () =>
        new Promise<string | undefined>((resolve) => {
          setTimeout(() => resolve(currentChain()?.parent ?? undefined), 5)
        })
    )
    expect(seen).toBe('cron:x')
  })
})
