// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { RowActionsMenu } from './CollectionBrowserView'

// army 7 N7/M52 — the row ⋯ menu copied and named the row id ("367714") while
// the right-click menu copied the friendly one (PW26-76166).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const tick = async () => {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

async function render(props: {
  label?: string
  row?: Record<string, unknown>
  meta?: Record<string, unknown>
}) {
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async () => ({ data: null }))
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (props.meta) qc.setQueryData(['cbv-collection-meta', 'workflows'], props.meta)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true } as never}>
            <RowActionsMenu
              collection='workflows'
              id={367714}
              hasPipeline={false}
              onOpen={() => {}}
              urlFor={() => '#'}
              onDeleted={() => {}}
              label={props.label}
              row={props.row}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
}

const writeText = vi.fn(async () => {})
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

describe('RowActionsMenu — Copy ID', () => {
  it('a queue row names and copies its friendly label', async () => {
    await render({ label: 'PW26-76166' })
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for PW26-76166"]'
    )
    expect(trigger).toBeTruthy()
    await act(async () => trigger?.click())
    await tick()
    await act(async () => button('Copy ID')?.click())
    expect(writeText).toHaveBeenLastCalledWith('PW26-76166')
  })

  it('a browser row copies its friendly id column, never the row id', async () => {
    await render({
      meta: { friendly_id_field: 'workflow_id' },
      row: { id: 367714, workflow_id: 'PW26-76166' }
    })
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for PW26-76166"]'
    )
    await act(async () => trigger?.click())
    await tick()
    await act(async () => button('Copy ID')?.click())
    expect(writeText).toHaveBeenLastCalledWith('PW26-76166')
  })

  it('a record with no number offers no Copy ID', async () => {
    await render({ label: 'No workflow number · IG Net2.0' })
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for No workflow number · IG Net2.0"]'
    )
    await act(async () => trigger?.click())
    await tick()
    expect(button('Copy link')).toBeTruthy()
    expect(button('Copy ID')).toBeUndefined()
  })
})
