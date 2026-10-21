// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { type EditorApi, useEditorApi } from './editor-api'
import { RowRuleRow } from './row-rule-row'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function render(ui: ReactNode, client: { request: (...a: unknown[]) => unknown }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>{ui}</NivaroProvider>
      </QueryClientProvider>
    )
  })
}

describe('editor-api', () => {
  it('rethrows SDK errors in the axios shape the moved catch sites read', async () => {
    // What the SDK throws on a non-2xx (packages/sdk request()).
    const sdkError = Object.assign(new Error('Unknown field qty'), {
      status: 400,
      response: { error: 'Unknown field qty' }
    })
    const client = { request: vi.fn().mockRejectedValue(sdkError) }
    let api: EditorApi | null = null
    function Probe() {
      api = useEditorApi()
      return null
    }
    render(<Probe />, client)
    for (const call of [
      () => api?.get('/x'),
      () => api?.post('/x', {}),
      () => api?.patch('/x', {})
    ]) {
      const err = await call()?.catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe('Unknown field qty')
      expect(err).toMatchObject({
        status: 400,
        response: { status: 400, data: { error: 'Unknown field qty' } }
      })
    }
  })
})

describe('RowRuleRow', () => {
  it('Enter on the remove button removes the rule instead of folding it', async () => {
    const onRemove = vi.fn()
    render(
      <RowRuleRow
        rule={{ trigger_field: 'qty', target_field: 'note', target_type: 'set' }}
        childFields={[
          { field: 'qty', label: 'Qty' },
          { field: 'note', label: 'Note' }
        ]}
        m2oRels={[]}
        o2mRels={[]}
        onChange={() => {}}
        onRemove={onRemove}
      />,
      { request: vi.fn().mockResolvedValue({ data: [] }) }
    )
    const header = host.querySelector('[role="button"][aria-expanded]') as HTMLElement
    expect(header.getAttribute('aria-expanded')).toBe('false')
    const remove = host.querySelector('[aria-label="Remove rule"]') as HTMLButtonElement
    expect(remove).not.toBeNull()
    await act(async () => {
      remove.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    // The header ignored the key (it was not its own); the button's native
    // Enter → click then removes.
    expect(header.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      remove.click()
    })
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(header.getAttribute('aria-expanded')).toBe('false')

    // Enter on the header itself still folds / unfolds.
    await act(async () => {
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(header.getAttribute('aria-expanded')).toBe('true')
  })
})
