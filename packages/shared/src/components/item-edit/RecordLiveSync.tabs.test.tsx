// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../context'
import { clearLiveRecordMarks, liveRecordWrite } from './live-record-marks'
import { RecordLiveSync } from './RecordLiveSync'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom and Node's BroadcastChannel do not mix (Node's dispatch refuses jsdom's events): a
// same-process stand-in with the browser's semantics — a channel never hears its own posts.
class FakeChannel {
  static open = new Map<string, Set<FakeChannel>>()
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor(readonly name: string) {
    const set = FakeChannel.open.get(name) ?? new Set()
    set.add(this)
    FakeChannel.open.set(name, set)
  }
  postMessage(data: unknown) {
    for (const ch of FakeChannel.open.get(this.name) ?? [])
      if (ch !== this) setTimeout(() => ch.onmessage?.({ data: structuredClone(data) }), 0)
  }
  close() {
    FakeChannel.open.get(this.name)?.delete(this)
  }
}
;(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel

// rt5 #6 — the same record open in two tabs of one browser.
describe('same record in two tabs', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
    clearLiveRecordMarks()
  })

  const tick = () => act(async () => new Promise((r) => setTimeout(r, 40)))

  function mount(dirty: boolean, qc = new QueryClient()) {
    const client = { request: vi.fn(async () => ({ data: null })) } as unknown as NivaroClient
    const el = (
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>
          <ItemEditAuthContext.Provider value={{ userId: 'me-1', isAdmin: false }}>
            <RecordLiveSync collection='workflows' itemId='5' dirty={dirty} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
    if (!root) {
      const host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    act(() => root?.render(el))
    return qc
  }

  it('says quietly that the other tab is editing, and on both sides when both are', async () => {
    const qc = mount(false)
    const other = new BroadcastChannel('nvr-record-tabs:me-1')
    other.postMessage({ type: 'state', tab: 'tab-2', key: 'workflows:5', dirty: true })
    await tick()
    const note = () => document.querySelector('[data-record-other-tab]')
    expect(note()?.getAttribute('data-record-other-tab')).toBe('quiet')
    expect(note()?.textContent).toContain('Also open in another tab — editing there')
    // Quiet: a status line, never an alert banner.
    expect(note()?.getAttribute('role')).toBe('status')

    // This tab starts editing too: the line stays and says both edit sets exist.
    mount(true, qc)
    await tick()
    expect(note()?.getAttribute('data-record-other-tab')).toBe('both')
    expect(note()?.textContent).toMatch(/Unsaved changes in another tab too/)

    // The other tab saved (or discarded): the line goes.
    other.postMessage({ type: 'state', tab: 'tab-2', key: 'workflows:5', dirty: false })
    await tick()
    expect(note()).toBeNull()
    other.close()
  })

  it("the other tab's save marks exactly the fields it carried and re-reads the record", async () => {
    const qc = mount(false)
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const other = new BroadcastChannel('nvr-record-tabs:me-1')
    other.postMessage({
      type: 'saved',
      tab: 'tab-2',
      key: 'workflows:5',
      fields: ['title', 'amount']
    })
    await tick()
    expect(liveRecordWrite('workflows', '5')?.fields).toEqual(['title', 'amount'])
    expect(
      spy.mock.calls.some((c) => JSON.stringify(c[0]?.queryKey) === '["item","workflows","5"]')
    ).toBe(true)
    other.close()
  })
})
