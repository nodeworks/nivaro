// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { AiComposer } from './AiComposer'
import { emptyBundle } from './ai-forms-api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Form from a paper form (#3186): several photos (one per page) go up in one
// request, and labels no field matched come back as fields you may want to
// create, with a suggested key and a Copy the list button.

const FORM = {
  name: 'Equipment request',
  layout: 'sections',
  groups: [{ label: 'Requester', fields: ['reason'], source: 'Requester' }],
  locks: [],
  requirements: [],
  candidates: [
    { label: 'Serial number', type: 'text', group: 'Item', key: 'serial_number' },
    { label: 'Needed by', type: 'date', group: null, key: 'needed_by' }
  ],
  dropped: [],
  explanation: 'Two pages, two sections.'
}

let root: Root
let el: HTMLDivElement
const realFetch = globalThis.fetch
beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  globalThis.fetch = realFetch
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}

function pick(files: File[]) {
  const input = document.querySelector('[data-ai-compose-file]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('AiComposer — paper form', () => {
  it('sends every page in one request and lists fields you may want to create', async () => {
    const sent: FormData[] = []
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(init?.body as FormData)
      return new Response(JSON.stringify({ data: { form: FORM, read_as: 'pdf-pages' } }), {
        status: 200
      })
    }) as typeof fetch
    const client = {
      request: vi.fn(async () => ({ data: [{ field: 'reason', label: 'Reason' }] })),
      getToken: () => 't',
      url: ''
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <AiComposer
              collection='returns'
              mode='picture'
              bundle={emptyBundle('returns')}
              applyLabel={() => 'Create form'}
              onApply={vi.fn()}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    pick([new File(['a'], 'page1.jpg'), new File(['b'], 'page2.jpg')])
    pick([new File(['a'], 'page1.jpg')]) // the same file again is not added twice
    expect(document.querySelectorAll('[data-ai-compose-files] li')).toHaveLength(2)

    await act(async () => {
      ;(document.querySelector('[data-ai-compose-run]') as HTMLButtonElement).click()
    })
    await settle(() => !!document.querySelector('[data-ai-candidates]'))
    expect(sent[0].getAll('file').map((f) => (f as File).name)).toEqual(['page1.jpg', 'page2.jpg'])
    expect(sent[0].get('mode')).toBe('picture')

    const text = document.querySelector('[data-ai-candidates]')?.textContent ?? ''
    expect(text).toContain('Serial number')
    expect(text).toContain('serial_number')
    expect(document.body.textContent).toContain('Fields you may want to create')
    expect(document.querySelector('[data-ai-read-as]')).not.toBeNull()

    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await act(async () => {
      ;(document.querySelector('[data-ai-candidates-copy]') as HTMLButtonElement).click()
    })
    expect(writeText).toHaveBeenCalledWith(
      'Label\tKey\tType\nSerial number\tserial_number\ttext\nNeeded by\tneeded_by\tdate'
    )
  })

  it('refuses a seventh file before anything is sent', async () => {
    const client = { request: vi.fn(async () => ({ data: [] })), getToken: () => 't', url: '' }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <AiComposer
              collection='returns'
              mode='picture'
              bundle={emptyBundle('returns')}
              applyLabel={() => 'Create form'}
              onApply={vi.fn()}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    pick(Array.from({ length: 7 }, (_, i) => new File(['x'], `p${i}.jpg`)))
    expect(document.querySelector('[data-ai-compose-error]')?.textContent).toBe(
      'Up to 6 files at once'
    )
    expect(document.querySelectorAll('[data-ai-compose-files] li')).toHaveLength(0)
  })
})
