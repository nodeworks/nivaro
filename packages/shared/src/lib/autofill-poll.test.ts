import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollProposal } from './autofill-poll'

type Answer = { status: number; ok: boolean; json: unknown }

function harness(answers: Answer[]) {
  const calls = {
    running: [] as (string | undefined)[],
    done: [] as unknown[],
    error: [] as string[],
    settled: 0
  }
  let i = 0
  const fetchResult = vi.fn(async () => answers[Math.min(i++, answers.length - 1)])
  const stop = pollProposal({
    fetchResult,
    intervalMs: 1000,
    onRunning: (name) => calls.running.push(name),
    onDone: (d) => calls.done.push(d),
    onError: (m) => calls.error.push(m),
    onSettled: () => {
      calls.settled += 1
    }
  })
  return { calls, fetchResult, stop }
}

describe('pollProposal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps waiting through 202 answers and settles only once the proposal lands', async () => {
    const { calls, fetchResult } = harness([
      { status: 202, ok: true, json: { data: { document_name: 'sow.pdf' } } },
      { status: 202, ok: true, json: { data: {} } },
      { status: 200, ok: true, json: { data: { fields: [] } } }
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.running).toEqual(['sow.pdf'])
    expect(calls.settled).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.settled).toBe(0)
    expect(calls.done).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchResult).toHaveBeenCalledTimes(3)
    expect(calls.done).toEqual([{ fields: [] }])
    expect(calls.error).toEqual([])
    expect(calls.settled).toBe(1)
  })

  it('reports a failed run and settles', async () => {
    const { calls } = harness([{ status: 422, ok: false, json: { error: 'Scanned PDF' } }])
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.error).toEqual(['Scanned PDF'])
    expect(calls.done).toEqual([])
    expect(calls.settled).toBe(1)
  })

  it('does nothing after stop()', async () => {
    const { calls, fetchResult, stop } = harness([
      { status: 202, ok: true, json: { data: {} } },
      { status: 200, ok: true, json: { data: { fields: [] } } }
    ])
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchResult).toHaveBeenCalledTimes(1)
    expect(calls.done).toEqual([])
    expect(calls.settled).toBe(0)
  })
})
