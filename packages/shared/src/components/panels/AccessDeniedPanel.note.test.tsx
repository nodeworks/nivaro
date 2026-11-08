// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { AccessDeniedPanel } from './AccessDeniedPanel'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type Cmd = { _method: string; _path: string; _body?: unknown }

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

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

describe('AccessDeniedPanel — ask for access with a note (army 11)', () => {
  it('sends the optional note with the request', async () => {
    const calls: Cmd[] = []
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path.startsWith('/access-explain'))
          return {
            data: { access: false, reasons: [{ type: 'scope', message: 'Outside your zones.' }] }
          }
        return { data: { requested: true } }
      })
    } as unknown as NivaroClient
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client}>
            <AccessDeniedPanel collection='workflows' itemId='372955' noun='Workflow' />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await flush()
    const box = host.querySelector<HTMLTextAreaElement>('[data-request-access-note]')
    expect(box).not.toBeNull()
    expect(host.querySelector(`label[for="${box!.id}"]`)?.textContent).toMatch(/what for/)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(box, 'I approve this for Zone 1')
      box!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-request-access]')!.click()
    })
    await flush()
    const sent = calls.find((c) => c._method === 'POST' && c._path === '/access-requests')
    expect(sent?._body).toEqual({
      collection: 'workflows',
      item: '372955',
      note: 'I approve this for Zone 1'
    })
  })
})
