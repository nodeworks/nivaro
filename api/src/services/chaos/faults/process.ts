import { getHeapStatistics } from 'node:v8'
import { type ArmedFault, registerFault } from '../catalog.js'
import { CHAOS_NODE } from '../registry.js'

/**
 * Process faults (#2837): block one replica's event loop for N ms every M seconds, or grow its
 * heap toward a share of the limit. Both stop on expiry, Stop all and abort (the retained
 * memory is dropped, the interval cleared).
 *
 * No event-loop watchdog (#2804) or heap growth guard (#2806) exists yet, so these drills prove
 * what does: the event-loop lag the steady-state sampler `loop.lag_ms` reads, `/api/ready`, the
 * request p95 — and, once the watchdog and guard land, that they act.
 */

/** Hard caps whatever the catalog allows. */
export const MAX_BLOCK_MS = 2000
export const MAX_HEAP_PCT = 75

function onThisNode(fault: ArmedFault): boolean {
  return fault.target.kind !== 'node' || fault.target.node === CHAOS_NODE
}

/** Spin the CPU on the event loop for `ms` (capped). Returns the ms actually spent. */
export function busyWait(ms: number): number {
  const until = Math.min(MAX_BLOCK_MS, Math.max(0, ms))
  const t0 = performance.now()
  while (performance.now() - t0 < until) {
    /* deliberately blocking */
  }
  return performance.now() - t0
}

export function applyLoopBlock(fault: ArmedFault): (() => void) | undefined {
  if (!onThisNode(fault)) return
  const blockMs = Math.min(MAX_BLOCK_MS, Number(fault.params.block_ms) || 0)
  const everyMs = Math.max(1000, (Number(fault.params.every_s) || 5) * 1000)
  const timer = setInterval(() => {
    // The interval may outlive the window by a tick if the release is late.
    if (Date.now() >= fault.ends_at) return
    busyWait(blockMs)
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Retained memory per fault id (the arrays live on the V8 heap, not off-heap buffers). */
const retained = new Map<string, { chunks: number[][]; bytes: number }>()

/** Bytes this replica's memory-pressure faults retain right now. */
export function memoryPressureBytes(): number {
  let n = 0
  for (const r of retained.values()) n += r.bytes
  return n
}

export interface HeapProbe {
  limit(): number
  used(): number
}

let heap: HeapProbe = {
  limit: () => getHeapStatistics().heap_size_limit,
  used: () => process.memoryUsage().heapUsed
}

/** Tests: a fake heap. */
export function _setHeapProbeForTests(p: HeapProbe): void {
  heap = p
}

/** One growth step: allocate `stepBytes` more unless that would pass the target (pure-ish). */
export function growStep(
  state: { chunks: number[][]; bytes: number },
  stepBytes: number,
  targetPct: number
): boolean {
  const limit = heap.limit()
  const target = (limit * Math.min(MAX_HEAP_PCT, targetPct)) / 100
  const hard = (limit * MAX_HEAP_PCT) / 100
  if (heap.used() + stepBytes > target || state.bytes + stepBytes > hard) return false
  // 8 bytes per element in a double array.
  state.chunks.push(new Array(Math.floor(stepBytes / 8)).fill(0.5))
  state.bytes += stepBytes
  return true
}

export function applyMemoryPressure(fault: ArmedFault): (() => void) | undefined {
  if (!onThisNode(fault)) return
  const pct = Math.min(MAX_HEAP_PCT, Number(fault.params.target_pct) || 60)
  const stepBytes = Math.max(1, Number(fault.params.step_mb) || 32) * 1024 * 1024
  const everyMs = Math.max(1000, (Number(fault.params.step_s) || 2) * 1000)
  const state = { chunks: [] as number[][], bytes: 0 }
  retained.set(fault.id, state)
  growStep(state, stepBytes, pct)
  const timer = setInterval(() => {
    if (Date.now() >= fault.ends_at) return
    growStep(state, stepBytes, pct)
  }, everyMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    state.chunks.length = 0
    state.bytes = 0
    retained.delete(fault.id)
    ;(globalThis as { gc?: () => void }).gc?.()
  }
}

registerFault({
  key: 'event_loop_block',
  label: 'Event-loop block',
  area: 'process',
  proves:
    'A replica whose event loop stalls is noticed and drained: event-loop lag and request p95 show it, readiness flips so the proxy stops sending it traffic, and the other replicas carry the load.',
  claim_keys: ['process.loop_block_drained'],
  targets: ['node', 'all'],
  params: {
    block_ms: {
      type: 'number',
      label: 'Block for',
      min: 10,
      max: MAX_BLOCK_MS,
      default: 300,
      unit: 'ms'
    },
    every_s: { type: 'number', label: 'Every', min: 1, max: 60, default: 5, unit: 's' }
  },
  max_seconds: 180,
  default_seconds: 30,
  points: ['process.loop'],
  danger: 'high',
  apply_scope: 'every',
  apply: (fault) => applyLoopBlock(fault),
  hypothesis_defaults: [{ sampler: 'loop.lag_ms', op: '<', limit: 2500, tolerance: 500 }]
})

registerFault({
  key: 'memory_pressure',
  label: 'Memory pressure',
  area: 'process',
  proves:
    'A replica whose heap grows toward its limit is caught before it dies mid-request: the heap figures show it, the guard sheds or restarts it, and the memory comes back when the pressure ends.',
  claim_keys: ['process.heap_guard'],
  targets: ['node', 'all'],
  params: {
    target_pct: {
      type: 'number',
      label: 'Grow the heap to',
      min: 10,
      max: MAX_HEAP_PCT,
      default: 60,
      unit: '% of limit'
    },
    step_mb: { type: 'number', label: 'Step', min: 4, max: 256, default: 32, unit: 'MB' },
    step_s: { type: 'number', label: 'Every', min: 1, max: 30, default: 2, unit: 's' }
  },
  max_seconds: 300,
  default_seconds: 60,
  points: ['process.heap'],
  danger: 'high',
  apply_scope: 'every',
  apply: (fault) => applyMemoryPressure(fault),
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }]
})

/** Tests only. */
export function _resetProcessFaultsForTests(): void {
  retained.clear()
}
