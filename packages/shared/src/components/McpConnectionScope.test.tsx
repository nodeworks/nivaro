// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { McpScopeSheet, type McpScopeSummary, scopeSummaryText } from './McpConnectionScope'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: unknown }

const CATALOG = {
  ready: true,
  actions: ['read', 'create', 'update', 'delete'],
  tools: [
    { name: 'search', title: 'Search', description: '', group: 'everyday', read_only: true },
    { name: 'read_items', title: 'Read', description: '', group: 'everyday', read_only: true },
    { name: 'update_item', title: 'Update', description: '', group: 'everyday', read_only: false }
  ],
  kits: [
    {
      key: 'buyer',
      label: 'Buyer',
      description: 'Buying things.',
      tools: ['search', 'read_items'],
      collections: null,
      actions: null,
      builtin: true,
      sort: 10
    }
  ]
}

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
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function mount(scope: McpScopeSummary | null, mode: 'mine' | 'admin') {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._method === 'GET' && cmd._path.startsWith('/mcp-connections/catalog'))
        return { data: CATALOG }
      if (cmd._method === 'GET')
        return { data: [{ collection: 'projects', display_name: 'Projects' }] }
      return { data: {} }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <McpScopeSheet
            open
            onClose={onClose}
            conn='o0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
            name='Claude'
            scope={scope}
            mode={mode}
          />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => (document.body.textContent ?? '').includes('Tool kit'))
  return { calls, onClose }
}

const buttonByText = (text: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

describe('McpScopeSheet', () => {
  it('saves a read-only limit on the person’s own route, never a lock', async () => {
    const { calls, onClose } = await mount(null, 'mine')
    expect(document.body.textContent).not.toContain('Lock')
    // Turn off Create, Change and Delete: read only.
    for (const label of ['Create', 'Change', 'Delete']) {
      await act(async () => {
        buttonByText(label)?.click()
      })
    }
    expect(document.body.textContent).toContain('read only')
    await act(async () => {
      buttonByText('Save limits')?.click()
    })
    await settle(() => calls.some((c) => c._method === 'PUT'))
    const put = calls.find((c) => c._method === 'PUT')!
    expect(put._path).toBe('/mcp-connections/mine/o0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b/scope')
    expect(put._body).toEqual({ kit: null, tools: null, collections: null, actions: ['read'] })
    await settle(() => onClose.mock.calls.length > 0)
    expect(onClose).toHaveBeenCalled()
  })

  it('lets an administrator lock, and remove the limits it already has', async () => {
    const scope: McpScopeSummary = {
      kit: 'buyer',
      kit_label: 'Buyer',
      kit_missing: false,
      tools: ['search', 'read_items'],
      collections: null,
      actions: null,
      own: { tools: null, collections: null, actions: null },
      locked: false,
      note: null,
      updated_at: null
    }
    const { calls } = await mount(scope, 'admin')
    expect(document.body.textContent).toContain('Lock')
    expect(document.body.textContent).toContain('Buying things.')
    await act(async () => {
      buttonByText('Remove limits')?.click()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="Remove limits?"]')?.click()
    })
    await settle(() => calls.some((c) => c._method === 'DELETE'))
    expect(calls.find((c) => c._method === 'DELETE')?._path).toBe(
      '/mcp-connections/o0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b/scope'
    )
  })
})

describe('scopeSummaryText', () => {
  it('reads like a sentence fragment', () => {
    expect(scopeSummaryText(null)).toBe('Everything the person can do')
    expect(
      scopeSummaryText({
        kit: 'buyer',
        kit_label: 'Buyer',
        kit_missing: false,
        tools: ['a', 'b'],
        collections: ['projects'],
        actions: ['read'],
        own: { tools: null, collections: null, actions: null },
        locked: false,
        note: null,
        updated_at: null
      })
    ).toBe('Buyer kit · 2 tools · projects · read only')
  })
})
