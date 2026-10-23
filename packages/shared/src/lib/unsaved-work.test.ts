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
  hasUnsavedWork,
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
