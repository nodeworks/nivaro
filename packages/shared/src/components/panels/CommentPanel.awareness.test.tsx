// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../context'
import { CommentPanel } from './CommentPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Realtime round 7, items 14–16 on the record's Comments panel.

const person = (id: string, first: string) => ({
  id,
  first_name: first,
  last_name: 'X',
  email: `${first.toLowerCase()}@x.test`
})
const comment = (id: string, user: ReturnType<typeof person>, at: string, extra = {}) => ({
  id,
  collection: 'orders',
  item: '7',
  user,
  text: `Note ${id}`,
  created_at: at,
  updated_at: at,
  mentions: [],
  ...extra
})

async function mount(initial: unknown[]) {
  let thread = initial
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: { _path?: string }) => {
      const path = String(cmd?._path ?? '')
      if (path.includes('/comments/related')) return { data: [] }
      if (path.includes('/comments')) return { data: thread }
      return { data: [] }
    })
  } as unknown as NivaroClient
  const qc = new QueryClient()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>
          <ItemEditAuthContext.Provider value={{ userId: 'U-ME' } as never}>
            <CommentPanel collection='orders' item='7' defaultExpanded />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  const settle = async () => {
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 10)))
  }
  await settle()
  return {
    host,
    settle,
    async arrive(next: unknown[]) {
      thread = next
      await act(async () => {
        await qc.invalidateQueries({ queryKey: ['comments', 'orders', '7'] })
      })
      await settle()
    },
    async type(text: string) {
      const box = host.querySelector('textarea') as HTMLTextAreaElement
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      await act(async () => {
        set?.call(box, text)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await settle()
    },
    done() {
      act(() => root.unmount())
      host.remove()
    }
  }
}

const beth = person('U-BETH', 'Beth')
const me = person('U-ME', 'Me')
const first = comment('c1', beth, '2026-11-15T10:00:00Z')

describe('CommentPanel — replies while typing', () => {
  it('names replies that land while the draft is unsent, and none of mine', async () => {
    const ui = await mount([first])
    await ui.type('I think we should')
    expect(ui.host.querySelector('[data-replies-while-typing]')).toBeNull()
    await ui.arrive([
      first,
      comment('c2', beth, '2026-11-15T10:05:00Z'),
      comment('c3', me, '2026-11-15T10:06:00Z')
    ])
    const strip = ui.host.querySelector('[data-replies-while-typing]')
    expect(strip?.getAttribute('data-replies-while-typing')).toBe('1')
    expect(strip?.textContent).toContain('1 new reply since you started typing')
    expect(ui.host.querySelector('[data-reply-while-typing="c2"]')).toBeTruthy()
    ui.done()
  })

  it('goes when the box is cleared, and does not come back for what was there', async () => {
    const ui = await mount([first])
    await ui.type('draft')
    await ui.arrive([first, comment('c2', beth, '2026-11-15T10:05:00Z')])
    expect(ui.host.querySelector('[data-replies-while-typing]')).toBeTruthy()
    await ui.type('')
    expect(ui.host.querySelector('[data-replies-while-typing]')).toBeNull()
    await ui.type('again')
    expect(ui.host.querySelector('[data-replies-while-typing]')).toBeNull()
    ui.done()
  })
})

describe('CommentPanel — seen by + delivery', () => {
  it('shows "Seen by" from the server answer and Delivery only where it says so', async () => {
    const ui = await mount([
      comment('c1', me, '2026-11-15T10:00:00Z', {
        mentions: [{ id: 'U-BETH', first_name: 'Beth', last_name: 'X', seen_at: null }],
        seen_by: [{ id: 'U-MARK', name: 'Mark Ode', seen_at: '2026-11-15T10:10:00Z' }],
        delivery_visible: true
      }),
      comment('c2', beth, '2026-11-15T09:00:00Z', {
        mentions: [{ id: 'U-KIM', first_name: 'Kim', last_name: 'X', seen_at: null }],
        seen_by: []
      })
    ])
    const seen = ui.host.querySelector('[data-comment-seen-by]')
    expect(seen?.textContent).toBe('Also seen by Mark Ode')
    expect(ui.host.querySelectorAll('[data-mention-delivery]').length).toBe(1)
    expect(ui.host.querySelector('[data-mention-delivery="c1"]')).toBeTruthy()
    ui.done()
  })
})
