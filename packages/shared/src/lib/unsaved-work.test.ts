import { afterEach, describe, expect, it, vi } from 'vitest'

const outbox = vi.hoisted(() => ({ entries: [] as unknown[], listeners: new Set<() => void>() }))
vi.mock('./record-outbox', () => ({
  getRecordOutbox: () => outbox.entries,
  subscribeRecordOutbox: (cb: () => void) => {
    outbox.listeners.add(cb)
    return () => outbox.listeners.delete(cb)
  }
}))

import {
  __resetUnsavedWorkForTests,
  beginReloadForUpdate,
  hasUnsavedWork,
  isReloadingForUpdate,
  prepareForReload,
  registerUnsavedWork,
  subscribeUnsavedWork,
  unsavedWorkLabels
} from './unsaved-work'

afterEach(() => {
  __resetUnsavedWorkForTests()
  outbox.entries = []
})

describe('unsaved work registry', () => {
  it('is true while any source is dirty, and tells subscribers when sources come and go', () => {
    const told = vi.fn()
    subscribeUnsavedWork(told)
    let dirty = true
    const off = registerUnsavedWork('Layout changes', () => dirty)
    expect(hasUnsavedWork()).toBe(true)
    expect(unsavedWorkLabels()).toEqual(['Layout changes'])
    dirty = false
    expect(hasUnsavedWork()).toBe(false)
    off()
    expect(told).toHaveBeenCalledTimes(2)
  })

  it('counts saves queued in the record outbox', () => {
    const told = vi.fn()
    subscribeUnsavedWork(told)
    outbox.entries = [{ id: 'a' }, { id: 'b' }]
    for (const cb of outbox.listeners) cb()
    expect(told).toHaveBeenCalled()
    expect(unsavedWorkLabels()).toEqual(['2 saves waiting to be sent'])
  })

  it('a source that throws counts as clean', () => {
    registerUnsavedWork('Broken', () => {
      throw new Error('x')
    })
    expect(hasUnsavedWork()).toBe(false)
  })
})

describe('prepareForReload (a pushed reload over kept work)', () => {
  it('lets the reload go when every dirty source stored its work', async () => {
    const save = vi.fn(async () => true)
    registerUnsavedWork('Unsaved record changes', () => true, { saveForReload: save })
    registerUnsavedWork('Clean editor', () => false, { saveForReload: async () => false })
    expect(await prepareForReload()).toEqual([])
    expect(save).toHaveBeenCalledOnce()
  })

  it('holds for work that cannot be kept, a failed save, or the outbox', async () => {
    registerUnsavedWork('Layout changes', () => true)
    registerUnsavedWork('Unsaved record changes', () => true, { saveForReload: async () => false })
    registerUnsavedWork('Video recording', () => true, {
      saveForReload: () => {
        throw new Error('boom')
      }
    })
    outbox.entries = [{}]
    expect(await prepareForReload()).toEqual([
      'Layout changes',
      'Unsaved record changes',
      'Video recording',
      '1 save waiting to be sent'
    ])
    outbox.entries = []
  })

  it('gives up on a save that hangs and keeps the hold', async () => {
    vi.useFakeTimers()
    registerUnsavedWork('Unsaved record changes', () => true, {
      saveForReload: () => new Promise<boolean>(() => {})
    })
    const p = prepareForReload()
    await vi.advanceTimersByTimeAsync(3000)
    expect(await p).toEqual(['Unsaved record changes'])
    vi.useRealTimers()
  })

  it('stands leave prompts down only briefly', () => {
    vi.useFakeTimers()
    expect(isReloadingForUpdate()).toBe(false)
    beginReloadForUpdate()
    expect(isReloadingForUpdate()).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(isReloadingForUpdate()).toBe(false)
    vi.useRealTimers()
  })
})
