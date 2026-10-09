// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelpVideoDto } from '../types'
import { DetailsTab } from './DetailsTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { method: string; path: string; body?: Record<string, unknown> }
const request = vi.fn()
vi.mock('../../../context', () => ({ useNivaroClient: () => ({ request }) }))
vi.mock('../../../lib/commands', () => ({
  get: (path: string) => ({ method: 'GET', path }),
  post: (path: string, body?: unknown) => ({ method: 'POST', path, body }),
  patch: (path: string, body?: unknown) => ({ method: 'PATCH', path, body }),
  put: (path: string, body?: unknown) => ({ method: 'PUT', path, body }),
  del: (path: string) => ({ method: 'DELETE', path })
}))

const video = (over: Partial<HelpVideoDto> = {}) =>
  ({
    id: 'v1',
    title: 'Old title',
    description: null,
    category: null,
    status: 'draft',
    contexts: [{ kind: 'collection', key: 'orders', state_key: null }],
    visibility: { mode: 'everyone', role_ids: [] },
    required_role_ids: [],
    ...over
  }) as unknown as HelpVideoDto

let host: HTMLDivElement
let root: Root
let patches: Cmd[]
let releaseFirstPatch: () => void
beforeEach(() => {
  patches = []
  request.mockReset()
  request.mockImplementation((c: Cmd) => {
    if (c.method === 'PATCH') {
      patches.push(c)
      // The first save stays in flight until the test lets it go.
      if (patches.length === 1)
        return new Promise((r) => (releaseFirstPatch = () => r({ data: {} })))
      return Promise.resolve({ data: {} })
    }
    if (c.path.startsWith('/queues/collection-states/'))
      return Promise.resolve({
        data: [
          { key: 'draft', label: 'Draft' },
          { key: 'approved', label: 'Approved' }
        ]
      })
    if (c.method === 'GET') return Promise.resolve({ data: [] })
    return Promise.resolve({ data: {} })
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const mount = async (v: HelpVideoDto) => {
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(DetailsTab, { video: v }))
    )
  })
}
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    el.focus()
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.blur()
  })
}

describe('DetailsTab text saves', () => {
  it('never writes a stale title back over a newer one', async () => {
    await mount(video())
    await type(
      host.querySelector<HTMLInputElement>('[data-hv-title]') as HTMLInputElement,
      'New title'
    )
    expect(patches[0].body).toEqual({ title: 'New title' })
    // The editor remounts (a tab switch, a reload) while that save is in flight,
    // from a copy of the video that still has the old title.
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount(video())
    await type(
      host.querySelector<HTMLTextAreaElement>('[data-hv-description]') as HTMLTextAreaElement,
      'A note'
    )
    expect(patches[1].body).toEqual({ description: 'A note' })
    await act(async () => releaseFirstPatch())
  })
})

describe('DetailsTab steps', () => {
  it('shows the stored steps as chosen, and says when none are', async () => {
    await mount(video())
    expect(host.querySelector('[data-hv-step-summary]')?.textContent).toBe('Every step')
    expect(host.querySelector('[data-hv-state-chip="draft"]')?.getAttribute('aria-pressed')).toBe(
      'false'
    )
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount(video({ contexts: [{ kind: 'collection', key: 'orders', state_key: 'approved' }] }))
    expect(host.querySelector('[data-hv-step-summary]')?.textContent).toBe(
      'Only at the chosen steps'
    )
    expect(
      host.querySelector('[data-hv-state-chip="approved"]')?.getAttribute('aria-pressed')
    ).toBe('true')
    expect(host.querySelector('[data-hv-state-chip="draft"]')?.getAttribute('aria-pressed')).toBe(
      'false'
    )
  })

  it('choosing a step replaces the every-step row it sends', async () => {
    await mount(video())
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-hv-state-chip="draft"]')?.click()
    })
    const put = request.mock.calls.map((c) => c[0] as Cmd).find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({
      contexts: [{ kind: 'collection', key: 'orders', state_key: 'draft' }]
    })
  })
})
