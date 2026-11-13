import { describe, expect, it } from 'vitest'
import {
  guardLazyImport,
  installStaleChunkRecovery,
  isStaleChunkError,
  recoverFromStaleChunk,
  staleChunkReloadJustTried
} from './stale-chunk'

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v)
  }
}

describe('stale chunk recovery', () => {
  it('recognises chunk-load failures from every browser', () => {
    expect(
      isStaleChunkError(
        new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js')
      )
    ).toBe(true)
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
    const uninstall = installStaleChunkRecovery({
      target,
      storage: memoryStorage(),
      reload: () => reloads++
    })
    let prevented = 0
    listeners.unhandledrejection({ reason: new Error('boom'), preventDefault: () => prevented++ })
    expect([reloads, prevented]).toEqual([0, 0])
    listeners['vite:preloadError']({ preventDefault: () => prevented++ })
    // Reloads, and leaves the event alone: cancelling it makes Vite resolve the import with
    // nothing instead of failing it (see "a failed screen import" below).
    expect([reloads, prevented]).toEqual([1, 0])
    // A burst of failures from the same stale build reloads once.
    listeners.unhandledrejection({
      reason: new TypeError('Failed to fetch dynamically imported module'),
      preventDefault: () => prevented++
    })
    expect(reloads).toBe(1)
    uninstall()
    expect(Object.keys(listeners)).toEqual([])
  })
})

// What Vite's preload helper does around every dynamic import (vite 6, build mode): on a
// failed import it raises `vite:preloadError`, and rethrows only when nobody cancelled it.
function viteImport<T>(target: EventTarget, load: () => Promise<T>): Promise<T | undefined> {
  return load().catch((err) => {
    const e = new Event('vite:preloadError', { cancelable: true })
    ;(e as Event & { payload?: unknown }).payload = err
    target.dispatchEvent(e)
    if (!e.defaultPrevented) throw err
    return undefined
  })
}

const chunkGone = () =>
  new TypeError('Failed to fetch dynamically imported module: https://x/assets/Collections-abc.js')

// The host's "updated, reload" notice must not offer the same reload as if it were new when
// one was just tried and did not bring the new build.
describe('a reload that was just tried', () => {
  it('is known for the minute the recovery will not repeat it, and not after', () => {
    const storage = memoryStorage()
    let t = 1_000_000
    const now = () => t
    expect(staleChunkReloadJustTried({ storage, now })).toBe(false)
    recoverFromStaleChunk({ storage, now, reload: () => {} })
    t += 5_000
    expect(staleChunkReloadJustTried({ storage, now })).toBe(true)
    t += 60_000
    expect(staleChunkReloadJustTried({ storage, now })).toBe(false)
  })

  it('is not claimed when storage is off or unreadable', () => {
    expect(staleChunkReloadJustTried({ storage: null })).toBe(false)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {}
    }
    expect(staleChunkReloadJustTried({ storage: broken })).toBe(false)
  })
})

describe('a failed screen import', () => {
  // 2026-11-11, a day with eight deploys: "[client] /collections: Cannot read properties of
  // undefined (reading 'CollectionsPage')". The recovery cancelled Vite's event, so the import
  // of a chunk the new release no longer served RESOLVED with nothing, and the route's own
  // `.then((m) => ({ default: m.CollectionsPage }))` crashed the page while the reload ran.
  it('fails as a failed import, never resolves with nothing', async () => {
    const target = new EventTarget()
    let reloads = 0
    const uninstall = installStaleChunkRecovery({
      target: target as never,
      storage: memoryStorage(),
      reload: () => reloads++,
      unsaved: () => []
    })
    const route = () =>
      viteImport<{ CollectionsPage: unknown }>(target, () => Promise.reject(chunkGone())).then(
        // As App.tsx writes its routes: the module is read without a second thought.
        (m) => ({ default: (m as { CollectionsPage: unknown }).CollectionsPage })
      )
    await expect(route()).rejects.toThrow(/Failed to fetch dynamically imported module/)
    expect(reloads).toBe(1)
    uninstall()
  })
})

describe('a reload that did not happen', () => {
  it('is not waited on for ever: a later failure says so instead of reloading again', () => {
    const target = new EventTarget()
    let reloads = 0
    let gaveUp = 0
    let t = 1_000_000
    const uninstall = installStaleChunkRecovery({
      target: target as never,
      storage: memoryStorage(),
      reload: () => reloads++,
      onGiveUp: () => gaveUp++,
      unsaved: () => [],
      now: () => t
    })
    const fail = () => target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    fail()
    t += 3_000
    fail()
    // Still inside the time a reload is given to take the page away: nothing more happens.
    expect([reloads, gaveUp]).toEqual([1, 0])
    t += 9_000
    fail()
    expect([reloads, gaveUp]).toEqual([1, 1])
    uninstall()
  })
})

