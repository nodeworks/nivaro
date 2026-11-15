// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { type RealtimeAdapter, RealtimeContext } from '../../lib/realtime'

vi.mock('../chat/chat-core', () => ({
  canOpenChatRoom: () => true,
  openChatRoom: vi.fn(),
  useRecordRoomTypes: () => [{ collection: 'workflows', prefix: 'wf', match_field: 'number' }]
}))
vi.mock('../chat/huddle/huddle-live', () => ({ useHuddleLive: () => ({ countFor: () => 0 }) }))

import { RecordChatActions } from './RecordChatActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// rt5 #9 — the record header's chat button shows the room's unread count live.
describe('record chat unread is live', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })

  it("a message in the record's room re-reads the count; another record's does not", async () => {
    let unread = 0
    const client = {
      request: vi.fn(async (cmd: { _path: string }) =>
        cmd._path === '/chat/record-room'
          ? { data: { room: 'wf:CR-1', unread, messages: 3 + unread, joined: true } }
          : { data: [] }
      )
    }
    const named = new Map<string, Array<(p: unknown) => void>>()
    const rt: RealtimeAdapter = {
      subscribeCollections: () => () => {},
      on: (event, cb) => {
        named.set(event, [...(named.get(event) ?? []), cb as (p: unknown) => void])
        return () => {}
      },
      emit() {}
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <NivaroProvider client={client as never}>
            <RealtimeContext.Provider value={rt}>
              <RecordChatActions
                collection='workflows'
                itemDraft={{ id: 7, number: 'CR-1' }}
                compact
              />
            </RealtimeContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const settle = async () => {
      for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    }
    await settle()
    const button = () => document.querySelector('[data-record-chat]')
    expect(button()?.getAttribute('data-record-chat-unread')).toBeNull()
    const reads = () =>
      client.request.mock.calls.filter(
        (c) => (c[0] as { _path: string })._path === '/chat/record-room'
      ).length
    const before = reads()

    // Another record's room: nothing.
    for (const cb of named.get('record:chat') ?? []) cb({ collection: 'workflows', item: '8' })
    await act(async () => new Promise((r) => setTimeout(r, 1100)))
    expect(reads()).toBe(before)

    // Two messages land in this record's room: one re-read, the badge shows them.
    unread = 2
    for (const cb of named.get('record:chat') ?? []) {
      cb({ collection: 'workflows', item: '7' })
      cb({ collection: 'workflows', item: '7' })
    }
    await act(async () => new Promise((r) => setTimeout(r, 1100)))
    await settle()
    expect(reads()).toBe(before + 1)
    expect(button()?.getAttribute('data-record-chat-unread')).toBe('2')
    expect(button()?.textContent).toContain('2')
  })
})
