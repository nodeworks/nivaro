import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The admin recorder records nothing while nobody is at the tab (packages/shared
 * replay-idle.ts). Same rules, same tests as @nivaro/react's recorder
 * (packages/react/src/hooks/useSessionRecorder.test.tsx): keep the two in step.
 */

const rr = vi.hoisted(() => ({
  emit: null as ((event: unknown) => void) | null,
  stop: vi.fn(),
  takeFullSnapshot: vi.fn()
}))
vi.mock('rrweb', () => {
  const record = Object.assign(
    (opts: { emit: (event: unknown) => void }) => {
      rr.emit = opts.emit
      return rr.stop
    },
    {
      addCustomEvent: vi.fn(),
      takeFullSnapshot: (c?: boolean) => rr.takeFullSnapshot(c)
    }
  )
  return { record }
})

/** A fake instance: every upload is taken; each start answers a new recording id (R1, R2…). */
const server = vi.hoisted(() => ({
  calls: [] as string[],
  uploads: [] as Array<{ recording: string; ids: string[] }>,
  started: 0
}))
vi.mock('@/lib/api', () => ({
  WORKSPACE_KEY: 'nivaro_workspace',
  api: {
    get: vi.fn(async () => ({ data: { data: null } })),
    post: vi.fn(async (path: string, body?: { events?: Array<{ id?: string }> }) => {
      server.calls.push(`POST ${path}`)
      if (path === '/session-recordings/start') {
        return { data: { data: { id: `R${++server.started}` } } }
      }
      const m = /^\/session-recordings\/([^/]+)\/events$/.exec(path)
      if (m) {
        server.uploads.push({
          recording: m[1],
          ids: (body?.events ?? []).map((e) => String(e.id))
        })
        return { data: { data: { ok: true } } }
      }
      return { data: { data: null } }
    })
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'U1' } }) }))
vi.mock('@/lib/masquerade', () => ({ readMasquerade: () => null }))
vi.mock('@/lib/auto-record-listener', () => ({ useAutoRecordListener: () => {} }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: { enabled: true } }) }))

import { useSessionRecorder } from './use-session-recorder'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Recorder() {
  useSessionRecorder()
  return null
}

const flushPromises = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}
/** Settle promise chains while setTimeout is faked. */
const microtasks = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
}
const ev = (id: string, type: number, source?: number) => ({
  id,
  type,
  ...(source === undefined ? {} : { data: { source } })
})

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  rr.emit = null
  rr.stop.mockClear()
  rr.takeFullSnapshot.mockClear()
  server.calls.length = 0
  server.uploads.length = 0
  server.started = 0
  sessionStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
})

async function mount() {
  root = createRoot(host as HTMLDivElement)
  await act(async () => {
    root?.render(createElement(Recorder))
    await flushPromises()
  })
  await act(async () => {
    await flushPromises()
  })
}

async function unmountAndUpload() {
  await act(async () => {
    root?.unmount()
    await flushPromises()
  })
  root = null
}

describe('admin useSessionRecorder: nothing is recorded while nobody is at the tab (2026-11-12)', () => {
  it('stops after five minutes without input and goes on from a fresh snapshot when someone is back', async () => {
    await mount()
    expect(rr.emit).toBeTypeOf('function')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    try {
      const t0 = Date.now()
      rr.emit?.(ev('meta1', 4))
      rr.emit?.(ev('snap1', 2))
      vi.setSystemTime(t0 + 60_000)
      rr.emit?.(ev('m1', 3, 0))
      vi.setSystemTime(t0 + 5 * 60_000 + 1)
      rr.emit?.(ev('m2', 3, 0))
      vi.setSystemTime(t0 + 10 * 60_000)
      rr.emit?.(ev('m3', 3, 0))
      rr.emit?.(ev('console1', 5))
      vi.runOnlyPendingTimers()
      expect(rr.takeFullSnapshot).not.toHaveBeenCalled()
      vi.setSystemTime(t0 + 12 * 60_000)
      rr.emit?.(ev('move', 3, 1))
      vi.runOnlyPendingTimers()
      await microtasks()
      expect(rr.takeFullSnapshot).toHaveBeenCalledTimes(1)
      expect(rr.takeFullSnapshot).toHaveBeenCalledWith(true)
      rr.emit?.(ev('meta2', 4))
      rr.emit?.(ev('snap2', 2))
      rr.emit?.(ev('m4', 3, 0))
    } finally {
      vi.useRealTimers()
    }
    await unmountAndUpload()
    expect(server.uploads.flatMap((u) => u.ids)).toEqual([
      'meta1',
      'snap1',
      'm1',
      'meta2',
      'snap2',
      'm4'
    ])
    expect([...new Set(server.uploads.map((u) => u.recording))]).toEqual(['R1'])
    expect(server.calls.filter((c) => c === 'POST /session-recordings/start')).toHaveLength(1)
  })

  it('back after a long break, what follows is a new recording', async () => {
    await mount()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    try {
      const t0 = Date.now()
      rr.emit?.(ev('meta1', 4))
      rr.emit?.(ev('snap1', 2))
      vi.setSystemTime(t0 + 60_000)
      rr.emit?.(ev('m1', 3, 0))
      vi.setSystemTime(t0 + 6 * 60_000)
      rr.emit?.(ev('m2', 3, 0))
      vi.setSystemTime(t0 + 45 * 60_000)
      rr.emit?.(ev('click', 3, 2))
      vi.runOnlyPendingTimers()
      await microtasks()
      expect(server.calls.filter((c) => c === 'POST /session-recordings/start')).toHaveLength(2)
      expect(server.calls).toContain('POST /session-recordings/R1/end')
      expect(rr.takeFullSnapshot).toHaveBeenCalledTimes(1)
      rr.emit?.(ev('meta2', 4))
      rr.emit?.(ev('snap2', 2))
      rr.emit?.(ev('m3', 3, 0))
    } finally {
      vi.useRealTimers()
    }
    await unmountAndUpload()
    const of = (rec: string) =>
      server.uploads.filter((u) => u.recording === rec).flatMap((u) => u.ids)
    expect(of('R1')).toEqual(['meta1', 'snap1', 'm1'])
    expect(of('R2')).toEqual(['meta2', 'snap2', 'm3'])
  })
})
