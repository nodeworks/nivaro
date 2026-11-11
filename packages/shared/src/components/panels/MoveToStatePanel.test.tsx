// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { MoveToStatePanel } from './MoveToStatePanel'

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
  document.body.innerHTML = ''
})

function render() {
  const request = vi.fn(async () => ({ data: { to: { label: 'Waiting on PO' }, ended: null } }))
  const client = { url: '', getToken: () => null, request } as unknown as NivaroClient
  const qc = new QueryClient()
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>
          <MoveToStatePanel
            collection='nivaro_addendums'
            item='A1'
            states={[
              { id: 'S-PO', label: 'Waiting on PO' },
              { id: 'S-DONE', label: 'Completed' }
            ]}
            currentStateId='S-DONE'
            onMoved={() => {}}
          />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { request }
}

const typeInto = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })

describe('MoveToStatePanel', () => {
  it('opens an inline form that warns no transition steps run', () => {
    render()
    expect(document.querySelector('[data-move-to-state-form]')).toBeNull()
    act(() => (document.querySelector('[data-move-to-state-open]') as HTMLButtonElement).click())
    const form = document.querySelector('[data-move-to-state-form]')
    expect(form?.textContent).toContain('No transition steps run')
  })

  it('keeps Move off until a state is picked and a reason is given', async () => {
    const { request } = render()
    act(() => (document.querySelector('[data-move-to-state-open]') as HTMLButtonElement).click())
    const submit = document.querySelector('[data-move-to-state-submit]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await typeInto(document.querySelector('textarea') as HTMLTextAreaElement, 'Completed too early')
    // Still no state picked.
    expect(submit.disabled).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })
})
