import { afterEach, describe, expect, it } from 'vitest'
import {
  type BuildStatus,
  CHECK_EVERY_LONG_IDLE_MS,
  CHECK_EVERY_MS,
  CHECK_EVERY_WHEN_OFF_MS,
  checkEveryMs,
  decideIdleReload,
  type IdleReloadInput,
  idleMsFor,
  LONG_IDLE_MS,
  usableScroll
} from './idle-reload'
import { __resetReloadHoldsForTests, registerReloadHold, reloadHoldLabels } from './reload-holds'

const NOW = 10_000_000

const old: BuildStatus = {
  older: 'build',
  target: '0.3.57',
  id: 'idle-admin-0.3.57',
  reason: 'old',
  auto_reload: { enabled: true, idle_seconds: 60 }
}
const current: BuildStatus = { ...old, older: null, target: null, id: null, reason: 'current' }

function input(over: Partial<IdleReloadInput> = {}): IdleReloadInput {
  return {
    now: NOW,
    lastInput: NOW - 61_000,
    unsaved: [],
    holds: [],
    status: old,
    statusAt: NOW - 1000,
    reloadedFor: () => 0,
    ...over
  }
}

describe('idle reload — when an old tab reloads by itself', () => {
  it('reloads an idle, free tab the server judged old', () => {
    expect(decideIdleReload(input())).toEqual({ action: 'reload', id: 'idle-admin-0.3.57' })
  })

  it('never while someone typed or clicked inside the idle time', () => {
    expect(decideIdleReload(input({ lastInput: NOW - 30_000 }))).toEqual({
      action: 'wait',
      reason: 'active'
    })
  })

  it('a hidden tab is idle only after the same time without input (no shortcut for hiding)', () => {
    // Nothing in the decision reads visibility: 59 s after the last key it still waits.
    expect(decideIdleReload(input({ lastInput: NOW - 59_000 })).action).toBe('wait')
  })

  it('uses the idle seconds the instance set', () => {
    const slow = { ...old, auto_reload: { enabled: true, idle_seconds: 300 } }
    expect(decideIdleReload(input({ status: slow, lastInput: NOW - 120_000 }))).toEqual({
      action: 'wait',
      reason: 'active'
    })
    expect(decideIdleReload(input({ status: slow, lastInput: NOW - 301_000 })).action).toBe(
      'reload'
    )
    expect(idleMsFor(null)).toBe(60_000)
  })

  it('leaves a tab with unsaved changes alone', () => {
    expect(decideIdleReload(input({ unsaved: ['Unsaved changes'] }))).toEqual({
      action: 'wait',
      reason: 'unsaved'
    })
  })

  it('never during a huddle or a screen clip', () => {
    expect(decideIdleReload(input({ holds: ['A huddle'] }))).toEqual({
      action: 'wait',
      reason: 'held'
    })
  })

  it('a busy tab never asks the server', () => {
    expect(decideIdleReload(input({ status: null, lastInput: NOW - 5000 })).action).toBe('wait')
    expect(decideIdleReload(input({ status: null, unsaved: ['x'] })).action).toBe('wait')
    expect(decideIdleReload(input({ status: null, holds: ['A huddle'] })).action).toBe('wait')
  })

  it('an idle, free tab asks when it has no answer or the answer is stale', () => {
    expect(decideIdleReload(input({ status: null }))).toEqual({ action: 'check' })
    expect(decideIdleReload(input({ status: current, statusAt: NOW - CHECK_EVERY_MS }))).toEqual({
      action: 'check'
    })
    expect(decideIdleReload(input({ status: current }))).toEqual({
      action: 'wait',
      reason: 'current'
    })
  })

  it('asks less often once idle for an hour, and rarely while the setting is off', () => {
    expect(checkEveryMs(current, 0)).toBe(CHECK_EVERY_MS)
    expect(checkEveryMs(current, LONG_IDLE_MS)).toBe(CHECK_EVERY_LONG_IDLE_MS)
    const off = { ...current, reason: 'off', auto_reload: { enabled: false, idle_seconds: 60 } }
    expect(checkEveryMs(off, 0)).toBe(CHECK_EVERY_WHEN_OFF_MS)
    expect(decideIdleReload(input({ status: { ...old, auto_reload: off.auto_reload } }))).toEqual({
      action: 'wait',
      reason: 'off'
    })
  })

  it('reloads once per target build (a cached old bundle never loops)', () => {
    expect(decideIdleReload(input({ reloadedFor: () => 1 }))).toEqual({
      action: 'wait',
      reason: 'already'
    })
  })

  it('stops for this page load once its own leave prompt kept the page', () => {
    expect(decideIdleReload(input({ declined: true }))).toEqual({
      action: 'wait',
      reason: 'declined'
    })
  })
})

describe('reload holds', () => {
  afterEach(() => __resetReloadHoldsForTests())

  it('reports live holds by label until removed', () => {
    let live = true
    const off = registerReloadHold('A huddle', () => live)
    const clip = registerReloadHold('A screen clip')
    expect(reloadHoldLabels()).toEqual(['A huddle', 'A screen clip'])
    live = false
    expect(reloadHoldLabels()).toEqual(['A screen clip'])
    clip()
    off()
    expect(reloadHoldLabels()).toEqual([])
  })

  it('a getter that throws counts as off', () => {
    registerReloadHold('Broken', () => {
      throw new Error('x')
    })
    expect(reloadHoldLabels()).toEqual([])
  })
})

describe('scroll position across the reload', () => {
  const saved = { path: '/a?b=1', at: NOW, window: { x: 0, y: 400 }, boxes: [] }

  it('restores only on the same path, shortly after', () => {
    const raw = JSON.stringify(saved)
    expect(usableScroll(raw, '/a?b=1', NOW + 1000)?.window.y).toBe(400)
    expect(usableScroll(raw, '/other', NOW + 1000)).toBeNull()
    expect(usableScroll(raw, '/a?b=1', NOW + 3 * 60_000)).toBeNull()
    expect(usableScroll('not json', '/a?b=1', NOW)).toBeNull()
    expect(usableScroll(null, '/a?b=1', NOW)).toBeNull()
  })
})
