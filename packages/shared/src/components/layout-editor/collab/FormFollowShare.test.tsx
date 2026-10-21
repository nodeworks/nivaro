// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { ShareButton, WatchButton } from './FormFollowShare'
import { OwnerLine } from './OwnerLine'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: unknown; _params?: Record<string, unknown> }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

function makeClient(state: { watching: boolean }) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._method === 'PUT' && cmd._path === '/layout-collab/5/watch') {
        state.watching = (cmd._body as { on: boolean }).on
        return { data: { watching: state.watching } }
      }
      if (cmd._path === '/layout-collab/5')
        return {
          data: {
            owner: { id: 'o1', name: 'Olive Owner' },
            watching: state.watching,
            watchers: [{ id: 'w1', name: 'Wes Watcher' }]
          }
        }
      if (cmd._path === '/layout-collab/owners')
        return { data: { '5': { id: 'o1', name: 'Olive Owner' } } }
      if (cmd._path === '/layout-collab/5/preview-comments')
        return {
          data: [
            {
              id: 'c1',
              link_id: 'l1',
              field: 'due',
              name: 'Bo',
              text: 'Due should be first',
              at: '2026-10-20T10:00:00Z'
            }
          ]
        }
      if (cmd._path === '/layout-collab/5/preview-links')
        return {
          data: [
            {
              id: 'l1',
              token: 'abc',
              path: '/api/form-preview/abc',
              expires_at: '2026-11-03T00:00:00Z',
              view_count: 3,
              comments: 1,
              created_at: '2026-10-20T00:00:00Z'
            }
          ]
        }
      return { data: null }
    })
  }
  return { client, calls }
}

async function render(node: React.ReactNode, client: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  })
}

describe('WatchButton', () => {
  it('turns a watch on and off through PUT /layout-collab/:id/watch', async () => {
    const state = { watching: false }
    const { client, calls } = makeClient(state)
    await render(<WatchButton layoutId={5} />, client)
    const btn = () => host.querySelector('[data-form-watch]') as HTMLButtonElement
    await settle(() => calls.some((c) => c._path === '/layout-collab/5'))
    expect(btn().getAttribute('aria-pressed')).toBe('false')
    await act(async () => btn().click())
    await settle(() => btn().getAttribute('aria-pressed') === 'true')
    expect(calls.find((c) => c._method === 'PUT')?._body).toEqual({ on: true })
    expect(btn().getAttribute('aria-label')).toBe('Stop watching this form')
  })
})

describe('ShareButton', () => {
  it('shows the comment count, the owner, watchers, links and comments; selects a field', async () => {
    const { client } = makeClient({ watching: false })
    const onSelectField = vi.fn()
    await render(
      <ShareButton
        layoutId={5}
        fields={[{ field: 'due', label: 'Due date' }]}
        onSelectField={onSelectField}
      />,
      client
    )
    await settle(() => !!host.querySelector('[data-preview-comment-count]'))
    expect(host.querySelector('[data-preview-comment-count]')?.textContent).toBe('1')
    const trigger = host.querySelector('[data-form-share]') as HTMLButtonElement
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      trigger.click()
    })
    await settle(() => !!document.querySelector('[data-preview-link]'))
    const text = document.body.textContent ?? ''
    expect(text).toContain('Olive Owner')
    expect(text).toContain('Wes Watcher')
    expect(text).toContain('Due date')
    expect(text).toContain('Due should be first')
    expect(document.querySelector('[data-preview-link]')?.textContent).toContain(
      '/api/form-preview/abc'
    )
    const select = document.querySelector('[aria-label="Select this field"]') as HTMLButtonElement
    await act(async () => select.click())
    expect(onSelectField).toHaveBeenCalledWith('due')
  })
})

describe('OwnerLine', () => {
  it('names the owner of a form on the overview', async () => {
    const { client } = makeClient({ watching: false })
    await render(<OwnerLine layoutId={5} />, client)
    await settle(() => !!host.querySelector('[data-layout-owner]'))
    expect(host.textContent).toBe('Owner: Olive Owner')
  })
})
