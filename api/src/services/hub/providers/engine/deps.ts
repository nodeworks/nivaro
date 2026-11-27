import type { NotifyDeps } from '../../notify-events.js'
import type { ProviderFetchOptions } from '../provider-fetch.js'
import { defaultResourceLock, type ResourceLock } from './locks.js'

/**
 * The engine's seams (tests and the Hub boot set them; production uses the defaults). The engine
 * functions keep Task 0's signatures, so their dependencies are read from here rather than passed.
 */
export interface EngineDeps {
  lock: () => ResourceLock
  /** The clock (ms). */
  now: () => number
  /** Heartbeat: lock renewal + heartbeat_at every this many ms. */
  heartbeatMs: number
  /** An `applying` change whose heartbeat is older than this (and whose lock is gone) is interrupted. */
  staleMs: number
  /** Tests: the run is awaited before start/resume/approve answer. */
  inline: boolean
  notify?: NotifyDeps
  /** Passed to every provider context's fetch (tests: a fixture fetchImpl). */
  fetch?: Omit<ProviderFetchOptions, 'signal'>
}

export const HEARTBEAT_MS = 30_000
export const STALE_MS = 2 * 60_000

const defaults = (): EngineDeps => ({
  lock: defaultResourceLock,
  now: Date.now,
  heartbeatMs: HEARTBEAT_MS,
  staleMs: STALE_MS,
  inline: false
})

// Hub-only (HUB=on, never a shared deployment): the engine's seams, set by tests.
let current: EngineDeps = defaults()

export function engineDeps(): EngineDeps {
  return current
}

/** Tests: override some seams (the rest keep their current values). */
export function configureResourceEngine(over: Partial<EngineDeps>): void {
  current = { ...current, ...over }
}

/** Tests: back to the defaults. */
export function resetResourceEngineForTest(): void {
  current = defaults()
}
