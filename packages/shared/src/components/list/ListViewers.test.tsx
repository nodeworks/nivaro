// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ItemEditAuthContext } from '../../context'
import { listViewTopic, othersFrom, viewersSentence } from '../../lib/list-viewers'
import { type RealtimeAdapter, RealtimeContext } from '../../lib/realtime'
import { ListViewers } from './ListViewers'

function fakeRealtime() {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  const emitted: Array<[string, unknown]> = []
  const rt: RealtimeAdapter & { emitted: typeof emitted; fire: (e: string, p: unknown) => void } = {
    emitted,
    subscribeCollections: () => () => {},
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)?.add(cb)
      return () => handlers.get(event)?.delete(cb)
    },
    emit(event, payload) {
      emitted.push([event, payload])
    },
    fire(e, p) {
      for (const cb of handlers.get(e) ?? []) cb(p)
    }
  }
  return rt
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mount(rt: RealtimeAdapter, isAdmin: boolean) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ItemEditAuthContext.Provider value={{ isAdmin, userId: 'U-ME' }}>
          <RealtimeContext.Provider value={rt}>
            <ListViewers kind='list' id='workflows' />
          </RealtimeContext.Provider>
        </ItemEditAuthContext.Provider>
      </QueryClientProvider>
    )
  )
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

describe('ListViewers (admins only)', () => {
  it('announces the list on open and leaves on close', () => {
    const rt = fakeRealtime()
    const v = mount(rt, false)
    expect(rt.emitted).toEqual([['ops:join', { topic: 'list-view:workflows' }]])
    v.unmount()
    expect(rt.emitted.at(-1)).toEqual(['ops:leave', { topic: 'list-view:workflows' }])
  })

  it('shows nothing until the server sends names (it only sends them to administrators)', () => {
    const rt = fakeRealtime()
    const v = mount(rt, false)
    expect(v.container.querySelector('[data-list-viewers]')).toBeNull()
  })

  it('shows the others, never me, when names arrive', () => {
    const rt = fakeRealtime()
    const v = mount(rt, true)
    act(() =>
      rt.fire('ops:changed', {
        topic: 'list-view:workflows',
        viewers: [
          { id: 'u-me', name: 'Me Myself' },
          { id: 'U-BETH', name: 'Beth Ames' },
          { id: 'U-ANA', name: 'Ana Ruiz' },
          { id: 'U-CY', name: 'Cy Doe' }
        ]
      })
    )
    const el = v.container.querySelector('[data-list-viewers]')
    expect(el?.getAttribute('data-list-viewers')).toBe('3')
    expect(el?.getAttribute('aria-label')).toBe('Viewing now: Ana Ruiz, Beth Ames, Cy Doe')
    expect(el?.getAttribute('aria-label')).not.toContain('Me Myself')
    // Another list's names never land here.
    act(() => rt.fire('ops:changed', { topic: 'list-view:orders', viewers: [] }))
    expect(v.container.querySelector('[data-list-viewers]')).not.toBeNull()
  })
})

describe('list viewer helpers', () => {
  it('names topics and sentences', () => {
    expect(listViewTopic('queue', 'Q1')).toBe('queue-view:Q1')
    expect(othersFrom('nope', 'x')).toEqual([])
    expect(viewersSentence(othersFrom([{ id: 'b', name: 'Beth Ames' }], 'x'))).toBe(
      'Beth is viewing this too'
    )
  })
})
