// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { CbvFileLabel } from './cbv-file-label'

// Production 2026-11-13: a list column "MWF Queue → File" read every file as "Not available to
// you" (and asked GET /collections/nivaro_files → 404), while the record page showed the file.
// Files are read through /files/:id/meta, as the viewer, never /items or /collections.

function client(meta: Record<string, unknown> | null) {
  const calls: string[] = []
  const c = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: { _path?: string }) => {
      calls.push(cmd._path ?? '')
      if (cmd._path === '/files/F-1/meta') {
        if (!meta) throw Object.assign(new Error('Not found'), { status: 404 })
        return { data: meta }
      }
      return { data: null }
    })
  } as unknown as NivaroClient
  return { c, calls }
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount(c: NivaroClient, id: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={c}>
          <CbvFileLabel id={id} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)))
}

describe('CbvFileLabel', () => {
  it('shows the file by name through /files/:id/meta, as a link to the file', async () => {
    const { c, calls } = client({ title: null, filename_download: 'B1020-6177735.xlsx' })
    await mount(c, 'F-1')
    const a = host.querySelector('a')
    expect(a?.textContent).toBe('B1020-6177735.xlsx')
    expect(a?.getAttribute('href')).toMatch(/\/files\/F-1$/)
    expect(calls).toEqual(['/files/F-1/meta'])
    expect(calls.some((p) => p.startsWith('/collections') || p.startsWith('/items'))).toBe(false)
  })

  it('a file the viewer cannot read (or that is gone) says so, never the id', async () => {
    const { c } = client(null)
    await mount(c, 'F-1')
    expect(host.textContent).toBe('Not available to you')
    expect(host.querySelector('[data-relation-missing]')).not.toBeNull()
  })

  it('no file is a dash', async () => {
    const { c, calls } = client(null)
    await mount(c, null)
    expect(host.textContent).toBe('—')
    expect(calls).toEqual([])
  })
})
