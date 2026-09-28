import { describe, expect, it, vi } from 'vitest'
import {
  activeMasquerades,
  masqueradeMarkerKey,
  touchMasqueradeMarker
} from '../../../services/masquerade-marker.js'

function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v)
      return 'OK'
    }),
    mget: vi.fn(async (keys: string[]) => keys.map((k) => store.get(k) ?? null))
  }
}

describe('masquerade marker', () => {
  it('keys by the upper-cased target and stores the admin id', async () => {
    const redis = fakeRedis()
    touchMasqueradeMarker(redis as never, 'abc-1', 'admin-9')
    await Promise.resolve()
    expect(redis.set).toHaveBeenCalledTimes(1)
    expect(redis.set.mock.calls[0][0]).toBe(masqueradeMarkerKey('ABC-1'))
    expect(redis.set.mock.calls[0][1]).toBe('ADMIN-9')
    const who = await activeMasquerades(redis as never, ['abc-1', 'nobody'])
    expect([...who.entries()]).toEqual([['ABC-1', 'ADMIN-9']])
  })

  it('throttles repeated touches for the same pair and never touches without an admin', async () => {
    const redis = fakeRedis()
    touchMasqueradeMarker(redis as never, 'u-2', 'a-2')
    touchMasqueradeMarker(redis as never, 'u-2', 'a-2')
    touchMasqueradeMarker(redis as never, 'u-3', undefined)
    await Promise.resolve()
    expect(redis.set).toHaveBeenCalledTimes(1)
  })

  it('answers empty with no redis and swallows a failing read', async () => {
    expect((await activeMasquerades(null, ['x'])).size).toBe(0)
    const broken = {
      mget: vi.fn(async () => {
        throw new Error('down')
      })
    }
    expect((await activeMasquerades(broken as never, ['x'])).size).toBe(0)
  })
})
