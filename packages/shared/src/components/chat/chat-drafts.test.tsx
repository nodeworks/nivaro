// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFT_DEBOUNCE_MS, useDraftSync } from './chat-drafts'

// Switching conversations within the save debounce used to drop the typed draft: the timer was
// cleared on the room change / unmount and nothing was sent (staging, 2026-10-26).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sent = vi.hoisted(() => [] as Array<{ method: string; path: string; body?: unknown }>)

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined })
}))
vi.mock('../../lib/realtime', () => ({ useOptionalRealtime: () => null }))
vi.mock('../../context', () => ({
  useNivaroClient: () => ({
    request: async (c: { _method?: string; _path?: string; _body?: unknown }) => {
      const method = (c._method ?? 'GET').toUpperCase()
      if (method === 'GET') return { data: null }
      sent.push({ method, path: c._path ?? '', body: c._body })
      return { data: null }
    }
  })
}))

let setText: (v: string) => void = () => {}

function Box({ room }: { room: string }) {
  const [draft, setDraft] = useState('')
  setText = setDraft
  useDraftSync(room, true, draft, setDraft)
  return null
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  sent.length = 0
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})

async function settle() {
  // the restore GET resolves on the microtask queue
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('chat draft sync', () => {
  it('saves after the debounce', async () => {
    act(() => root.render(createElement(Box, { room: 'ch:a' })))
    await settle()
    act(() => setText('hello'))
    expect(sent).toEqual([])
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS))
    expect(sent).toEqual([
      {
        method: 'PUT',
        path: '/chat/drafts/ch%3Aa',
        body: expect.objectContaining({ body: 'hello' })
      }
    ])
  })

  it('flushes the typed draft at once when the room changes inside the debounce', async () => {
    act(() => root.render(createElement(Box, { room: 'ch:a' })))
    await settle()
    act(() => setText('half a thought'))
    act(() => vi.advanceTimersByTime(300))
    act(() => root.render(createElement(Box, { room: 'ch:b' })))
    expect(sent).toEqual([
      {
        method: 'PUT',
        path: '/chat/drafts/ch%3Aa',
        body: expect.objectContaining({ body: 'half a thought' })
      }
    ])
    // …and nothing is saved again for the old room, nor the old text into the new one.
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2))
    expect(sent).toHaveLength(1)
  })

  it('flushes when the composer unmounts inside the debounce', async () => {
    act(() => root.render(createElement(Box, { room: 'ch:a' })))
    await settle()
    act(() => setText('closing the panel'))
    act(() => root.render(createElement('div')))
    expect(sent.map((s) => s.path)).toEqual(['/chat/drafts/ch%3Aa'])
  })

  it('sends nothing on a room change when everything was already saved', async () => {
    act(() => root.render(createElement(Box, { room: 'ch:a' })))
    await settle()
    act(() => setText('saved'))
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS))
    await settle()
    act(() => root.render(createElement(Box, { room: 'ch:b' })))
    expect(sent).toHaveLength(1)
  })
})
