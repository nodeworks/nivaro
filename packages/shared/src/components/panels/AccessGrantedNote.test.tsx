// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { AccessGrantedNote, accessGrantedText, useAccessRegained } from './AccessGrantedNote'

// rt4 #11 — a refused record or list that becomes readable while open (an access request
// granted) shows its content with one quiet line: "Access granted by Beth".

type Cmd = { _method: string; _path: string; _query?: Record<string, unknown> }

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

describe('accessGrantedText', () => {
  it('names the administrator only for a granted request', () => {
    expect(accessGrantedText({ status: 'granted', resolved_by_first: 'Beth' })).toBe(
      'Access granted by Beth'
    )
    expect(accessGrantedText({ status: 'pending', resolved_by_first: 'Beth' })).toBe(
      'Access granted'
    )
    expect(accessGrantedText(null)).toBe('Access granted')
  })
})

function Probe(p: { denied: boolean; readable: boolean; k: string }) {
  const regained = useAccessRegained(p.denied, p.readable, p.k)
  return <span data-regained={regained ? 'yes' : 'no'} />
}
const regained = () => host.querySelector('[data-regained]')?.getAttribute('data-regained')

describe('useAccessRegained', () => {
  it('is true only after a refusal on this page turned readable, and resets per record', async () => {
    await act(async () => root.render(<Probe denied={false} readable k='w:1' />))
    expect(regained()).toBe('no') // readable from the start: nothing to say
    await act(async () => root.render(<Probe denied readable={false} k='w:2' />))
    expect(regained()).toBe('no')
    await act(async () => root.render(<Probe denied={false} readable k='w:2' />))
    expect(regained()).toBe('yes')
    await act(async () => root.render(<Probe denied={false} readable k='w:3' />))
    expect(regained()).toBe('no')
  })
})

describe('AccessGrantedNote', () => {
  it('asks for the caller’s own request and says who granted it', async () => {
    const calls: Cmd[] = []
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        return { data: { status: 'granted', resolved_by_first: 'Beth' } }
      })
    } as unknown as NivaroClient
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client}>
            <AccessGrantedNote collection='workflows' itemId='372955' />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await flush()
    expect(calls[0]?._path).toBe('/access-requests/mine')
    const note = host.querySelector('[data-access-granted]')
    expect(note?.getAttribute('role')).toBe('status')
    expect(note?.textContent).toContain('Access granted by Beth')
    // Dismissable, quietly.
    await act(async () => host.querySelector<HTMLButtonElement>('button')?.click())
    expect(host.querySelector('[data-access-granted]')).toBeNull()
  })

  it('still says "Access granted" when the request cannot be read', async () => {
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async () => {
        throw Object.assign(new Error('nope'), { status: 500 })
      })
    } as unknown as NivaroClient
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client}>
            <AccessGrantedNote collection='workflows' />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await flush()
    expect(host.querySelector('[data-access-granted]')?.textContent).toContain('Access granted')
  })
})
