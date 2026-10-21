// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { FormWhatsNew } from './FormWhatsNew'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: unknown }
const REV = 'a'.repeat(64)

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

async function mount(answer: Record<string, unknown>) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._method === 'GET') return { data: answer }
      return { data: { ok: true } }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <FormWhatsNew layoutId={9} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  return calls
}

describe('FormWhatsNew', () => {
  it('shows what changed and records it as seen when dismissed', async () => {
    const calls = await mount({
      rev: REV,
      lines: ['New: Budget code', 'Due date moved to Schedule'],
      mark: false,
      changed_by: 'Ada Lovelace',
      changed_at: '2026-10-20T10:00:00Z'
    })
    await settle(() => !!host.querySelector('[data-form-whats-new]'))
    const text = host.textContent ?? ''
    expect(text).toContain('What’s new on this form')
    expect(text).toContain('Ada Lovelace')
    expect(text).toContain('Due date moved to Schedule')
    expect(calls.some((c) => c._method === 'POST')).toBe(false)
    await act(async () =>
      (host.querySelector('[aria-label="Dismiss what’s new"]') as HTMLButtonElement).click()
    )
    await settle(() => !host.querySelector('[data-form-whats-new]'))
    expect(calls.find((c) => c._method === 'POST')).toMatchObject({
      _path: '/layout-collab/9/whats-new/seen',
      _body: { rev: REV }
    })
  })

  it('shows nothing on a first open but remembers the state once', async () => {
    const calls = await mount({ rev: REV, lines: null, mark: true })
    await settle(() => calls.some((c) => c._method === 'POST'))
    expect(host.querySelector('[data-form-whats-new]')).toBeNull()
    expect(calls.filter((c) => c._method === 'POST')).toHaveLength(1)
  })
})
