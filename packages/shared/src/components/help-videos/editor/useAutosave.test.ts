// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VersionDto, VideoEdits } from '../types'
import { type History, type HistoryAction, historyReducer, initHistory } from './history'
import { useAutosave } from './useAutosave'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const request = vi.fn()
vi.mock('../../../context', () => ({ useNivaroClient: () => ({ request }) }))

const e = (n: number): VideoEdits => ({
  v: 1,
  segments: [{ start_ms: 0, end_ms: n, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
})
const version = (edits: VideoEdits, hash: string) => ({
  data: { edits, edits_hash: hash } as VersionDto
})
const fail = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.error ?? 'failed')), { status, response: body })
const puts = () => request.mock.calls.filter(([c]) => c._method === 'PUT').map(([c]) => c._body)

type Api = {
  h: History
  dispatch: (a: HistoryAction) => void
  save: ReturnType<typeof useAutosave>
}
let api: Api
let root: Root

function Probe({ initial }: { initial: VideoEdits }) {
  const [h, dispatch] = useReducer(historyReducer, initial, initHistory)
  const save = useAutosave('v1', h.present, 'h0', {
    onAdopt: (from, edits) => dispatch({ type: 'adopt', from, edits })
  })
  api = { h, dispatch, save }
  return null
}

async function mount(initial = e(1000)) {
  const qc = new QueryClient()
  root = createRoot(document.createElement('div'))
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(Probe, { initial }))
    )
  )
}
const change = (edits: VideoEdits) =>
  act(async () => api.dispatch({ type: 'set', edits, now: Date.now() }))
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  vi.useFakeTimers()
  request.mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
})