describe('unsaved work', () => {
  it('is never reloaded over: the host is told instead, and the next try may reload', () => {
    const storage = memoryStorage()
    let reloads = 0
    const held: string[][] = []
    let dirty = ['Purchase order 12']
    const opts = {
      storage,
      reload: () => reloads++,
      unsaved: () => dirty,
      onHeld: (labels: string[]) => held.push(labels),
      now: () => 5_000_000
    }
    expect(recoverFromStaleChunk(opts)).toBe('held')
    expect([reloads, held]).toEqual([0, [['Purchase order 12']]])
    // Saved: the same failure now reloads (holding back did not use up the one reload).
    dirty = []
    expect(recoverFromStaleChunk(opts)).toBe('reload')
    expect(reloads).toBe(1)
  })

  it('falls back to the give-up message for a host with no message of its own', () => {
    let gaveUp = 0
    expect(
      recoverFromStaleChunk({
        storage: memoryStorage(),
        reload: () => {},
        unsaved: () => ['Layout'],
        onGiveUp: () => gaveUp++
      })
    ).toBe('held')
    expect(gaveUp).toBe(1)
  })
})

describe('guardLazyImport', () => {
  const Notice = () => null
  const Screen = () => null
  const settled = async <T>(p: Promise<T>) => {
    let state: 'pending' | 'done' | 'failed' = 'pending'
    p.then(
      () => (state = 'done'),
      () => (state = 'failed')
    )
    await new Promise((r) => setTimeout(r, 5))
    return state as 'pending' | 'done' | 'failed'
  }
  const recovery = (over: { unsaved?: () => string[]; now?: () => number } = {}) => {
    const calls = { reloads: 0 }
    return {
      calls,
      opts: { storage: memoryStorage(), reload: () => calls.reloads++, unsaved: () => [], ...over }
    }
  }

  it('hands a screen that loads straight through', async () => {
    const { opts, calls } = recovery()
    const load = guardLazyImport(async () => ({ default: Screen }), Notice, opts)
    await expect(load()).resolves.toEqual({ default: Screen })
    expect(calls.reloads).toBe(0)
  })

  it('reloads once for a chunk that is gone and keeps the screen loading meanwhile', async () => {
    const { opts, calls } = recovery()
    const load = guardLazyImport(() => Promise.reject(chunkGone()), Notice, opts)
    expect(await settled(load())).toBe('pending')
    expect(calls.reloads).toBe(1)
  })

  it('shows the notice when the reload was just tried: no loop, no crash', async () => {
    const { opts, calls } = recovery()
    const load = guardLazyImport(() => Promise.reject(chunkGone()), Notice, opts)
    void load()
    // The reloaded page (same session) fails the same way.
    const afterReload = guardLazyImport(() => Promise.reject(chunkGone()), Notice, opts)
    await expect(afterReload()).resolves.toEqual({ default: Notice })
    expect(calls.reloads).toBe(1)
  })

  it('shows the notice instead of reloading over unsaved work', async () => {
    const { opts, calls } = recovery({ unsaved: () => ['Purchase order 12'] })
    const load = guardLazyImport(() => Promise.reject(chunkGone()), Notice, opts)
    await expect(load()).resolves.toEqual({ default: Notice })
    expect(calls.reloads).toBe(0)
  })

  it('treats a module without the screen it should export as an old build', async () => {
    const { opts, calls } = recovery()
    const missingExport = guardLazyImport(
      async () => ({ default: undefined }) as never,
      Notice,
      opts
    )
    expect(await settled(missingExport())).toBe('pending')
    expect(calls.reloads).toBe(1)
    const nothing = guardLazyImport(async () => undefined as never, Notice, recovery().opts)
    expect(await settled(nothing())).toBe('pending')
  })

  it('leaves a real error in the screen alone', async () => {
    const { opts, calls } = recovery()
    const load = guardLazyImport(
      () => Promise.reject(new TypeError('x is not a function')),
      Notice,
      opts
    )
    await expect(load()).rejects.toThrow('x is not a function')
    expect(calls.reloads).toBe(0)
  })
})
