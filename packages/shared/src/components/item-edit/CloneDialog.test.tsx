// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { CloneDialog } from './CloneDialog'
import type { CMSField } from './types'

// Rob 2026-11-14: "cloning an active workflow keeps its state". The copy started
// fresh on the server, but the dialog left the person on the ORIGINAL (hosts only
// navigate from a new-record form), still showing its workflow step.

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const fields = [
  { field: 'name', type: 'string', interface: 'input' },
  { field: 'request_state', type: 'integer', interface: 'input' },
  { field: 'order_number', type: 'string', interface: 'input' },
  { field: 'unit.name', type: 'string', interface: 'input' }
] as unknown as CMSField[]

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(() => new Promise((r) => setTimeout(r, 5)))
}

function render() {
  const calls: Cmd[] = []
  const navigate = vi.fn()
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path.startsWith('/copy-rules/'))
        return {
          data: { skip: { request_state: 'pipeline-state', order_number: 'do-not-duplicate' } }
        }
      return { data: { id: 77 } }
    })
  } as unknown as NivaroClient
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>
          <NavigationContext.Provider
            value={{ navigate, itemUrl: (t) => `/records/${t.collection}/${t.itemId}` }}
          >
            <CloneDialog
              collection='inventory_request'
              itemId='5'
              fields={fields}
              relations={[]}
              currentValues={{ name: 'A', request_state: 4, order_number: 'SO-1' }}
              onSuccess={() => {}}
            />
          </NavigationContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { calls, navigate }
}

const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined

describe('CloneDialog', () => {
  it('offers only fields that copy, then opens the copy', async () => {
    const { calls, navigate } = render()
    act(() => buttonByText('Clone')?.click())
    await settle()
    const labels = [...document.querySelectorAll('label')].map((l) => l.textContent?.trim())
    expect(labels).toContain('Name')
    expect(labels).not.toContain('Request State')
    expect(labels).not.toContain('Order Number')
    expect(labels.some((l) => l?.includes('.'))).toBe(false)

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const submit = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Clone'
    ) as HTMLButtonElement
    act(() => submit.click())
    await settle()
    expect(calls.some((c) => c._path === '/items/inventory_request/5/clone')).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/records/inventory_request/77')
  })
})
