import { describe, expect, it } from 'vitest'
import { installStaleChunkRecovery, isStaleChunkError, recoverFromStaleChunk } from './stale-chunk'

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('stale chunk recovery', () => {
  it('recognises chunk-load failures from every browser', () => {
    expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toBe(true)
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isStaleChunkError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isStaleChunkError({ message: 'Unable to preload CSS for /assets/b.css' })).toBe(true)
    expect(isStaleChunkError(new Error('Network Error'))).toBe(false)
    expect(isStaleChunkError(undefined)).toBe(false)
  })

  it('reloads once, then gives up inside the window', () => {
    const storage = memoryStorage()
    let reloads = 0
    let gaveUp = 0
    let t = 1_000_000
    const opts = { storage, reload: () => reloads++, onGiveUp: () => gaveUp++, now: () => t }
    expect(recoverFromStaleChunk(opts)).toBe('reload')
    t += 5_000
    expect(recoverFromStaleChunk(opts)).toBe('gave-up')
    expect([reloads, gaveUp]).toEqual([1, 1])
    t += 120_000
    expect(recoverFromStaleChunk(opts)).toBe('reload')
    expect(reloads).toBe(2)
  })

  it('still reloads when storage is unavailable', () => {
    let reloads = 0
    expect(recoverFromStaleChunk({ storage: null, reload: () => reloads++ })).toBe('reload')
    expect(reloads).toBe(1)
  })

  it('handles the Vite preload event and matching rejections only', () => {
    const listeners: Record<string, (e: any) => void> = {}
    const target = {
      addEventListener: (t: string, fn: any) => void (listeners[t] = fn),
      removeEventListener: (t: string) => void delete listeners[t]
    }
    let reloads = 0
    const uninstall = installStaleChunkRecovery({ target, storage: memoryStorage(), reload: () => reloads++ })
    let prevented = 0
    listeners.unhandledrejection({ reason: new Error('boom'), preventDefault: () => prevented++ })
    expect([reloads, prevented]).toEqual([0, 0])
    listeners['vite:preloadError']({ preventDefault: () => prevented++ })
    expect([reloads, prevented]).toEqual([1, 1])
    // A burst of failures from the same stale build reloads once.
    listeners.unhandledrejection({ reason: new TypeError('Failed to fetch dynamically imported module'), preventDefault: () => prevented++ })
    expect(reloads).toBe(1)
    uninstall()
    expect(Object.keys(listeners)).toEqual([])
  })
})
