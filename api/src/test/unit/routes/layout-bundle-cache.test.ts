import { beforeEach, describe, expect, it, vi } from 'vitest'

// /active + /summary bundle cache (2026-10-27): kept per layout + configuration epoch,
// copies out, dropped on a configuration write, read through without a known epoch.

const epoch = vi.hoisted(() => ({
  now: 7 as number | null,
  writeListeners: [] as Array<() => void>
}))
vi.mock('../../../db/config-epoch.js', async (orig) => ({
  ...(await orig<object>()),
  configEpochNow: () => epoch.now,
  onConfigWrite: (fn: () => void) => {
    epoch.writeListeners.push(fn)
    return () => {}
  }
}))

import { cachedLayoutBundle, layoutBundleStats } from '../../../routes/collection-layouts.js'

describe('cachedLayoutBundle', () => {
  beforeEach(() => {
    epoch.now = 7
    delete process.env.LAYOUT_BUNDLE_CACHE
    for (const fn of epoch.writeListeners) fn()
  })

  it('one load per layout and epoch; callers get copies', async () => {
    const load = vi.fn(async () => ({ groups: [{ key: 'a' }] }))
    const one = await cachedLayoutBundle('t1', 1, load)
    one.groups[0].key = 'mutated'
    const two = await cachedLayoutBundle('t1', 1, load)
    expect(load).toHaveBeenCalledTimes(1)
    expect(two.groups[0].key).toBe('a')
    expect(layoutBundleStats().entries).toBeGreaterThan(0)
  })

  it('a new epoch or a configuration write loads again', async () => {
    const load = vi.fn(async () => ({ n: 1 }))
    await cachedLayoutBundle('t2', 1, load)
    epoch.now = 8
    await cachedLayoutBundle('t2', 1, load)
    expect(load).toHaveBeenCalledTimes(2)
    for (const fn of epoch.writeListeners) fn()
    await cachedLayoutBundle('t2', 1, load)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('no known epoch, or switched off: straight through', async () => {
    const load = vi.fn(async () => ({ n: 1 }))
    epoch.now = null
    await cachedLayoutBundle('t3', 1, load)
    await cachedLayoutBundle('t3', 1, load)
    expect(load).toHaveBeenCalledTimes(2)
    epoch.now = 9
    process.env.LAYOUT_BUNDLE_CACHE = 'off'
    await cachedLayoutBundle('t3', 1, load)
    await cachedLayoutBundle('t3', 1, load)
    expect(load).toHaveBeenCalledTimes(4)
  })
})