describe('useAutosave', () => {
  it('saves a second after the last change, never on mount', async () => {
    request.mockImplementation(async (c) => version(c._body.edits, 'h1'))
    await mount()
    await wait(5000)
    expect(puts()).toHaveLength(0)
    await change(e(2000))
    expect(api.save.unsaved).toBe(true)
    await wait(900)
    expect(puts()).toHaveLength(0)
    await wait(200)
    expect(puts()).toEqual([{ edits: e(2000), base_hash: 'h0' }])
    expect(api.save.status).toBe('saved')
    expect(api.save.hash).toBe('h1')
    expect(api.save.unsaved).toBe(false)
  })

  it('adopts the server-normalized copy without an undo step or a second save', async () => {
    const normalized = { ...e(2000), chapters: [{ id: 'c1', at_ms: 0, title: 'Chapter' }] }
    request.mockResolvedValue(version(normalized, 'h1'))
    await mount()
    await change(e(2000))
    const pastBefore = api.h.past.length
    await wait(1100)
    expect(api.h.present).toEqual(normalized)
    expect(api.h.past.length).toBe(pastBefore)
    await wait(10_000)
    expect(puts()).toHaveLength(1)
    expect(api.save.status).toBe('saved')
    expect(api.save.unsaved).toBe(false)
  })

  it('keeps edits made while a save was in flight, then saves them next', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    request.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
    request.mockImplementation(async (c) => version(c._body.edits, 'h2'))
    await mount()
    await change(e(2000))
    await wait(1100)
    expect(api.save.status).toBe('saving')
    await change(e(3000))
    await wait(1100)
    // Never two PUTs at once: the second waits for the first.
    expect(puts()).toHaveLength(1)
    await act(async () => resolveFirst(version({ ...e(2000), poster_ms: 5 }, 'h1')))
    await wait(0)
    expect(api.h.present).toEqual(e(3000))
    expect(puts()).toEqual([
      { edits: e(2000), base_hash: 'h0' },
      { edits: e(3000), base_hash: 'h1' }
    ])
    expect(api.save.hash).toBe('h2')
  })

  it('stops saving on an edits conflict', async () => {
    request.mockRejectedValue(
      fail(409, { error: 'changed', code: 'HELP_VIDEO_EDITS_CONFLICT', current_hash: 'hx' })
    )
    await mount()
    await change(e(2000))
    await wait(1100)
    expect(api.save.status).toBe('conflict')
    expect(api.save.message).toMatch(/another tab/)
    await change(e(3000))
    await wait(120_000)
    expect(puts()).toHaveLength(1)
  })

  it('treats any other 409 as an error to retry', async () => {
    request.mockRejectedValueOnce(fail(409, { error: 'Busy', code: 'SOMETHING_ELSE' }))
    request.mockImplementation(async (c) => version(c._body.edits, 'h1'))
    await mount()
    await change(e(2000))
    await wait(1100)
    expect(api.save.status).toBe('error')
    await wait(5000)
    expect(api.save.status).toBe('saved')
  })

  it('retries a failed save by itself, backing off from 5 s to 60 s', async () => {
    request.mockRejectedValue(Object.assign(new Error('Failed to fetch')))
    await mount()
    await change(e(2000))
    await wait(1000)
    expect(puts()).toHaveLength(1)
    expect(api.save.status).toBe('error')
    expect(api.save.retryInMs).toBe(5000)
    expect(api.save.unsaved).toBe(true)
    // 5 s, 10 s, 20 s, 40 s, then 60 s from there on.
    for (const [delay, total] of [
      [5000, 2],
      [10_000, 3],
      [20_000, 4],
      [40_000, 5],
      [60_000, 6],
      [60_000, 7]
    ]) {
      await wait(delay - 1)
      expect(puts()).toHaveLength(total - 1)
      await wait(1)
      expect(puts()).toHaveLength(total)
    }
    request.mockImplementation(async (c) => version(c._body.edits, 'h1'))
    await wait(60_000)
    expect(api.save.status).toBe('saved')
    expect(api.save.retryInMs).toBeNull()
    await wait(300_000)
    expect(puts()).toHaveLength(8)
  })

  it('reports invalid edits and waits for the next change', async () => {
    request.mockRejectedValueOnce(
      fail(422, {
        error: 'Keep at least one second of the recording',
        code: 'HELP_VIDEO_EDITS_INVALID'
      })
    )
    request.mockImplementation(async (c) => version(c._body.edits, 'h1'))
    await mount()
    await change(e(2000))
    await wait(1100)
    expect(api.save.status).toBe('invalid')
    expect(api.save.message).toBe('Keep at least one second of the recording')
    expect(api.save.unsaved).toBe(true)
    await wait(120_000)
    expect(puts()).toHaveLength(1)
    await change(e(3000))
    await wait(1100)
    expect(api.save.status).toBe('saved')
  })

  it('asks before leaving the page while a change is unsaved, and not once saved', async () => {
    const live = new Set<unknown>()
    vi.spyOn(window, 'addEventListener').mockImplementation((type, fn) => {
      if (type === 'beforeunload') live.add(fn)
    })
    vi.spyOn(window, 'removeEventListener').mockImplementation((type, fn) => {
      if (type === 'beforeunload') live.delete(fn)
    })
    request.mockRejectedValueOnce(new Error('Failed to fetch'))
    request.mockImplementation(async (c) => version(c._body.edits, 'h1'))
    await mount()
    expect(live.size).toBe(0)
    await change(e(2000))
    expect(live.size).toBe(1)
    await wait(1100)
    expect(api.save.status).toBe('error')
    expect(live.size).toBe(1)
    await wait(5000)
    expect(api.save.status).toBe('saved')
    expect(live.size).toBe(0)
    vi.restoreAllMocks()
  })

  it('flush saves at once', async () => {
    request.mockImplementation(async (c) => version(c._body.edits, 'h1'))
    await mount()
    await change(e(2000))
    await act(async () => api.save.flush())
    expect(puts()).toHaveLength(1)
    expect(api.save.status).toBe('saved')
    await wait(5000)
    expect(puts()).toHaveLength(1)
  })
})
