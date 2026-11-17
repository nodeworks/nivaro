// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { SupportEmailSwitch } from './SupportEmailSwitch'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: any }

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
  for (let i = 0; i < 80 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function mount(preferences: Record<string, unknown>) {
  const calls: Cmd[] = []
  const state = { preferences: { ...preferences } }
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._method === 'GET' && cmd._path === '/users/me') return { data: { ...state } }
      if (cmd._method === 'PATCH' && cmd._path === '/users/me/preferences') {
        state.preferences = { ...state.preferences, ...cmd._body }
        return { data: { preferences: state.preferences } }
      }
      return { data: {} }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <SupportEmailSwitch />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => !!wrap() && wrap()?.dataset.supportEmailSwitch !== 'loading')
  return calls
}

const wrap = () => host.querySelector<HTMLElement>('[data-support-email-switch]')
const sw = () => host.querySelector<HTMLButtonElement>('button[role="switch"]')

describe('SupportEmailSwitch', () => {
  it('reads the preference: off by default', async () => {
    await mount({})
    expect(wrap()?.dataset.supportEmailSwitch).toBe('off')
    expect(sw()?.getAttribute('aria-checked')).toBe('false')
    expect(sw()?.getAttribute('aria-label')).toBe('Email me when my requests get a reply or change')
  })

  it('reads the preference: on when stored', async () => {
    await mount({ support_email_updates: true })
    expect(wrap()?.dataset.supportEmailSwitch).toBe('on')
    expect(sw()?.getAttribute('aria-checked')).toBe('true')
  })

  it('turning it on writes true; turning it off writes null', async () => {
    const calls = await mount({})
    await act(async () => sw()!.click())
    await settle(() => calls.some((c) => c._method === 'PATCH'))
    expect(calls.find((c) => c._method === 'PATCH')).toMatchObject({
      _path: '/users/me/preferences',
      _body: { support_email_updates: true }
    })
    await settle(() => wrap()?.dataset.supportEmailSwitch === 'on')
    expect(wrap()?.dataset.supportEmailSwitch).toBe('on')
    await act(async () => sw()!.click())
    await settle(() => calls.filter((c) => c._method === 'PATCH').length === 2)
    expect(calls.filter((c) => c._method === 'PATCH')[1]._body).toEqual({
      support_email_updates: null
    })
    await settle(() => wrap()?.dataset.supportEmailSwitch === 'off')
    expect(wrap()?.dataset.supportEmailSwitch).toBe('off')
  })
})
